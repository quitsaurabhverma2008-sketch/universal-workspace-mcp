import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import { acquireLock, listLocks, releaseLock } from "../core/locks.js";
import { writeEvent } from "../core/events.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");

export function registerLockTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);
  const ev = (action: string, target: string | null, workspaceId: string, detail?: unknown) =>
    writeEvent(services.db, { workspaceId, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action, target, detail });

  tool(
    "lock_acquire",
    {
      description:
        "Acquire a TTL lock on a workspace path (30–3600 s, default 300). Other sessions' writes to that path will be rejected with LOCKED until it expires or is released. Write tools respect locks held by other sessions; same-session writes pass.",
      inputSchema: {
        workspace: slug,
        path: z.string().min(1).max(1024).describe("Path relative to the workspace root"),
        ttl_seconds: z.number().int().min(30).max(3600).optional().default(300),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:write"]);
      const lock = acquireLock(services.db, workspace.id, ctx.sessionRowId, { agentId: ctx.principal.agentId }, workspace.root_path, args.path, args.ttl_seconds);
      ev("lock.acquire", lock.path, workspace.id, { expires_at: lock.expires_at });
      return lock;
    }
  );

  tool(
    "lock_release",
    {
      description: "Release a lock — by path, by lock_id, or all locks held by this session (when both omitted).",
      inputSchema: {
        workspace: slug,
        path: z.string().min(1).max(1024).optional(),
        lock_id: z.string().optional(),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:write"]);
      const result = releaseLock(services.db, workspace.id, ctx.sessionRowId, { path: args.path, lockId: args.lock_id });
      ev("lock.release", args.path ?? args.lock_id ?? "all", workspace.id, result);
      return result;
    }
  );

  tool(
    "lock_list",
    {
      description: "List active locks in this workspace, including who holds them and when they expire.",
      inputSchema: {
        workspace: slug,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:read"]);
      const locks = listLocks(services.db, workspace.id);
      return {
        locks: locks.map((l) => ({
          id: l.id,
          path: l.path,
          agent_id: l.agent_id,
          session_id: l.session_id,
          is_yours: l.session_id === ctx.sessionRowId,
          acquired_at: l.acquired_at,
          expires_at: l.expires_at,
        })),
        count: locks.length,
      };
    }
  );
}
