import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import {
  deletePath,
  editFileContent,
  listDir,
  movePath,
  readFileContent,
  searchFiles,
  writeFileContent,
} from "../core/filesystem.js";
import { writeEvent } from "../core/events.js";
import { assertNoForeignLock } from "../core/locks.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");
const relPath = z.string().min(1).max(1024).describe("Path relative to the workspace root (use '.' for the root)");

export function registerFileTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);
  const ev = (action: string, target: string | null, workspaceId: string, detail?: unknown) =>
    writeEvent(services.db, { workspaceId, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action, target, detail });

  tool(
    "file_read",
    {
      description:
        "Read a text file from the workspace. Returns content with a sha256 hash to use as expected_hash on later writes. Binary files return metadata only.",
      inputSchema: {
        workspace: slug,
        path: relPath,
        offset: z.number().int().min(0).optional().describe("Line offset (0-based) for large files"),
        limit: z.number().int().min(1).max(10000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:read"]);
      const result = await readFileContent(workspace.root_path, args.path, {
        offset: args.offset,
        limit: args.limit,
        maxFileBytes: services.config.maxFileBytes,
      });
      return result;
    }
  );

  tool(
    "file_write",
    {
      description:
        "Create or overwrite a file (atomic write). Pass expected_hash (from file_read) to prevent overwriting someone else's changes — mismatch returns HASH_CONFLICT. Reserved files (Brain.md, PLAN.md, PROJECT.md) are not writable here; use brain_update/plan tools.",
      inputSchema: {
        workspace: slug,
        path: relPath,
        content: z.string().max(services.config.maxFileBytes).describe("Full file content (UTF-8 text)"),
        expected_hash: z.string().optional().describe("sha256 from a previous file_read; file must match"),
        create_dirs: z.boolean().optional().default(true),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:write"]);
      assertNoForeignLock(services.db, workspace.id, ctx.sessionRowId, workspace.root_path, args.path);
      const result = await writeFileContent(workspace.root_path, args.path, args.content, {
        expectedHash: args.expected_hash,
        createDirs: args.create_dirs,
        maxFileBytes: services.config.maxFileBytes,
        tmpDir: services.config.tmpDir,
      });
      ev("file.write", result.path, workspace.id, { bytes: result.bytes, created: result.created });
      return result;
    }
  );

  tool(
    "file_edit",
    {
      description:
        "Precise in-place edit: replace old_string with new_string. old_string must be unique in the file (or set replace_all=true). Pass expected_hash to guard against concurrent modifications.",
      inputSchema: {
        workspace: slug,
        path: relPath,
        old_string: z.string().min(1).max(services.config.maxFileBytes),
        new_string: z.string().max(services.config.maxFileBytes),
        expected_hash: z.string().optional(),
        replace_all: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:write"]);
      assertNoForeignLock(services.db, workspace.id, ctx.sessionRowId, workspace.root_path, args.path);
      const result = await editFileContent(workspace.root_path, args.path, args.old_string, args.new_string, {
        expectedHash: args.expected_hash,
        replaceAll: args.replace_all,
        maxFileBytes: services.config.maxFileBytes,
        tmpDir: services.config.tmpDir,
      });
      ev("file.edit", result.path, workspace.id, { replacements: result.replacements, bytes: result.bytes });
      return result;
    }
  );

  tool(
    "file_delete",
    {
      description:
        "Delete a file or directory. Deleting directories requires recursive=true. Reserved entries cannot be deleted. Admin scope required. Prefer moving to outputs/ or git for anything important.",
      inputSchema: {
        workspace: slug,
        path: relPath,
        recursive: z.boolean().optional().default(false),
        expected_hash: z.string().optional().describe("Optional hash guard for files"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:delete"]);
      assertNoForeignLock(services.db, workspace.id, ctx.sessionRowId, workspace.root_path, args.path);
      const result = await deletePath(workspace.root_path, args.path, { recursive: args.recursive, expectedHash: args.expected_hash });
      ev("file.delete", result.path, workspace.id, { deleted: result.deleted });
      return result;
    }
  );

  tool(
    "file_move",
    {
      description: "Move or rename a file or directory inside the workspace. overwrite=false (default) fails if destination exists.",
      inputSchema: {
        workspace: slug,
        from: relPath.describe("Source path relative to workspace root"),
        to: relPath.describe("Destination path relative to workspace root"),
        overwrite: z.boolean().optional().default(false),
        expected_hash: z.string().optional().describe("Optional hash guard for the source file"),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:write"]);
      assertNoForeignLock(services.db, workspace.id, ctx.sessionRowId, workspace.root_path, args.from);
      const result = await movePath(workspace.root_path, args.from, args.to, {
        overwrite: args.overwrite,
        expectedHash: args.expected_hash,
        tmpDir: services.config.tmpDir,
      });
      ev("file.move", `${result.from} -> ${result.to}`, workspace.id);
      return result;
    }
  );

  tool(
    "file_list",
    {
      description:
        "List files and directories. Defaults to the workspace root. Use recursive=true for a full tree (capped). .git is skipped by default.",
      inputSchema: {
        workspace: slug,
        path: relPath.optional().default("."),
        recursive: z.boolean().optional().default(false),
        max_entries: z.number().int().min(1).max(2000).optional().default(1000),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:read"]);
      const entries = await listDir(workspace.root_path, args.path ?? ".", { recursive: args.recursive, maxEntries: args.max_entries });
      return { entries, count: entries.length, truncated: entries.length >= (args.max_entries ?? 1000) };
    }
  );

  tool(
    "file_search",
    {
      description:
        "Search by filename glob (e.g. '*.ts', 'src/**/*.test.ts') and/or content (substring, or /regex/). Returns matching paths, and line + preview for content matches.",
      inputSchema: {
        workspace: slug,
        pattern: z.string().min(1).max(200).describe("Filename glob; bare names match anywhere ('utils' → '**/*utils*')"),
        path: relPath.optional().default(".").describe("Base directory for the search"),
        content_query: z.string().min(1).max(500).optional(),
        max_results: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["files:read"]);
      const { results, truncated } = await searchFiles(workspace.root_path, {
        pattern: args.pattern,
        path: args.path,
        contentQuery: args.content_query,
        maxResults: args.max_results,
      });
      return { results, count: results.length, truncated };
    }
  );
}
