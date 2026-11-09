import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { Db } from "../database/db.js";
import type { SessionContext, ToolResult, WorkspaceRow } from "../types.js";
import { resolveWorkspace, requireScopes, type ResolvedWorkspace } from "../security/authorize.js";
import { toErrorPayload } from "../utils/errors.js";
import { touchSession } from "../core/sessions.js";

export interface ToolServices {
  db: Db;
  config: AppConfig;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Register a tool on the MCP server.
 * - Session heartbeat (sessions.last_seen_at) is maintained automatically.
 * - Handler results are serialized as JSON text content.
 * - Errors are converted to MCP `isError` results with a stable code (see ERROR REGISTRY in docs).
 */
export function defineTool(server: McpServer, services: ToolServices, ctx: SessionContext) {
  return function tool<S extends z.ZodRawShape>(
    name: string,
    config: {
      description: string;
      inputSchema: S;
      annotations?: ToolAnnotations;
    },
    handler: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>
  ): void {
    server.registerTool(
      name,
      {
        description: config.description,
        // zod v3 raw shape is what the SDK supports; keep the cast localized
        inputSchema: config.inputSchema as never,
        annotations: config.annotations,
      },
      (async (args: unknown) => {
        if (ctx.sessionRowId) {
          try {
            touchSession(services.db, ctx.sessionRowId);
          } catch {
            /* non-fatal */
          }
        }
        try {
          const result = await handler(args as z.infer<z.ZodObject<S>>);
          return jsonResult(result);
        } catch (error) {
          const payload = toErrorPayload(error);
          return jsonError(payload.code, payload.message, payload.detail);
        }
      }) as never
    );
  };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function jsonError(code: string, message: string, detail?: unknown): ToolResult {
  const payload = { code, message, ...(detail !== undefined ? { detail } : {}) };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * Resolve the workspace for this call.
 * - explicit `slug` wins; otherwise the session-bound workspace.
 * - verifies membership, type and scopes before returning.
 */
export function requireWorkspace(
  services: ToolServices,
  ctx: SessionContext,
  slug: string | undefined,
  neededScopes: string[]
): ResolvedWorkspace & { workspace: WorkspaceRow } {
  const resolved = resolveWorkspace(services.db, ctx.principal, {
    slug,
    boundWorkspaceId: slug ? null : ctx.boundWorkspaceId,
  });
  requireScopes(resolved.scopes, neededScopes);
  return resolved;
}
