/** Shared types across the app. */

export interface Principal {
  tokenId: string;
  userId: string;
  userRole: string; // owner | admin | member (global)
  displayName: string;
  agentId: string | null;
  agentName: string | null;
  tokenScopes: string[]; // [] = inherit role scopes
}

/** Per-MCP-transport-session context, extended with session binding (workspace). */
export interface SessionContext {
  principal: Principal;
  sessionRowId: string;
  boundWorkspaceId: string | null;
}

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: "shared" | "private" | "team";
  owner_id: string;
  root_path: string;
  git_enabled: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: "owner" | "admin" | "editor" | "viewer";
  created_at: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}
