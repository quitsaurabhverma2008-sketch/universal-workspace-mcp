import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import { getProcessStatus, readProcessOutput, startProcess, stopProcess } from "../core/execution.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");

export function registerTerminalTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);

  tool(
    "terminal_execute",
    {
      description:
        "Execute a shell command inside the workspace (restricted mode: safety denylist always on; cwd is jailed to the workspace; timeouts and output caps enforced). Returns exit code and captured output tail. Use wait=false for long builds, then poll with terminal_output/terminal_status.",
      inputSchema: {
        workspace: slug,
        command: z.string().min(1).max(4000).describe("Shell command, run via /bin/sh -c"),
        cwd: z.string().max(1024).optional().default(".").describe("Working directory relative to workspace root"),
        timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Default 120000, hard cap 600000"),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables (merged over a minimal safe base)"),
        allow_sensitive_env: z.boolean().optional().default(false).describe("Allow env keys matching SECRET/TOKEN/PASSWORD/... to pass through (they are still redacted in logs)"),
        wait: z.boolean().optional().default(true).describe("Wait up to wait_ms for the command to finish"),
        wait_ms: z.number().int().min(0).max(30_000).optional().default(30_000),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["exec:run"]);
      return startProcess(services.db, services.config, ctx, workspace, {
        command: args.command,
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        env: args.env,
        allowSensitiveEnv: args.allow_sensitive_env,
        wait: args.wait,
        waitMs: args.wait_ms,
      });
    }
  );

  tool(
    "terminal_output",
    {
      description: "Read captured stdout/stderr of a process (incrementally, via offset_bytes). Large outputs are truncated at 64 KB per call.",
      inputSchema: {
        workspace: slug,
        process_id: z.string().min(1),
        stream: z.enum(["stdout", "stderr", "both"]).optional().default("both"),
        offset_bytes: z.number().int().min(0).optional().default(0),
        max_bytes: z.number().int().min(1).max(1_048_576).optional().default(65_536),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["exec:run"]);
      return readProcessOutput(services.db, workspace.id, args.process_id, {
        stream: args.stream,
        offsetBytes: args.offset_bytes,
        maxBytes: args.max_bytes,
      });
    }
  );

  tool(
    "terminal_status",
    {
      description: "Status of a process: running | exited | killed | timed_out | denied | failed, exit code, byte counts, paths of captured logs.",
      inputSchema: {
        workspace: slug,
        process_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["exec:run"]);
      const row = getProcessStatus(services.db, workspace.id, args.process_id);
      return row;
    }
  );

  tool(
    "terminal_stop",
    {
      description: "Stop a running process (SIGTERM, escalating to SIGKILL if needed, or SIGKILL directly if requested). Requires the exec:kill scope (admin roles).",
      inputSchema: {
        workspace: slug,
        process_id: z.string().min(1),
        signal: z.enum(["SIGTERM", "SIGKILL"]).optional().default("SIGTERM"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["exec:kill"]);
      return stopProcess(services.db, workspace.id, args.process_id, args.signal);
    }
  );
}
