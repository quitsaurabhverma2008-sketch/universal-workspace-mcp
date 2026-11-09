import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import { exportArtifacts, listArtifacts, readArtifact, saveArtifact } from "../core/outputs.js";
import { writeEvent } from "../core/events.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");
const artifactKind = z.enum(["report", "log", "build", "export", "snapshot", "other"]);

export function registerOutputTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);
  const ev = (action: string, target: string | null, workspaceId: string, detail?: unknown) =>
    writeEvent(services.db, { workspaceId, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action, target, detail });

  tool(
    "output_save",
    {
      description:
        "Register a file as an output artifact. If the file is not already under outputs/, it is copied there (or moved when move=true). Artifacts are listed/read via output_list/output_read and survive workspace export.",
      inputSchema: {
        workspace: slug,
        source_path: z.string().min(1).max(1024).describe("Path to an existing file inside the workspace"),
        kind: artifactKind.optional().default("other"),
        description: z.string().max(500).optional(),
        move: z.boolean().optional().default(false).describe("false = copy into outputs/ (default); true = move"),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["outputs:write"]);
      const artifact = await saveArtifact(services.db, workspace, ctx.principal.agentId, {
        sourcePath: args.source_path,
        kind: args.kind,
        description: args.description,
        move: args.move,
      });
      ev("output.save", artifact.path, workspace.id, { kind: artifact.kind });
      return artifact;
    }
  );

  tool(
    "output_list",
    {
      description: "List registered output artifacts, newest first.",
      inputSchema: {
        workspace: slug,
        kind: artifactKind.optional(),
        limit: z.number().int().min(1).max(200).optional().default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["outputs:read"]);
      const artifacts = listArtifacts(services.db, workspace.id, { kind: args.kind, limit: args.limit });
      return { artifacts, count: artifacts.length };
    }
  );

  tool(
    "output_read",
    {
      description: "Read an artifact's content (up to 5 MB; binary files return metadata only).",
      inputSchema: {
        workspace: slug,
        artifact_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["outputs:read"]);
      return readArtifact(services.db, services.config, workspace, args.artifact_id);
    }
  );

  tool(
    "output_export",
    {
      description:
        "Bundle up to 100 workspace paths into outputs/export-<timestamp>.tar.gz and register it as a 'export' artifact. Use to hand a whole work product back to the user.",
      inputSchema: {
        workspace: slug,
        paths: z.array(z.string().min(1).max(1024)).min(1).max(100).describe("Workspace-relative paths to include"),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["outputs:read"]);
      const artifact = await exportArtifacts(services.db, workspace, ctx.principal.agentId, { paths: args.paths });
      ev("output.export", artifact.path, workspace.id, { paths: args.paths.length });
      return artifact;
    }
  );
}
