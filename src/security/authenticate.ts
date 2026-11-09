import { randomUUID } from "node:crypto";
import type { Db } from "../database/db.js";
import type { Principal } from "../types.js";
import { Err } from "../utils/errors.js";
import { generateToken, hashToken } from "./token.js";

interface TokenJoinRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
  user_role: string;
  display_name: string;
  agent_name: string | null;
}

/** Mint a token for a user (and optional agent). Returns plaintext — shown once. */
export function mintToken(
  db: Db,
  pepper: string,
  args: { userId: string; agentId: string | null; name: string; scopes?: string[]; expiresAt?: string | null }
): { id: string; token: string } {
  const token = generateToken();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO access_tokens (id, user_id, agent_id, name, token_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.userId, args.agentId, args.name, hashToken(token, pepper), JSON.stringify(args.scopes ?? []), args.expiresAt ?? null);
  return { id, token };
}

/** Verify a bearer token against the DB. Throws AppError on any failure. Returns the Principal. */
export function verifyBearer(db: Db, pepper: string, token: string): Principal {
  if (!token || !token.startsWith("umcp_")) throw Err.unauthorized();
  const hash = hashToken(token, pepper);
  const row = db
    .prepare(
      `SELECT t.id, t.user_id, t.agent_id, t.scopes, t.expires_at, t.revoked_at,
              u.role AS user_role, u.display_name,
              a.name AS agent_name
       FROM access_tokens t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.token_hash = ?`
    )
    .get(hash) as TokenJoinRow | undefined;

  if (!row) throw Err.unauthorized("invalid token");
  if (row.revoked_at) throw Err.unauthorized("token has been revoked");
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) throw Err.unauthorized("token has expired");

  // Best-effort usage stamp; failure here must never block the request.
  try {
    db.prepare(`UPDATE access_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(row.id);
  } catch {
    /* ignore */
  }

  let tokenScopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as unknown;
    if (Array.isArray(parsed)) tokenScopes = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    tokenScopes = [];
  }

  return {
    tokenId: row.id,
    userId: row.user_id,
    userRole: row.user_role,
    displayName: row.display_name,
    agentId: row.agent_id,
    agentName: row.agent_name,
    tokenScopes,
  };
}

export function revokeToken(db: Db, tokenId: string): boolean {
  const result = db.prepare(`UPDATE access_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL`).run(tokenId);
  return result.changes > 0;
}
