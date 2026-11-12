/**
 * Pixel-rendered preview of the 3D squad view (same scene as the web UI,
 * projected offline so it can be shipped as a GIF).
 *
 *   npx tsx tools/render-3d-gif.ts examples/tui-demo/squad-3d.gif
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, rgb, writeGif, type GifFrame, type RGBA } from "./gifkit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(path.join(ROOT, "data/database.sqlite"), { readOnly: true });
const SLUG = process.argv[3] ?? "aurora-showcase";

const ws = db.prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(SLUG) as { id: string; name: string };
const agents = db.prepare(`SELECT id, name FROM agents`).all() as unknown as Array<{ id: string; name: string }>;
const nameById = new Map(agents.map((a) => [a.id, a.name]));
const tasks = db
  .prepare(
    `SELECT t.id, t.title, t.status, t.priority, a.name AS assignee_name
     FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent WHERE t.workspace_id = ? ORDER BY t.priority`
  )
  .all(ws.id) as unknown as Array<{ id: string; title: string; status: string; priority: number; assignee_name: string | null }>;
const events = db
  .prepare(`SELECT id, agent_id, action, target, created_at FROM events WHERE workspace_id = ? ORDER BY id ASC`)
  .all(ws.id) as unknown as Array<{ id: number; agent_id: string | null; action: string; target: string | null; created_at: string }>;
db.close();

const AGENT_COLOR: Record<string, RGBA> = {
  "agent-alpha": rgb("#72e6a0"),
  "agent-beta": rgb("#5ad7e8"),
  "agent-gamma": rgb("#ffb86b"),
  "setup-cli": rgb("#4a5170"),
};
const nameColor = (n: string | null | undefined): RGBA => (n ? (AGENT_COLOR[n] ?? rgb("#c792ea")) : rgb("#8a90b4"));

/* ── tiny 3D projection ─────────────────────────────────────────────── */
const CAM = { x: 0, y: 6.6, z: 15.5 };
const TARGET = { x: 0, y: 1.5, z: 0 };
const FOCAL = 620;

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a: [number, number, number], b: [number, number, number]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const F = norm([TARGET.x - CAM.x, TARGET.y - CAM.y, TARGET.z - CAM.z]);
const R = norm(cross(F, [0, 1, 0]));
const U = cross(R, F);

function project(x: number, y: number, z: number, W: number, H: number) {
  const dx = x - CAM.x, dy = y - CAM.y, dz = z - CAM.z;
  const vx = dot3([dx, dy, dz], R);
  const vy = dot3([dx, dy, dz], U);
  const vz = dot3([dx, dy, dz], F);
  const s = FOCAL / Math.max(vz, 0.001);
  return { sx: W / 2 + vx * s, sy: H / 2 - vy * s, s, depth: vz };
}

/* ── layout ─────────────────────────────────────────────────────────── */
const W = 960, H = 540;
const slot = (i: number, total: number, radius = 6.4) => {
  const a = (i / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(a) * radius, y: 2.3 + (i % 2) * 0.8, z: Math.sin(a) * radius };
};

const FRAMES = 34;
const frames: GifFrame[] = [];

for (let f = 0; f < FRAMES; f++) {
  const k = Math.min(events.length, Math.round((f / (FRAMES - 1)) ** 1.5 * events.length));
  const slice = events.slice(0, k);
  const yaw = 0.28 + Math.sin(f * 0.09) * 0.22;

  const cv = new Canvas(W, H, rgb("#05070f"));

  // stars
  let s2 = 99991;
  const rnd = () => { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; return s2 / 0x7fffffff; };
  for (let i = 0; i < 220; i++) cv.fillCircle(rnd() * W, rnd() * H * 0.9, rnd() * 1.2, [255, 255, 255, 90]);

  // floor disc + grid
  for (let i = 0; i < 72; i++) {
    const a1 = (i / 72) * Math.PI * 2, a2 = ((i + 1) / 72) * Math.PI * 2;
    const p1 = project(Math.cos(a1) * 11, 0, Math.sin(a1) * 11, W, H);
    const p2 = project(Math.cos(a2) * 11, 0, Math.sin(a2) * 11, W, H);
    cv.drawLine(p1.sx, p1.sy, p2.sx, p2.sy, rgb("#161d33"));
  }
  for (const r of [3.6, 7.2, 11]) {
    for (let i = 0; i < 72; i++) {
      const a1 = (i / 72) * Math.PI * 2, a2 = ((i + 1) / 72) * Math.PI * 2;
      const p1 = project(Math.cos(a1) * r, 0, Math.sin(a1) * r, W, H);
      const p2 = project(Math.cos(a2) * r, 0, Math.sin(a2) * r, W, H);
      cv.drawLine(p1.sx, p1.sy, p2.sx, p2.sy, rgb("#101728"));
    }
  }

  // core (shared workspace)
  const coreP = project(0, 1.0, 0, W, H);
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const p = project(Math.cos(a) * 2.1, 0.25, Math.sin(a) * 2.1, W, H);
    cv.fillCircle(p.sx, p.sy, Math.max(1, 0.11 * p.s), [139, 92, 246, 230]);
  }
  cv.addRadialGlow(coreP.sx, coreP.sy, 1.7 * coreP.s, rgb("#8b5cf6"), 0.55);
  cv.fillCircle(coreP.sx, coreP.sy, Math.max(4, 0.62 * coreP.s), rgb("#a78bfa"));
  cv.fillCircle(coreP.sx, coreP.sy, Math.max(2, 0.26 * coreP.s), [255, 255, 255, 210]);

  // task card anchors (cards themselves are drawn after the orbs)
  const cardPos = new Map<string, { x: number; y: number; z: number }>();
  tasks.forEach((t, i) => {
    cardPos.set(t.id, slot(i, tasks.length));
  });

  // agent orbs — position lerps toward the task they own
  const squad = ["agent-alpha", "agent-beta", "agent-gamma"];
  squad.forEach((name, i) => {
    const owned = tasks.find((t) => t.assignee_name === name);
    const goal = owned ? cardPos.get(owned.id)! : slot(i, squad.length, 4.2);
    const prog = Math.min(1, k / 14);
    const from = slot(i, squad.length, 8.2);
    const px = from.x + (goal.x - from.x) * prog;
    const pz = from.z + (goal.z - from.z) * prog;
    const py = goal.y - 1.15 + Math.sin(f * 0.4 + i) * 0.12;
    const sp = project(px, py, pz, W, H);
    const c = AGENT_COLOR[name]!;
    cv.addRadialGlow(sp.sx, sp.sy, 1.5 * sp.s, c, 0.5);
    cv.fillCircle(sp.sx, sp.sy, Math.max(4, 0.62 * sp.s), c);
    cv.fillCircle(sp.sx, sp.sy, Math.max(2, 0.24 * sp.s), [255, 255, 255, 210]);
    const label = name.toUpperCase();
    const lw = cv.measureText(label, 1) + 10;
    cv.fillRoundRect(sp.sx - lw / 2, sp.sy - 0.95 * sp.s - 5, lw, 13, 3, [6, 9, 18, 235]);
    cv.drawText(label, sp.sx - lw / 2 + 5, sp.sy - 0.95 * sp.s - 2, c, 1);
  });

  // task cards drawn on top (like depthTest:false sprites in the web UI)
  tasks.forEach((t) => {
    const p = cardPos.get(t.id)!;
    const sp = project(p.x, p.y, p.z, W, H);
    const owner = nameColor(t.assignee_name);
    const w = 138, h = 40;
    cv.fillRoundRect(sp.sx - w / 2, sp.sy - h / 2, w, h, 5, [16, 22, 44, 244]);
    cv.strokeRoundRect(sp.sx - w / 2, sp.sy - h / 2, w, h, 5, t.status === "done" ? rgb("#72e6a0") : owner, 2);
    cv.drawText(t.title.slice(0, 17), sp.sx - w / 2 + 7, sp.sy - 12, rgb("#e6e9f5"), 1);
    cv.drawText(t.status === "done" ? "DONE" : (t.assignee_name ?? "unclaimed").toUpperCase(), sp.sx - w / 2 + 7, sp.sy + 3, t.status === "done" ? rgb("#72e6a0") : owner, 1);
  });

  // trails from active agents to the core for recent events
  const recent = slice.slice(-3);
  recent.forEach((e, idx) => {
    const agent = nameById.get(e.agent_id ?? "");
    if (!agent) return;
    const i = squad.indexOf(agent);
    if (i < 0) return;
    const owned = tasks.find((t) => t.assignee_name === agent);
    const goal = owned ? cardPos.get(owned.id)! : slot(i, squad.length, 4.2);
    const p1 = project(goal.x, goal.y - 1.0, goal.z, W, H);
    const p2 = project(0, 1.0, 0, W, H);
    const prog = (f * 0.22 + idx * 0.3) % 1;
    const tx = p1.sx + (p2.sx - p1.sx) * prog;
    const ty = p1.sy + (p2.sy - p1.sy) * prog;
    cv.fillCircle(tx, ty, 6 - idx, AGENT_COLOR[agent]!);
  });

  // HUD
  cv.fillRect(0, 0, W, 34, rgb("#0e1424"));
  cv.drawText("UNIV-MCP  3D SQUAD VIEW", 16, 12, rgb("#5ad7e8"), 2);
  const sub = `${ws.name.toUpperCase()}   REPLAY ${k}/${events.length} EVENTS`;
  cv.drawText(sub, 330, 14, rgb("#8a90b4"), 1);
  cv.fillRect(0, H - 26, W, 26, rgb("#0e1424"));
  const legend = squad.map((s) => s.toUpperCase()).join("   ");
  cv.drawText(legend, 16, H - 18, rgb("#7d84a6"), 1);
  const done = tasks.filter((t) => t.status === "done").length;
  cv.drawText(`TASKS ${done}/${tasks.length}`, W - 140, H - 18, rgb("#72e6a0"), 1);

  frames.push({ canvas: cv, delay: 220 });
}

const out = process.argv[2] ?? "examples/tui-demo/squad-3d.gif";
writeGif(out, frames);
console.log("wrote", out, `${frames.length} frames`);
