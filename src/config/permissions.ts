/**
 * Role -> scope mapping. Per-workspace member roles grant scopes.
 * Token-level scopes (when set on the token) can only *narrow* the role grants.
 */

export const ALL_SCOPES = [
  "workspace:read",
  "workspace:write",
  "workspace:delete",
  "workspaces:manage",
  "files:read",
  "files:write",
  "files:delete",
  "memory:read",
  "memory:write",
  "planning:read",
  "planning:write",
  "exec:run",
  "exec:kill",
  "sessions:read",
  "sessions:write",
  "outputs:read",
  "outputs:write",
  "admin:tokens",
  "admin:users",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

const VIEWER: Scope[] = [
  "workspace:read",
  "files:read",
  "memory:read",
  "planning:read",
  "outputs:read",
  "sessions:read",
];

const EDITOR: Scope[] = [
  ...VIEWER,
  "workspace:write",
  "files:write",
  "memory:write",
  "planning:write",
  "exec:run",
  "outputs:write",
  "sessions:write",
];

const ADMIN: Scope[] = [
  ...EDITOR,
  "files:delete",
  "exec:kill",
  "workspace:delete",
  "workspaces:manage",
];

const OWNER: Scope[] = [...ADMIN, "admin:tokens", "admin:users"];

export const ROLE_SCOPES: Record<string, readonly Scope[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  admin: ADMIN,
  owner: OWNER,
};

/** Effective scopes: role grants intersected with token scopes (if the token narrows them). */
export function effectiveScopes(memberRole: string, tokenScopes: string[] | undefined): string[] {
  const granted = ROLE_SCOPES[memberRole] ?? ROLE_SCOPES["viewer"]!;
  if (!tokenScopes || tokenScopes.length === 0) return [...granted];
  return granted.filter((s) => tokenScopes.includes(s));
}
