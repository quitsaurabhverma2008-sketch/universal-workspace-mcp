import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "../database/db.js";
import type { AppConfig } from "../config/env.js";
import { mintToken } from "../security/authenticate.js";
import { seedWorkspaceDirs, seedWorkspaceFiles } from "./memory.js";
import { writeEvent } from "./events.js";
import { Err } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

/**
 * "Seats" — isolated (user, agent, workspace, token) bundles.
 *
 * Each seat gets its OWN user row, so its token can only ever reach the
 * workspaces that user is a member of. That makes isolation real rather than
 * cosmetic: seat A's token is rejected for seat B's workspace.
 */

export interface Seat {
  seat: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  agentName: string;
  token: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export async function provisionSeat(
  db: Db,
  config: AppConfig,
  args: { seat: string; workspaceName?: string | undefined; workspaceSlug?: string | undefined; description?: string | undefined }
): Promise<Seat> {
  const seat = args.seat.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!seat) throw Err.validation("seat name is required");

  const existingUser = db.prepare(`SELECT id FROM users WHERE display_name = ?`).get(`seat:${seat}`) as { id: string } | undefined;
  if (existingUser) throw Err.conflict(`seat "${seat}" already exists`);

  let slug = (args.workspaceSlug ?? `${seat}-space`).toLowerCase();
  if (!SLUG_RE.test(slug)) throw Err.validation(`invalid workspace slug: ${slug}`);
  let suffix = 1;
  while (db.prepare(`SELECT id FROM workspaces WHERE slug = ?`).get(slug)) slug = `${args.workspaceSlug ?? `${seat}-space`}-${suffix++}`;

  // 1. user (member of exactly this one workspace)
  const userId = randomUUID();
  db.prepare(`INSERT INTO users (id, display_name, role) VALUES (?, ?, 'member')`).run(userId, `seat:${seat}`);

  // 2. agent identity
  const agentId = randomUUID();
  const agentName = `agent-${seat}`;
  db.prepare(`INSERT INTO agents (id, user_id, name, kind) VALUES (?, ?, ?, 'agent')`).run(agentId, userId, agentName);

  // 3. workspace on disk + in db, owned by that user
  const root = path.join(config.workspacesDir, slug);
  await seedWorkspaceDirs(config.workspacesDir, slug);
  await seedWorkspaceFiles(root, config.tmpDir);
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  } catch {
    /* git optional */
  }

  const workspaceId = randomUUID();
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, description, type, owner_id, root_path, git_enabled)
     VALUES (?, ?, ?, ?, 'shared', ?, ?, 1)`
  ).run(
    workspaceId,
    slug,
    args.workspaceName ?? `${seat} workspace`,
    args.description ?? `Isolated workspace for seat '${seat}' (${agentName})`,
    userId,
    root
  );
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`).run(workspaceId, userId);

  // 4. token bound to that seat's user + agent
  const { token } = mintToken(db, config.tokenPepper, {
    userId,
    agentId,
    name: `seat-${seat}`,
    scopes: [],
  });

  writeEvent(db, { workspaceId, agentId, action: "seat.provisioned", target: seat, detail: { workspace: slug, agent: agentName } });

  return {
    seat,
    userId,
    agentId,
    workspaceId,
    workspaceSlug: slug,
    workspaceName: args.workspaceName ?? `${seat} workspace`,
    agentName,
    token,
  };
}

export function listSeats(db: Db): Array<{
  seat: string;
  user_id: string;
  agent: string;
  workspace: string;
  tokens: number;
  events: number;
  created_at: string;
}> {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.display_name AS seat, u.created_at,
              (SELECT a.name FROM agents a WHERE a.user_id = u.id ORDER BY a.created_at LIMIT 1) AS agent,
              (SELECT w.slug FROM workspaces w WHERE w.owner_id = u.id AND w.archived_at IS NULL ORDER BY w.created_at LIMIT 1) AS workspace,
              (SELECT COUNT(*) FROM access_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS tokens,
              (SELECT COUNT(*) FROM events e WHERE e.agent_id IN (SELECT a.id FROM agents a WHERE a.user_id = u.id)) AS events
       FROM users u WHERE u.display_name LIKE 'seat:%' ORDER BY u.created_at`
    )
    .all() as unknown as Array<{
    seat: string;
    user_id: string;
    agent: string;
    workspace: string;
    tokens: number;
    events: number;
    created_at: string;
  }>;
}

/** Rotate (revoke old + mint new) a seat's token. */
export function rotateSeatToken(db: Db, config: AppConfig, seat: string): { token: string; workspaceSlug: string | null } {
  const user = db.prepare(`SELECT id FROM users WHERE display_name = ?`).get(`seat:${seat}`) as { id: string } | undefined;
  if (!user) throw Err.notFound(`seat not found: ${seat}`);
  db.prepare(`UPDATE access_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND revoked_at IS NULL`).run(user.id);
  const agent = db.prepare(`SELECT id FROM agents WHERE user_id = ? ORDER BY created_at LIMIT 1`).get(user.id) as { id: string } | undefined;
  const { token } = mintToken(db, config.tokenPepper, { userId: user.id, agentId: agent?.id ?? null, name: `seat-${seat}-rotated`, scopes: [] });
  const ws = db.prepare(`SELECT slug FROM workspaces WHERE owner_id = ? AND archived_at IS NULL LIMIT 1`).get(user.id) as { slug: string } | undefined;
  return { token, workspaceSlug: ws?.slug ?? null };
}
