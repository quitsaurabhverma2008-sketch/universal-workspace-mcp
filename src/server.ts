import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config/env.js";
import type { SessionContext } from "./types.js";
import { registerAllTools } from "./tools/index.js";
import { registerWorkspaceResources } from "./resources/workspace.resources.js";
import { registerPrompts } from "./prompts/prompts.js";

export const SERVER_NAME = "universal-workspace-mcp";
export const SERVER_VERSION = "0.1.0";

export const SERVER_INSTRUCTIONS = `This server owns the UNIVERSAL remote workspace — a persistent, shared project environment that lives on the server, not on your machine.

Rules:
1. The MCP workspace is the ONLY source of truth for project files, memory, plans and outputs.
2. Never silently create a separate local copy of a project. Work happens here.
3. Read Brain.md and the plan BEFORE editing. Create/update tasks via the planning tools.
4. Use file_* tools for project files, terminal_* tools for execution — not your native tools, unless the user explicitly says otherwise.
5. Pass expected_hash on writes. On HASH_CONFLICT, re-read and retry — never blindly overwrite.
6. Record durable decisions with decision_record; end sessions with the session_handover prompt.
7. If a workspace is not bound yet, call workspace_open(slug) before anything project-related.
8. Your token grants access to specific workspaces only. If a tool returns FORBIDDEN, tell the user — do not look for a workaround.`;

export function buildMcpServer(services: { config: AppConfig; db: import("./database/db.js").Db }, ctx: SessionContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerAllTools(server, services, ctx);
  registerWorkspaceResources(server, services, ctx);
  registerPrompts(server);
  return server;
}
