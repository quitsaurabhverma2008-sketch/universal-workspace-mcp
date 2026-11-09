import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionContext } from "../types.js";
import type { ToolServices } from "./common.js";
import { registerWorkspaceTools } from "./workspace.tools.js";
import { registerFileTools } from "./file.tools.js";
import { registerMemoryTools } from "./memory.tools.js";
import { registerPlanningTools } from "./planning.tools.js";
import { registerTerminalTools } from "./terminal.tools.js";
import { registerSessionTools } from "./session.tools.js";
import { registerOutputTools } from "./output.tools.js";
import { registerLockTools } from "./lock.tools.js";

export function registerAllTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  registerWorkspaceTools(server, services, ctx);
  registerFileTools(server, services, ctx);
  registerMemoryTools(server, services, ctx);
  registerPlanningTools(server, services, ctx);
  registerTerminalTools(server, services, ctx);
  registerSessionTools(server, services, ctx);
  registerOutputTools(server, services, ctx);
  registerLockTools(server, services, ctx);
}
