import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../database/db.js";
import type { AppConfig } from "../config/env.js";
import type { SessionContext, WorkspaceRow } from "../types.js";
import { Err } from "../utils/errors.js";
import { safeResolve, toPosixRelative } from "../utils/paths.js";
import { buildEnv, checkCommand } from "../policy/command-policy.js";
import { writeEvent } from "./events.js";
import { redactString } from "../security/redact.js";

/**
 * Restricted remote execution: spawn a shell in the workspace, capture output
 * to logs/, track the lifecycle in SQLite, enforce policy + limits.
 * Single-instance server; `live` is the in-memory registry for kill/stop.
 */

export interface ProcessRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  agent_id: string | null;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "timed_out" | "denied" | "failed";
  exit_code: number | null;
  stdout_path: string | null;
  stderr_path: string | null;
  bytes_out: number;
  started_at: string;
  ended_at: string | null;
}

interface LiveProcess {
  child: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  bytesWritten: number;
  truncated: boolean;
  killReason: "timeout" | "user" | null;
  timeoutHandle: NodeJS.Timeout;
}

const live = new Map<string, LiveProcess>();

export function getLiveProcessIds(): string[] {
  return [...live.keys()];
}

export async function startProcess(
  db: Db,
  config: AppConfig,
  ctx: SessionContext,
  workspace: WorkspaceRow,
  args: {
    command: string;
    cwd?: string | undefined;
    timeoutMs?: number | undefined;
    env?: Record<string, string> | undefined;
    allowSensitiveEnv?: boolean | undefined;
    wait?: boolean | undefined;
    waitMs?: number | undefined;
  }
): Promise<{ processId: string; status: string; exitCode?: number | null; durationMs?: number; stdoutTail?: string; stderrTail?: string; truncated?: boolean } | never> {
  if (config.execMode === "disabled") throw Err.execDisabled();

  const decision = checkCommand(config.execMode, args.command, config.allowedCommands);
  const processId = randomUUID();
  const logsDir = path.join(workspace.root_path, "logs");
  await fsp.mkdir(logsDir, { recursive: true });
  const stdoutPath = path.join(logsDir, `${processId}.stdout`);
  const stderrPath = path.join(logsDir, `${processId}.stderr`);

  if (!decision.allowed) {
    db.prepare(
      `INSERT INTO processes (id, workspace_id, session_id, agent_id, command, cwd, status, exit_code, stdout_path, stderr_path, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, 'denied', NULL, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(processId, workspace.id, ctx.sessionRowId, ctx.principal.agentId, args.command.slice(0, 4000), args.cwd ?? ".", stdoutPath, stderrPath);
    writeEvent(db, { workspaceId: workspace.id, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action: "exec.denied", target: args.command.slice(0, 300), detail: { reason: decision.reason } });
    throw Err.execDenied(`${decision.reason ?? "blocked"} (process_id: ${processId})`);
  }

  // Concurrency cap (live + DB-running)
  const runningInDb = db.prepare(`SELECT COUNT(*) AS c FROM processes WHERE workspace_id = ? AND status = 'running'`).get(workspace.id) as { c: number };
  if (runningInDb.c >= config.execMaxConcurrentPerWorkspace) throw Err.concurrencyLimit(config.execMaxConcurrentPerWorkspace);

  const cwdAbs = safeResolve(workspace.root_path, args.cwd ?? ".");
  const cwdStat = await fsp.stat(cwdAbs).catch(() => null);
  if (!cwdStat?.isDirectory()) throw Err.notFound(`cwd not found or not a directory: ${args.cwd}`);

  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? config.execDefaultTimeoutMs, 1000), config.execMaxTimeoutMs);
  const env = buildEnv(args.env, args.allowSensitiveEnv ?? false, { slug: workspace.slug, rootPath: workspace.root_path });

  db.prepare(
    `INSERT INTO processes (id, workspace_id, session_id, agent_id, command, cwd, status, stdout_path, stderr_path)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(processId, workspace.id, ctx.sessionRowId, ctx.principal.agentId, redactString(args.command).slice(0, 4000), toPosixRelative(workspace.root_path, cwdAbs) || ".", stdoutPath, stderrPath);

  const started = Date.now();
  const child = spawn("/bin/sh", ["-c", args.command], {
    cwd: cwdAbs,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: "w" });
  const liveEntry: LiveProcess = {
    child,
    stdoutPath,
    stderrPath,
    bytesWritten: 0,
    truncated: false,
    killReason: null,
    timeoutHandle: setTimeout(() => {
      liveEntry.killReason = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs),
  };
  live.set(processId, liveEntry);

  const cap = config.execMaxOutputBytes;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    liveEntry.bytesWritten += chunk.length;
    if (stdoutStream.bytesWritten + chunk.length <= cap) {
      stdoutStream.write(chunk);
    } else if (!liveEntry.truncated) {
      stdoutStream.write(Buffer.from(`\n…[output truncated at ${cap} bytes]\n`));
      liveEntry.truncated = true;
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    liveEntry.bytesWritten += chunk.length;
    if (stderrStream.bytesWritten + chunk.length <= cap) {
      stderrStream.write(chunk);
    } else if (!liveEntry.truncated) {
      stderrStream.write(Buffer.from(`\n…[output truncated at ${cap} bytes]\n`));
      liveEntry.truncated = true;
    }
  });

  const exitPromise = new Promise<{ code: number | null; killed: boolean; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, killed: signal !== null, signal }));
    child.on("error", () => resolve({ code: -1, killed: false, signal: null }));
  });

  const finalize = (code: number | null, killed: boolean) => {
    clearTimeout(liveEntry.timeoutHandle);
    live.delete(processId);
    const status = liveEntry.killReason === "timeout" ? "timed_out" : killed ? "killed" : "exited";
    db.prepare(`UPDATE processes SET status = ?, exit_code = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
      status,
      code,
      processId
    );
    writeEvent(db, {
      workspaceId: workspace.id,
      agentId: ctx.principal.agentId,
      sessionId: ctx.sessionRowId,
      action: "exec.executed",
      target: processId,
      detail: { command: redactString(args.command).slice(0, 300), status, exit_code: code, cwd: toPosixRelative(workspace.root_path, cwdAbs) || "." },
    });
    stdoutStream.end();
    stderrStream.end();
  };
  void exitPromise.then(({ code, killed }) => finalize(code, killed));

  const wait = args.wait ?? true;
  if (!wait) {
    return { processId, status: "running" };
  }

  const waitMs = Math.min(Math.max(args.waitMs ?? 30_000, 0), 30_000);
  const raced = await Promise.race([
    exitPromise.then((r) => ({ done: true as const, ...r })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), waitMs)),
  ]);

  if (!raced.done) {
    return { processId, status: "running" };
  }

  const tail = async (stream: "stdout" | "stderr") => {
    try {
      const content = await fsp.readFile(stream === "stdout" ? stdoutPath : stderrPath, "utf8");
      return content.slice(-8192);
    } catch {
      return "";
    }
  };
  const row = db.prepare(`SELECT status, exit_code FROM processes WHERE id = ?`).get(processId) as { status: string; exit_code: number | null };
  return {
    processId,
    status: row.status,
    exitCode: row.exit_code,
    durationMs: Date.now() - started,
    stdoutTail: await tail("stdout"),
    stderrTail: await tail("stderr"),
    truncated: liveEntry.truncated,
  };
}

export async function readProcessOutput(
  db: Db,
  workspaceId: string,
  processId: string,
  opts: { stream?: "stdout" | "stderr" | "both" | undefined; offsetBytes?: number | undefined; maxBytes?: number | undefined }
): Promise<{ command: string; status: string; exitCode: number | null; stream: string; stdout?: string; stderr?: string; truncated: boolean }> {
  const row = db.prepare(`SELECT * FROM processes WHERE id = ? AND workspace_id = ?`).get(processId, workspaceId) as ProcessRow | undefined;
  if (!row) throw Err.notFound(`process not found: ${processId}`);

  const stream = opts.stream ?? "both";
  const offset = Math.max(0, opts.offsetBytes ?? 0);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? 65536, 1), 1_048_576);

  const readSlice = async (filePath: string | null): Promise<{ text: string; truncated: boolean }> => {
    if (!filePath) return { text: "", truncated: false };
    let data: Buffer;
    try {
      data = await fsp.readFile(filePath);
    } catch {
      return { text: "", truncated: false };
    }
    const slice = data.subarray(offset, offset + maxBytes);
    return { text: slice.toString("utf8"), truncated: offset + maxBytes < data.length };
  };

  const out: { command: string; status: string; exitCode: number | null; stream: string; stdout?: string; stderr?: string; truncated: boolean } = {
    command: row.command,
    status: row.status,
    exitCode: row.exit_code,
    stream,
    truncated: false,
  };
  if (stream === "stdout" || stream === "both") {
    const r = await readSlice(row.stdout_path);
    out.stdout = r.text;
    out.truncated ||= r.truncated;
  }
  if (stream === "stderr" || stream === "both") {
    const r = await readSlice(row.stderr_path);
    out.stderr = r.text;
    out.truncated ||= r.truncated;
  }
  return out;
}

export function getProcessStatus(db: Db, workspaceId: string, processId: string): ProcessRow {
  const row = db.prepare(`SELECT * FROM processes WHERE id = ? AND workspace_id = ?`).get(processId, workspaceId) as ProcessRow | undefined;
  if (!row) throw Err.notFound(`process not found: ${processId}`);
  return row;
}

export async function stopProcess(
  db: Db,
  workspaceId: string,
  processId: string,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM"
): Promise<{ stopped: boolean; status: string }> {
  const row = db.prepare(`SELECT * FROM processes WHERE id = ? AND workspace_id = ?`).get(processId, workspaceId) as ProcessRow | undefined;
  if (!row) throw Err.notFound(`process not found: ${processId}`);
  if (row.status !== "running") return { stopped: false, status: row.status };

  const entry = live.get(processId);
  if (entry) {
    entry.killReason = "user";
    entry.child.kill(signal);
    // Exit handler performs the final row update; give it a beat.
    await new Promise((r) => setTimeout(r, 250));
    const updated = db.prepare(`SELECT status FROM processes WHERE id = ?`).get(processId) as { status: string };
    if (updated.status === "running") {
      // Escalate if SIGTERM didn't do it
      entry.child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 250));
    }
  } else {
    // Handle lost (server restarted earlier or entry missing)
    db.prepare(`UPDATE processes SET status = 'failed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(processId);
  }
  const finalRow = db.prepare(`SELECT status FROM processes WHERE id = ?`).get(processId) as { status: string };
  writeEvent(db, { workspaceId, action: "exec.stopped", target: processId, detail: { signal } });
  return { stopped: true, status: finalRow.status };
}
