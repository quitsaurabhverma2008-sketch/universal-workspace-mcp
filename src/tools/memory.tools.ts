import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, requireWorkspace, type ToolServices } from "./common.js";
import type { SessionContext } from "../types.js";
import {
  addMemoryEntry,
  getMemoryEntry,
  listMemoryEntries,
  MEMORY_KINDS,
  readBrain,
  searchMemoryEntries,
  updateMemoryEntry,
  writeBrainSection,
  type MemoryKind,
} from "../core/memory.js";
import { writeEvent } from "../core/events.js";
import { Err } from "../utils/errors.js";

const slug = z.string().min(1).optional().describe("Workspace slug (defaults to session-bound workspace)");
const kindSchema = z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]);

export function registerMemoryTools(server: McpServer, services: ToolServices, ctx: SessionContext): void {
  const tool = defineTool(server, services, ctx);
  const ev = (action: string, target: string | null, workspaceId: string, detail?: unknown) =>
    writeEvent(services.db, { workspaceId, agentId: ctx.principal.agentId, sessionId: ctx.sessionRowId, action, target, detail });

  tool(
    "brain_read",
    {
      description:
        "Read Brain.md — the durable project memory. Optionally return a single section (e.g. 'Mission', 'Architecture', 'Decisions', 'Current State').",
      inputSchema: {
        workspace: slug,
        section: z.string().min(1).max(80).optional().describe("Section heading without the leading ##, case-insensitive"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:read"]);
      return readBrain(workspace.root_path, args.section);
    }
  );

  tool(
    "brain_update",
    {
      description:
        "Update one section of Brain.md (mode='append' adds to the section, 'replace' rewrites it). Creates the section if missing. Atomic write.",
      inputSchema: {
        workspace: slug,
        section: z.string().min(1).max(80).describe("Section heading, e.g. 'Current State'"),
        content: z.string().min(1).max(50_000),
        mode: z.enum(["append", "replace"]).default("append"),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:write"]);
      const result = await writeBrainSection(workspace.root_path, services.config.tmpDir, args.section, args.content, args.mode);
      ev("brain.update", args.section, workspace.id, { mode: args.mode });
      return result;
    }
  );

  tool(
    "memory_add",
    {
      description:
        "Store a structured memory entry (note | decision | fact | instruction | handover) in the workspace memory. Searchable via memory_search.",
      inputSchema: {
        workspace: slug,
        kind: kindSchema.optional().default("note"),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(20_000),
        tags: z.array(z.string().min(1).max(40)).max(10).optional().default([]),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:write"]);
      const row = addMemoryEntry(services.db, workspace.id, ctx.principal.agentId, {
        kind: args.kind,
        title: args.title,
        content: args.content,
        tags: args.tags,
      });
      ev("memory.add", row.id, workspace.id, { kind: row.kind, title: row.title });
      return row;
    }
  );

  tool(
    "memory_read",
    {
      description: "Read a memory entry by id.",
      inputSchema: {
        workspace: slug,
        id: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:read"]);
      const row = getMemoryEntry(services.db, workspace.id, args.id);
      if (!row) throw Err.notFound(`memory entry not found: ${args.id}`);
      return row;
    }
  );

  tool(
    "memory_update",
    {
      description: "Update a memory entry (title, content, kind or tags).",
      inputSchema: {
        workspace: slug,
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(20_000).optional(),
        kind: kindSchema.optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional(),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:write"]);
      const row = updateMemoryEntry(services.db, workspace.id, args.id, {
        title: args.title,
        content: args.content,
        kind: args.kind,
        tags: args.tags,
      });
      ev("memory.update", row.id, workspace.id, { kind: row.kind });
      return row;
    }
  );

  tool(
    "memory_search",
    {
      description:
        "Search workspace memory by substring (title, content, tags), optionally filtered by kind and/or tag. Returns newest first. Use it before starting work to recall decisions and context.",
      inputSchema: {
        workspace: slug,
        query: z.string().min(1).max(200),
        kind: kindSchema.optional(),
        tag: z.string().min(1).max(40).optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:read"]);
      const rows = searchMemoryEntries(services.db, workspace.id, { query: args.query, kind: args.kind, tag: args.tag, limit: args.limit });
      return { results: rows, count: rows.length };
    }
  );

  tool(
    "decision_record",
    {
      description:
        "Record a durable project decision: writes a decision memory entry AND appends a dated bullet under '## Decisions' in Brain.md. Use for architecture/product choices that future sessions must respect.",
      inputSchema: {
        workspace: slug,
        title: z.string().min(1).max(200),
        decision: z.string().min(1).max(5000).describe("What was decided"),
        rationale: z.string().min(1).max(5000).describe("Why — the forces and trade-offs"),
        alternatives: z.array(z.string().min(1).max(500)).max(10).optional().default([]).describe("Options considered and rejected"),
      },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:write"]);
      const alternatives = args.alternatives?.length ? `\n\nRejected alternatives:\n${args.alternatives.map((a) => `- ${a}`).join("\n")}` : "";
      const row = addMemoryEntry(services.db, workspace.id, ctx.principal.agentId, {
        kind: "decision",
        title: args.title,
        content: `Decision: ${args.decision}\n\nRationale: ${args.rationale}${alternatives}`,
        tags: ["decision"],
      });
      const date = new Date().toISOString().slice(0, 10);
      const bullet = `- **${date}** ${args.title} — ${args.decision.slice(0, 300)} (rationale: ${args.rationale.slice(0, 300)})`;
      await writeBrainSection(workspace.root_path, services.config.tmpDir, "Decisions", bullet, "append");
      ev("memory.decision", row.id, workspace.id, { title: args.title });
      return { memory_id: row.id, brain_section: "Decisions" };
    }
  );

  tool(
    "memory_list",
    {
      description: "List recent memory entries (optionally by kind), newest first.",
      inputSchema: {
        workspace: slug,
        kind: kindSchema.optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { workspace } = requireWorkspace(services, ctx, args.workspace, ["memory:read"]);
      const rows = listMemoryEntries(services.db, workspace.id, { kind: args.kind, limit: args.limit });
      return { entries: rows, count: rows.length };
    }
  );
}
