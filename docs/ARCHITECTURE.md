# Universal Remote Coding Workspace MCP — Architecture

**Project:** Universal Remote Coding Workspace MCP (`UNIVERSAL-MCP`)
**Status:** Implemented as v0.1.0 (Phases 1–7) — see README §0 and `npm test`. This document remains the architectural reference; where it and the code diverge, the code wins and this doc gets updated.
**Date:** 2026-11-09
**Host:** Android phone + Termux (hybrid-ready for VPS later)
**Scope of this document:** Complete architecture, directory structure, API contracts, MCP tool schemas, database schema, and development roadmap.

---

## 0. Document map

1. Executive summary
2. Environment audit findings
3. Final architecture decisions (ADR log)
4. System overview & component model
5. Repository / directory structure
6. Transport & connection model (MCP Streamable HTTP)
7. Authentication, authorization & scopes
8. Workspace model (Option 2 build, Option 3-ready schema)
9. Filesystem layout & path safety
10. Database schema (SQLite DDL)
11. MCP tools — full catalog with schemas
12. MCP resources & prompts
13. Agent instruction system (how agents are kept inside the workspace)
14. Execution engine (restricted remote terminal)
15. Concurrency, file locking & conflict detection
16. API contracts (health, auth, errors)
17. Security model & threat notes
18. Termux deployment & operations runbook
19. Backup, recovery & monitoring
20. Testing strategy & checklist mapping
21. Development roadmap (Phases 1–7) with exit criteria
22. Risk register & Termux limitations
23. Non-goals (v1)
24. Open questions for review
25. Appendix A: Agent connection snippets
26. Appendix B: Recommended toolchain & dependencies

---

## 1. Executive summary

A persistent, multi-agent, remote **coding workspace** exposed through the standard **MCP Streamable HTTP** protocol. Any MCP-compatible agent (OpenCode, Claude Code, Codex CLI, others) connects to one HTTPS URL, authenticates with a bearer token, and works **inside the central workspace**: project files, `Brain.md` memory, plans/tasks, outputs and logs all live on the MCP host — never on the agent's local machine.

Key properties:

- **The MCP server is the source of truth** for files, memory, plans and outputs. Agents provide reasoning; the workspace provides persistence and execution.
- **Multiple agents, one shared project** (per workspace). Cross-agent visibility via shared filesystem + SQLite state + audit event log.
- **Option 2 now, Option 3-ready:** v1 ships *Multiple Projects + Shared Access*. The schema and authorization layer are designed so *Multi-Workspace + Agent Teams / private workspaces* (Option 3) can be enabled later **without re-architecting** (see §8.3).
- **Restricted remote execution** — explicit tool, never the agent's native terminal; denylist + cwd jail + timeouts + process limits.
- **Honest limitation:** Termux is not guaranteed 24×7. Recovery is designed in from Phase 1 (WAL SQLite, idempotent startup, orphan reaping, tmux + wake-lock + Termux:Boot), not bolted on later.

### What this project is NOT

- It is not a public multi-tenant SaaS.
- Connecting the MCP does **not** redirect an agent's native filesystem — remote tools are explicit, plus an agent instruction system (§13) is mandatory for correct behavior.
- v1 has no Docker-grade sandbox (Termux can't run it); §14 defines the realistic restriction model.

---

## 2. Environment audit findings (2026-11-09)

Verified on the target device:

| Item | Status |
|---|---|
| Node.js | ✅ v24.22.2 |
| npm | ✅ 12.2.2 |
| git | ✅ 2.56.0 |
| `node:sqlite` (built-in, sync API, zero native build) | ✅ Works out of the box |
| `sqlite3` CLI | ❌ Not installed (not required; scripts use Node) |
| `cloudflared` | ❌ Not installed — must be installed in Phase 1 (`pkg install cloudflared`) |
| Existing "MCP Brain" project | ❌ **Not found anywhere in `$HOME`** — no `UNIVERSAL-MCP/`, no `*mcp*` / `*brain*` dirs, no `package.json` |
| `/sdcard` | Not accessible/empty from this shell — reiterates: **use `$HOME/UNIVERSAL-MCP/data`, never `/sdcard`** |

**Consequences:**

1. There is no existing foundation to audit — Phase 1 starts from scratch. (If the old MCP Brain lives on another device, only its `.env` token model and any learning docs are worth porting; do not port code blindly.)
2. `better-sqlite3` would require a node-gyp source build on Termux (no prebuilt android-arm64 binaries). **Decision: use the built-in `node:sqlite` behind a thin repository layer**, swappable later (see ADR-004).
3. All native-module risk is avoided; the entire dependency tree is pure JS/TS.

---

## 3. Architecture decision log (ADRs)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| ADR-001 | Protocol | **MCP (Model Context Protocol)** | Native integration in OpenCode / Claude Code / Codex; one endpoint, auto tool discovery |
| ADR-002 | Transport | **Streamable HTTP** (single `/mcp` endpoint) | Remote agents behind one HTTPS URL; per spec; supports sessions (`Mcp-Session-Id`) and SSE streaming |
| ADR-003 | Runtime | **Node.js 24 + TypeScript (ESM, strict)** | LTS line, built-in `node:sqlite`, native `--env-file`, strong typing for tool schemas |
| ADR-004 | Database | **SQLite via `node:sqlite`**, WAL mode, behind repository layer | Zero native builds on Termux; swap path to better-sqlite3/Postgres preserved |
| ADR-005 | Storage root | **`$HOME/UNIVERSAL-MCP/data/`** | Predictable perms vs `/sdcard`; survives package updates; backups trivial |
| ADR-006 | Public access | **Cloudflare named tunnel** (HTTPS → `127.0.0.1:3333`) | Stable domain, TLS termination, no port forwarding; Tailscale noted as hardened alternative (§18.6) |
| ADR-007 | Workspace model | **Option 2 now** (multi-project, shared access), **schema & authz Option 3-ready** | Controlled complexity now; no re-architecture for teams/private later (§8.3) |
| ADR-008 | Auth | **API tokens (bearer), SHA-256(pepper + token) at rest**, per-agent identity, scope + role based authorization | Simple, revocable, auditable; OAuth-ready seam (§7.6) |
| ADR-009 | Execution | **Restricted child_process**, denylist + cwd jail + timeouts + concurrency caps | Termux has no Docker; unrestricted shell must never be exposed publicly |
| ADR-010 | Concurrency | **Optimistic hash checks + TTL file locks + atomic rename writes** | Silent overwrite prevention across agents (§15) |
| ADR-011 | Source of truth | **DB for metadata/plans/memory index; filesystem for content; `Brain.md` curated by agents** | Agents can read files directly; DB queries stay fast and structured |
| ADR-012 | Server state | **Stateless core + stateful shell**: tools hold no hidden state; sessions tracked in DB; restart loses only in-memory transport sessions (clients re-initialize) | Crash-tolerant on an unreliable host |
| ADR-013 | Secrets | **`.env` (git-ignored), token pepper, no secrets in project files; log redaction (Phase 7)** | Baseline hygiene |
| ADR-014 | Logging/metrics | **pino structured logs** + `events` audit table | Cheap, greppable, agent-attributed audit |
| ADR-015 | Validation | **zod schemas** for every tool input; JSON Schema advertised to clients | Single source for runtime + advertised schemas |

---

## 4. System overview

```
┌──────────────────────────────────────────────────────────────┐
│                        AI AGENTS                             │
│     OpenCode        Claude Code        Codex CLI     …       │
└───────┬───────────────┬──────────────────┬───────────────────┘
        │  MCP over HTTPS (Streamable HTTP)                      
        │  Authorization: Bearer umcp_…                           
┌───────▼───────────────────────────────────────────────────────┐
│              CLOUDFLARE TUNNEL  (named, stable URL)           │
└───────┬───────────────────────────────────────────────────────┘
        │ http://127.0.0.1:3333                                  
┌───────▼───────────────────────────────────────────────────────┐
│                 UNIVERSAL-MCP (Termux)                         │
│                                                                │
│  ┌───────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ /health   │  │  /mcp       │  │  Auth middleware        │  │
│  │ (no auth) │  │  (401 gate) │  │  scope check per tool   │  │
│  └───────────┘  └──────┬──────┘  └─────────────────────────┘  │
│                        │                                       │
│  ┌─────────────────────▼───────────────────────────────────┐  │
│  │                    MCP CORE                              │  │
│  │  Tools │ Resources │ Prompts │ Session registry          │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │ Workspace │ FileSys │ Memory │ Planner │ Sessions        │  │
│  │ Execution │ Output  │ Locks  │ Events  │ Access control  │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  SQLite (WAL)            │  data/workspaces/<slug>/      │  │
│  │  database.sqlite          │  Brain.md PLAN.md PROJECT.md  │  │
│  │                           │  outputs/ logs/ .git/ source  │  │
│  └───────────────────────────┴───────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

**Data flow for a coding task (happy path):**

1. Agent opens `/mcp` with bearer token → server validates token → initializes MCP session (`Mcp-Session-Id`).
2. `workspace_open({slug:"xcomb"})` → session bound to workspace; authorization re-checked.
3. Agent reads `workspace://current/brain`, `task_list`, `file_list` → discovers context.
4. `plan_create` / `task_create` → persisted to SQLite; `PLAN.md` re-rendered atomically.
5. `file_read` / `file_edit` → direct disk I/O inside workspace root; hash returned with every read; `expected_hash` enforced on write when supplied.
6. `terminal_execute({command:"npm test"})` → sandboxed child process; output streamed to `logs/<proc>.log` + ring buffer; row in `processes`.
7. `memory_add({kind:"decision", …})` / `task_complete` → SQLite + audit event.
8. Second agent (other device/session) reads the same files & tasks → sees everything.

---

## 5. Directory structure

Server code and project data are **strictly separated**; updating the server never touches workspaces.

```
$HOME/UNIVERSAL-MCP/
│
├── src/
│   ├── index.ts                 # entry: load env, build container, start HTTP
│   ├── server.ts                # http server, routing (/health, /mcp)
│   ├── container.ts             # dependency wiring (no DI framework)
│   │
│   ├── config/
│   │   ├── env.ts               # zod-parsed env; fail fast on boot
│   │   └── permissions.ts       # role → scope set mapping
│   │
│   ├── transport/
│   │   ├── http.ts              # StreamableHTTPServerTransport wiring
│   │   ├── auth.ts              # bearer extraction, token verify, scope guard
│   │   └── ratelimit.ts         # in-memory token bucket per token id
│   │
│   ├── core/
│   │   ├── workspace.ts         # create/list/open/info/delete + seeding
│   │   ├── filesystem.ts        # path jail, read/write/edit, atomic rename
│   │   ├── memory.ts            # Brain.md + memory_entries CRUD/search
│   │   ├── planner.ts           # plans/tasks CRUD + PLAN.md render
│   │   ├── sessions.ts          # logical sessions + agent registry
│   │   ├── execution.ts         # spawn, capture, ring buffer, kill, timeout
│   │   ├── outputs.ts           # artifacts registry, export bundles
│   │   ├── locks.ts             # file locks (TTL) — Phase 6
│   │   └── events.ts            # audit event writer
│   │
│   ├── policy/
│   │   └── command-policy.ts    # denylist / allowlist / limits
│   │
│   ├── tools/                   # one file per tool group; thin adapters
│   │   ├── workspace.tools.ts   ├── file.tools.ts    ├── memory.tools.ts
│   │   ├── planning.tools.ts    ├── terminal.tools.ts├── session.tools.ts
│   │   ├── output.tools.ts      └── lock.tools.ts
│   │
│   ├── resources/
│   │   └── workspace.resources.ts    # workspace://current[/*]
│   ├── prompts/
│   │   └── prompts.ts                # 5 prompts (§12.3)
│   │
│   ├── database/
│   │   ├── db.ts                  # node:sqlite open, pragma, migration runner
│   │   ├── schema.sql             # canonical DDL (§10)
│   │   ├── repositories/          # typed repos, one per table group
│   │   └── migrations/            # 0001_init.sql … forward-only
│   │
│   ├── security/
│   │   ├── token.ts               # generate/hash/verify, pepper
│   │   ├── authorize.ts           # canAccess(user, workspace, op)
│   │   └── redact.ts              # secret patterns for logs/outputs
│   │
│   └── utils/
│       ├── paths.ts               # safeResolve(), workspaceRoot()
│       ├── logger.ts              # pino instance + redact
│       ├── json.ts                # stable JSON stringify for hashing
│       └── errors.ts              # AppError codes → MCP tool results
│
├── data/                        # ← everything stateful lives here
│   ├── database.sqlite            # + -wal -shm
│   ├── workspaces/
│   │   └── <slug>/                # workspace root == project root
│   │       ├── Brain.md           # seeded at create; agent-curated
│   │       ├── PROJECT.md         # seeded human/agent brief
│   │       ├── PLAN.md            # auto-rendered on plan/task writes
│   │       ├── outputs/           # reports, exports, artifacts (reserved top-level)
│   │       ├── logs/              # terminal logs, build logs (reserved)
│   │       └── …project source…   # real code lives at root; .git/ here
│   ├── backups/
│   └── tmp/                     # atomic-write scratch (same filesystem)
│
├── tests/
│   ├── unit/                    # vitest; pure logic (policy, paths, planner)
│   ├── integration/             # boot server on :0, real MCP client SDK
│   └── fixtures/
│
├── scripts/
│   ├── dev.sh                   # tsx watch + env-file
│   ├── start.sh                 # build check + node dist under tmux
│   ├── backup.sh                # VACUUM INTO + tar data/ (14-day retention)
│   ├── restore.md               # disaster restore steps
│   └── watchdog.sh              # curl /health → restart tmux session if down
│
├── docs/
│   └── ARCHITECTURE.md            # ← this file
│
├── .env                          # git-ignored: PORT, TOKEN_PEPPER, DATA_DIR…
├── .env.example
├── .gitignore                    # .env, data/, dist/, node_modules/
├── package.json
├── tsconfig.json
└── README.md
```

Reserved top-level names inside a workspace (agents must not delete/move them; tools reject it): `Brain.md`, `PROJECT.md`, `PLAN.md`, `outputs/`, `logs/`.

---

## 6. Transport & connection model

### 6.1 Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness: `{status:"ok", version, uptime_s}` — no internals |
| `POST /mcp` | Bearer | MCP messages (JSON-RPC 2.0 over Streamable HTTP) |
| `GET /mcp` | Bearer | SSE stream for server→client notifications |
| `DELETE /mcp` | Bearer | Explicit session termination |

Behavior notes:

- `Mcp-Session-Id` issued on `initialize`; required on subsequent requests; unknown/expired session → JSON-RPC error `-32001` ("session not found") and the client re-initializes (this is expected after a server restart).
- SSE by default; `enableJsonResponse: true` may be set later for debugging but is not the default.
- Binding: **`127.0.0.1` only.** The tunnel is the only way in. Never bind `0.0.0.0`.
- Body limit: 4 MB; request timeout: 30 s; keep-alive for SSE.

### 6.2 MCP SDK wiring (Phase 1 skeleton)

- `new McpServer({ name: "universal-workspace-mcp", version, instructions })` — `instructions` is the server-level instruction block (§13.1) so every compliant client sees the workspace rules automatically.
- `StreamableHTTPServerTransport` with `sessionIdGenerator: randomUUID`, stateful mode.
- One `McpServer` instance per transport session (SDK contract) — instances are cheap; all state lives in DB/disk.

### 6.3 Public exposure

- Cloudflare **named tunnel** (`mcp.<your-domain>`) → stable HTTPS URL; quick tunnels (`--url`) are for one-off tests only (URL changes every run).
- **"HTTPS URL ≠ public access"**: every `/mcp` request requires a valid bearer token; tunnel adds reachability, not authorization.
- Hardened alternative for personal-only use: Tailscale (no public ingress at all). Switch costs nothing but the tunnel layer.

---

## 7. Authentication & authorization

### 7.1 Identity model

- **Users** — humans. v1 seeds one `owner` (you). Schema supports more.
- **Agents** — non-human identities (OpenCode@laptop, Claude Code@phone…). Every token is linked to exactly one agent; every audit event is attributed to `(user, agent, session)`.
- **Workspaces** — projects. Access mediated by `workspace_members` (role) or ownership.
- **Sessions** — one MCP transport session = one row (`sessions`), optionally bound to a logical work session (`session_create`).

### 7.2 Tokens

- Format: `umcp_<43-char base64url>` (256-bit entropy). Prefix enables secret-scanners/leak detection.
- Storage: `token_hash = SHA256(TOKEN_PEPPER + token)` — plaintext shown **once** at creation. Pepper lives in `.env` only.
- Expiry optional (`expires_at`); rotation = create new + revoke old; `revoked_at` checked on every request.
- `last_used_at` touched (throttled write, ≤1/min) for hygiene audits.

### 7.3 Roles → scope set

| Role | Granted scopes |
|---|---|
| `viewer` | `workspace:read`, `files:read`, `memory:read`, `planning:read`, `outputs:read`, `sessions:read` |
| `editor` | viewer + `workspace:write`, `files:write`, `memory:write`, `planning:write`, `exec:run`, `outputs:write`, `sessions:write` |
| `admin` | editor + `files:delete`, `exec:kill`, `workspace:delete`, `workspaces:manage` |
| `owner` | all + `admin:tokens`, `admin:users` |

Workspace role is assigned **per workspace** (`workspace_members.role`). Global user role (`users.role`) only governs admin surfaces (token minting). An agent with a valid token but no membership in `xcomb` gets `403`-equivalent (`FORBIDDEN`) tool results for that workspace — tokens never grant blanket access.

### 7.4 Scope-to-tool enforcement

Every tool declares required scopes (§11). Enforcement order: **token valid? → not revoked/expired? → agent/user resolved? → workspace (if any) membership? → scope present? → execute**. Failures return structured tool errors, never stack traces.

### 7.5 Rate limiting

In-memory token bucket: **120 requests/min per token**, burst 30. Exceed → `RATE_LIMITED` tool error + audit event. (In-memory is fine for a single-process Termux host; move to SQLite if we go multi-process.)

### 7.6 OAuth-readiness seam

`security/token.ts` exposes `verify(credential): Principal`. v1 implements only `BearerTokenVerifier`. An `OAuthIssuer` can be swapped in later (device flow for CLIs, or Cloudflare Access in front for browser agents) without touching tools. Not in v1 scope.

---

## 8. Workspace model

### 8.1 Build target (Option 2 — Multiple Projects + Shared Access)

- Many workspaces (`xcomb`, `xminal`, `xcleaner`, …), each isolated on disk: `data/workspaces/<slug>/`.
- Shared access: any authorized member agent reads/writes the same workspace — file changes visible immediately to all (disk is the medium), tasks/memory via SQLite.
- Slug rules: `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`, unique.

### 8.2 Private vs shared (v1 semantics)

`workspaces.type`: `shared` (default, membership-governed) | `private` (owner-only; membership rows of others are ignored). This gives us "both" connection models with ~20 lines of authz logic.

### 8.3 Option 3-readiness (built into the schema, dormant in v1)

The following ship in schema v1 but are unused until Phase 8+:

- `teams`, `team_members`, `team_workspaces` — team → workspace grants.
- `workspaces.type = 'team'` reserved enum value.
- `authorize.ts` resolves grants as: direct membership ∪ team membership ∪ owner. Team checks are just additional SELECTs — no structural changes.
- Per-agent scope narrowing stays valid; team grants only inject roles.

Enabling Option 3 later = new tools (`team_create`, `team_add_member`, …) + authz index changes. **Zero migration of files or tokens.**

### 8.4 Workspace lifecycle

1. `workspace_create` → DB row → `mkdir` root → seed `Brain.md`, `PROJECT.md`, `PLAN.md`, `outputs/ logs/` → `git init` (if `git_enabled`, default on) → `events` row `workspace.created`.
2. `workspace_open` → validates membership → binds `workspace_id` to the MCP session row → returns `workspace_info` + pinned context (Brain.md head, open tasks count) so agents bootstrap cheaply.
3. Deletion: `workspace_delete` requires `workspace:delete` scope **and** the literal slug re-supplied; moves root to `data/backups/deleted-<slug>-<ts>/` (soft delete, 14-day purge) then deletes DB rows. Never `rm -rf` directly.

---

## 9. Filesystem layout & path safety

**Workspace root = project root.** Agents see a normal project tree; the reserved names (§5) are the only special cases.

`utils/paths.ts → safeResolve(workspaceRoot, userPath)`:

1. Reject absolute paths and NUL bytes.
2. `path.resolve(root, userPath)`; result **must** start with `root + path.sep` (or equal root).
3. `fs.realpath` the deepest existing ancestor; re-check containment (defeats symlink escapes, including `outputs -> /sdcard`).
4. Reserved-name check for write/delete/move targets at depth 0.
5. All writes: write to `data/tmp/<uuid>` → `fsync` → `rename(2)` (atomic on same fs) → mode 0644. Reads return `sha256` of file content.

Limits: file max **5 MB** read/write; `file_search` caps **500 results**; directory listing caps 2000 entries; symlinked *workspace roots* detected at startup and rejected (root itself must be a real dir).

---

## 10. Database schema (canonical DDL)

`database/schema.sql` (forward-only migrations; this is `0001_init.sql`):

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── Identity ────────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,              -- uuid v4
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner','admin','member')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                 -- e.g. 'opencode-phone'
  kind          TEXT NOT NULL DEFAULT 'agent'
                CHECK (kind IN ('agent','cli','web','other')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE access_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,          -- sha256(pepper || token)
  scopes        TEXT NOT NULL DEFAULT '[]',    -- JSON array (narrowing only)
  expires_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    TEXT
);
CREATE INDEX idx_tokens_hash ON access_tokens(token_hash);

-- ── Workspaces & membership ─────────────────────────────────
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  type          TEXT NOT NULL DEFAULT 'shared'
                CHECK (type IN ('shared','private','team')),  -- 'team' reserved
  owner_id      TEXT NOT NULL REFERENCES users(id),
  root_path     TEXT NOT NULL UNIQUE,
  git_enabled   INTEGER NOT NULL DEFAULT 1,
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE workspace_members (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'editor'
                CHECK (role IN ('owner','admin','editor','viewer')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, user_id)
);

-- Option 3 (dormant in v1; §8.3)
CREATE TABLE teams (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE team_members (
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE team_workspaces (
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, workspace_id)
);

-- ── Sessions ────────────────────────────────────────────────
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,              -- uuid; == transport session row
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  client_name   TEXT, client_version TEXT,     -- from initialize/User-Agent
  logical_label TEXT,                          -- set by session_create
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','ended','orphaned')),
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT
);

-- ── Planning ────────────────────────────────────────────────
CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  summary       TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('draft','active','completed','archived')),
  created_by    TEXT REFERENCES agents(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_task_id  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','blocked','done','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  position        INTEGER NOT NULL DEFAULT 0,
  assignee_agent  TEXT REFERENCES agents(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT
);
CREATE INDEX idx_tasks_plan   ON tasks(plan_id, status);
CREATE INDEX idx_tasks_ws     ON tasks(workspace_id, status);

-- ── Memory / project brain ──────────────────────────────────
CREATE TABLE memory_entries (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('note','decision','fact','instruction','handover')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array
  source_agent  TEXT REFERENCES agents(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_memory_ws ON memory_entries(workspace_id, kind);
-- Optional: FTS5 "memory_fts" added by migration 0002 only if the
-- node:sqlite build supports fts5; search falls back to LIKE otherwise.

-- ── Audit & processes ───────────────────────────────────────
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id),
  session_id    TEXT REFERENCES sessions(id),
  action        TEXT NOT NULL,                 -- 'file.write', 'task.done', …
  target        TEXT,                          -- path / entity id
  detail        TEXT NOT NULL DEFAULT '{}',    -- JSON, redacted
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_ws_time ON events(workspace_id, created_at);

CREATE TABLE processes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    TEXT REFERENCES sessions(id),
  agent_id      TEXT REFERENCES agents(id),
  command       TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','exited','killed','timed_out','denied','failed')),
  exit_code     INTEGER,
  stdout_path   TEXT,                          -- data/workspaces/<slug>/logs/<id>.stdout
  stderr_path   TEXT,
  bytes_out     INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT
);

-- ── Concurrency ─────────────────────────────────────────────
CREATE TABLE file_locks (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,                 -- relative POSIX path
  agent_id      TEXT REFERENCES agents(id),
  session_id    TEXT REFERENCES sessions(id),
  acquired_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL,
  UNIQUE (workspace_id, path)
);

-- ── Outputs / artifacts ─────────────────────────────────────
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,                 -- relative to workspace root
  kind          TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('report','log','build','export','snapshot','other')),
  description   TEXT,
  created_by    TEXT REFERENCES agents(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Retention: `events` pruned to 90 days (startup + daily timer); `processes` logs kept in `logs/` (filesystem-managed); backups (§19) are the real safety net.

---

## 11. MCP tool catalog (v1, 45 tools)

**Conventions**

- Every tool input is a zod schema; the JSON Schema shown to MCP clients is derived from it. This section shows compact JSON Schema.
- **Common optional param:** `workspace` (slug). Defaults to the session's bound workspace (`workspace_open`). Absent binding + absent param → `WORKSPACE_NOT_BOUND`.
- **Common read result:** files and brain/memory payloads include `hash` (sha256) for optimistic concurrency.
- Tool errors: `{ isError: true, content: [{type:"text", text: JSON.stringify({code, message, detail?})}] }` with `code` from the registry in §16.4.
- Scopes listed per tool. All write tools append an `events` row.

### 11.1 Workspace tools (6)

| Tool | Scope | Input schema (JSON) |
|---|---|---|
| `workspace_create` | `workspace:write` + owner membership implicit | `{ name: string(1..80), slug?: string(pattern ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$), description?: string(≤500), git_enabled?: boolean = true, type?: "shared" \| "private" = "shared" }` |
| `workspace_list` | `workspace:read` | `{ include_archived?: boolean = false }` → caller's workspaces only |
| `workspace_open` | `workspace:read` | `{ slug: string }` → binds session; returns workspace info + context pin (brain head, open task counts, recent events) |
| `workspace_info` | `workspace:read` | `{ workspace?: string }` → id, slug, name, root, counts (files/tasks/memory), git status, storage bytes |
| `workspace_switch` | `workspace:read` | `{ slug: string }` → rebind session (same validation as open) |
| `workspace_delete` | `workspace:delete` (admin) | `{ slug: string, confirm_slug: string }` → soft delete to `data/backups/deleted-*` + DB cascade |

### 11.2 File tools (7)

| Tool | Scope | Input schema |
|---|---|---|
| `file_read` | `files:read` | `{ path: string, offset?: number = 0, limit?: number = 2000 }` → `{ content, hash, bytes, truncated }`; images/PDF/binary → `{ binary: true, hash, bytes, mime }` (no inline content) |
| `file_write` | `files:write` | `{ path: string, content: string, expected_hash?: string, create_dirs?: boolean = true }` — atomic; `expected_hash` mismatch → `HASH_CONFLICT` |
| `file_edit` | `files:write` | `{ path: string, old_string: string, new_string: string, expected_hash?: string, replace_all?: boolean = false }` — unique match required unless `replace_all`; 0 matches → `NO_MATCH`, >1 → `AMBIGUOUS_MATCH` |
| `file_delete` | `files:delete` (admin) | `{ path: string, recursive?: boolean = false, expected_hash?: string }` — reserved names forbidden |
| `file_move` | `files:write` | `{ from: string, to: string, overwrite?: boolean = false, expected_hash?: string }` |
| `file_list` | `files:read` | `{ path?: string = ".", recursive?: boolean = false, max_entries?: number = 1000 }` → entries `{name, type, bytes, mtime, hash?}` |
| `file_search` | `files:read` | `{ pattern: string(glob), path?: string = ".", content_query?: string, max_results?: number = 200 }` → glob on names and/or substring/regex content scan (ripgrep-style, bounded) |

### 11.3 Memory / Brain tools (7)

| Tool | Scope | Input schema |
|---|---|---|
| `brain_read` | `memory:read` | `{ workspace?, section?: string }` → full Brain.md or one `## section` |
| `brain_update` | `memory:write` | `{ workspace?, section: string, content: string, mode: "append" \| "replace" }` — section-addressed edit of Brain.md; atomic |
| `memory_add` | `memory:write` | `{ workspace?, kind?: enum note\|decision\|fact\|instruction\|handover = "note", title: string(1..200), content: string(≤20k), tags?: string[] }` |
| `memory_read` | `memory:read` | `{ workspace?, id: string }` |
| `memory_update` | `memory:write` | `{ workspace?, id: string, title?, content?, kind?, tags? }` |
| `memory_search` | `memory:read` | `{ workspace?, query: string, kind?: enum, tag?: string, limit?: number = 20 }` → FTS5 if available else LIKE; returns ranked entries |
| `decision_record` | `memory:write` | `{ workspace?, title: string, decision: string, rationale: string, alternatives?: string[] }` — writes `memory_entries(kind='decision')` **and** appends a dated bullet under `## Decisions` in Brain.md |

### 11.4 Planning tools (8)

| Tool | Scope | Input schema |
|---|---|---|
| `plan_create` | `planning:write` | `{ workspace?, title: string(1..200), summary?: string(≤4k) }` → new active plan; re-renders PLAN.md |
| `plan_read` | `planning:read` | `{ workspace?, plan_id?: string }` → active plan (or given) as structured JSON + rendered markdown |
| `plan_update` | `planning:write` | `{ workspace?, plan_id: string, title?, summary?, status?: enum draft\|active\|completed\|archived }` |
| `plan_list` | `planning:read` | `{ workspace?, status?: enum }` → all plans with task counts |
| `task_create` | `planning:write` | `{ workspace?, plan_id?: string(default active), title: string, description?: string, parent_task_id?: string, priority?: 1..5 = 3, assignee_agent?: string }` — re-renders PLAN.md |
| `task_update` | `planning:write` | `{ workspace?, task_id: string, title?, description?, status?: enum, priority?, assignee_agent?, position? }` |
| `task_complete` | `planning:write` | `{ workspace?, task_id: string, note?: string }` → sets done + `completed_at`; if plan has no open tasks → plan auto `completed` (returns `plan_completed: true`) |
| `task_list` | `planning:read` | `{ workspace?, plan_id?, status?: enum, parent_task_id?: string, limit?: number = 100 }` |

### 11.5 Execution tools (4)

| Tool | Scope | Input schema |
|---|---|---|
| `terminal_execute` | `exec:run` | `{ workspace?, command: string(1..4000), cwd?: string = "." (jail-checked), timeout_ms?: number = 120000, env?: Record<string,string> (merged over scrubbed base) }` → returns `{ process_id, status }` immediately for long runs; `wait?: boolean = true` with `wait_ms ≤ 30s` for short commands to also return final output inline |
| `terminal_output` | `exec:run` | `{ workspace?, process_id: string, stream?: enum stdout\|stderr\|both = "both", offset_bytes?: number = 0, max_bytes?: number = 65536 }` — incremental read from log files |
| `terminal_status` | `exec:run` | `{ workspace?, process_id: string }` → state, exit_code, elapsed, bytes captured |
| `terminal_stop` | `exec:kill` (admin) | `{ workspace?, process_id: string, signal?: enum SIGTERM\|SIGKILL = "SIGTERM" }` |

Execution constraints (§14): denylist always on; `cwd` jail; default timeout 120 s, hard cap 600 s; max 5 concurrent processes per workspace (6th → `CONCURRENCY_LIMIT`); output captured to `logs/<process_id>.{stdout,stderr}` + 64 KB ring buffer in memory; env scrubbed of everything except a minimal safe set + caller-provided keys (never the server's own `.env`).

### 11.6 Session & agent tools (6)

| Tool | Scope | Input schema |
|---|---|---|
| `agent_register` | `sessions:write` | `{ workspace?, name: string(1..80), kind?: enum agent\|cli\|web\|other = "agent" }` → idempotent upsert by `(user, name)`; returns agent id |
| `agent_list` | `sessions:read` | `{ workspace? }` → agents with recent activity |
| `session_create` | `sessions:write` | `{ workspace?, label: string(1..120) }` → names the current transport session (logical work session) |
| `session_list` | `sessions:read` | `{ workspace?, status?: enum active\|ended = "active", limit?: number = 50 }` |
| `session_status` | `sessions:read` | `{ workspace?, session_id?: string = current }` → binding, counters (files touched, tasks completed), last seen |
| `session_history` | `sessions:read` | `{ workspace?, session_id?: string, since?: ISO-8601, limit?: number = 100 }` → event-log view |

### 11.7 Output tools (4)

| Tool | Scope | Input schema |
|---|---|---|
| `output_save` | `outputs:write` | `{ workspace?, source_path: string, kind?: enum report\|log\|build\|export\|snapshot\|other = "other", description?: string, move?: boolean = false }` — registers artifact (file already inside workspace outputs/) |
| `output_list` | `outputs:read` | `{ workspace?, kind?: enum, limit?: number = 100 }` |
| `output_read` | `outputs:read` | `{ workspace?, artifact_id: string }` → content (≤5 MB) or `{binary:true,…}` |
| `output_export` | `outputs:read` | `{ workspace?, paths: string[] }` → creates `outputs/export-<ts>.tar.gz`, registers artifact; returns id + bytes (agent fetches via `output_read` if small, else copies out via its own channel) |

### 11.8 Lock tools (3, Phase 6)

| Tool | Scope | Input schema |
|---|---|---|
| `lock_acquire` | `files:write` | `{ workspace?, path: string, ttl_seconds?: 30..3600 = 300 }` → `{ lock_id, expires_at }`; held by another → `LOCKED` |
| `lock_release` | `files:write` | `{ workspace?, path?: string, lock_id?: string }` |
| `lock_list` | `files:read` | `{ workspace? }` |

### 11.9 Tool count by phase

| Phase | Tools delivered |
|---|---|
| 1 | `workspace_info` only (auth + connection proof) + `/health` |
| 2 | workspace_create/list/open/switch/delete, all 7 file tools |
| 3 | brain_read, brain_update, memory_add/read/update/search, decision_record |
| 4 | plan_create/read/update/list, task_create/update/complete/list (+auto PLAN.md) |
| 5 | terminal_execute/output/status/stop |
| 6 | agent_register/list, session_create/list/status/history, lock_acquire/release/list |
| 7 | output_save/list/read/export + hardening |

---

## 12. MCP resources & prompts

### 12.1 Resources

| URI | MIME | Content |
|---|---|---|
| `workspace://current` | application/json | Workspace summary (id, slug, root, counts, git status) |
| `workspace://current/brain` | text/markdown | Brain.md |
| `workspace://current/plan` | text/markdown | PLAN.md (rendered) |
| `workspace://current/tasks` | application/json | Open tasks (pending/in_progress/blocked), ordered by priority |
| `workspace://current/activity` | application/json | Last 50 events |
| `workspace://current/files/{path}` | text/plain | Read-only file template (≤256 KB; larger → error) |

Resources are read-only views; mutations go through tools (keeps audit uniform).

### 12.2 Prompts (5)

| Prompt | Purpose / arguments |
|---|---|
| `coding_session_start` | Bootstrap ritual: read brain/plan/tasks, report state, propose next steps. Args: `workspace` |
| `project_analysis` | Deep-dive a repo in the workspace; write findings to memory. Args: `workspace`, `focus?` |
| `implementation_plan` | Turn an objective into plan + tasks; approval gate before coding. Args: `workspace`, `objective` |
| `code_review` | Review a diff/range; write decisions. Args: `workspace`, `scope?` |
| `session_handover` | Summarize session → `memory_add(kind="handover")` + task notes for the next agent. Args: `workspace` |

### 12.3 Example: `coding_session_start` (verbatim logic)

Instructs the agent to: (1) `workspace_open`, (2) read `workspace://current/brain`, `workspace://current/plan`, `workspace://current/tasks`, (3) state current state + blockers, (4) propose the next task, (5) **wait for user approval before editing or executing**. This mirrors the project's approval-gate principle.

---

## 13. Agent instruction system

MCP alone never redirects an agent's native filesystem. Compliance comes from **three layers**, all shipped together:

### 13.1 Server `instructions` (automatic for all clients)

Passed to `McpServer({…, instructions })` at initialize:

> "This server owns the UNIVERSAL remote workspace. If you were pointed at a specific project, it is likely the bound workspace. Rules: (1) Treat the MCP workspace as the only source of truth for project files/memory/plans/outputs. (2) Never silently create a local copy of a project. (3) Read memory + plan before editing. (4) Create/update tasks via planning tools. (5) Use file tools for project files and terminal tools for execution — not your native shell/filesystem. (6) Record decisions and hand over via memory tools. (7) If a tool reports HASH_CONFLICT or LOCKED, re-read and retry — never overwrite blindly."

### 13.2 Per-client bootstrap prompt (Appendix A)

Ready-to-paste instruction block per agent (OpenCode / Claude Code / Codex) — the refined version of your section-3 prompt, including workspace name, approval gate, and the 8 rules.

### 13.3 In-repo agent rules file

On `workspace_create`, seed `PROJECT.md` containing a short "Agent protocol" section (same rules, project-specific placeholders) so agents that read the repo also see them.

---

## 14. Execution engine (restricted remote terminal)

Termux gives us **no container isolation**. The honest model:

**Layer 1 — Command policy (`policy/command-policy.ts`)**

- **Denylist (always on), matched on normalized command:** `rm -rf /` & equivalents at root/home, `mkfs*`, `dd … of=/dev/`, fork bombs, `shutdown|reboot|poweroff|halt`, `:(){`, writes to raw devices, `passwd`/`su `, pipe of network script into `sh` (`curl … | sh`), `git push --force` to `main` outside an explicit `allow_force_push:true` flag.
- **Modes** (`EXEC_MODE` env): `disabled` (tool returns `EXEC_DISABLED`) | **`restricted`** (default: denylist + jail + limits) | `allowlist` (only `ALLOWED_COMMANDS` prefixes, e.g. `npm`, `git`, `node`, `ls` — for high-risk periods).
- Denied → audit event `exec.denied` + `status='denied'` row; never executed.

**Layer 2 — Jail & limits**

- `cwd` must resolve inside the workspace root (same `safeResolve` rules).
- Timeout default 120 s, hard cap 600 s (SIGKILL on expiry → `status='timed_out'`).
- ≤5 concurrent processes per workspace; ≤256 KB captured per stream (then truncated, flagged `bytes_out`); ring buffer 64 KB for inline reads.
- `env`: base set is minimal (`PATH`, `HOME`, `LANG`, workspace vars). Server secrets (`TOKEN_PEPPER`, tunnel creds) are **never** inherited. User `env` keys merged over base; keys matching `(?i)(secret|token|key|password)` are passed only if `allow_sensitive_env:true` on the call (default false) and are redacted in logs.

**Layer 3 — Identity & audit**

- Process row carries `(workspace_id, session_id, agent_id)`; every denial/kill is an event.
- Logs streamed to `logs/<process_id>.stdout|.stderr` (files) + `processes` row points at them.

**Documented residual risks:** terminal runs as the Termux UID and can read anything that UID can (e.g. `~/.ssh`). Mitigations: agents don't get arbitrary interactive shells; commands are logged + reviewable; secrets should never live in Termux home; rotating `TOKEN_PEPPER` invalidates all tokens. A `proot`-based chroot is a possible Phase 8 hardening — evaluated, not promised.

---

## 15. Concurrency & conflict prevention

**Model: optimistic concurrency + short-lived locks.**

1. Every `file_read` returns `hash`. `file_write`/`file_edit` with `expected_hash` → mismatch → `HASH_CONFLICT` (nothing written). Without it, last write wins but is fully audited — agents are instructed (§13) to always pass it.
2. `file_edit` semantics additionally require unique match → accidental cross-edit of wrong region is impossible.
3. `file_locks` (Phase 6): explicit mutex per path with TTL (default 300 s, max 3600 s). Locked by another agent → `LOCKED` with `held_by` + `expires_at`. Expired locks lazily reaped.
4. Writes are atomic (tmp + fsync + rename) → no torn files even on crash/battery pull.
5. Multi-writer plan edits: `task_update` uses `updated_at` compare-and-set when `expected_updated_at` is supplied; else last-write-wins + event.
6. Conflict *detection* cross-agent: `session_history`/`workspace://current/activity` lets agents see "who touched what" before writing — this is social, protocol-level hygiene, backed by hard hashes.

---

## 16. API contracts & error model

### 16.1 `GET /health`

```
200 OK
{ "status": "ok", "version": "0.1.0", "uptime_s": 1234 }
```

No auth, no internals, < 2 ms. Used by watchdog (§19.3).

### 16.2 Auth failures (non-MCP plumbing layer)

```
401 { "error": { "code": "UNAUTHORIZED", "message": "missing or invalid bearer token" } }
    WWW-Authenticate: Bearer realm="universal-mcp"
429 { "error": { "code": "RATE_LIMITED", ... } }   (+ Retry-After)
```

### 16.3 MCP-layer failures

- **Protocol errors** (bad JSON-RPC, unknown session): standard JSON-RPC errors (`-32700`, `-32600`, `-32001`).
- **Tool/business failures**: HTTP 200 with `isError:true` tool result whose text is `JSON.stringify({code, message, detail?})` — agents can parse and react.

### 16.4 Error code registry

`UNAUTHORIZED` · `FORBIDDEN` · `WORKSPACE_NOT_FOUND` · `WORKSPACE_NOT_BOUND` · `WORKSPACE_ARCHIVED` · `VALIDATION` · `NOT_FOUND` · `HASH_CONFLICT` · `AMBIGUOUS_MATCH` · `NO_MATCH` · `LOCKED` · `PATH_ESCAPE` · `RESERVED_NAME` · `TOO_LARGE` · `EXEC_DENIED` · `EXEC_DISABLED` · `TIMEOUT` · `CONCURRENCY_LIMIT` · `RATE_LIMITED` · `CONFLICT` (generic CAS) · `INTERNAL`

### 16.5 Session semantics

`DELETE /mcp` ends the transport session → DB row `status='ended'`. Server crash → row stays `active` → on boot, `active` rows older than shutdown time are marked `orphaned` (startup reaper, idempotent).

---

## 17. Security model summary

| Threat | Mitigation |
|---|---|
| Unauthenticated access | Bearer on every route except `/health`; tunnel provides no bypass |
| Token leak (logs/git) | Hashed at rest (+pepper); prefix `umcp_`; log redaction (Phase 7); `.env` git-ignored; docs tell agents never to print tokens |
| Cross-workspace access | Per-workspace membership/role; `private` type; slug-scoped queries everywhere |
| Path traversal / symlink escape | `safeResolve` (§9); reserved names; root==project |
| Command injection / catastrophic commands | Policy layers (§14); not a general shell |
| Concurrent overwrite | §15 (hash CAS + locks + atomic rename) |
| Tunnel subdomain takeover | Named tunnel tied to your Cloudflare zone; quick tunnels never for real use |
| DoS via huge outputs/files | Caps everywhere (4 MB body, 5 MB file, 256 KB/stream, 30 s request) |
| Supply chain | Minimal pure-JS deps (§Appendix B); `npm audit` gate in Phase 7 |
| Secret exposure inside projects | `redact.ts` on logs/events; `.mcpignore` semantics for export; agents instructed (§13) not to commit secrets |

**Explicitly out of scope for v1:** OAuth full flow, per-user rate quotas beyond token bucket, WAF, multi-process scale-out, and encryption-at-rest of `data/` (Android/Termux fs is the boundary; Termux:Boot devices should use device encryption — documented in runbook).

---

## 18. Termux deployment & operations

### 18.1 One-time setup

```bash
pkg update && pkg install nodejs git cloudflared tmux
npm install -g npm@latest          # optional
termux-wake-lock                   # keep CPU awake while server runs
```

### 18.2 App install & build

```bash
cd ~/UNIVERSAL-MCP
cp .env.example .env               # then edit: HOST, PORT, DATA_DIR, TOKEN_PEPPER (openssl rand -base64 48)
npm ci
npm run build
```

### 18.3 Run under tmux (survives terminal close)

```bash
tmux new -d -s umcp 'cd ~/UNIVERSAL-MCP && node dist/index.js >> data/backups/server.log 2>&1'
termux-wake-lock
```

### 18.4 Auto-start on boot — `~/.termux/boot/start-umcp.sh` (needs Termux:Boot app)

```bash
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
killall -9 cloudflared 2>/dev/null
tmux kill-session -t umcp 2>/dev/null
tmux new -d -s umcp 'cd ~/UNIVERSAL-MCP && node dist/index.js'
tmux new -d -s umcp-tunnel 'cloudflared tunnel run umcp'
```

### 18.5 Cloudflare named tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create umcp
cloudflared tunnel route dns umcp mcp.<your-domain>
# ~/.cloudflared/config.yml →
#   tunnel: <TUNNEL_ID>
#   credentials-file: /data/data/com.termux/files/home/.cloudflared/<TUNNEL_ID>.json
#   ingress:
#     - hostname: mcp.<your-domain>
#       service: http://127.0.0.1:3333
#     - service: http_status:404
tmux new -d -s umcp-tunnel 'cloudflared tunnel run umcp'
```

Tunnel reconnects automatically on network changes; blip in connectivity = re-established SSE sessions (clients re-initialize).

### 18.6 Alternatives

- **Quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:3333`): instant, ephemeral URL — tests only.
- **Tailscale** on phone + agents' machines: no public URL at all; strongest privacy posture; ACL-scoped. Recommended end-state if the audience stays "my own devices + my own agents".

### 18.7 Known Termux constraints (write these on the wall)

- Phone off / no network / Android kills Termux → server down. Wake-lock + battery-optimization exemption + Termux:Boot mitigate, never eliminate.
- No Docker/podman → execution is restricted, not sandboxed (§14).
- I/O is flash; SQLite WAL is safe but don't put `data/` on `/sdcard` (also breaks `fsync` guarantees and watchdog scripts).
- Survive gracefully: `tmux`, `watchdog.sh` (cron or Termux:Boot loop: `curl -f 127.0.0.1:3333/health || tmux send-keys …`), nightly backup.
- Long-term 24×7 → same codebase deploys to any VPS (env vars only). Architecture is deliberately host-agnostic; Termux is the first host, not a prison.

---

## 19. Backup, recovery & monitoring

### 19.1 Backup (`scripts/backup.sh`)

1. `VACUUM INTO 'data/backups/db-<date>.sqlite'` (consistent snapshot, no lock issues).
2. `tar -czf data/backups/workspaces-<date>.tar.gz -C data workspaces Brain.md…` (whole tree).
3. Retain 14 daily + 4 weekly; upload target (optional) — `rclone` to a cloud bucket recommended, never the same phone only.
4. Also `git` remotes per workspace (private repos under your account) = continuous file backup for free; push from `watchdog.sh` on success of builds? No — **push is an agent/user action**, never implicit from the server.

### 19.2 Restore

`scripts/restore.md`: stop server → replace `data/` from tar → drop in db snapshot or run `sqlite3` restore → start → `workspace_info` sanity check per workspace.

### 19.3 Monitoring

- Local: `watchdog.sh` (loop every 60 s): `/health` fail → tmux restart → log.
- External (free): UptimeRobot/healthchecks.io pinging `https://mcp.<domain>/health` → alert if down (catches phone/tunnel/ISP failures).
- Log review: `data/backups/server.log` (pino JSON) — `jq` recipes in README.

### 19.4 Startup reaper (idempotent)

On boot: mark `sessions.active → orphaned` where `last_seen_at < boot_time - 5 min`; mark `processes.running → failed` similarly; reap expired `file_locks`; WAL checkpoint; verify each workspace root exists (missing root → mark + event, never crash).

---

## 20. Testing strategy & checklist mapping

### 20.1 Layers

- **Unit (vitest):** `safeResolve` (traversal matrix), command policy (deny/allow corpus), planner transitions, token hash/verify, PLAN.md renderer, redaction.
- **Integration:** boot server on port 0 in CI-like env; real `@modelcontextprotocol/sdk` client over Streamable HTTP; auth matrix (missing/expired/revoked token, wrong scope, wrong workspace); file roundtrip + `HASH_CONFLICT` path; process kill; lock TTL expiry.
- **Compatibility (manual, Phase 7):** OpenCode, Claude Code, Codex CLI — connect with each appendix-A snippet; run `coding_session_start`; verify identical workspace view from two agents concurrently.
- **Soak:** 24 h wake-locked run with hourly self-check event; battery drain logged.

### 20.2 Your acceptance checklist → where it's proven

| # | Test | Phase | How |
|---|---|---|---|
| 1 | Termux restart → data remains | 2+7 | Reboot drill; `data/` untouched; WAL recovery |
| 2 | Server restart → workspace restored | 2 | tmux kill + start; DB state intact |
| 3 | OpenCode connects | 1/2 | Appendix A snippet |
| 4 | Second agent connects | 2/6 | Claude Code + OpenCode same workspace |
| 5 | Agent A write → Agent B sees | 2 | `file_write` then `file_read` from B; hash differs |
| 6 | Plan creation persisted | 4 | `plan_create` → restart → `plan_read` |
| 7 | Memory update visible next session | 3 | `brain_update` → new session → `brain_read` |
| 8 | Long-running process trackable | 5 | `npm run build`-like 5-min task; `terminal_status` polls |
| 9 | Unauthorized connection rejected | 1 | curl with no/bad token → 401 |
| 10 | Simultaneous edits → conflict detected | 6 | Two agents, stale `expected_hash` → `HASH_CONFLICT` |
| 11 | Network interruption recoverable | 7 | Tunnel kill → restore; client re-init; no data loss |

---

## 21. Development roadmap

Do not start a phase until the previous exits green. Every phase = code + tests + the relevant checklist rows.

### Phase 1 — MCP Foundation *(local proof)*

Deliver: repo scaffold, `env.ts`, token auth middleware, `/health`, Streamable HTTP `/mcp` with `initialize`, one tool (`workspace_info` minimal: server version + uptime), `events` table, pino logging, `npm run build`, tmux start script.
**Exit:** `curl` health OK; `initialize` + tool call from a real MCP client over localhost with token; unauthorized → 401.

### Phase 2 — Shared Workspace

Deliver: SQLite schema `0001`, repositories, `workspace_create/list/open/info/switch/delete`, all `file_*` tools with safeResolve + atomic writes + hashes, git init per workspace, workspace seeding (Brain/PROJECT/PLAN + outputs/logs).
**Exit:** tests 1, 2, 3, 4, 5, 9 pass. Two agents interleave reads/writes.

### Phase 3 — Project Brain / Memory

Deliver: `brain_read/update` (section-addressed, atomic), `memory_add/read/update/search` (LIKE first, FTS5 if build supports), `decision_record`, `PROJECT.md` agent protocol, `session_handover` prompt.
**Exit:** test 7 passes; handover prompt round-trip verified.

### Phase 4 — Planning Engine

Deliver: `plan_create/read/update/list`, `task_create/update/complete/list`, subtasks, auto PLAN.md render, `plan_completed` detection.
**Exit:** test 6 passes; approval-gate prompt (`implementation_plan`) produces persisted tasks.

### Phase 5 — Execution Engine

Deliver: `terminal_execute/output/status/stop`, policy layer, jail, limits, log capture, denied-exec audit, `EXEC_MODE` switch.
**Exit:** test 8 passes; `cat ~/.ssh/…`-class commands denied & logged; npm test / git status run fine.

### Phase 6 — Multi-Agent Collaboration

Deliver: `agent_register/list`, `session_create/list/status/history`, `lock_acquire/release/list`, orphan reaper, `events` activity resource.
**Exit:** test 10 passes; `session_history` shows both agents' edits; lock contention behaves.

### Phase 7 — Production Readiness

Deliver: `output_save/list/read/export`, backup/restore scripts, watchdog + wake-lock + boot scripts, cloudflared named tunnel + DNS, log redaction, audit pruning, npm audit gate, README runbook, full 11-test matrix, compatibility verification across OpenCode / Claude Code / Codex CLI.
**Exit:** all 11 tests green; 24 h wake-locked soak; restore drill from backup succeeded.

**Phase 8+ (designed-for, not built):** Option 3 teams/private tools, Tailscale profile, proot sandbox, OAuth device flow, VPS deployment profile, web dashboard, multi-process (SQLite → Postgres).

---

## 22. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| Android kills Termux / phone restarts | H | M | wake-lock, battery exemption, Termux:Boot, tmux, watchdog, backups |
| ISP/network drops mid-session | H | L | Tunnel auto-reconnect; clients re-init; sessions resumable by design |
| Unauthorized use of leaked URL | L | H | Always-on bearer auth; token hashing; revoke-by-id; rate limit |
| Agent ignores instructions, uses local FS | M | M | §13 three-layer; server instructions; PROJECT.md protocol; obvious `workspace_open` nudges in tool responses |
| Accidental destructive command | L | H | §14 denylist + `staging`/`allowlist` mode; admin scope for kill/delete |
| SQLite corruption on power loss | L | M | WAL + fsync + VACUUM INTO backups; restore runbook |
| `/sdcard` misuse by agents | M | M | Tools only ever see workspace roots; `/sdcard` unreachable through path jail |
| Scope creep to public SaaS | — | — | Non-goals §23; authz already multi-user-ready but v1 = personal |
| Client protocol drift (MCP spec changes) | M | L | SDK tracks spec; pin SDK; compatibility suite in Phase 7 re-runs per release |

---

## 23. Non-goals (v1)

- Web UI / dashboard (CLI + MCP only)
- Public multi-tenant signup, billing, OAuth issuer (seam exists, unimplemented)
- Docker/rootless containers (impossible on Termux)
- End-to-end encryption of workspace content at rest
- Real-time collaborative cursors/CRDTs (locks + hashes are the model)
- Running CI/CD pipelines (agents may *trigger* builds via execution; orchestration is theirs)

---

## 24. Open questions for review

1. **Workspace root layout** — approve "root = project root" with reserved top-level names (`Brain.md`, `PROJECT.md`, `PLAN.md`, `outputs/`, `logs/`)? (Alternative: everything under `files/` like the early sketch — I recommend against it: breaks git ergonomics and agent familiarity.)
2. **PLAN.md auto-render** — should every plan/task write regenerate `PLAN.md` atomically, or only on `plan_read`? (My recommendation: auto-render.)
3. **Named tunnel + domain** — do you have a Cloudflare-managed domain for `mcp.<domain>`? If not, Phase 7 falls back to quick tunnel for testing + Tailscale for real use.
4. **Token UX** — mint one token per agent now (recommended) or a single shared token for v1?
5. **FTS5** — if `node:sqlite` build lacks FTS5, accept LIKE search (my recommendation for v1) or add `better-sqlite3` build burden?
6. **Git remotes** — do workspace projects get private GitHub remotes created/pushed by the server tooling, or is git strictly agent-driven via `terminal_execute`? (I recommend: agent-driven + optional `git.remote` config note in PROJECT.md.)
7. **Exec policy default** — ship `restricted` or `allowlist`? (Restricted recommended; allowlist as `.env` opt-in.)
8. **Backup destination** — local-only (`data/backups/`) or add an `rclone` remote (Drive/S3) in Phase 7?

---

## Appendix A. Agent connection & instruction snippets

### A.1 OpenCode

```jsonc
// ~/.config/opencode/opencode.json
{
  "mcp": {
    "universal-mcp": {
      "type": "remote",
      "url": "https://mcp.<your-domain>/mcp",
      "headers": { "Authorization": "Bearer umcp_xxx" },
      "enabled": true
    }
  }
}
```

### A.2 Claude Code

```bash
claude mcp add --transport http universal-mcp \
  https://mcp.<your-domain>/mcp \
  --header "Authorization: Bearer umcp_xxx"
```

### A.3 Codex CLI

```toml
# ~/.codex/config.toml  (verify against your codex version's docs)
[mcp_servers.universal-mcp]
url = "https://mcp.<your-domain>/mcp"
bearer_token_env_var = "UMCP_TOKEN"   # export UMCP_TOKEN=umcp_xxx in your shell
```

### A.4 Master instruction block (paste as first message / system)

```text
Connect to my MCP server (universal-mcp). Workspace: XCOMB.

IMPORTANT:
1. All project files must be stored in the MCP workspace.
2. Read existing project memory (brain_read, memory_search) before coding.
3. Open or create a plan and tasks before making changes (plan_create/task_create).
4. Use MCP file tools for all project file operations — never your local filesystem.
5. Execute commands through MCP terminal_* tools — never your native shell for project work.
6. Save all outputs and logs in the MCP workspace (outputs/, logs/).
7. Update project memory after completing work (brain_update / memory_add).
8. Never silently create a separate local project.
9. Pass expected_hash on writes; on HASH_CONFLICT re-read and retry.
10. Wait for my approval after presenting the plan, before editing code.
```

### A.5 Sample `coding_session_start` outcome

```text
Workspace XCOMB opened.
Brain: 3 active decisions (auth via tokens, SQLite WAL, restricted exec).
Plan "Phase 2 — Shared Workspace": 6 tasks, 2 done, 1 in_progress ("file_edit tool"), 3 pending.
Last activity: opencode-phone wrote src/core/filesystem.ts (12m ago).
Proposed next step: finish file_edit + add HASH_CONFLICT test. Awaiting your approval.
```

---

## Appendix B. Toolchain & dependencies (Phase 1)

**Runtime deps (pure JS, no native builds):** `@modelcontextprotocol/sdk`, `zod`, `pino`, `execa` (child processes; or raw `node:child_process` if you prefer zero-dep).
**Dev deps:** `typescript`, `tsx`, `vitest`, `@types/node`, `pino-pretty`.
**Built-ins used:** `node:sqlite`, `node:crypto`, `node:fs/promises`, `node:http` (or SDK's transport on `http.createServer`), `--env-file`.
**System:** `git`, `tmux`, `cloudflared` (apt via `pkg`), `termux-wake-lock`.
**Scripts:** `dev` = `tsx watch --env-file=.env src/index.ts` · `build` = `tsc` · `start` = `node --env-file=.env dist/index.js` · `test` = `vitest run`.

---

*End of document. Review sign-off required on §24 items before Phase 1 begins.*
