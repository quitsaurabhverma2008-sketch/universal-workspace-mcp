import { randomUUID } from "node:crypto";
import type { Db } from "../database/db.js";
import { atomicWriteFile, safeResolve } from "../utils/paths.js";
import { AppError, Err } from "../utils/errors.js";

/**
 * Planning engine: plans + tasks (with subtasks), persisted in SQLite.
 * PLAN.md at the workspace root is re-rendered atomically on every mutation
 * so humans always have a readable snapshot on disk.
 */

export type PlanStatus = "draft" | "active" | "completed" | "archived";
export type TaskStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

export interface PlanRow {
  id: string;
  workspace_id: string;
  title: string;
  summary: string | null;
  status: PlanStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  plan_id: string;
  workspace_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  position: number;
  assignee_agent: string | null;
  assignee_name?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Tool boundary convenience: assignee may be supplied as an agent id OR an
 * agent name (names suffice for humans and agents). Resolves to the internal id.
 * Unknown names are rejected — never silently drop the assignment.
 */
export function resolveAgentId(db: Db, nameOrId: string | null | undefined): string | null | undefined {
  if (nameOrId === undefined || nameOrId === null) return nameOrId;
  const byId = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(nameOrId) as { id: string } | undefined;
  if (byId) return byId.id;
  const byName = db.prepare(`SELECT id FROM agents WHERE name = ? ORDER BY created_at ASC LIMIT 1`).get(nameOrId) as { id: string } | undefined;
  if (!byName) throw Err.validation(`unknown assignee_agent: "${nameOrId}" (pass an agent name or id; register with agent_register first)`);
  return byName.id;
}

export function createPlan(
  db: Db,
  workspaceId: string,
  agentId: string | null,
  args: { title: string; summary?: string | undefined }
): PlanRow {
  const id = randomUUID();
  db.prepare(`INSERT INTO plans (id, workspace_id, title, summary, status, created_by) VALUES (?, ?, ?, ?, 'active', ?)`).run(
    id,
    workspaceId,
    args.title,
    args.summary ?? null,
    agentId
  );
  return getPlan(db, workspaceId, id)!;
}

export function getPlan(db: Db, workspaceId: string, planId?: string): PlanRow | null {
  if (planId) {
    return (db.prepare(`SELECT * FROM plans WHERE workspace_id = ? AND id = ?`).get(workspaceId, planId) as PlanRow | undefined) ?? null;
  }
  return (
    (db.prepare(`SELECT * FROM plans WHERE workspace_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`).get(
      workspaceId
    ) as PlanRow | undefined) ?? null
  );
}

export function updatePlan(
  db: Db,
  workspaceId: string,
  planId: string,
  args: { title?: string | undefined; summary?: string | undefined; status?: PlanStatus | undefined }
): PlanRow {
  const existing = getPlan(db, workspaceId, planId);
  if (!existing) throw Err.notFound(`plan not found: ${planId}`);
  db.prepare(
    `UPDATE plans SET title = ?, summary = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(args.title ?? existing.title, args.summary ?? existing.summary, args.status ?? existing.status, planId);
  return getPlan(db, workspaceId, planId)!;
}

export function listPlans(
  db: Db,
  workspaceId: string,
  opts: { status?: PlanStatus | undefined } = {}
): Array<PlanRow & { task_total: number; task_done: number }> {
  const params: unknown[] = [workspaceId];
  let where = `p.workspace_id = ?`;
  if (opts.status) {
    where += ` AND p.status = ?`;
    params.push(opts.status);
  }
  return db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id) AS task_total,
              (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id AND t.status = 'done') AS task_done
       FROM plans p WHERE ${where}
       ORDER BY p.status = 'active' DESC, p.updated_at DESC`
    )
    .all(...(params as never[])) as unknown as Array<PlanRow & { task_total: number; task_done: number }>;
}

export function createTask(
  db: Db,
  workspaceId: string,
  agentId: string | null,
  args: {
    planId?: string | undefined;
    title: string;
    description?: string | undefined;
    parentTaskId?: string | undefined;
    priority?: number | undefined;
    assigneeAgent?: string | undefined;
  }
): TaskRow {
  const plan = args.planId ? getPlan(db, workspaceId, args.planId) : getPlan(db, workspaceId);
  if (!plan) throw Err.notFound(args.planId ? `plan not found: ${args.planId}` : "no active plan in this workspace; create one with plan_create");
  if (args.parentTaskId) {
    const parent = getTask(db, workspaceId, args.parentTaskId);
    if (!parent) throw Err.notFound(`parent task not found: ${args.parentTaskId}`);
  }
  const id = randomUUID();
  const position =
    (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE plan_id = ?`).get(plan.id) as { p: number }).p ?? 0;
  db.prepare(
    `INSERT INTO tasks (id, plan_id, workspace_id, parent_task_id, title, description, priority, position, assignee_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    plan.id,
    workspaceId,
    args.parentTaskId ?? null,
    args.title,
    args.description ?? null,
    Math.min(Math.max(args.priority ?? 3, 1), 5),
    position,
    resolveAgentId(db, args.assigneeAgent) ?? null
  );
  db.prepare(`UPDATE plans SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(plan.id);
  void agentId;
  return getTask(db, workspaceId, id)!;
}

export function getTask(db: Db, workspaceId: string, taskId: string): TaskRow | null {
  return (
    (db
      .prepare(
        `SELECT t.*, a.name AS assignee_name FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent
         WHERE t.workspace_id = ? AND t.id = ?`
      )
      .get(workspaceId, taskId) as TaskRow | undefined) ?? null
  );
}

export function updateTask(
  db: Db,
  workspaceId: string,
  taskId: string,
  args: {
    title?: string | undefined;
    description?: string | undefined;
    status?: TaskStatus | undefined;
    priority?: number | undefined;
    assigneeAgent?: string | null | undefined;
    position?: number | undefined;
    expectedUpdatedAt?: string | undefined;
  }
): TaskRow {
  const existing = getTask(db, workspaceId, taskId);
  if (!existing) throw Err.notFound(`task not found: ${taskId}`);
  if (args.expectedUpdatedAt && args.expectedUpdatedAt !== existing.updated_at) {
    throw new AppError("CONFLICT", `task was updated by someone else at ${existing.updated_at}; re-read and retry`, {
      current_updated_at: existing.updated_at,
    });
  }
  const nextStatus = args.status ?? existing.status;
  const completedAt = nextStatus === "done" ? existing.completed_at ?? new Date().toISOString() : nextStatus === "pending" || nextStatus === "in_progress" ? null : existing.completed_at;
  const resolvedAssignee =
    (args.assigneeAgent === undefined ? existing.assignee_agent : resolveAgentId(db, args.assigneeAgent)) ?? null;
  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_agent = ?, position = ?,
       completed_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    args.title ?? existing.title,
    args.description ?? existing.description,
    nextStatus,
    Math.min(Math.max(args.priority ?? existing.priority, 1), 5),
    resolvedAssignee,
    args.position ?? existing.position,
    completedAt,
    taskId
  );
  touchPlan(db, existing.plan_id);
  return getTask(db, workspaceId, taskId)!;
}

export function completeTask(
  db: Db,
  workspaceId: string,
  taskId: string
): { task: TaskRow; planCompleted: boolean } {
  const task = updateTask(db, workspaceId, taskId, { status: "done" });
  const plan = getPlan(db, workspaceId, task.plan_id)!;
  const openCount = db
    .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE plan_id = ? AND status NOT IN ('done','cancelled')`)
    .get(plan.id) as { c: number };
  if (openCount.c === 0 && plan.status === "active") {
    updatePlan(db, workspaceId, plan.id, { status: "completed" });
    return { task, planCompleted: true };
  }
  return { task, planCompleted: false };
}

export function listTasks(
  db: Db,
  workspaceId: string,
  opts: {
    planId?: string | undefined;
    status?: TaskStatus | undefined;
    parentTaskId?: string | null | undefined;
    limit?: number | undefined;
  } = {}
): TaskRow[] {
  const params: unknown[] = [workspaceId];
  let sql = `SELECT t.*, a.name AS assignee_name FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent WHERE t.workspace_id = ?`;
  if (opts.planId) {
    sql += ` AND plan_id = ?`;
    params.push(opts.planId);
  }
  if (opts.status) {
    sql += ` AND status = ?`;
    params.push(opts.status);
  }
  if (opts.parentTaskId !== undefined) {
    if (opts.parentTaskId === null) {
      sql += ` AND parent_task_id IS NULL`;
    } else {
      sql += ` AND parent_task_id = ?`;
      params.push(opts.parentTaskId);
    }
  }
  sql += ` ORDER BY status = 'in_progress' DESC, priority ASC, position ASC, created_at ASC LIMIT ?`;
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return db.prepare(sql).all(...(params as never[])) as unknown as TaskRow[];
}

function touchPlan(db: Db, planId: string): void {
  db.prepare(`UPDATE plans SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(planId);
}

/* ── PLAN.md rendering ─────────────────────────────────────── */

const STATUS_MARK: Record<TaskStatus, string> = {
  pending: " ",
  in_progress: "~",
  blocked: "!",
  done: "x",
  cancelled: "-",
};

export async function renderPlanMarkdownForWorkspace(db: Db, workspaceId: string, root: string, tmpDir: string): Promise<string> {
  const plans = db
    .prepare(
      `SELECT p.* FROM plans p WHERE p.workspace_id = ? AND p.status IN ('active','draft','completed') ORDER BY p.status, p.updated_at DESC`
    )
    .all(workspaceId) as unknown as PlanRow[];
  const tasks = listTasks(db, workspaceId, { limit: 500 });

  const lines: string[] = ["# Plan", "", `_Auto-rendered from the workspace planning database at ${new Date().toISOString()}._`, ""];

  if (plans.length === 0) {
    lines.push("_No plans yet. Use `plan_create` to start one._", "");
  }

  for (const plan of plans) {
    const mark = plan.status === "active" ? "▶" : plan.status === "completed" ? "✓" : "·";
    lines.push(`## ${mark} ${plan.title}  \`${plan.status}\``);
    if (plan.summary) lines.push("", plan.summary);
    lines.push("");

    const planTasks = tasks.filter((t) => t.plan_id === plan.id && !t.parent_task_id);
    const childrenByParent = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      if (t.parent_task_id) {
        const list = childrenByParent.get(t.parent_task_id) ?? [];
        list.push(t);
        childrenByParent.set(t.parent_task_id, list);
      }
    }

    if (planTasks.length === 0) {
      lines.push("_No tasks._", "");
      continue;
    }

    for (const task of planTasks) {
      const markBox = `[${STATUS_MARK[task.status]}]`;
      const prio = task.priority > 3 ? "" : ` _(P${task.priority})_`;
      lines.push(`- ${markBox} ${task.title}${prio}`);
      for (const child of childrenByParent.get(task.id) ?? []) {
        lines.push(`  - [${STATUS_MARK[child.status]}] ${child.title}`);
      }
    }
    lines.push("");
  }

  const content = lines.join("\n");
  await atomicWriteFile(safeResolve(root, "PLAN.md"), content, tmpDir);
  return content;
}
