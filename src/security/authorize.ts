import type { Db } from "../database/db.js";
import type { Principal, WorkspaceRow } from "../types.js";
import { effectiveScopes } from "../config/permissions.js";
import { Err } from "../utils/errors.js";

/** Check a scope list contains every required scope. */
export function requireScopes(scopes: string[], needed: string[]): void {
  for (const scope of needed) {
    if (!scopes.includes(scope)) {
      throw Err.forbidden(`missing required scope: ${scope}`);
    }
  }
}

export interface ResolvedWorkspace {
  workspace: WorkspaceRow;
  memberRole: "owner" | "admin" | "editor" | "viewer";
  scopes: string[];
}

/**
 * Resolve and authorize a workspace for the calling principal.
 *
 * Resolution order:
 *   1. explicit `slug` argument
 *   2. the workspace bound to this MCP session (from workspace_open)
 *   3. otherwise WORKSPACE_NOT_BOUND
 *
 * Authorization:
 *   - private workspaces: owner only
 *   - shared workspaces: membership row or workspace ownership
 *   - 'team' type: reserved for Option 3 (team grants); falls back to direct membership
 */
export function resolveWorkspace(
  db: Db,
  principal: Principal,
  opts: { slug?: string | undefined; boundWorkspaceId?: string | null | undefined; write?: boolean }
): ResolvedWorkspace {
  let row: WorkspaceRow | undefined;

  if (opts.slug) {
    row = db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(opts.slug) as WorkspaceRow | undefined;
    if (!row) throw Err.workspaceNotFound(opts.slug);
  } else if (opts.boundWorkspaceId) {
    row = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(opts.boundWorkspaceId) as WorkspaceRow | undefined;
    if (!row) throw Err.workspaceNotBound();
  } else {
    throw Err.workspaceNotBound();
  }

  if (row.archived_at) throw Err.workspaceArchived(row.slug);

  const isOwner = row.owner_id === principal.userId;
  const membership = db
    .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .get(row.id, principal.userId) as { role: ResolvedWorkspace["memberRole"] } | undefined;

  let memberRole: ResolvedWorkspace["memberRole"] | null = isOwner ? "owner" : membership?.role ?? null;

  // Option 3-ready: team grants (dormant until teams tooling ships in Phase 8+)
  if (!memberRole && row.type === "team") {
    const teamGrant = db
      .prepare(
        `SELECT tm.role FROM team_members tm
         JOIN team_workspaces tw ON tw.team_id = tm.team_id
         WHERE tw.workspace_id = ? AND tm.user_id = ?`
      )
      .get(row.id, principal.userId) as { role: string } | undefined;
    if (teamGrant) memberRole = teamGrant.role === "owner" ? "owner" : teamGrant.role === "admin" ? "admin" : "editor";
  }

  if (row.type === "private" && !isOwner) {
    throw Err.forbidden("this workspace is private");
  }
  if (!memberRole) {
    throw Err.forbidden("you are not a member of this workspace");
  }

  const scopes = effectiveScopes(memberRole, principal.tokenScopes);
  return { workspace: row, memberRole, scopes };
}
