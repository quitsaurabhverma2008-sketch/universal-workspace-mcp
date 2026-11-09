/**
 * Self-agent demo: this agent connects to the Universal Workspace MCP over
 * Streamable HTTP (exactly like any remote agent would) and builds a small
 * real project end-to-end through MCP tools only.
 *
 * Usage: UMCP_TOKEN=umcp_... npx tsx scripts/self-agent-demo.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.UMCP_URL ?? "http://127.0.0.1:3333/mcp";
const TOKEN = process.env.UMCP_TOKEN;
if (!TOKEN) { console.error("set UMCP_TOKEN"); process.exit(1); }

const client = new Client({ name: "opencode-builder", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(BASE), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* raw */ }
  return { isErr: Boolean(res.isError), data: data as Record<string, unknown> };
};
const step = (label: string, r: { isErr: boolean; data: unknown }) => {
  const s = JSON.stringify(r.data);
  console.log(`\n▶ ${label}${r.isErr ? "  [ERROR]" : ""}\n  ${s.length > 300 ? s.slice(0, 300) + "…" : s}`);
  return r;
};

// ── 1. Identity + session ────────────────────────────────────────────
step("agent_register", await call("agent_register", { name: "opencode-builder", kind: "agent" }));
step("session_create", await call("session_create", { label: "build pocket-ledger demo" }));

// ── 2. Workspace ─────────────────────────────────────────────────────
let ws = await call("workspace_create", { name: "Pocket Ledger", slug: "pocket-ledger", description: "Zero-dependency Node.js CLI expense tracker (demo project built through MCP)" });
if (ws.isErr && String((ws.data as { message?: string }).message ?? "").includes("already")) {
  ws = await call("workspace_open", { slug: "pocket-ledger" });
} else {
  ws = await call("workspace_open", { slug: "pocket-ledger" });
}
step("workspace_open", ws);

// ── 3. Plan + tasks ──────────────────────────────────────────────────
const plan = step("plan_create", await call("plan_create", {
  title: "Pocket Ledger v1",
  summary: "Zero-dep Node CLI: add/list/total expenses in a local ledger.json.",
}));
const taskIds: string[] = [];
for (const [i, title] of ["Scaffold package + CLI entry", "Implement add/list/total commands", "Docs + git commit"].entries()) {
  const t = step(`task_create [${i + 1}]`, await call("task_create", { title, priority: i + 1 }));
  taskIds.push((t.data as { id: string }).id);
}

// ── 4. Write the project through MCP file tools ──────────────────────
step("file_write package.json", await call("file_write", {
  path: "package.json",
  content: JSON.stringify({
    name: "pocket-ledger",
    version: "1.0.0",
    description: "Zero-dependency Node.js CLI expense tracker",
    type: "module",
    bin: { "pocket-ledger": "src/cli.js" },
    scripts: { start: "node src/cli.js" },
    engines: { node: ">=18" },
    license: "MIT",
  }, null, 2) + "\n",
}));

step("file_write src/cli.js", await call("file_write", {
  path: "src/cli.js",
  content: `#!/usr/bin/env node
/** Pocket Ledger — zero-dependency CLI expense tracker. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LEDGER = new URL('../ledger.json', import.meta.url).pathname;
const load = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : []);
const save = (rows) => writeFileSync(LEDGER, JSON.stringify(rows, null, 2) + '\\n');

const [cmd, ...args] = process.argv.slice(2);

function fail(msg) { console.error('error: ' + msg); process.exit(1); }
function fmt(n) { return n.toFixed(2); }

switch (cmd) {
  case 'add': {
    const [item, amountRaw] = args;
    const amount = Number(amountRaw);
    if (!item) fail('usage: add <item> <amount>');
    if (!Number.isFinite(amount) || amount === 0) fail('amount must be a non-zero number');
    const rows = load();
    rows.push({ item, amount, at: new Date().toISOString() });
    save(rows);
    console.log(\`added: \${item} (\${fmt(amount)})\`);
    break;
  }
  case 'list': {
    const rows = load();
    if (rows.length === 0) { console.log('ledger is empty'); break; }
    rows.forEach((r, i) => console.log(\`\${String(i + 1).padStart(3)}. \${r.item.padEnd(20)} \${fmt(r.amount).padStart(10)}\`));
    break;
  }
  case 'total': {
    const sum = load().reduce((a, r) => a + r.amount, 0);
    console.log('total: ' + fmt(sum));
    break;
  }
  default:
    console.log('pocket-ledger — commands: add <item> <amount> | list | total');
}
`,
}));

step("file_write README.md", await call("file_write", {
  path: "README.md",
  content: `# Pocket Ledger

Zero-dependency Node.js CLI expense tracker. Ledger stored in \`ledger.json\` (gitignored).

\`\`\`bash
npm start -- add "chai" 20
npm start -- add "auto" 2400
npm start -- list
npm start -- total
\`\`\`

Built entirely through the Universal Workspace MCP (file_write, terminal_execute, task_*, decision_record).
`,
}));

step("file_write .gitignore", await call("file_write", { path: ".gitignore", content: "ledger.json\nnode_modules/\n" }));

// ── 5. Run it via remote execution ───────────────────────────────────
step("task_update 1 → in_progress", await call("task_update", { task_id: taskIds[0], status: "in_progress" }));
step("exec npm start add chai", await call("terminal_execute", { command: "npm start -- add 'chai' 20", wait: true }));
step("exec add auto", await call("terminal_execute", { command: "npm start -- add 'auto' 2400", wait: true }));
step("exec add book", await call("terminal_execute", { command: "npm start -- add 'book' 350", wait: true }));
step("task_update 2 → in_progress", await call("task_update", { task_id: taskIds[1], status: "in_progress" }));
const listed = step("exec list", await call("terminal_execute", { command: "npm start -- list", wait: true }));
step("exec total", await call("terminal_execute", { command: "npm start -- total", wait: true }));

// ── 6. Git commit inside the workspace ───────────────────────────────
step("git add + commit", await call("terminal_execute", { command: "git add -A && git -c user.name=opencode-builder -c user.email=builder@localhost commit -m 'Pocket Ledger v1' --quiet && git log --oneline", wait: true }));

// ── 7. Complete tasks, record decisions, hand over ───────────────────
step("task_complete 1", await call("task_complete", { task_id: taskIds[0], note: "scaffold done" }));
step("task_complete 2", await call("task_complete", { task_id: taskIds[1], note: "add/list/total verified via remote exec" }));
step("task_complete 3", await call("task_complete", { task_id: taskIds[2], note: "docs + git commit done" }));
step("decision_record", await call("decision_record", {
  title: "Zero-dependency Node CLI",
  decision: "No npm dependencies for Pocket Ledger",
  rationale: "Runs anywhere Node ≥18 exists, zero install friction, zero supply-chain surface",
  alternatives: ["commander.js (nicer UX, adds dep)", "Ink/React CLI"],
}));
step("brain_update Current State", await call("brain_update", {
  section: "Current State",
  content: "Pocket Ledger v1 complete: add/list/total work, git committed. Ledger is ledger.json (gitignored).",
  mode: "replace",
}));
step("memory_add handover", await call("memory_add", {
  kind: "handover",
  title: "Handover — pocket-ledger v1",
  content: "Project complete and committed. Next ideas: budgets, CSV import/export, categories. Run via npm start.",
}));

const status = step("project_status", await call("project_status", {}));
void plan; void listed; void status;

await client.close();
console.log("\n✔ self-agent demo finished — project built entirely over MCP");
process.exit(0);
