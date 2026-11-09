import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import {
  completeTask,
  createPlan,
  createTask,
  getPlan,
  listPlans,
  listTasks,
  renderPlanMarkdownForWorkspace,
  updatePlan,
  updateTask,
  type PlanStatus,
  type TaskStatus,
} from "../core/planner.js";
import { writeEvent } from "../core/events.js";
import { Err } from "../utils/errors.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");
const planStatus = z.enum(["draft", "active", "completed", "archived"]);
const taskStatus = z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]);

export function registerPlanningTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);

  const rerender = async (workspaceId: string, root: string) => {
    try {
      await renderPlanMarkdownForWorkspace(services.db, workspaceId, root, services.config.tmpDir);
    } catch {
      /* PLAN.md render is best-effort; the DB is the source of truth */
    }
  };

  const ev = (action: string, target: string | null, workspaceId: string, detail?: unknown) =>
    writeEvent(services.db, { workspaceId, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action, target, detail });

  tool(
    "plan_create",
    {
      description:
        "Create a new plan for this workspace (becomes the active plan). Follow the approval-gate workflow: propose the plan, wait for the user's approval, then execute via task_* tools.",
      inputSchema: {
        workspace: slug,
        title: z.string().min(1).max(200),
        summary: z.string().max(4000).optional(),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:write"]);
      const plan = createPlan(services.db, workspace.id, ctx.principal.agentId, { title: args.title, summary: args.summary });
      ev("plan.created", plan.id, workspace.id, { title: plan.title });
      await rerender(workspace.id, workspace.root_path);
      return plan;
    }
  );

  tool(
    "plan_read",
    {
      description: "Read a plan (defaults to the active plan) with its tasks grouped as a tree. PLAN.md is the human-readable mirror.",
      inputSchema: {
        workspace: slug,
        plan_id: z.string().optional().describe("Plan id; defaults to the active plan"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:read"]);
      const plan = getPlan(services.db, workspace.id, args.plan_id);
      if (!plan) throw Err.notFound(args.plan_id ? `plan not found: ${args.plan_id}` : "no active plan; create one with plan_create");
      const tasks = listTasks(services.db, workspace.id, { planId: plan.id, limit: 500 });
      return { plan, tasks, task_count: tasks.length, done_count: tasks.filter((t) => t.status === "done").length };
    }
  );

  tool(
    "plan_update",
    {
      description: "Update a plan's title, summary or status (draft | active | completed | archived).",
      inputSchema: {
        workspace: slug,
        plan_id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        summary: z.string().max(4000).optional(),
        status: planStatus.optional(),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:write"]);
      const plan = updatePlan(services.db, workspace.id, args.plan_id, { title: args.title, summary: args.summary, status: args.status as PlanStatus | undefined });
      ev("plan.updated", plan.id, workspace.id, { status: plan.status });
      await rerender(workspace.id, workspace.root_path);
      return plan;
    }
  );

  tool(
    "plan_list",
    {
      description: "List all plans in the workspace with task counters.",
      inputSchema: {
        workspace: slug,
        status: planStatus.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:read"]);
      const plans = listPlans(services.db, workspace.id, { status: args.status as PlanStatus | undefined });
      return { plans, count: plans.length };
    }
  );

  tool(
    "task_create",
    {
      description:
        "Create a task in the active plan (or a specified plan). Supports subtasks via parent_task_id. priority: 1 (highest) to 5 (default 3). PLAN.md re-renders automatically.",
      inputSchema: {
        workspace: slug,
        plan_id: z.string().optional(),
        title: z.string().min(1).max(300),
        description: z.string().max(8000).optional(),
        parent_task_id: z.string().optional().describe("Set to make this a subtask"),
        priority: z.number().int().min(1).max(5).optional().default(3),
        assignee_agent: z.string().max(80).optional(),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:write"]);
      const task = createTask(services.db, workspace.id, ctx.principal.agentId, {
        planId: args.plan_id,
        title: args.title,
        description: args.description,
        parentTaskId: args.parent_task_id,
        priority: args.priority,
        assigneeAgent: args.assignee_agent,
      });
      ev("task.created", task.id, workspace.id, { title: task.title, plan_id: task.plan_id });
      await rerender(workspace.id, workspace.root_path);
      return task;
    }
  );

  tool(
    "task_update",
    {
      description:
        "Update a task (title, description, status, priority, assignee, position). Pass expected_updated_at for safe concurrent edits — mismatch returns CONFLICT.",
      inputSchema: {
        workspace: slug,
        task_id: z.string().min(1),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(8000).optional(),
        status: taskStatus.optional(),
        priority: z.number().int().min(1).max(5).optional(),
        assignee_agent: z.string().max(80).nullable().optional(),
        position: z.number().int().min(0).optional(),
        expected_updated_at: z.string().optional(),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:write"]);
      const task = updateTask(services.db, workspace.id, args.task_id, {
        title: args.title,
        description: args.description,
        status: args.status as TaskStatus | undefined,
        priority: args.priority,
        assigneeAgent: args.assignee_agent,
        position: args.position,
        expectedUpdatedAt: args.expected_updated_at,
      });
      ev("task.updated", task.id, workspace.id, { status: task.status });
      await rerender(workspace.id, workspace.root_path);
      return task;
    }
  );

  tool(
    "task_complete",
    {
      description:
        "Mark a task done. If it was the last open task in its plan, the plan is automatically marked completed (plan_completed=true).",
      inputSchema: {
        workspace: slug,
        task_id: z.string().min(1),
        note: z.string().max(2000).optional().describe("Completion note — recorded in the audit log"),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:write"]);
      const { task, planCompleted } = completeTask(services.db, workspace.id, args.task_id);
      ev("task.completed", task.id, workspace.id, { note: args.note, plan_completed: planCompleted });
      await rerender(workspace.id, workspace.root_path);
      return { task, plan_completed: planCompleted };
    }
  );

  tool(
    "task_list",
    {
      description:
        "List tasks, filtered by plan, status or parent. Ordering: in_progress first, then priority, position, creation time.",
      inputSchema: {
        workspace: slug,
        plan_id: z.string().optional(),
        status: taskStatus.optional(),
        parent_task_id: z.string().nullish().describe("null = top-level tasks only; omitted = all"),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:read"]);
      const tasks = listTasks(services.db, workspace.id, {
        planId: args.plan_id,
        status: args.status as TaskStatus | undefined,
        parentTaskId: args.parent_task_id,
        limit: args.limit,
      });
      return { tasks, count: tasks.length };
    }
  );

  tool(
    "project_status",
    {
      description: "Single-shot status of the workspace: active plan, open/in-progress/blocked tasks, recent decisions. The fastest way to answer 'where are we?'",
      inputSchema: {
        workspace: slug,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["planning:read"]);
      const plan = getPlan(services.db, workspace.id);
      const open = listTasks(services.db, workspace.id, { status: "in_progress", limit: 20 });
      const blocked = listTasks(services.db, workspace.id, { status: "blocked", limit: 20 });
      const pending = services.db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status = 'pending'`)
        .get(workspace.id) as { c: number };
      const done = services.db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status = 'done'`)
        .get(workspace.id) as { c: number };
      return {
        active_plan: plan ? { id: plan.id, title: plan.title, status: plan.status } : null,
        in_progress: open.map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
        blocked: blocked.map((t) => ({ id: t.id, title: t.title })),
        pending_count: pending.c,
        done_count: done.c,
      };
    }
  );
}
