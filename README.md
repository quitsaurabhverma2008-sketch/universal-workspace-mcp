# Universal Workspace MCP

A remote, persistent, multi-agent **coding workspace** exposed through the standard **MCP Streamable HTTP** protocol. Any MCP-compatible agent — OpenCode, Claude Code, Codex CLI — connects to one HTTPS URL and works *inside* this server: files, project memory (`Brain.md`), plans/tasks, outputs, logs and an audit trail all live on this machine, never on the agent's device.

- **Server is the source of truth.** Agents provide reasoning; this workspace provides persistence and execution.
- **Multi-project, shared access (Option 2)** with an Option 3-ready schema (teams/private workspaces) — see `docs/ARCHITECTURE.md`.
- **Restricted remote execution** — safety denylist, workspace-jailed cwd, timeouts, concurrency caps. No unrestricted shell is exposed.
- **47 MCP tools + 6 resources + 5 prompts**, all behind per-workspace roles and bearer tokens.

---

## 0. Status

Everything in Phases 1–7 is implemented and tested on this device:

| Area | Status |
|---|---|
| MCP Streamable HTTP server, health, auth (bearer + pepper) | ✅ |
| Workspaces, filesystem (atomic writes, hashes, locks), git init | ✅ |
| Brain.md + structured memory + decision records | ✅ |
| Plans/tasks with subtasks; auto-rendered PLAN.md | ✅ |
| Restricted execution engine + audit | ✅ |
| Agents/sessions + file locking + conflict detection | ✅ |
| Outputs/artifacts + export bundles | ✅ |
| 31 automated tests (unit + end-to-end) | ✅ |
| Backup & watchdog scripts | ✅ |
| Public HTTPS tunnel | ⚠️ scripts ready — **you** must log in once (see §6.4) |

A demo workspace `smoke-test` exists (created by the end-to-end smoke run). Archive it any time with the `workspace_delete` MCP tool (`confirm_slug=smoke-test`) or keep it to poke at.

## 1. Layout

```
~/UNIVERSAL-MCP/
├── src/            # TypeScript source (server, core, tools, resources, prompts)
├── dist/           # built output (npm run build)
├── data/           # ALL state — gitignored
│   ├── database.sqlite[-wal|-shm]
│   ├── workspaces/<slug>/   # Brain.md, PROJECT.md, PLAN.md, outputs/, logs/, .git, your files
│   ├── backups/             # db snapshots + workspace tarballs
│   ├── tmp/                 # atomic-write scratch
│   └── server.log
├── docs/ARCHITECTURE.md     # full design document
├── scripts/                 # start/stop/backup/watchdog/termux-boot/smoke
└── tests/                   # vitest unit + end-to-end integration
```

## 2. Quick start

```bash
cd ~/UNIVERSAL-MCP
npm install          # once
npm run setup        # once: writes .env (fresh TOKEN_PEPPER), seeds owner + admin token
npm run build
npm start            # http://127.0.0.1:3333/mcp   (Ctrl-C to stop)
```

`npm run setup` prints an **admin token once**. Save it — it is what your agents will use. Mint more any time:

```bash
npm run mint-token -- --name opencode-phone --agent opencode-phone
npm run mint-token -- --name readonly --agent viewerbot --scopes workspace:read,files:read
npm run list-tokens
npm run revoke-token -- <token-id>   # note the double dash for npm arg passing
```

Health check: `curl http://127.0.0.1:3333/health` → `{"status":"ok",...}`

## 3. Connecting an agent

Give the agent the URL and its own token. The agent then calls `workspace_open` first.

### OpenCode — `~/.config/opencode/opencode.json`
```jsonc
{
  "mcp": {
    "universal-mcp": {
      "type": "remote",
      "url": "https://mcp.<your-domain>/mcp",
      "headers": { "Authorization": "Bearer umcp_..." },
      "enabled": true
    }
  }
}
```

### Claude Code
```bash
claude mcp add --transport http universal-mcp \
  https://mcp.<your-domain>/mcp \
  --header "Authorization: Bearer umcp_..."
```

### Codex CLI — `~/.codex/config.toml`
```toml
[mcp_servers.universal-mcp]
url = "https://mcp.<your-domain>/mcp"
bearer_token_env_var = "UMCP_TOKEN"   # export UMCP_TOKEN=umcp_...
```

### Master instruction block (paste as the agent's first message / system prompt)
```text
Connect to my MCP server (universal-mcp). Workspace: XCOMB.

IMPORTANT:
1. All project files must be stored in the MCP workspace.
2. Read existing project memory before coding (brain_read, memory_search).
3. Open or create a plan and tasks before making changes (plan_create/task_create).
4. Use MCP file tools for all project file operations — never your local filesystem.
5. Execute commands through MCP terminal_* tools — never your native shell for project work.
6. Save all outputs and logs in the MCP workspace (outputs/, logs/).
7. Update project memory after completing work (brain_update / memory_add).
8. Never silently create a separate local project.
9. Pass expected_hash on writes; on HASH_CONFLICT re-read and retry.
10. Wait for my approval after presenting the plan, before editing code.
```

The MCP `initialize` response also carries `instructions` so compliant clients see the workspace rules automatically.

## 4. Tools (47)

**Workspace** — `workspace_create` `workspace_list` `workspace_open` `workspace_switch` `workspace_info` `workspace_delete`
**Files** — `file_read` `file_write` `file_edit` `file_list` `file_search` `file_move` `file_delete`
**Brain/Memory** — `brain_read` `brain_update` `memory_add` `memory_read` `memory_update` `memory_search` `memory_list` `decision_record`
**Planning** — `plan_create` `plan_read` `plan_update` `plan_list` `task_create` `task_update` `task_complete` `task_list` `project_status`
**Execution** — `terminal_execute` `terminal_output` `terminal_status` `terminal_stop`
**Agents/Sessions** — `agent_register` `agent_list` `session_create` `session_list` `session_status` `session_history`
**Outputs** — `output_save` `output_list` `output_read` `output_export`
**Concurrency** — `lock_acquire` `lock_release` `lock_list`

**Resources** — `workspace://current` · `workspace://current/brain` · `workspace://current/plan` · `workspace://current/tasks` · `workspace://current/activity` · `workspace://current/files/{path}`
**Prompts** — `coding_session_start` · `project_analysis` · `implementation_plan` · `code_review` · `session_handover`

Every mutating tool is audit-logged (`events` table) with agent + session identity.

## 5. Security model (short)

- **Auth**: `Bearer umcp_<random>` per agent. Stored as `SHA-256(pepper + token)`; pepper lives only in `.env` (mode 600). Tokens shown once at mint time.
- **Authorization**: per-workspace membership + roles (`viewer → editor → admin → owner`), each expanding scopes; token scopes can only *narrow* role scopes. `private` workspaces are owner-only. Server binds **loopback only** — public reach happens exclusively through your tunnel.
- **Rate limit**: 120 req/min per token (fixed window).
- **Path safety**: all file paths jailed to the workspace root (symlink-safe); reserved entries (`Brain.md`, `PLAN.md`, `PROJECT.md`, `outputs/`, `logs/`) are immutable via file tools.
- **Execution**: `EXEC_MODE` — `restricted` (default; denylist of catastrophic commands, cwd jail, 5 concurrent processes, output caps) or `allowlist` (only listed command prefixes) or `disabled`. No Docker on Termux — this is the honest ceiling. Build tools freely; system taming is not available from agents by design.
- **Concurrency**: atomic rename writes; `expected_hash` compare-and-swap on writes; TTL file locks; PLAN/tasks use compare-and-set on `updated_at`.

### Honest limitations (know these)

- **Termux is not guaranteed 24×7.** Phone off / no network / Android process death ⇒ server down. Wake-lock + battery-optimization exemption + Termux:Boot + `scripts/watchdog.sh` mitigate, never eliminate. For real 24×7, the same code deploys to a VPS unchanged.
- **Restart = new transport sessions.** MCP sessions after a restart are `orphaned`; agents must re-`initialize` (the client handles this) and re-`workspace_open`.
- **Terminal is not a sandbox** — it runs as your Termux UID. Secrets must not live in Termux home; tokens are hashed but host access is host access.
- A token leaks ⇒ full access it was granted. Mint one token per agent, revoke on suspicion.

## 6. Operations

### 6.1 tmux (already installed)
```bash
bash scripts/start.sh     # build + start 'umcp' tmux session + wake-lock
bash scripts/stop.sh
tmux attach -t umcp
```

### 6.2 Backup
```bash
bash scripts/backup.sh          # VACUUM INTO db snapshot + workspaces tarball, keep 14
```
**Restore**: stop server → `rm -rf data/workspaces data/database.sqlite*` → untar newest `data/backups/workspaces-*.tar.gz` → copy `db-*.sqlite` back as `data/database.sqlite` → `npm start`.

### 6.3 Watchdog (every 60 s)
Run from cron or a Termux:Boot loop:
```bash
bash scripts/watchdog.sh        # health check; restarts tmux session if down
```
Plus an external monitor (UptimeRobot/healthchecks.io) on `https://mcp.<your-domain>/health`.

### 6.4 Public URL via Cloudflare named tunnel (your one-time step)
```bash
cloudflared tunnel login                      # browser auth, once
cloudflared tunnel create umcp
cloudflared tunnel route dns umcp mcp.<your-domain>
# ~/.cloudflared/config.yml:
#   tunnel: umcp
#   credentials-file: /data/data/com.termux/files/home/.cloudflared/<TUNNEL_ID>.json
#   ingress:
#     - hostname: mcp.<your-domain>
#       service: http://127.0.0.1:3333
#     - service: http_status:404
cloudflared tunnel run umcp     # or a 'umcp-tunnel' tmux session
```
Then paste `https://mcp.<your-domain>/mcp` into your agents. **A public URL is not public access** — every request still requires a bearer token.

Quick but throwaway alternative: `cloudflared tunnel --url http://127.0.0.1:3333` (URL changes each run). Strongest privacy posture: Tailscale instead of any tunnel.

### 6.5 Termux:Boot (survive reboots)
```bash
mkdir -p ~/.termux/boot
cp scripts/termux-boot.sh ~/.termux/boot/start-umcp.sh
chmod +x ~/.termux/boot/start-umcp.sh
```
Plus: enable *Termux:Boot* and grant *Ignore battery optimizations* to Termux in Android settings.

### 6.6 Tests & compatibility
```bash
npm test                # 31 tests: paths, policy, brain sections, full HTTP+MCP workflow
npx tsx scripts/smoke.ts   # live smoke against a running server (needs SMOKE_TOKEN=...)
```
Compatibility matrix to run once the tunnel is live: OpenCode, Claude Code, Codex CLI — connect two of them to the same workspace and watch `session_history`.

## 7. Development

```bash
npm run dev            # tsx watch
npm run typecheck
npm run build          # tsc + copies schema.sql into dist/
npm run status         # db/user/workspace/session counters
```

Design doc: `docs/ARCHITECTURE.md` — directory layout, ADRs, full DDL, tool schemas, threat model, Phase 8+ (Option 3 teams, proot sandbox, OAuth, VPS profile).

Single-instance host by design (SQLite + in-memory process registry). Do not run two servers against the same `data/`.
