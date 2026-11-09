import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "../database/db.js";
import type { AppConfig } from "../config/env.js";
import { Err } from "../utils/errors.js";
import { safeResolve, toPosixRelative } from "../utils/paths.js";

const execFileAsync = promisify(execFile);

/**
 * Output manager: register, list, read and export artifacts produced in the
 * workspace. Artifacts live under outputs/ so they stay with the project.
 */

export interface ArtifactRow {
  id: string;
  workspace_id: string;
  path: string;
  kind: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
}

const ARTIFACT_KINDS = new Set(["report", "log", "build", "export", "snapshot", "other"]);

export async function saveArtifact(
  db: Db,
  workspace: { id: string; root_path: string },
  agentId: string | null,
  args: { sourcePath: string; kind?: string | undefined; description?: string | undefined; move?: boolean | undefined }
): Promise<ArtifactRow> {
  const kind = args.kind ?? "other";
  if (!ARTIFACT_KINDS.has(kind)) throw Err.validation(`invalid kind: ${kind}`);

  const sourceAbs = safeResolve(workspace.root_path, args.sourcePath);
  if (!existsSync(sourceAbs)) throw Err.notFound(`source not found: ${args.sourcePath}`);

  // Determine final outputs/-relative location
  const initialRel = toPosixRelative(workspace.root_path, sourceAbs);
  let finalRel = initialRel;
  const inOutputs = initialRel === "outputs" || initialRel.startsWith("outputs/");

  if (!inOutputs) {
    const base = path.basename(sourceAbs);
    finalRel = `outputs/${base}`;
    let target = path.join(workspace.root_path, finalRel);
    let counter = 1;
    while (existsSync(target)) {
      const parsed = path.parse(base);
      finalRel = `outputs/${parsed.name}-${counter}${parsed.ext}`;
      target = path.join(workspace.root_path, finalRel);
      counter += 1;
    }
    if (args.move) {
      await fs.rename(sourceAbs, target);
    } else {
      await fs.copyFile(sourceAbs, target);
    }
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO artifacts (id, workspace_id, path, kind, description, created_by) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    workspace.id,
    finalRel,
    kind,
    args.description?.slice(0, 500) ?? null,
    agentId
  );
  return db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as unknown as ArtifactRow;
}

export function listArtifacts(
  db: Db,
  workspaceId: string,
  opts: { kind?: string | undefined; limit?: number | undefined } = {}
): ArtifactRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  if (opts.kind) {
    return db
      .prepare(`SELECT * FROM artifacts WHERE workspace_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?`)
      .all(workspaceId, opts.kind, limit) as unknown as ArtifactRow[];
  }
  return db
    .prepare(`SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(workspaceId, limit) as unknown as ArtifactRow[];
}

export async function readArtifact(
  db: Db,
  config: AppConfig,
  workspace: { id: string; root_path: string },
  artifactId: string
): Promise<{ artifact: ArtifactRow; content?: string; binary?: boolean; bytes: number }> {
  const artifact = db.prepare(`SELECT * FROM artifacts WHERE workspace_id = ? AND id = ?`).get(workspace.id, artifactId) as
    | ArtifactRow
    | undefined;
  if (!artifact) throw Err.notFound(`artifact not found: ${artifactId}`);

  const abs = safeResolve(workspace.root_path, artifact.path);
  if (!existsSync(abs)) throw Err.notFound(`artifact file missing on disk: ${artifact.path}`);
  const bytes = statSync(abs).size;
  if (bytes > config.maxFileBytes) {
    return { artifact, binary: true, bytes };
  }
  const buffer = await fs.readFile(abs);
  if (buffer.includes(0)) return { artifact, binary: true, bytes };
  return { artifact, content: buffer.toString("utf8"), bytes };
}

export async function exportArtifacts(
  db: Db,
  workspace: { id: string; root_path: string },
  agentId: string | null,
  args: { paths: string[] }
): Promise<ArtifactRow> {
  if (!Array.isArray(args.paths) || args.paths.length === 0) throw Err.validation("paths must be a non-empty array");
  if (args.paths.length > 100) throw Err.validation("at most 100 paths per export");

  // Resolve and verify every path; collect root-relative posix names for tar
  const resolved: string[] = [];
  for (const p of args.paths) {
    const abs = safeResolve(workspace.root_path, p);
    if (!existsSync(abs)) throw Err.notFound(`path not found: ${p}`);
    resolved.push(toPosixRelative(workspace.root_path, abs));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportRel = `outputs/export-${stamp}.tar.gz`;
  const exportAbs = path.join(workspace.root_path, exportRel);
  await fs.mkdir(path.dirname(exportAbs), { recursive: true });

  try {
    await execFileAsync("tar", ["-czf", exportAbs, "-C", workspace.root_path, ...resolved], { timeout: 60_000 });
  } catch (error) {
    throw Err.internal(`tar failed: ${(error as Error).message}`);
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO artifacts (id, workspace_id, path, kind, description, created_by) VALUES (?, ?, ?, 'export', ?, ?)`).run(
    id,
    workspace.id,
    exportRel,
    `export of ${resolved.length} path(s)`,
    agentId
  );
  return db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as unknown as ArtifactRow;
}
