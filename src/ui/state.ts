import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Principal } from "../types.js";
import { resolveWorkspace } from "../security/authorize.js";

/**
 * Live state payload for the web UI (3D scene + side panel).
 * Read-only view over the same SQLite state the MCP tools write.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface UiTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  assignee_id: string | null;
  assignee_name: string | null;
  updated_at: string;
  completed_at: string | null;
}

export interface UiAgent {
  id: string;
  name: string;
  color: string;
  files_written: number;
  tasks_claimed: number;
  tasks_done: number;
  last_action: string | null;
  last_target: string | null;
  last_seen: string | null;
  intent: string;
  active: boolean;
}

export interface UiEvent {
  id: number;
  agent_id: string | null;
  agent_name: string | null;
  action: string;
  target: string | null;
  detail: string;
  created_at: string;
}

export interface UiState {
  server: { name: string; version: string; started_at: string; uptime_s: number };
  workspace: { slug: string; name: string; description: string | null; root_path: string };
  plan: { id: string; title: string; status: string; summary: string | null } | null;
  tasks: UiTask[];
  agents: UiAgent[];
  events: UiEvent[];
  stats: { tasks_total: number; tasks_done: number; tasks_active: number; events_total: number; files_written: number; memories: number; processes_running: number; sessions_active: number };
  generated_at: string;
}

const AGENT_COLORS = ["#72e6a0", "#5ad7e8", "#ffb86b", "#c792ea", "#9ece6a", "#f7768e"];
const db = new DatabaseSync(path.join(ROOT, "data/database.sqlite"), { readOnly: true });

/** Human-readable intent for an agent, derived from its last tool activity. */
function intentFor(action: string | null, target: string | null): string {
  if (!action) return "idle — waiting for work";
  switch (action) {
    case "task.updated": return `claiming task ${(target ?? "").slice(0, 8)}`;
    case "task.created": return "adding a task to the plan";
    case "task.completed": return `completed task ${(target ?? "").slice(0, 8)}`;
    case "file.write": return `writing ${target ?? "a file"}`;
    case "file.edit": return `editing ${target ?? "a file"}`;
    case "file.read": return `reading ${target ?? "a file"}`;
    case "file.list": return "scanning the project tree";
    case "file.search": return "searching the codebase";
    case "lock.acquire": return `locking ${target ?? "a file"}`;
    case "lock.release": return `releasing ${target ?? "a file"}`;
    case "exec.executed": return `running a command (${(target ?? "").slice(0, 8)})`;
    case "exec.denied": return "command blocked by policy";
    case "brain.update": return `updating Brain.md → ${target ?? ""}`;
    case "memory.add": return "writing a memory entry";
    case "decision_record": return "recording a decision";
    case "workspace.opened": return "opening the workspace";
    case "workspace.created": return "creating the workspace";
    case "agent.registered": return "registering as an agent";
    case "session.created": return "starting a work session";
    default: return `${action.replace(/[._]/g, " ")}${target ? ` → ${target.slice(0, 28)}` : ""}`;
  }
}

export function buildUiState(db_: DatabaseSync, principal: Principal, slug: string, serverInfo: UiState["server"]): UiState {
  const ws = db_
    .prepare(`SELECT * FROM workspaces WHERE slug = ?`)
    .get(slug) as { id: string; slug: string; name: string; description: string | null; root_path: string } | undefined;
  if (!ws) throw new Error("workspace not found");

  // authorize: caller must be a member (same rule as the tools)
  resolveWorkspace(db_, principal, { slug });

  const plan = db_
    .prepare(`SELECT * FROM plans WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(ws.id) as { id: string; title: string; status: string; summary: string | null } | undefined;

  const tasks = db_
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.assignee_agent AS assignee_id,
              a.name AS assignee_name, t.updated_at, t.completed_at
       FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent
       WHERE t.workspace_id = ? ORDER BY t.priority ASC`
    )
    .all(ws.id) as unknown as UiTask[];

  const agentRows = db_
    .prepare(`SELECT DISTINCT id, name FROM agents`)
    .all() as unknown as Array<{ id: string; name: string }>;

  const events = db_
    .prepare(
      `SELECT id, agent_id, action, target, detail, created_at FROM events
       WHERE workspace_id = ? ORDER BY id DESC LIMIT 80`
    )
    .all(ws.id) as unknown as UiEvent[];
  const nameById = new Map(agentRows.map((a) => [a.id, a.name]));
  for (const e of events) e.agent_name = e.agent_id ? (nameById.get(e.agent_id) ?? null) : null;

  // per-agent aggregates
  const agents: UiAgent[] = [];
  const allEvents = db_
    .prepare(`SELECT id, agent_id, action, target, created_at FROM events WHERE workspace_id = ? ORDER BY id DESC`)
    .all(ws.id) as unknown as Array<{ id: number; agent_id: string | null; action: string; target: string | null; created_at: string }>;

  for (const [i, a] of agentRows.entries()) {
    const own = allEvents.filter((e) => e.agent_id === a.id);
    if (own.length === 0) continue;
    const last = own[0]!;
    const files = own.filter((e) => e.action === "file.write" || e.action === "file.edit").length;
    const claimed = own.filter((e) => e.action === "task.updated").length;
    const done = own.filter((e) => e.action === "task.completed").length;
    const lastSeenMs = Date.parse(last.created_at);
    agents.push({
      id: a.id,
      name: a.name,
      color: AGENT_COLORS[i % AGENT_COLORS.length]!,
      files_written: files,
      tasks_claimed: claimed,
      tasks_done: done,
      last_action: last.action,
      last_target: last.target,
      last_seen: last.created_at,
      intent: intentFor(last.action, last.target),
      active: Date.now() - lastSeenMs < 120_000,
    });
  }

  const cnt = (sql: string) => (db_.prepare(sql).get(ws.id) as { c: number }).c;
  const stats = {
    tasks_total: tasks.length,
    tasks_done: tasks.filter((t) => t.status === "done").length,
    tasks_active: tasks.filter((t) => t.status === "in_progress").length,
    events_total: cnt(`SELECT COUNT(*) AS c FROM events WHERE workspace_id = ?`),
    files_written: cnt(`SELECT COUNT(*) AS c FROM events WHERE workspace_id = ? AND action IN ('file.write','file.edit')`),
    memories: cnt(`SELECT COUNT(*) AS c FROM memory_entries WHERE workspace_id = ?`),
    processes_running: cnt(`SELECT COUNT(*) AS c FROM processes WHERE workspace_id = ? AND status = 'running'`),
    sessions_active: cnt(`SELECT COUNT(*) AS c FROM sessions WHERE workspace_id = ? AND status = 'active'`),
  };

  return {
    server: serverInfo,
    workspace: { slug: ws.slug, name: ws.name, description: ws.description, root_path: ws.root_path },
    plan: plan ?? null,
    tasks,
    agents,
    events,
    stats,
    generated_at: new Date().toISOString(),
  };
}

export function listUiWorkspaces(db_: DatabaseSync, principal: Principal): Array<{ slug: string; name: string }> {
  const rows = db_
    .prepare(
      `SELECT w.slug, w.name FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
       WHERE (w.owner_id = ? OR m.user_id IS NOT NULL) AND w.archived_at IS NULL
       ORDER BY w.updated_at DESC`
    )
    .all(principal.userId, principal.userId) as unknown as Array<{ slug: string; name: string }>;
  return rows;
}

export { db as uiDb };
