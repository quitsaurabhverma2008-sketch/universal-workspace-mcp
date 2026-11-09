import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "../database/db.js";
import type { AppConfig } from "../config/env.js";
import type { WorkspaceRow } from "../types.js";
import { seedWorkspaceDirs, seedWorkspaceFiles } from "./memory.js";
import { AppError, Err } from "../utils/errors.js";
import { writeEvent } from "./events.js";

const execFileAsync = promisify(execFile);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `workspace-${randomUUID().slice(0, 8)}`;
}

export function getWorkspaceBySlug(db: Db, slug: string): WorkspaceRow | null {
  return (db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(slug) as WorkspaceRow | undefined) ?? null;
}

export async function createWorkspace(
  services: { db: Db; config: AppConfig },
  principal: { userId: string; agentId: string | null },
  sessionId: string,
  args: { name: string; slug?: string | undefined; description?: string | undefined; gitEnabled?: boolean | undefined; type?: "shared" | "private" | undefined }
): Promise<WorkspaceRow> {
  const { db, config } = services;
  let slug = args.slug ?? slugify(args.name);
  if (!SLUG_RE.test(slug)) throw Err.validation(`invalid slug "${slug}"; must match ${SLUG_RE.source}`);

  // Ensure uniqueness
  let attempt = slug;
  let suffix = 1;
  while (getWorkspaceBySlug(db, attempt)) {
    attempt = `${slug}-${suffix++}`;
  }
  slug = attempt;

  const root = path.join(config.workspacesDir, slug);
  await seedWorkspaceDirs(config.workspacesDir, slug);
  await seedWorkspaceFiles(root, config.tmpDir);

  const gitEnabled = args.gitEnabled ?? config.gitEnabledDefault;
  if (gitEnabled) {
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: root });
      // Local, overridable identity so the agent's commits have an author.
      const localName = (await execFileAsync("git", ["config", "user.name"], { cwd: root }).catch(() => null))?.stdout?.trim();
      if (!localName) {
        await execFileAsync("git", ["config", "user.name", "universal-workspace-mcp"], { cwd: root }).catch(() => undefined);
        await execFileAsync("git", ["config", "user.email", "mcp@localhost"], { cwd: root }).catch(() => undefined);
      }
    } catch {
      // git unavailable — workspace works fine without it; record and continue
      await writeEvent(db, { workspaceId: null, agentId: principal.agentId, sessionId, action: "workspace.git_init_failed", target: slug });
    }
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, description, type, owner_id, root_path, git_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    slug,
    args.name.slice(0, 80),
    args.description?.slice(0, 500) ?? null,
    args.type ?? "shared",
    principal.userId,
    root,
    gitEnabled ? 1 : 0
  );
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`).run(id, principal.userId);

  writeEvent(db, {
    workspaceId: id,
    agentId: principal.agentId,
    sessionId,
    action: "workspace.created",
    target: slug,
    detail: { name: args.name, git_enabled: gitEnabled, type: args.type ?? "shared" },
  });

  return getWorkspaceBySlug(db, slug)!;
}

export function listWorkspaces(db: Db, principal: { userId: string }, includeArchived = false): WorkspaceRow[] {
  const rows = db
    .prepare(
      `SELECT w.* FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
       WHERE (w.owner_id = ? OR m.user_id IS NOT NULL)
         ${includeArchived ? "" : "AND w.archived_at IS NULL"}
       ORDER BY w.updated_at DESC`
    )
    .all(principal.userId, principal.userId) as unknown as WorkspaceRow[];
  return rows;
}

export async function workspaceStats(db: Db, workspace: WorkspaceRow): Promise<{
  fileBytes: number;
  fileCount: number;
  memoryEntries: number;
  openTasks: number;
  doneTasks: number;
  plans: number;
  gitStatus: string | null;
}> {
  const walk = async (): Promise<{ bytes: number; count: number }> => {
    let bytes = 0;
    let count = 0;
    const SKIP = new Set([".git", "node_modules"]);
    async function walkDir(dir: string, depth: number): Promise<void> {
      if (depth > 12 || count > 50_000) return;
      const children = await fs.readdir(dir, { withFileTypes: true });
      for (const child of children) {
        if (SKIP.has(child.name)) continue;
        const childAbs = path.join(dir, child.name);
        if (child.isDirectory()) await walkDir(childAbs, depth + 1);
        else if (child.isFile()) {
          count += 1;
          try {
            bytes += (await fs.stat(childAbs)).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
    try {
      await walkDir(workspace.root_path, 0);
    } catch {
      return { bytes, count };
    }
    return { bytes, count };
  };

  const [{ bytes, count }] = await Promise.all([walk()]);

  const mem = db.prepare(`SELECT COUNT(*) AS c FROM memory_entries WHERE workspace_id = ?`).get(workspace.id) as { c: number };
  const openTasks = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status NOT IN ('done','cancelled')`).get(workspace.id) as { c: number };
  const doneTasks = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status = 'done'`).get(workspace.id) as { c: number };
  const plans = db.prepare(`SELECT COUNT(*) AS c FROM plans WHERE workspace_id = ?`).get(workspace.id) as { c: number };

  let gitStatus: string | null = null;
  if (workspace.git_enabled) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace.root_path, timeout: 5000 });
      const changed = stdout.split("\n").filter(Boolean).length;
      gitStatus = changed === 0 ? "clean" : `${changed} changed file(s)`;
    } catch {
      gitStatus = null;
    }
  }

  return { fileBytes: bytes, fileCount: count, memoryEntries: mem.c, openTasks: openTasks.c, doneTasks: doneTasks.c, plans: plans.c, gitStatus };
}

/** Soft delete: archive + move root under backups/deleted-<slug>-<ts>. DB rows (audit) are kept. */
export async function deleteWorkspace(
  services: { db: Db; config: AppConfig },
  principal: { userId: string; agentId: string | null },
  sessionId: string,
  args: { slug: string; confirmSlug: string }
): Promise<{ slug: string; archived: true; movedTo: string }> {
  const { db, config } = services;
  if (args.slug !== args.confirmSlug) {
    throw Err.validation(`confirm_slug must match the slug exactly ("${args.slug}")`);
  }
  const ws = getWorkspaceBySlug(db, args.slug);
  if (!ws) throw Err.workspaceNotFound(args.slug);
  if (ws.archived_at) return { slug: ws.slug, archived: true, movedTo: "already archived" };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const movedTo = path.join(config.backupsDir, `deleted-${ws.slug}-${stamp}`);
  await fs.mkdir(config.backupsDir, { recursive: true });
  try {
    if (existsSync(ws.root_path)) await fs.rename(ws.root_path, movedTo);
  } catch (error) {
    throw new AppError("INTERNAL", `failed to move workspace root: ${(error as Error).message}`);
  }

  db.prepare(`UPDATE workspaces SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(ws.id);
  db.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?`).run(ws.id);

  writeEvent(db, {
    workspaceId: ws.id,
    agentId: principal.agentId,
    sessionId,
    action: "workspace.deleted",
    target: ws.slug,
    detail: { movedTo },
  });
  return { slug: ws.slug, archived: true, movedTo };
}
