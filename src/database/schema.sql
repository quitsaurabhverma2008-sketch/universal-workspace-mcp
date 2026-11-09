-- 0001_init.sql — Universal Workspace MCP canonical schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── Identity ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent','cli','web','other')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_name ON agents(user_id, name);

CREATE TABLE IF NOT EXISTS access_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL DEFAULT '[]',      -- JSON array; empty = inherit role scopes
  expires_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON access_tokens(token_hash);

-- ── Workspaces & membership ─────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  type          TEXT NOT NULL DEFAULT 'shared' CHECK (type IN ('shared','private','team')),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  root_path     TEXT NOT NULL UNIQUE,
  git_enabled   INTEGER NOT NULL DEFAULT 1,
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner','admin','editor','viewer')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, user_id)
);

-- Option 3 (teams) — dormant in v1, schema-ready
CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS team_workspaces (
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, workspace_id)
);

-- ── Sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  client_name   TEXT,
  client_version TEXT,
  logical_label TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','orphaned')),
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_ws ON sessions(workspace_id, status);

-- ── Planning ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  summary       TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','completed','archived')),
  created_by    TEXT REFERENCES agents(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_ws ON plans(workspace_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_task_id  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','blocked','done','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  position        INTEGER NOT NULL DEFAULT 0,
  assignee_agent  TEXT REFERENCES agents(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id, status);

-- ── Memory ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_entries (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','decision','fact','instruction','handover')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  source_agent  TEXT REFERENCES agents(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_ws ON memory_entries(workspace_id, kind);

-- ── Audit ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id),
  session_id    TEXT REFERENCES sessions(id),
  action        TEXT NOT NULL,
  target        TEXT,
  detail        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_ws_time ON events(workspace_id, created_at);

-- ── Processes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    TEXT REFERENCES sessions(id),
  agent_id      TEXT REFERENCES agents(id),
  command       TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','exited','killed','timed_out','denied','failed')),
  exit_code     INTEGER,
  stdout_path   TEXT,
  stderr_path   TEXT,
  bytes_out     INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_processes_ws ON processes(workspace_id, status);

-- ── Locks ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_locks (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  agent_id      TEXT REFERENCES agents(id),
  session_id    TEXT REFERENCES sessions(id),
  acquired_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL,
  UNIQUE (workspace_id, path)
);

-- ── Artifacts ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('report','log','build','export','snapshot','other')),
  description   TEXT,
  created_by    TEXT REFERENCES agents(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_ws ON artifacts(workspace_id, kind);
