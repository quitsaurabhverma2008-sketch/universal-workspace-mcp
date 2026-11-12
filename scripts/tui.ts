#!/usr/bin/env node
/**
 * Universal Workspace MCP — real-time TUI monitor.
 *
 *   npx tsx scripts/tui.ts                 # watch the default workspace
 *   npx tsx scripts/tui.ts aurora-showcase # watch a specific workspace
 *   SMOKE=1 npx tsx scripts/tui.ts         # print one frame and exit (no TTY)
 *
 * Shows, live: plan progress, task board (who claimed what), connected agents,
 * the audit feed (who wrote what, when) and process/workspace stats.
 * Reads the MCP SQLite database read-only — no MCP session required.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(ROOT, "data/database.sqlite");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[38;5;81m", green: "\x1b[38;5;114m", orange: "\x1b[38;5;215m",
  magenta: "\x1b[38;5;177m", blue: "\x1b[38;5;111m", yellow: "\x1b[38;5;222m",
  red: "\x1b[38;5;203m", gray: "\x1b[38;5;245m", white: "\x1b[38;5;255m",
  bg: "\x1b[48;5;236m",
};

const AGENT_COLORS: Record<string, string> = {
  "agent-alpha": C.green,
  "agent-beta": C.cyan,
  "agent-gamma": C.orange,
};

interface TaskRow {
  id: string; title: string; status: string; priority: number;
  assignee_agent: string | null; assignee_name: string | null; updated_at: string;
}
interface EventRow {
  id: number; agent_id: string | null; action: string; target: string | null;
  detail: string; created_at: string;
}

function loadState(slug: string) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const ws = db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(slug) as
      | { id: string; slug: string; name: string; root_path: string; updated_at: string; archived_at: string | null }
      | undefined;
    if (!ws) return null;
    const plan = db.prepare(`SELECT * FROM plans WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`).get(ws.id) as
      | { id: string; title: string; status: string } | undefined;
    const tasks = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, t.assignee_agent, a.name AS assignee_name, t.updated_at
         FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent
         WHERE t.workspace_id = ? ORDER BY t.priority ASC`
      )
      .all(ws.id) as unknown as TaskRow[];
    const events = db
      .prepare(
        `SELECT id, agent_id, action, target, detail, created_at FROM events
         WHERE workspace_id = ? ORDER BY id DESC LIMIT 24`
      )
      .all(ws.id) as unknown as EventRow[];
    const agents = db
      .prepare(
        `SELECT DISTINCT a.id, a.name FROM agents a
         WHERE a.id IN (SELECT DISTINCT agent_id FROM events WHERE workspace_id = ? AND agent_id IS NOT NULL)
            OR a.id IN (SELECT DISTINCT agent_id FROM sessions WHERE workspace_id = ? AND agent_id IS NOT NULL)`
      )
      .all(ws.id, ws.id) as unknown as Array<{ id: string; name: string }>;
    const sessions = db
      .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE workspace_id = ? AND status = 'active'`)
      .get(ws.id) as { c: number };
    const procs = db
      .prepare(`SELECT COUNT(*) AS c FROM processes WHERE workspace_id = ? AND status = 'running'`)
      .get(ws.id) as { c: number };
    const mem = db.prepare(`SELECT COUNT(*) AS c FROM memory_entries WHERE workspace_id = ?`).get(ws.id) as { c: number };
    return { ws, plan, tasks, events, agents, sessions: sessions.c, processes: procs.c, memory: mem.c };
  } finally {
    db.close();
  }
}

const ago = (iso: string): string => {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};
const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return "█".repeat(filled) + C.dim + "░".repeat(Math.max(0, width - filled)) + C.reset;
}

function render(slug: string): string {
  const st = loadState(slug);
  const cols = Math.max(80, process.stdout.columns ?? 100);
  const rows = Math.max(20, process.stdout.rows ?? 30);
  const out: string[] = [];

  if (!st) {
    return `${C.red}workspace not found: ${slug}${C.reset}\n`;
  }

  const done = st.tasks.filter((t) => t.status === "done").length;
  const active = st.tasks.filter((t) => t.status === "in_progress").length;
  const width = cols - 4;

  out.push(
    `${C.bg}${C.bold}${C.cyan} UNIV-MCP ${C.reset}${C.bg}${C.white} ${st.ws.name} ${C.reset}` +
      `${C.dim} slug=${st.ws.slug} plan=${st.plan?.title ?? "-"} ${C.reset}`
  );
  out.push(`${C.dim}${"─".repeat(width)}${C.reset}`);
  const progress = bar(done, st.tasks.length, Math.min(30, width - 34));
  out.push(
    `${C.bold}TASKS${C.reset} ${progress} ${C.green}${done}${C.reset}/${st.tasks.length} done` +
      (active ? `  ${C.yellow}${active} in progress${C.reset}` : "") +
      `   ${C.dim}agents=${st.agents.length} sessions=${st.sessions} procs=${st.processes} memories=${st.memory}${C.reset}`
  );
  out.push(`${C.dim}${"─".repeat(width)}${C.reset}`);

  // task board
  const glyph = (s: string) => (s === "done" ? `${C.green}✓${C.reset}` : s === "in_progress" ? `${C.yellow}~${C.reset}` : s === "blocked" ? `${C.red}!${C.reset}` : `${C.gray}·${C.reset}`);
  const titleW = Math.min(52, width - 26);
  for (const t of st.tasks) {
    const who = t.assignee_name ? (AGENT_COLORS[t.assignee_name] ?? C.magenta) + t.assignee_name.padEnd(11) + C.reset : C.dim + "—".padEnd(11) + C.reset;
    const title = t.title.length > titleW ? t.title.slice(0, titleW - 1) + "…" : t.title;
    out.push(` ${glyph(t.status)} ${title.padEnd(titleW)} ${who} ${C.dim}${ago(t.updated_at).padStart(4)}${C.reset}`);
  }

  out.push(`${C.dim}${"─".repeat(width)}${C.reset}`);

  // activity feed
  out.push(`${C.bold}ACTIVITY${C.reset} ${C.dim}(live audit feed — who wrote what, when)${C.reset}`);
  const feedRows = Math.max(4, rows - out.length - 3);
  const nameById = new Map(st.agents.map((a) => [a.id, a.name]));
  for (const e of st.events.slice(0, feedRows)) {
    const agentName = (e.agent_id ? nameById.get(e.agent_id) : undefined) ?? "—";
    const color = AGENT_COLORS[agentName] ?? C.gray;
    const target = (e.target ?? "").slice(0, 48);
    out.push(
      ` ${C.dim}${hhmm(e.created_at)}${C.reset} ${color}${agentName.padEnd(11)}${C.reset} ${C.yellow}${e.action.padEnd(16)}${C.reset} ${C.white}${target}${C.reset}`
    );
  }

  out.push(`${C.dim}${"─".repeat(width)}${C.reset}`);
  out.push(
    `${C.dim} q quit · r refresh · p pause   ${C.magenta}universal-workspace-mcp${C.reset} ${C.dim}v0.1.0 · MCP Streamable HTTP · ${new Date().toLocaleTimeString("en-GB", { hour12: false })}${C.reset}`
  );
  return out.join("\n");
}

const slug = process.argv[2] ?? "aurora-showcase";

if (process.env.SMOKE === "1" || !process.stdout.isTTY) {
  console.log(render(slug));
  process.exit(0);
}

let paused = false;
let frame = 0;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  if (key === "q" || key === "\x03") {
    process.stdout.write("\x1b[?25h");
    process.exit(0);
  }
  if (key === "p") paused = !paused;
  if (key === "r") draw();
});

function draw(): void {
  if (paused) {
    process.stdout.write(`\x1b[?25l\x1b[H\x1b[2J${C.dim}— paused (p to resume) —${C.reset}`);
    return;
  }
  const spin = SPINNER[frame % SPINNER.length]!;
  process.stdout.write(`\x1b[?25l\x1b[H\x1b[2J${render(slug)}\n${C.dim}live${C.reset} ${spin}`);
  frame++;
}

draw();
const timer = setInterval(draw, 1000);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write("\x1b[?25h");
  process.exit(0);
});
