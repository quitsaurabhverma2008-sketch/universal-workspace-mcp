import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  workspaceStats,
} from "../core/workspace.js";
import { bindSessionWorkspace } from "../core/sessions.js";
import { writeEvent, recentEvents } from "../core/events.js";
import { resolveWorkspace, requireScopes } from "../security/authorize.js";
import fs from "node:fs/promises";
import path from "node:path";

const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "slug must be 2-50 chars of lowercase a-z, 0-9 and dashes");

export function registerWorkspaceTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);

  tool(
    "workspace_create",
    {
      description:
        "Create a new project workspace: seeds Brain.md, PROJECT.md, PLAN.md, outputs/, logs/ and initializes git (if enabled). You become the workspace owner.",
      inputSchema: {
        name: z.string().min(1).max(80).describe("Human-readable workspace name"),
        slug: slugSchema.optional().describe("URL-safe id; derived from name if omitted; auto-suffixed if taken"),
        description: z.string().max(500).optional(),
        git_enabled: z.boolean().optional().describe("Initialize a git repo (default: server setting, usually true)"),
        type: z.enum(["shared", "private"]).optional().describe("shared = members invited via tokens; private = owner only (default shared)"),
      },
    },
    async (args) => {
      const ws = await createWorkspace(
        services,
        { userId: ctx.principal.userId, agentId: ctx.principal.agentId },
        ctx.sessionRowId,
        { name: args.name, slug: args.slug, description: args.description, gitEnabled: args.git_enabled, type: args.type }
      );
      return { id: ws.id, slug: ws.slug, name: ws.name, root_path: ws.root_path, type: ws.type, git_enabled: ws.git_enabled === 1 };
    }
  );

  tool(
    "workspace_list",
    {
      description: "List workspaces you own or are a member of, newest activity first.",
      inputSchema: {
        include_archived: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = listWorkspaces(services.db, { userId: ctx.principal.userId }, args.include_archived ?? false);
      return {
        workspaces: rows.map((w) => ({
          slug: w.slug,
          name: w.name,
          type: w.type,
          git_enabled: w.git_enabled === 1,
          archived: w.archived_at !== null,
          updated_at: w.updated_at,
        })),
      };
    }
  );

  tool(
    "workspace_open",
    {
      description:
        "Open a workspace and bind it to this session. Call this FIRST when working on a specific project. Returns the workspace summary, the head of Brain.md, open tasks and recent activity — everything needed to bootstrap.",
      inputSchema: {
        slug: z.string().min(1).describe("Workspace slug, e.g. 'xcomb'"),
      },
    },
    async (args) => {
      const resolved = resolveWorkspace(services.db, ctx.principal, { slug: args.slug });
      requireScopes(resolved.scopes, ["workspace:read"]);
      const ws = resolved.workspace;
      ctx.boundWorkspaceId = ws.id;
      bindSessionWorkspace(services.db, ctx.sessionRowId, ws.id);

      let brainHead = "";
      try {
        const raw = await fs.readFile(path.join(ws.root_path, "Brain.md"), "utf8");
        brainHead = raw.slice(0, 4000);
      } catch {
        brainHead = "";
      }

      const openTasks = services.db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status NOT IN ('done','cancelled')`)
        .get(ws.id) as { c: number };
      const inProgress = services.db
        .prepare(`SELECT title FROM tasks WHERE workspace_id = ? AND status = 'in_progress' ORDER BY priority ASC LIMIT 5`)
        .all(ws.id) as unknown as Array<{ title: string }>;

      const recent = recentEvents(services.db, ws.id, 10).map((e) => ({
        action: e.action,
        target: e.target,
        at: e.created_at,
      }));

      writeEvent(services.db, {
        workspaceId: ws.id,
        agentId: ctx.principal.agentId,
        sessionId: ctx.sessionRowId,
        action: "workspace.opened",
        target: ws.slug,
      });

      return {
        workspace: {
          id: ws.id,
          slug: ws.slug,
          name: ws.name,
          description: ws.description,
          type: ws.type,
          git_enabled: ws.git_enabled === 1,
          your_role: resolved.memberRole,
        },
        brain_head: brainHead,
        open_tasks: openTasks.c,
        in_progress: inProgress.map((t) => t.title),
        recent_activity: recent,
        hint: "workspace is now bound to this session; tools without an explicit workspace argument will target it",
      };
    }
  );

  tool(
    "workspace_switch",
    {
      description: "Re-bind this session to a different workspace. Equivalent to workspace_open but signals an intentional context switch.",
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    async (args) => {
      const resolved = resolveWorkspace(services.db, ctx.principal, { slug: args.slug });
      requireScopes(resolved.scopes, ["workspace:read"]);
      ctx.boundWorkspaceId = resolved.workspace.id;
      bindSessionWorkspace(services.db, ctx.sessionRowId, resolved.workspace.id);
      writeEvent(services.db, {
        workspaceId: resolved.workspace.id,
        agentId: ctx.principal.agentId,
        sessionId: ctx.sessionRowId,
        action: "workspace.switched",
        target: resolved.workspace.slug,
      });
      return { slug: resolved.workspace.slug, name: resolved.workspace.name, bound: true };
    }
  );

  tool(
    "workspace_info",
    {
      description: "Detailed information about a workspace: stats, git state, storage usage, task counts. Does not change the session binding.",
      inputSchema: {
        workspace: slugSchema.optional().describe("Workspace slug (defaults to the session-bound workspace)"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["workspace:read"]);
      const stats = await workspaceStats(services.db, workspace);
      return {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        description: workspace.description,
        type: workspace.type,
        root_path: workspace.root_path,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
        archived: workspace.archived_at !== null,
        git_enabled: workspace.git_enabled === 1,
        stats,
      };
    }
  );

  tool(
    "workspace_delete",
    {
      description:
        "ARCHIVE (soft delete) a workspace. Requires admin scope. The directory is moved to data/backups/deleted-<slug>-* — never hard-deleted. confirm_slug must repeat the slug exactly.",
      inputSchema: {
        slug: slugSchema,
        confirm_slug: z.string().describe("Must equal slug; guards against accidental deletion"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const resolved = resolveWorkspace(services.db, ctx.principal, { slug: args.slug });
      requireScopes(resolved.scopes, ["workspace:delete"]);
      const result = await deleteWorkspace(
        services,
        { userId: ctx.principal.userId, agentId: ctx.principal.agentId },
        ctx.sessionRowId,
        { slug: args.slug, confirmSlug: args.confirm_slug }
      );
      if (ctx.boundWorkspaceId === resolved.workspace.id) ctx.boundWorkspaceId = null;
      return result;
    }
  );
}
