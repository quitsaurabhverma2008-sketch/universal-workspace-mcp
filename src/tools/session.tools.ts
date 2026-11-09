import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import {
  createLogicalSession,
  listAgents,
  listSessions,
  sessionEventCounts,
  sessionHistory,
  upsertAgent,
} from "../core/sessions.js";
import { writeEvent } from "../core/events.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");

export function registerSessionTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);

  tool(
    "agent_register",
    {
      description:
        "Register (or re-register) this agent identity — e.g. 'opencode-phone'. Idempotent per (user, name). Does not require an open workspace; when called before workspace_open the audit event is recorded without a workspace.",
      inputSchema: {
        workspace: slug,
        name: z.string().min(1).max(80),
        kind: z.enum(["agent", "cli", "web", "other"]).optional().default("agent"),
      },
    },
    async (args) => {
      // Identity registration is session-level: allowed with or without a workspace context.
      let workspaceId: string | null = null;
      if (args.workspace) {
        const resolved = requireWorkspace(services, ctx, args.workspace, ["sessions:write"]);
        workspaceId = resolved.workspace.id;
      } else if (ctx.boundWorkspaceId) {
        workspaceId = ctx.boundWorkspaceId;
      }
      const agent = upsertAgent(services.db, ctx.principal.userId, { name: args.name, kind: args.kind });
      ctx.principal.agentId = agent.id;
      services.db.prepare(`UPDATE sessions SET agent_id = ? WHERE id = ?`).run(agent.id, ctx.sessionRowId);
      writeEvent(services.db, { workspaceId, agentId: agent.id, sessionId: ctx.sessionRowId, action: "agent.registered", target: args.name });
      return { agent_id: agent.id, created: agent.created, name: args.name };
    }
  );

  tool(
    "agent_list",
    {
      description: "List agents known in this workspace (via sessions and events).",
      inputSchema: {
        workspace: slug,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["sessions:read"]);
      return { agents: listAgents(services.db, workspace.id) };
    }
  );

  tool(
    "session_create",
    {
      description:
        "Label this MCP connection as a logical work session, e.g. 'implement auth'. Makes session_history and handover prompts much more useful.",
      inputSchema: {
        workspace: slug,
        label: z.string().min(1).max(120),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["sessions:write"]);
      const row = createLogicalSession(services.db, ctx.sessionRowId, workspace.id, args.label);
      writeEvent(services.db, { workspaceId: workspace.id, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action: "session.created", target: args.label });
      return row;
    }
  );

  tool(
    "session_list",
    {
      description: "List sessions for this workspace (transport connections), newest activity first.",
      inputSchema: {
        workspace: slug,
        status: z.enum(["active", "ended", "orphaned"]).optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["sessions:read"]);
      return { sessions: listSessions(services.db, workspace.id, { status: args.status, limit: args.limit }) };
    }
  );

  tool(
    "session_status",
    {
      description: "Status of a session (defaults to this one): binding, counters (files touched, tasks completed, commands run), last seen.",
      inputSchema: {
        workspace: slug,
        session_id: z.string().optional().describe("Defaults to the current session"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["sessions:read"]);
      const sessionId = args.session_id ?? ctx.sessionRowId;
      const session = services.db
        .prepare(
          `SELECT s.*, a.name AS agent_name FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id WHERE s.id = ? AND (s.workspace_id = ? OR s.id = ?)`
        )
        .get(sessionId, workspace.id, ctx.sessionRowId) as Record<string, unknown> | undefined;
      if (!session) return { error: { code: "NOT_FOUND", message: "session not found" } };
      const counts = sessionEventCounts(services.db, sessionId);
      return { ...session, counters: counts, is_current: sessionId === ctx.sessionRowId };
    }
  );

  tool(
    "session_history",
    {
      description:
        "Audit history for this workspace (or a single session): files written, commands run, tasks completed, memory updates — attributed per agent. Use it to avoid clobbering another agent's work or to resume context.",
      inputSchema: {
        workspace: slug,
        session_id: z.string().optional().describe("Restrict to one session"),
        since: z.string().optional().describe("ISO-8601 timestamp lower bound"),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["sessions:read"]);
      const rows = sessionHistory(services.db, workspace.id, { sessionId: args.session_id, since: args.since, limit: args.limit });
      return { events: rows, count: (rows as unknown[]).length };
    }
  );
}
