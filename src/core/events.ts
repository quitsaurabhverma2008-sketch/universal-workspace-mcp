import type { Db } from "../database/db.js";
import { redactDetail } from "../security/redact.js";
import { logger } from "../utils/logger.js";

export interface EventInput {
  workspaceId?: string | null | undefined;
  agentId?: string | null | undefined;
  sessionId?: string | null | undefined;
  action: string;
  target?: string | null | undefined;
  detail?: unknown;
}

/** Append an audit event. Failures are logged but never thrown into the tool path. */
export function writeEvent(db: Db, event: EventInput): void {
  try {
    db.prepare(
      `INSERT INTO events (workspace_id, agent_id, session_id, action, target, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      event.workspaceId ?? null,
      event.agentId ?? null,
      event.sessionId ?? null,
      event.action,
      event.target ?? null,
      JSON.stringify(redactDetail(event.detail ?? {}))
    );
  } catch (error) {
    logger.error({ err: error, action: event.action }, "failed to write audit event");
  }
}

/** Fetch recent events for a workspace, newest first. */
export function recentEvents(db: Db, workspaceId: string, limit = 50) {
  return db
    .prepare(
      `SELECT id, agent_id, session_id, action, target, detail, created_at
       FROM events WHERE workspace_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(workspaceId, limit) as Array<{
    id: number;
    agent_id: string | null;
    session_id: string | null;
    action: string;
    target: string | null;
    detail: string;
    created_at: string;
  }>;
}
