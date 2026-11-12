/**
 * Trio agent worker — runs as an independent MCP client.
 *
 *   UMCP_TOKEN=<agent token> AGENT_NAME=agent-alpha npx tsx scripts/trio-agent.ts
 *
 * Behaviour: register → open aurora-home → loop: claim lowest-priority pending
 * unassigned task via compare-and-set (expected_updated_at) → do the work via
 * MCP tools → verify → git commit as the agent → task_complete → repeat.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = process.env.UMCP_TOKEN;
const AGENT = process.env.AGENT_NAME;
if (!TOKEN || !AGENT) throw new Error("set UMCP_TOKEN and AGENT_NAME");

const log = (...a: unknown[]) => console.log(`[${AGENT}]`, ...a);
const client = new Client({ name: AGENT, version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  try { return { isErr: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { isErr: Boolean(res.isError), data: text as unknown as Record<string, unknown> }; }
};

// ── Register + open ──────────────────────────────────────────────────
log("register:", (await call("agent_register", { name: AGENT, kind: "agent" })).data);
const opened = await call("workspace_open", { slug: process.env.DEMO_SLUG ?? "aurora-showcase" });
log("workspace_open:", opened.isErr ? "ERR" : "ok");

// ── File contents (alpha/beta/gamma tracks) ──────────────────────────
const FILES: Record<number, { path: string; content: string }> = {
  1: {
    path: "index.html",
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AURORA — Aarav Rao</title>
  <meta name="description" content="Personal page of Aarav Rao — systems engineer building calm software.">
  <link rel="stylesheet" href="styles.css">
</head>
<body data-theme="aurora">
  <canvas id="stars" aria-hidden="true"></canvas>

  <header class="nav">
    <a class="logo" href="#">AURORA</a>
    <nav>
      <a href="#work">Work</a>
      <a href="#about">About</a>
      <a href="#contact">Contact</a>
    </nav>
    <button class="theme-toggle" type="button" aria-label="Toggle theme">☀ / ☾</button>
  </header>

  <main>
    <section class="hero">
      <p class="kicker">Aarav Rao · Systems Engineer</p>
      <h1>Building calm software.</h1>
      <p class="lede">I design and ship small, honest tools — zero ceremony, no dark patterns, real tests.</p>
      <a class="button" href="#work">See the work</a>
    </section>

    <section id="work" class="projects">
      <h2>Selected work</h2>
      <div class="grid">
        <article class="card"><h3>Prism</h3><p>A log lens for Node services. Filters, context, zero deps.</p><a href="#">Details →</a></article>
        <article class="card"><h3>Cirrus</h3><p>Pocket weather you can read in 2 seconds. Offline-first.</p><a href="#">Details →</a></article>
        <article class="card"><h3>notes-api</h3><p>Tiny REST notes service. SQLite, one file of code, MIT.</p><a href="#">Details →</a></article>
      </div>
    </section>

    <section id="about" class="about">
      <h2>About</h2>
      <p>Ten years of backend and infra. I like SQLite, small teams, honest UIs.</p>
    </section>
  </main>

  <footer id="contact">
    <span>Built by three MCP agents — aurora-home</span>
    <span id="local-time">--:--:--</span>
    <a href="mailto:hi@aurora.dev">hi@aurora.dev</a>
  </footer>

  <script src="app.js" defer></script>
</body>
</html>
`,
  },
  2: {
    path: "styles.css",
    content: `:root {
  --bg: #050816;
  --accent: #8b5cf6;
  --accent-2: #22d3ee;
  --card: rgba(17, 22, 45, 0.62);
  --text: #e6e9f5;
  --muted: #8a90b4;
  --radius: 16px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text);
  background:
    radial-gradient(ellipse 60% 50% at 15% -10%, rgba(139, 92, 246, 0.45), transparent),
    radial-gradient(ellipse 50% 40% at 90% 10%, rgba(34, 211, 238, 0.35), transparent),
    radial-gradient(ellipse 45% 45% at 55% 110%, rgba(217, 70, 239, 0.35), transparent),
    var(--bg);
}

#stars {
  position: fixed;
  inset: 0;
  z-index: -1;
  display: block;
}

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 6vw;
  position: sticky;
  top: 0;
  backdrop-filter: blur(10px);
  background: rgba(5, 8, 22, 0.55);
}
.logo { font-weight: 800; letter-spacing: 0.35em; color: var(--text); text-decoration: none; }
.nav nav a { color: var(--muted); margin: 0 14px; text-decoration: none; }
.nav nav a:hover { color: var(--text); }

.theme-toggle {
  background: var(--card);
  color: var(--text);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 6px 14px;
  cursor: pointer;
}
.theme-toggle:hover { border-color: var(--accent); }

.hero { padding: 12vh 6vw 8vh; max-width: 900px; }
.kicker { color: var(--accent-2); letter-spacing: 0.15em; text-transform: uppercase; font-size: 0.8rem; }
h1 { font-size: clamp(2.5rem, 7vw, 4.5rem); line-height: 1.05; margin: 12px 0; }
.lede { color: var(--muted); font-size: 1.15rem; max-width: 34ch; }
.button {
  display: inline-block; margin-top: 22px; padding: 12px 26px;
  border-radius: 999px; text-decoration: none; color: #0b0a1a; font-weight: 700;
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
}
.button:hover { filter: brightness(1.1); }

.projects { padding: 6vh 6vw; }
.projects h2 { letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted); font-size: 0.9rem; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 18px; }
.card {
  background: var(--card);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius);
  padding: 22px;
  backdrop-filter: blur(14px);
  transition: transform 180ms ease, border-color 180ms ease;
}
.card:hover { transform: translateY(-6px); border-color: var(--accent); }
.card p { color: var(--muted); }
.card a { color: var(--accent-2); text-decoration: none; }

.about { padding: 4vh 6vw 10vh; color: var(--muted); }

footer {
  display: flex; gap: 24px; align-items: center; justify-content: center;
  padding: 26px; border-top: 1px solid rgba(255, 255, 255, 0.07); color: var(--muted);
}
#local-time { font-variant-numeric: tabular-nums; color: var(--accent-2); }
footer a { color: var(--text); text-decoration: none; }

body[data-theme="light"] {
  --bg: #f5f6ff;
  --card: rgba(255, 255, 255, 0.8);
  --text: #1b1b2e;
  --muted: #555a75;
  background:
    radial-gradient(ellipse 60% 50% at 15% -10%, rgba(139, 92, 246, 0.18), transparent),
    radial-gradient(ellipse 50% 40% at 90% 10%, rgba(34, 211, 238, 0.18), transparent),
    var(--bg);
}
body[data-theme="light"] .nav { background: rgba(245, 246, 255, 0.7); }

@media (max-width: 720px) {
  .grid { grid-template-columns: 1fr; }
  .nav nav { display: none; }
  footer { flex-direction: column; gap: 8px; }
}
`,
  },
  3: {
    path: "app.js",
    content: `// AURORA — starfield canvas, live clock, theme toggle. Vanilla JS, zero deps.
(() => {
  const canvas = document.getElementById('stars');
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    let W = (canvas.width = window.innerWidth);
    let H = (canvas.height = window.innerHeight);

    const makeStar = () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, phase: Math.random() * Math.PI * 2 });
    const stars = Array.from({ length: 180 }, makeStar);
    let shot = null;
    let lastShot = 0;

    const frame = (t) => {
      ctx.clearRect(0, 0, W, H);

      for (const s of stars) {
        const tw = 0.45 + 0.55 * Math.abs(Math.sin(t / 900 + s.phase));
        ctx.globalAlpha = tw;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!shot && t - lastShot > 7000) {
        shot = { x: Math.random() * W * 0.8, y: Math.random() * H * 0.25, vx: 9 + Math.random() * 5, vy: 4.5 + Math.random() * 2.5, life: 1 };
        lastShot = t;
      }
      if (shot) {
        shot.x += shot.vx; shot.y += shot.vy; shot.life -= 0.02;
        const grad = ctx.createLinearGradient(shot.x, shot.y, shot.x - shot.vx * 8, shot.y - shot.vy * 8);
        grad.addColorStop(0, 'rgba(255,255,255,' + Math.max(shot.life, 0) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1; ctx.strokeStyle = grad; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(shot.x, shot.y); ctx.lineTo(shot.x - shot.vx * 8, shot.y - shot.vy * 8); ctx.stroke();
        if (shot.life <= 0) shot = null;
      }

      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    window.addEventListener('resize', () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; });
  }

  // Live footer clock
  const timeEl = document.getElementById('local-time');
  if (timeEl) {
    const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tick = () => { timeEl.textContent = fmt.format(new Date()); };
    tick();
    setInterval(tick, 1000);
  }

  // Theme toggle
  const toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = document.body.getAttribute('data-theme') === 'light' ? 'aurora' : 'light';
      document.body.setAttribute('data-theme', next);
    });
  }

  console.log('%cAURORA', 'color:#8b5cf6;font-weight:bold;font-size:16px', '— calm software, built by three MCP agents.');
})();
`,
  },
  4: {
    path: "README.md",
    content: `# AURORA — Aarav Rao · Personal Landing Page

Fictional-developer personal page. **Built entirely through the Universal
Workspace MCP by three MCP agents working in one shared workspace.**

## View it
Open \`index.html\` in any browser — no build step, no dependencies.

## How it was built
- **agent-alpha** → \`index.html\` (semantic page, hero, projects grid, footer with #local-time)
- **agent-beta**  → \`styles.css\` (aurora dark theme, CSS variables, responsive)
- **agent-gamma** → \`app.js\` (canvas starfield, live clock, theme toggle)
- open race → this README + cross-file integration check

All coordination (task claims with compare-and-set, file locks, hash-checked
writes, audited events) happened over MCP. See \`PLAN.md\`,
\`git log\` and the workspace \`events\` table for the full trail.

## Files
- \`index.html\` — structure
- \`styles.css\` — theme (supports \`body[data-theme="light"]\`)
- \`app.js\` — starfield + clock + theme toggle
`,
  },
};

// ── Claim + work loop ────────────────────────────────────────────────
for (let round = 0; round < 4; round++) {
  const listed = await call("task_list", { status: "pending", limit: 20 });
  const tasks = (listed.data.tasks ?? []) as Array<{
    id: string; title: string; priority: number; assignee_agent: string | null; updated_at: string;
  }>;
  const unassigned = tasks.filter((t) => !t.assignee_agent).sort((a, b) => a.priority - b.priority);
  const target = unassigned[0];
  if (!target) { log("no claimable tasks left"); break; }

  // CAS claim — loser of the race gets CONFLICT and moves on
  const claim = await call("task_update", {
    task_id: target.id,
    status: "in_progress",
    assignee_agent: AGENT,
    expected_updated_at: target.updated_at,
  });
  if (claim.isErr) { log("claim lost/conflict on P" + target.priority, "— retrying"); continue; }
  log("claimed P" + target.priority, "→", target.title.slice(0, 60));

  // Execute the task for real
  const content = FILES[target.priority];
  if (content) {
    const lock = await call("lock_acquire", { path: content.path, ttl_seconds: 120 });
    if (lock.isErr) log("lock_acquire warning:", JSON.stringify(lock.data).slice(0, 120));
    const wr = await call("file_write", { path: content.path, content: content.content, create_dirs: true });
    if (wr.isErr) { log("file_write FAILED", wr.data); break; }
    const verify = await call("file_read", { path: content.path });
    const html = String((verify.data as { content?: string }).content ?? "");
    const sanity =
      content.path === "index.html" ? html.includes("<!DOCTYPE") && html.includes('id="local-time"') && html.includes("app.js")
      : content.path === "styles.css" ? html.includes("--bg") && html.includes("@media")
      : content.path === "app.js" ? html.includes("getElementById('local-time')") || html.includes('getElementById("local-time")')
      : null;
    if (sanity !== null) log("wrote + verified", content.path, sanity ? "sanity OK" : "SANITY CHECK FAILED");
    if (content.path === "README.md") {
      const idx = await call("file_read", { path: "index.html" });
      const js = await call("file_read", { path: "app.js" });
      const si = String((idx.data as { content?: string }).content ?? "");
      const sj = String((js.data as { content?: string }).content ?? "");
      const ok = si.includes("styles.css") && si.includes("app.js") && si.includes('id="local-time"') && sj.includes("local-time");
      log("integration check:", ok ? "index.html ↔ styles.css ↔ app.js cross-references OK ✓" : "MISMATCH — inspect!");
    }

    const commit = await call("terminal_execute", {
      command: `git add "${content.path}" && git -c user.name=${AGENT} -c user.email=${AGENT}@mcp commit --quiet -m "${content.path} by ${AGENT}" && git log --oneline | head -1`,
      wait: true,
    });
    log("git commit:", (commit.data as { stdoutTail?: string }).stdoutTail?.trim());
  } else {
    // README + integration task (priority 4)
    const readme = FILES[4];
    if (readme) {
      await call("file_write", { path: readme.path, content: readme.content, create_dirs: true });
      // integration sanity: index.html must reference styles.css and app.js
      const idx = await call("file_read", { path: "index.html" });
      const s = String((idx.data as { content?: string }).content ?? "");
      const ok = s.includes("styles.css") && s.includes("app.js") && s.includes('id="local-time"');
      log("integration check:", ok ? "index.html links styles.css + app.js + #local-time ✓" : "MISMATCH — inspect!");
    }
  }

  await call("lock_release", { path: content?.path ?? "README.md" });
  const done = await call("task_complete", { task_id: target.id, note: `completed by ${AGENT}` });
  log("task_complete:", (done.data as { task?: { status: string } }).task?.status);

  // The integration task also sweeps whatever the other agents left uncommitted
  if (target.priority === 4) {
    const sweep = await call("terminal_execute", {
      command: `git add -A && git -c user.name=${AGENT} -c user.email=${AGENT}@mcp commit --quiet -m "integration: sweep remaining agent artifacts" || true; git log --oneline | head -6`,
      wait: true,
    });
    log("integration sweep done; history:", (sweep.data as { stdoutTail?: string }).stdoutTail?.trim().split("\n").length, "commits");
  }

  await call("brain_update", { section: "Current State", content: `${AGENT} completed P${target.priority}: ${target.title.split("—")[0]?.trim()}`, mode: "append" });
}

const fin = await call("memory_add", {
  kind: "handover",
  title: `Handover — ${AGENT}`,
  content: "Finished my claim(s) on Aurora v1. Check git log and task_list for the final state.",
});
log("handover recorded:", fin.isErr ? "ERR" : "ok");

await client.close();
log("done");
process.exit(0);
