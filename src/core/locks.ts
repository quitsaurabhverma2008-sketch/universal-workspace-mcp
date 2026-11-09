import { randomUUID } from "node:crypto";
import type { Db } from "../database/db.js";
import { Err } from "../utils/errors.js";
import { safeResolve, toPosixRelative } from "../utils/paths.js";

/**
 * Short-lived per-path locks for multi-agent coordination.
 * TTL-based, lazily reaped. A path lock is advisory at the API layer but
 * HARD-enforced on file_write/file_edit/file_delete/file_move: a foreign
 * live lock blocks the write even if your hash is fresh.
 */

export interface LockRow {
  id: string;
  workspace_id: string;
  path: string;
  agent_id: string | null;
  session_id: string | null;
  acquired_at: string;
  expires_at: string;
}

export function acquireLock(
  db: Db,
  workspaceId: string,
  sessionRowId: string,
  principal: { agentId: string | null },
  root: string,
  userPath: string,
  ttlSeconds: number
): LockRow {
  const ttl = Math.min(Math.max(Math.trunc(ttlSeconds), 30), 3600);
  const abs = safeResolve(root, userPath); // forces jail validation
  const rel = toPosixRelative(root, abs);
  if (rel === ".") throw Err.validation("cannot lock the workspace root");

  reapExpiredLocks(db, workspaceId);

  const existing = db
    .prepare(`SELECT * FROM file_locks WHERE workspace_id = ? AND path = ?`)
    .get(workspaceId, rel) as LockRow | undefined;
  if (existing) {
    if (existing.session_id === sessionRowId) {
      // Re-entrant: extend TTL
      db.prepare(`UPDATE file_locks SET expires_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`).run(ttl, existing.id);
      return db.prepare(`SELECT * FROM file_locks WHERE id = ?`).get(existing.id) as unknown as LockRow;
    }
    throw Err.locked(existing.agent_id ?? "unknown agent", existing.expires_at);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO file_locks (id, workspace_id, path, agent_id, session_id, expires_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || ? || ' seconds'))`
  ).run(id, workspaceId, rel, principal.agentId, sessionRowId, ttl);
  return db.prepare(`SELECT * FROM file_locks WHERE id = ?`).get(id) as unknown as LockRow;
}

export function releaseLock(
  db: Db,
  workspaceId: string,
  sessionRowId: string,
  args: { path?: string | undefined; lockId?: string | undefined }
): { released: number } {
  if (args.lockId) {
    const result = db.prepare(`DELETE FROM file_locks WHERE workspace_id = ? AND id = ? AND (session_id = ? OR session_id IS NULL)`).run(
      workspaceId,
      args.lockId,
      sessionRowId
    );
    return { released: Number(result.changes) };
  }
  if (args.path) {
    const normalized = args.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
    const result = db.prepare(`DELETE FROM file_locks WHERE workspace_id = ? AND path = ? AND (session_id = ? OR session_id IS NULL)`).run(
      workspaceId,
      normalized,
      sessionRowId
    );
    return { released: Number(result.changes) };
  }
  const result = db.prepare(`DELETE FROM file_locks WHERE workspace_id = ? AND session_id = ?`).run(workspaceId, sessionRowId);
  return { released: Number(result.changes) };
}

export function listLocks(db: Db, workspaceId: string): LockRow[] {
  reapExpiredLocks(db, workspaceId);
  return db.prepare(`SELECT * FROM file_locks WHERE workspace_id = ? ORDER BY path`).all(workspaceId) as unknown as LockRow[];
}

export function reapExpiredLocks(db: Db, workspaceId?: string): number {
  const now = new Date().toISOString();
  const result = workspaceId
    ? db.prepare(`DELETE FROM file_locks WHERE workspace_id = ? AND expires_at < ?`).run(workspaceId, now)
    : db.prepare(`DELETE FROM file_locks WHERE expires_at < ?`).run(now);
  return Number(result.changes);
}

/**
 * Guard called before mutating a file: if a live lock on (workspace, path)
 * is held by a DIFFERENT session, throw LOCKED. Same-session locks pass.
 */
export function assertNoForeignLock(db: Db, workspaceId: string, sessionRowId: string, root: string, userPath: string): void {
  let rel: string;
  try {
    rel = toPosixRelative(root, safeResolve(root, userPath));
  } catch {
    return; // path validation happens in the actual operation
  }
  reapExpiredLocks(db, workspaceId);
  const existing = db.prepare(`SELECT * FROM file_locks WHERE workspace_id = ? AND path = ?`).get(workspaceId, rel) as LockRow | undefined;
  if (existing && existing.session_id !== sessionRowId) {
    throw Err.locked(existing.agent_id ?? "unknown agent", existing.expires_at);
  }
}
