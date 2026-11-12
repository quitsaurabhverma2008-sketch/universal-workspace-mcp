/**
 * Renders the MCP monitor dashboard as animated GIFs, straight from the real
 * audit trail in SQLite:
 *
 *   build-replay.gif — timelapse replay of the actual 3-agent build
 *   tui-live.gif     — the live view (final state, ticking clock)
 *   agent-race.gif   — who claimed which task, and when
 *
 *   npx tsx tools/render-tui-gif.ts
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, rgb, writeGif, type GifFrame } from "./gifkit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(ROOT, "data/database.sqlite");
const SLUG = process.argv[2] ?? "aurora-showcase";
const OUT_DIR = process.argv[3] ?? path.join(ROOT, "examples/tui-demo");

const COL = {
  bg: rgb("#05070f"),
  panel: rgb("#0e1424"),
  panelEdge: rgb("#1e2740"),
  bar: rgb("#141b2e"),
  text: rgb("#e6e9f5"),
  muted: rgb("#7d84a6"),
  dim: rgb("#4a5170"),
  cyan: rgb("#5ad7e8"),
  green: rgb("#72e6a0"),
  orange: rgb("#ffb86b"),
  magenta: rgb("#c792ea"),
  yellow: rgb("#ffd479"),
  white: rgb("#ffffff"),
};
const AGENT_COLOR: Record<string, [number, number, number, number]> = {
  "agent-alpha": COL.green,
  "agent-beta": COL.cyan,
  "agent-gamma": COL.orange,
  "setup-cli": COL.dim,
};

interface EventRow { id: number; agent_id: string | null; action: string; target: string | null; detail: string; created_at: string }
interface TaskRow { id: string; title: string; status: string; priority: number; assignee_name: string | null }

const db = new DatabaseSync(DB, { readOnly: true });
const ws = db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(SLUG) as { id: string; slug: string; name: string };
const agents = db.prepare(`SELECT id, name FROM agents`).all() as unknown as Array<{ id: string; name: string }>;
const nameById = new Map(agents.map((a) => [a.id, a.name]));
const tasks = db
  .prepare(
    `SELECT t.id, t.title, t.status, t.priority, a.name AS assignee_name
     FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent WHERE t.workspace_id = ? ORDER BY t.priority`
  )
  .all(ws.id) as unknown as TaskRow[];
const events = db
  .prepare(`SELECT id, agent_id, action, target, detail, created_at FROM events WHERE workspace_id = ? ORDER BY id ASC`)
  .all(ws.id) as unknown as EventRow[];
db.close();

const W = 960, H = 540;
const HH = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

function panel(cv: Canvas, x: number, y: number, w: number, h: number, title: string, titleColor = COL.cyan): void {
  cv.fillRoundRect(x, y, w, h, 8, COL.panel);
  cv.strokeRoundRect(x, y, w, h, 8, COL.panelEdge, 1);
  cv.fillRoundRect(x + 10, y - 7, cv.measureText(title, 1) + 12, 14, 4, COL.bg);
  cv.drawText(title, x + 16, y - 3, titleColor, 1);
}

function progress(cv: Canvas, x: number, y: number, done: number, total: number, width: number): void {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  for (let i = 0; i < width; i++) {
    const c = i < filled ? COL.green : COL.dim;
    cv.fillRect(x + i * 10, y, 8, 10, c);
  }
}

function dot(cv: Canvas, x: number, y: number, color: [number, number, number, number]): void {
  cv.fillCircle(x, y, 4, color);
}

/** Shared dashboard drawing; `feed` is already windowed, `state` carries task status. */
function drawDashboard(
  cv: Canvas,
  opts: {
    feed: EventRow[];
    taskState: Map<string, { status: string; claimed: boolean }>;
    clock: string;
    spinner: string;
    note?: string;
  }
): void {
  cv.fillRect(0, 0, W, H, COL.bg);

  // top bar
  cv.fillRect(0, 0, W, 34, COL.bar);
  cv.drawText("UNIV-MCP", 16, 12, COL.cyan, 2);
  cv.drawText(ws.name.toUpperCase(), 150, 14, COL.text, 1);
  const right = "127.0.0.1:3333  MCP STREAMABLE HTTP";
  cv.drawText(right, W - cv.measureText(right, 1) - 16, 14, COL.muted, 1);

  // task summary bar
  const doneCount = [...opts.taskState.values()].filter((s) => s.status === "done").length;
  const inProg = [...opts.taskState.values()].filter((s) => s.status === "in_progress").length;
  cv.drawText("TASKS", 16, 48, COL.text, 1);
  progress(cv, 70, 46, doneCount, tasks.length, 26);
  cv.drawText(`${doneCount}/${tasks.length} DONE`, 350, 48, COL.green, 1);
  if (inProg) cv.drawText(`${inProg} IN PROGRESS`, 470, 48, COL.yellow, 1);
  const stats = `AGENTS ${new Set(events.map((e) => nameById.get(e.agent_id ?? "") ?? "?")).size}   EVENTS ${opts.feed.length ? events.length : events.length}   FILES 4`;
  cv.drawText(stats, W - cv.measureText(stats, 1) - 16, 48, COL.muted, 1);

  // ── tasks panel
  panel(cv, 16, 82, 470, 176, "TASK BOARD");
  tasks.forEach((t, i) => {
    const st = opts.taskState.get(t.id) ?? { status: "pending", claimed: false };
    const y = 112 + i * 34;
    const glyph = st.status === "done" ? COL.green : st.status === "in_progress" ? COL.yellow : COL.dim;
    cv.drawText(st.status === "done" ? "✓" : st.status === "in_progress" ? "~" : "·", 34, y, glyph, 1);
    const title = t.title.length > 42 ? t.title.slice(0, 41) + "…" : t.title;
    cv.drawText(title, 56, y, st.claimed ? COL.text : COL.muted, 1);
    if (st.claimed && t.assignee_name) {
      const c = AGENT_COLOR[t.assignee_name] ?? COL.magenta;
      const label = t.assignee_name;
      cv.drawText(label, 340, y, c, 1);
      dot(cv, 330, y + 3, c);
    }
    cv.drawHLine(34, 468, y + 18, COL.panelEdge);
  });

  // ── agents panel
  panel(cv, 502, 82, 442, 176, "AGENTS");
  const seen = new Map<string, { files: number; claims: number; last: string }>();
  for (const e of events) {
    const n = nameById.get(e.agent_id ?? "");
    if (!n) continue;
    const cur = seen.get(n) ?? { files: 0, claims: 0, last: e.created_at };
    if (e.action === "file.write") cur.files += 1;
    if (e.action === "task.updated" || e.action === "task.completed") cur.claims += 1;
    cur.last = e.created_at;
    seen.set(n, cur);
  }
  let ai = 0;
  for (const [name, info] of seen) {
    const y = 112 + ai * 30;
    const c = AGENT_COLOR[name] ?? COL.magenta;
    dot(cv, 522, y + 3, c);
    cv.drawText(name, 536, y, c, 1);
    cv.drawText(`FILES ${info.files}`, 680, y, COL.muted, 1);
    cv.drawText(`TASKS ${info.claims}`, 790, y, COL.muted, 1);
    cv.drawText(`LAST ${HH(info.last)}`, 860, y, COL.dim, 1);
    ai += 1;
    if (ai >= 4) break;
  }

  // ── activity feed
  panel(cv, 16, 276, 928, 236, "ACTIVITY - LIVE AUDIT FEED (WHO WROTE WHAT, WHEN)");
  opts.feed.slice(0, 11).forEach((e, i) => {
    const y = 316 + i * 17;
    const agent = nameById.get(e.agent_id ?? "") ?? "—";
    const c = AGENT_COLOR[agent] ?? COL.magenta;
    cv.drawText(HH(e.created_at), 34, y, COL.dim, 1);
    cv.drawText(agent.padEnd(12), 104, y, c, 1);
    cv.drawText(e.action.padEnd(16), 200, y, COL.yellow, 1);
    const target = (e.target ?? "").slice(0, 60);
    cv.drawText(target, 340, y, COL.text, 1);
  });

  // footer
  cv.fillRect(0, H - 24, W, 24, COL.bar);
  cv.drawText("Q QUIT   R REFRESH   P PAUSE", 16, H - 17, COL.muted, 1);
  const foot = `UNIVERSAL-WORKSPACE-MCP V0.1.0   ${opts.spinner}   ${opts.clock}${opts.note ? "   " + opts.note : ""}`;
  cv.drawText(foot, W - cv.measureText(foot, 1) - 16, H - 17, COL.magenta, 1);
}

/* ── GIF 1: timelapse replay of the real build ───────────────────────── */
function buildReplay(): GifFrame[] {
  const frames: GifFrame[] = [];
  const total = events.length;
  const FRAMES = 30;
  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  for (let f = 0; f < FRAMES; f++) {
    const k = Math.min(total, Math.round((f / (FRAMES - 1)) ** 1.6 * total));
    const slice = events.slice(0, k);
    const state = new Map<string, { status: string; claimed: boolean }>();
    for (const t of tasks) state.set(t.id, { status: "pending", claimed: false });
    for (const e of slice) {
      if (e.action === "task.updated" || e.action === "task.completed") {
        const cur = state.get(e.target ?? "");
        if (cur) {
          cur.claimed = true;
          cur.status = e.action === "task.completed" ? "done" : "in_progress";
        }
      }
    }
    const cv = new Canvas(W, H, COL.bg);
    drawDashboard(cv, {
      feed: slice.slice(-11).reverse(),
      taskState: state,
      clock: HH(slice[slice.length - 1]?.created_at ?? new Date().toISOString()),
      spinner: SPIN[f % SPIN.length]!,
      note: `REPLAY ${k}/${total} EVENTS`,
    });
    frames.push({ canvas: cv, delay: 260 });
  }
  return frames;
}

/* ── GIF 2: live idle view (clock + spinner) ──────────────────────────── */
function liveView(): GifFrame[] {
  const frames: GifFrame[] = [];
  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const state = new Map<string, { status: string; claimed: boolean }>();
  for (const t of tasks) state.set(t.id, { status: t.status, claimed: !!t.assignee_name });
  for (let f = 0; f < 12; f++) {
    const cv = new Canvas(W, H, COL.bg);
    const now = new Date(Date.now() + f * 1000);
    drawDashboard(cv, {
      feed: events.slice(-11).reverse(),
      taskState: state,
      clock: now.toLocaleTimeString("en-GB", { hour12: false }),
      spinner: SPIN[f % SPIN.length]!,
      note: "LIVE",
    });
    frames.push({ canvas: cv, delay: 220 });
  }
  return frames;
}

/* ── GIF 3: the claim race ────────────────────────────────────────────── */
function claimRace(): GifFrame[] {
  const frames: GifFrame[] = [];
  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const claimEvents = events.filter((e) => e.action === "task.updated" && e.detail.includes("in_progress"));
  const FRAMES = 20;
  for (let f = 0; f < FRAMES; f++) {
    const k = Math.min(claimEvents.length, Math.round((f / (FRAMES - 1)) * claimEvents.length));
    const cv = new Canvas(W, H, COL.bg);
    cv.fillRect(0, 0, W, 34, COL.bar);
    cv.drawText("CLAIM RACE - WHO TOOK WHICH TASK", 16, 12, COL.cyan, 2);
    cv.drawText("TASK CLAIMED VIA COMPARE-AND-SET (EXPECTED_UPDATED_AT)", W - 470, 14, COL.muted, 1);

    const lanes = ["agent-alpha", "agent-beta", "agent-gamma"];
    const laneY = lanes.map((_, i) => 90 + i * 70);
    panel(cv, 16, 62, 928, 240, "TASK CLAIM TIMELINE");
    lanes.forEach((lane, i) => {
      const y = laneY[i]!;
      const c = AGENT_COLOR[lane] ?? COL.magenta;
      dot(cv, 40, y + 6, c);
      cv.drawText(lane, 54, y, c, 1);
      cv.drawHLine(150, 900, y + 6, COL.panelEdge);
      claimEvents.forEach((e, idx) => {
        const agent = nameById.get(e.agent_id ?? "") ?? "";
        const task = tasks.find((t) => t.id === e.target);
        const x = 170 + idx * 150;
        const active = idx < k;
        const mine = agent === lane;
        if (!mine) {
          if (active) cv.fillCircle(x, y + 6, 4, COL.dim);
          return;
        }
        cv.fillCircle(x, y + 6, 8, c);
        cv.fillCircle(x, y + 6, 3, COL.bg);
        cv.drawText(task ? task.title.slice(0, 18) : "", x - 6, y + 20, COL.text, 1);
      });
    });
    const done = claimEvents.slice(0, k);
    cv.drawText(`CLAIMS ${k}/${claimEvents.length}`, 34, 320, COL.yellow, 1);
    for (const e of done) {
      const agent = nameById.get(e.agent_id ?? "") ?? "";
      const c = AGENT_COLOR[agent] ?? COL.magenta;
      const task = tasks.find((t) => t.id === e.target);
      cv.drawText(`${HH(e.created_at)}`, 34, 344 + done.indexOf(e) * 16, COL.dim, 1);
      cv.drawText(agent.padEnd(12), 104, 344 + done.indexOf(e) * 16, c, 1);
      cv.drawText(`CLAIMED ${(task?.title ?? "").slice(0, 40)}`, 210, 344 + done.indexOf(e) * 16, COL.text, 1);
    }
    cv.fillRect(0, H - 24, W, 24, COL.bar);
    const foot = `UNIVERSAL-WORKSPACE-MCP   ${SPIN[f % SPIN.length]!}   REPLAY ${k}/${claimEvents.length} CLAIMS`;
    cv.drawText(foot, 16, H - 17, COL.magenta, 1);
    frames.push({ canvas: cv, delay: 300 });
  }
  return frames;
}

writeGif(path.join(OUT_DIR, "build-replay.gif"), buildReplay());
writeGif(path.join(OUT_DIR, "tui-live.gif"), liveView());
writeGif(path.join(OUT_DIR, "agent-race.gif"), claimRace());
console.log("wrote 3 gifs to", OUT_DIR, `(${events.length} events, ${tasks.length} tasks)`);
