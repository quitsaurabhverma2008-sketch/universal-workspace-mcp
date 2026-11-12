/**
 * Seed the shared 'duo-demo' workspace for the two-agent collaboration test:
 * mission brain + plan + 4 claimable tasks. Idempotent-ish: workspace_create
 * is skipped if it already exists (re-open then).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = process.env.UMCP_TOKEN;
if (!TOKEN) { console.error("set UMCP_TOKEN (admin)"); process.exit(1); }

const client = new Client({ name: "seed-duo", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  try { return { isErr: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { isErr: Boolean(res.isError), data: text as unknown as Record<string, unknown> }; }
};

// workspace (skip error if already exists)
let res = await call("workspace_create", { name: "Duo Demo — DuoHome Static Site", slug: "duo-demo", description: "Two agents collaborate on one static personal homepage via MCP", git_enabled: true });
console.log("workspace_create:", res.isErr ? JSON.stringify(res.data).slice(0, 150) : `ok (${res.data.slug})`);
res = await call("workspace_open", { slug: "duo-demo" });
console.log("workspace_open:", res.isErr ? "ERR" : "ok");

// brain: mission + rules for the two agents
await call("brain_update", {
  section: "Mission",
  content: "Build 'DuoHome' — a small static personal homepage in this workspace: index.html, styles.css, app.js, README.md. Two agents (duo-agent-1, duo-agent-2) collaborate on ONE project via MCP. Coordinate through task_claim, locks and expected_hash — never overwrite blindly. Acceptance: open index.html, you see a dark page with live clock; README documents the project.",
  mode: "replace",
});

// plan + tasks (claimable, unassigned)
res = await call("plan_create", { title: "DuoHome v1", summary: "Static personal homepage built collaboratively by two MCP agents." });
console.log("plan:", res.isErr ? "ERR" : res.data.id);

const tasks: Array<{ title: string; priority: number; description: string }> = [
  { title: "index.html — semantic DuoHome page (header nav, hero, projects grid, footer)", priority: 1, description: "Dark-friendly semantic HTML5. Link styles.css and app.js. Include a live clock element with id=clock." },
  { title: "styles.css — dark theme, responsive layout", priority: 2, description: "CSS variables, grid or flexbox, mobile breakpoint @media (max-width: 720px), smooth links." },
  { title: "app.js — live clock + theme toggle + console greeting", priority: 3, description: "Vanilla JS only. Render time into #clock every second; dark/light toggle button toggling body class." },
  { title: "README.md — what it is, how to view, how DuoHome/who built it", priority: 4, description: "Short, honest doc. Mention built by two MCP agents (duo-agent-1, duo-agent-2)." },
];
for (const t of tasks) {
  const r = await call("task_create", { title: t.title, description: t.description, priority: t.priority });
  console.log("task:", r.isErr ? "ERR" : (r.data.id as string).slice(0, 8), "—", t.title.slice(0, 40));
}
await client.close();
console.log("duo-demo seeded");
process.exit(0);
