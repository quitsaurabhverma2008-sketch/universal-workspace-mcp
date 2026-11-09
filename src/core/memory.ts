import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Db } from "../database/db.js";
import { atomicWriteFile } from "../utils/paths.js";
import { Err } from "../utils/errors.js";

/**
 * Project memory: Brain.md (human/agent-curated markdown at the workspace
 * root) + structured memory_entries in SQLite (searchable).
 */

export const BRAIN_TEMPLATE = `# Project Brain

<!-- Curated durable memory for this workspace. Updated by agents via brain_update / decision_record. -->

## Mission

_What is this project trying to achieve? Fill in._

## Architecture

_Key components, data flow, constraints. Fill in._

## Decisions

_Dated architecture/product decisions, newest last. Use decision_record to append._

## Current State

_What works, what is in progress, known problems._

## Handover Log

_End-of-session notes for the next agent. Use session_handover prompt._

## Open Questions

_Unresolved questions for the owner._

## PROJECT AGENT PROTOCOL

1. The MCP workspace is the only source of truth for project files, memory, plans and outputs.
2. Never create a separate local copy of this project.
3. Read memory and the plan before editing; create/update tasks as you work.
4. Use file tools for project files, terminal tools for execution — not native shells.
5. Pass expected_hash on writes; on HASH_CONFLICT re-read and retry — never overwrite blindly.
6. Record decisions with decision_record; hand over via the session_handover prompt.
`;

export const PROJECT_TEMPLATE = `# PROJECT

_Owner-facing project brief. Edit this file freely._

## Overview

## Stack

## Workspace layout

- \`Brain.md\` — durable project memory (agents update it)
- \`PLAN.md\` — live plan + tasks (auto-rendered from the planning database)
- \`outputs/\` — reports, exports, build artifacts
- \`logs/\` — terminal/build logs
- Everything else — the real project tree
`;

const PLAN_STUB = `# Plan

_No plans yet. Use plan_create to start one._
`;

export async function seedWorkspaceDirs(workspacesDir: string, slug: string): Promise<string> {
  const root = `${workspacesDir}/${slug}`;
  await fs.mkdir(`${root}/outputs`, { recursive: true });
  await fs.mkdir(`${root}/logs`, { recursive: true });
  return root;
}

export async function seedWorkspaceFiles(root: string, tmpDir: string): Promise<void> {
  await atomicWriteFile(`${root}/Brain.md`, BRAIN_TEMPLATE, tmpDir);
  await atomicWriteFile(`${root}/PROJECT.md`, PROJECT_TEMPLATE, tmpDir);
  await atomicWriteFile(`${root}/PLAN.md`, PLAN_STUB, tmpDir);
}

/** List all `## Section` headings in a markdown document. */
export function listSections(markdown: string): string[] {
  const sections: string[] = [];
  for (const match of markdown.matchAll(/^##\s+(.+)$/gm)) {
    if (match[1]) sections.push(match[1].trim());
  }
  return sections;
}

/** Extract one `## Section` (case-insensitive heading match). */
export function extractSection(markdown: string, section: string): string | null {
  const lines = markdown.split("\n");
  const needle = section.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^##\s+(.+)$/.exec(lines[i]!);
    if (match && match[1] && match[1].trim().toLowerCase() === needle) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Replace or append a `## Section` body in markdown. Atomic at the call site. */
export function upsertSection(markdown: string, section: string, body: string, mode: "append" | "replace"): string {
  const lines = markdown.split("\n");
  const heading = `## ${section.trim()}`;
  const needle = section.trim().toLowerCase();

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^##\s+(.+)$/.exec(lines[i]!);
    if (match && match[1] && match[1].trim().toLowerCase() === needle) {
      start = i;
      break;
    }
  }

  const normalizedBody = body.replace(/\n+$/g, "");

  if (start === -1) {
    // Append new section before nothing else — at end of file.
    const sep = markdown.endsWith("\n") ? "" : "\n";
    return `${markdown}${sep}\n${heading}\n\n${normalizedBody}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const existingBody = lines.slice(start + 1, end).join("\n").trim();
  const nextBody =
    mode === "append" && existingBody
      ? `${existingBody}\n${normalizedBody}`
      : normalizedBody;

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const rebuilt = [...before, lines[start]!, "", nextBody, "", ...after].join("\n");
  return rebuilt.replace(/\n{3,}/g, "\n\n");
}

/** Update (or create) one `## Section` in Brain.md atomically. Returns the section after write. */
export async function writeBrainSection(
  root: string,
  tmpDir: string,
  section: string,
  body: string,
  mode: "append" | "replace"
): Promise<{ section: string; content: string }> {
  const path = `${root}/Brain.md`;
  let current: string;
  try {
    current = await fs.readFile(path, "utf8");
  } catch {
    current = BRAIN_TEMPLATE;
  }
  const updated = upsertSection(current, section, body, mode);
  await atomicWriteFile(path, updated, tmpDir);
  return { section: section.trim(), content: extractSection(updated, section) ?? "" };
}

export interface BrainDoc {
  content: string;
  sections: string[];
  updatedAt: string;
}

export async function readBrain(root: string, section?: string): Promise<BrainDoc> {
  const path = `${root}/Brain.md`;
  let content: string;
  let updatedAt = new Date().toISOString();
  try {
    content = await fs.readFile(path, "utf8");
    updatedAt = (await fs.stat(path)).mtime.toISOString();
  } catch {
    // Missing Brain.md (workspace created by older builds) — present template, don't write from a read path.
    content = BRAIN_TEMPLATE;
  }
  if (section) {
    const found = extractSection(content, section);
    if (found === null) throw Err.notFound(`section not found in Brain.md: ${section} (available: ${listSections(content).join(", ")})`);
    return { content: found, sections: listSections(content), updatedAt };
  }
  return { content, sections: listSections(content), updatedAt };
}

/* ── Structured memory entries ─────────────────────────────── */

export type MemoryKind = "note" | "decision" | "fact" | "instruction" | "handover";
export const MEMORY_KINDS: MemoryKind[] = ["note", "decision", "fact", "instruction", "handover"];

export interface MemoryRow {
  id: string;
  workspace_id: string;
  kind: string;
  title: string;
  content: string;
  tags: string;
  source_agent: string | null;
  created_at: string;
  updated_at: string;
}

export function addMemoryEntry(
  db: Db,
  workspaceId: string,
  agentId: string | null,
  args: { kind?: MemoryKind | undefined; title: string; content: string; tags?: string[] | undefined }
): MemoryRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO memory_entries (id, workspace_id, kind, title, content, tags, source_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, args.kind ?? "note", args.title, args.content, JSON.stringify(args.tags ?? []), agentId);
  return getMemoryEntry(db, workspaceId, id)!;
}

export function getMemoryEntry(db: Db, workspaceId: string, id: string): MemoryRow | null {
  return (
    (db.prepare(`SELECT * FROM memory_entries WHERE workspace_id = ? AND id = ?`).get(workspaceId, id) as MemoryRow | undefined) ??
    null
  );
}

export function updateMemoryEntry(
  db: Db,
  workspaceId: string,
  id: string,
  args: { title?: string | undefined; content?: string | undefined; kind?: MemoryKind | undefined; tags?: string[] | undefined }
): MemoryRow {
  const existing = getMemoryEntry(db, workspaceId, id);
  if (!existing) throw Err.notFound(`memory entry not found: ${id}`);
  db.prepare(
    `UPDATE memory_entries SET
       title = ?, content = ?, kind = ?, tags = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE workspace_id = ? AND id = ?`
  ).run(
    args.title ?? existing.title,
    args.content ?? existing.content,
    args.kind ?? existing.kind,
    JSON.stringify(args.tags ?? (JSON.parse(existing.tags) as string[])),
    workspaceId,
    id
  );
  return getMemoryEntry(db, workspaceId, id)!;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export function searchMemoryEntries(
  db: Db,
  workspaceId: string,
  opts: { query: string; kind?: MemoryKind | undefined; tag?: string | undefined; limit?: number | undefined }
): MemoryRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const like = `%${escapeLike(opts.query)}%`;
  const params: unknown[] = [workspaceId, like, like, like];
  let sql = `SELECT * FROM memory_entries
             WHERE workspace_id = ?
               AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`;
  if (opts.kind) {
    sql += ` AND kind = ?`;
    params.push(opts.kind);
  }
  if (opts.tag) {
    sql += ` AND tags LIKE ? ESCAPE '\\'`;
    params.push(`%${escapeLike(opts.tag)}%`);
  }
  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...(params as never[])) as unknown as MemoryRow[];
}

export function listMemoryEntries(
  db: Db,
  workspaceId: string,
  opts: { kind?: MemoryKind | undefined; limit?: number | undefined } = {}
): MemoryRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.kind) {
    return db
      .prepare(`SELECT * FROM memory_entries WHERE workspace_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(workspaceId, opts.kind, limit) as unknown as MemoryRow[];
  }
  return db
    .prepare(`SELECT * FROM memory_entries WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?`)
    .all(workspaceId, limit) as unknown as MemoryRow[];
}
