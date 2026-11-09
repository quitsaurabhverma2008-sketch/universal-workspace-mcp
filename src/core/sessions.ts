import { randomUUID } from "node:crypto";
import type { Db } from "../database/db.js";
import { Err } from "../utils/errors.js";
import type { Principal } from "../types.js";

/**
 * Session and agent registry.
 *
 * Two levels of "session":
 *   - transport session  (sessions table row, one per MCP connection)
 *   - logical session    (optional human label, e.g. "implement auth"; via session_create)
 */

export function upsertAgent(db: Db, userId: string, args: { name: string; kind?: string | undefined }) {
  const existing = db
    .prepare(`SELECT * FROM agents WHERE user_id = ? AND name = ?`)
    .get(userId, args.name) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  db.prepare(`INSERT INTO agents (id, user_id, name, kind) VALUES (?, ?, ?, ?)`).run(id, userId, args.name, args.kind ?? "agent");
  return { id, created: true };
}

export function listAgents(db: Db, workspaceId?: string) {
  if (!workspaceId) {
    return db.prepare(`SELECT id, user_id, name, kind, created_at FROM agents ORDER BY name`).all();
  }
  return db
    .prepare(
      `SELECT DISTINCT a.id, a.user_id, a.name, a.kind, a.created_at
       FROM agents a
       WHERE a.id IN (SELECT DISTINCT agent_id FROM events WHERE workspace_id = ? AND agent_id IS NOT NULL)
          OR a.id IN (SELECT DISTINCT agent_id FROM sessions WHERE workspace_id = ? AND agent_id IS NOT NULL)
       ORDER BY a.name`
    )
    .all(workspaceId, workspaceId);
}

export function createLogicalSession(db: Db, sessionRowId: string, workspaceId: string, label: string) {
  db.prepare(`UPDATE sessions SET logical_label = ?, workspace_id = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
    label.slice(0, 120),
    workspaceId,
    sessionRowId
  );
  return getSession(db, sessionRowId)!;
}

export function bindSessionWorkspace(db: Db, sessionRowId: string, workspaceId: string): void {
  db.prepare(`UPDATE sessions SET workspace_id = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
    workspaceId,
    sessionRowId
  );
}

export function touchSession(db: Db, sessionRowId: string): void {
  db.prepare(`UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(sessionRowId);
}

export function getSession(db: Db, sessionRowId: string) {
  return (
    (db
      .prepare(
        `SELECT s.*, a.name AS agent_name, w.slug AS workspace_slug
         FROM sessions s
         LEFT JOIN agents a ON a.id = s.agent_id
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.id = ?`
      )
      .get(sessionRowId) as
      | Record<string, unknown>
      | undefined) ?? null
  );
}

export function listSessions(db: Db, workspaceId: string, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.status) {
    return db
      .prepare(
        `SELECT s.*, a.name AS agent_name FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id
         WHERE s.workspace_id = ? AND s.status = ? ORDER BY s.last_seen_at DESC LIMIT ?`
      )
      .all(workspaceId, opts.status, limit);
  }
  return db
    .prepare(
      `SELECT s.*, a.name AS agent_name FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id
       WHERE s.workspace_id = ? ORDER BY s.last_seen_at DESC LIMIT ?`
    )
    .all(workspaceId, limit);
}

export function sessionEventCounts(db: Db, sessionRowId: string) {
  const filesTouched = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND action LIKE 'file.%'`)
    .get(sessionRowId) as { c: number };
  const tasksCompleted = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND action = 'task.completed'`)
    .get(sessionRowId) as { c: number };
  const commandsRun = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND action = 'exec.executed'`)
    .get(sessionRowId) as { c: number };
  return { filesTouched: filesTouched.c, tasksCompleted: tasksCompleted.c, commandsRun: commandsRun.c };
}

export function sessionHistory(
  db: Db,
  workspaceId: string,
  opts: { sessionId?: string | undefined; since?: string | undefined; limit?: number | undefined }
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const params: unknown[] = [workspaceId];
  let sql = `SELECT id, agent_id, session_id, action, target, detail, created_at FROM events WHERE workspace_id = ?`;
  if (opts.sessionId) {
    sql += ` AND session_id = ?`;
    params.push(opts.sessionId);
  }
  if (opts.since) {
    sql += ` AND created_at >= ?`;
    params.push(opts.since);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...(params as never[]));
}
