import fs from "node:fs/promises";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolServices } from "../tools/common.js";
import type { SessionContext, WorkspaceRow } from "../types.js";
import { recentEvents } from "../core/events.js";
import { listTasks, renderPlanMarkdownForWorkspace } from "../core/planner.js";
import { safeResolve } from "../utils/paths.js";

/** Resources are read-only views; mutations always go through tools (keeps audit uniform). */

function boundWorkspace(services: ToolServices, ctx: SessionContext): WorkspaceRow | null {
  if (!ctx.boundWorkspaceId) return null;
  return (services.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(ctx.boundWorkspaceId) as WorkspaceRow | undefined) ?? null;
}

export function registerWorkspaceResources(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const { db } = services;

  const current = () => {
    const ws = boundWorkspace(services, ctx);
    if (!ws) return null;
    const openTasks = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status NOT IN ('done','cancelled')`).get(ws.id) as { c: number };
    return {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      description: ws.description,
      type: ws.type,
      git_enabled: ws.git_enabled === 1,
      open_tasks: openTasks.c,
      updated_at: ws.updated_at,
    };
  };

  server.registerResource(
    "workspace-current",
    "workspace://current",
    { description: "Summary of the workspace bound to this session", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(current() ?? { error: "no workspace bound — call workspace_open first" }, null, 2) }] })
  );

  server.registerResource(
    "workspace-brain",
    "workspace://current/brain",
    { description: "Brain.md — durable project memory", mimeType: "text/markdown" },
    async (uri) => {
      const ws = boundWorkspace(services, ctx);
      const text = ws
        ? await fs.readFile(path.join(ws.root_path, "Brain.md"), "utf8").catch(() => "# Brain\n\n_Brain.md missing._")
        : "_No workspace bound — call workspace_open first._";
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource(
    "workspace-plan",
    "workspace://current/plan",
    { description: "PLAN.md — auto-rendered plan and tasks", mimeType: "text/markdown" },
    async (uri) => {
      const ws = boundWorkspace(services, ctx);
      let text = "_No workspace bound — call workspace_open first._";
      if (ws) {
        try {
          text = await renderPlanMarkdownForWorkspace(db, ws.id, ws.root_path, services.config.tmpDir);
        } catch {
          text = await fs.readFile(path.join(ws.root_path, "PLAN.md"), "utf8").catch(() => "_plan unavailable_");
        }
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource(
    "workspace-tasks",
    "workspace://current/tasks",
    { description: "Open tasks for the bound workspace (pending/in_progress/blocked), ordered by priority", mimeType: "application/json" },
    async (uri) => {
      const ws = boundWorkspace(services, ctx);
      if (!ws) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "no workspace bound" }) }] };
      const tasks = listTasks(db, ws.id, { status: "in_progress", limit: 50 }).concat(
        listTasks(db, ws.id, { status: "pending", limit: 100 }),
        listTasks(db, ws.id, { status: "blocked", limit: 50 })
      );
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ tasks }, null, 2) }] };
    }
  );

  server.registerResource(
    "workspace-activity",
    "workspace://current/activity",
    { description: "Last 50 audit events for the bound workspace", mimeType: "application/json" },
    async (uri) => {
      const ws = boundWorkspace(services, ctx);
      if (!ws) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "no workspace bound" }) }] };
      const events = recentEvents(db, ws.id, 50).map((e) => ({ ...e, detail: safeJson(e.detail) }));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ events }, null, 2) }] };
    }
  );

  server.registerResource(
    "workspace-file",
    new ResourceTemplate("workspace://current/files/{path}", { list: undefined }),
    { description: "Read a workspace file (≤256 KB). Note: use file_read tool for full fidelity.", mimeType: "text/plain" },
    async (uri, variables) => {
      const ws = boundWorkspace(services, ctx);
      if (!ws) return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "_No workspace bound_" }] };
      const raw = Array.isArray(variables.path) ? variables.path.join("/") : String(variables.path ?? "");
      try {
        const abs = safeResolve(ws.root_path, raw);
        const stat = await fs.stat(abs);
        if (!stat.isFile()) throw new Error("not a file");
        if (stat.size > 256 * 1024) throw new Error("file too large for resource read; use file_read");
        const text = await fs.readFile(abs, "utf8");
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
      } catch (error) {
        throw new Error(`cannot read resource: ${(error as Error).message}`);
      }
    }
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
