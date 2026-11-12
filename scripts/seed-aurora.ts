/**
 * Seed the 'aurora-home' workspace: mission + plan + 4 claimable tasks (P1..P4).
 * Timestamps every step; prints SEED_START for the timing harness.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = process.env.UMCP_TOKEN;
if (!TOKEN) throw new Error("set UMCP_TOKEN (admin)");
console.log("SEED_START", Date.now());

const client = new Client({ name: "seed-aurora", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  try { return { isErr: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { isErr: Boolean(res.isError), data: text as unknown as Record<string, unknown> }; }
};

const createRes = await call("workspace_create", {
  name: "Aurora — Personal Landing Page",
  slug: "aurora-showcase",
  description: "Fictional developer's personal landing page — built by 3 MCP agents in one shared workspace",
  git_enabled: true,
});
console.log("workspace_create:", createRes.isErr ? JSON.stringify(createRes.data).slice(0, 200) : `ok ${createRes.data.slug}`);
await call("workspace_open", { slug: "aurora-showcase" });

await call("brain_update", {
  section: "Mission",
  content:
    "Build 'AURORA' — personal landing page for a fictional systems engineer ('Aarav Rao'). " +
    "Static site: index.html (semantic page, hero, projects grid, footer with live clock + theme toggle), " +
    "styles.css (aurora dark theme, responsive, CSS variables, body[data-theme=light] supported), " +
    "app.js (canvas starfield + live clock + theme toggle), README.md. " +
    "THREE agents collaborate: agent-alpha (index.html), agent-beta (styles.css), agent-gamma (app.js). " +
    "A fourth task (README + integration) is an open race — first free agent takes it. " +
    "Coordinate with task claims (expected_updated_at CAS), locks, and expected_hash. Never overwrite blindly.",
  mode: "replace",
});

const plan = await call("plan_create", {
  title: "Aurora v1",
  summary: "Two-deliverable static personal landing page built by three MCP agents in one workspace.",
});
console.log("plan:", plan.isErr ? "ERR" : plan.data.id);

const tasks: Array<{ title: string; priority: number; description: string }> = [
  { title: "index.html — semantic AURORA landing page", priority: 1,
    description: "Header nav (logo AURORA, links Work/About/Contact), hero h1 'Building calm software.' + CTA, section#projects with 3 cards (Prism, Cirrus, notes-api), footer with span#local-time and button.theme-toggle. MUST link styles.css + app.js — beta and gamma depend on it." },
  { title: "styles.css — aurora dark theme, responsive", priority: 2,
    description: "CSS variables in :root (--bg, --accent, --card, --text), aurora radial-gradient background, cards with backdrop-filter, hover lift, @media (max-width: 720px) single column, body[data-theme=light] overrides." },
  { title: "app.js — starfield canvas, live clock, theme toggle", priority: 3,
    description: "Fullscreen <canvas> starfield with twinkling stars + occasional shooting star behind the content; #local-time footer clock via Intl.DateTimeFormat updated every second; .theme-toggle toggles body[data-theme] between aurora and light. Vanilla JS, no dependencies. Must reference #local-time and .theme-toggle (alpha defines them)." },
  { title: "README.md — doc + cross-file integration check", priority: 4,
    description: "Short doc: what the page is, how to open (file://), how the three agents built it. Integration check: grep index.html for styles.css/app.js links, README mentions #local-time and .theme-toggle exist in app.js/index.html — fix mismatches (file_edit) if any. Commit as your own agent." },
];

for (const t of tasks) {
  const r = await call("task_create", { title: t.title, description: t.description, priority: t.priority });
  console.log("task:P" + t.priority, r.isErr ? "ERR " + JSON.stringify(r.data).slice(0, 120) : (r.data.id as string).slice(0, 8));
}
console.log("SEED_END", Date.now());
await client.close();
process.exit(0);
