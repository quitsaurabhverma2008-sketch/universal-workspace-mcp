/**
 * Universal Workspace MCP — live 3D squad view.
 *
 * Renders the shared workspace as a 3D scene:
 *   - the project "core" (shared state) at the centre
 *   - one glowing orb per agent, drifting to the task it owns
 *   - task cards floating in a ring, colour-coded by state
 *   - energy trails when an agent writes / commits / completes work
 *   - a side panel with the live audit feed (who, what, when)
 *
 * Data comes from GET /ui/api/state (1 s poll) — the same SQLite state the
 * MCP tools write, so what you see is exactly what the agents did.
 */
import * as THREE from "three";

function fatal(msg) {
  const gate = document.getElementById("gate");
  const box = document.getElementById("gate-msg");
  if (gate) gate.classList.remove("hidden");
  if (box) {
    box.textContent = msg;
    box.style.color = "#ffd479";
  }
  // eslint-disable-next-line no-console
  console.error(msg);
}

try {
  const probe = document.createElement("canvas");
  if (!probe.getContext("webgl2") && !probe.getContext("webgl")) {
    fatal("WebGL is not available in this browser — the 3D view needs WebGL.");
  }
} catch (e) {
  fatal("WebGL probe failed: " + (e instanceof Error ? e.message : String(e)));
}

/* ───────────────────────── setup ───────────────────────── */

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05070f, 0.028);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, 8, 16);
camera.lookAt(0, 1.4, 0);

scene.add(new THREE.AmbientLight(0x8899cc, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 0.8);
key.position.set(6, 12, 8);
scene.add(key);

// starfield
{
  const n = 900;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 40 + Math.random() * 90;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.6 + 12;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fb0ff, size: 0.42, sizeAttenuation: true })));
}

// workspace floor + grid
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(11, 72),
  new THREE.MeshStandardMaterial({ color: 0x0a0f1e, roughness: 0.95, metalness: 0.1 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(22, 22, 0x24314f, 0x141c30);
grid.position.y = 0.02;
scene.add(grid);

// shared project core
const core = new THREE.Group();
{
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.1, 0.06, 16, 90),
    new THREE.MeshStandardMaterial({ color: 0x8b5cf6, emissive: 0x8b5cf6, emissiveIntensity: 1.5 })
  );
  ring.rotation.x = Math.PI / 2;
  core.add(ring);
  const coreBall = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 3),
    new THREE.MeshStandardMaterial({ color: 0x1b1140, emissive: 0x7c3aed, emissiveIntensity: 1.1, roughness: 0.3 })
  );
  coreBall.position.y = 0.9;
  core.add(coreBall);
  const glow = new THREE.PointLight(0x8b5cf6, 14, 16);
  glow.position.y = 1.2;
  core.add(glow);
}
core.position.y = 0.1;
scene.add(core);

/* ───────────────────────── helpers ───────────────────────── */

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function labelTexture(title, sub, color, status = "") {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 200;
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "rgba(8,12,24,0.82)";
  roundRect(g, 6, 6, c.width - 12, c.height - 12, 22); g.fill();
  g.strokeStyle = color; g.lineWidth = 4; g.stroke();
  g.fillStyle = color;
  g.font = "bold 44px ui-monospace, monospace";
  g.fillText(title.slice(0, 22), 28, 74);
  if (status) {
    g.font = "bold 30px ui-monospace, monospace";
    g.fillStyle = status === "done" ? "#72e6a0" : color;
    g.fillText(status, 28, 124);
  }
  g.fillStyle = "#98a1c4";
  g.font = "26px ui-monospace, monospace";
  g.fillText((sub || "").slice(0, 34), 28, 168);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSprite(texture, w = 4.2, h = 1.3) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h, 1);
  return s;
}

/* ───────────────────────── scene objects ───────────────────────── */

const agentObjs = new Map(); // id -> {orb, label, target, color}
const taskObjs = new Map(); // id -> {sprite, pos, status}
const trails = [];
const pulses = [];

function slotFor(index, total) {
  const radius = 6.2;
  const a = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return new THREE.Vector3(Math.cos(a) * radius, 2.4 + (index % 2) * 0.7, Math.sin(a) * radius);
}

function ensureTask(t, index, total) {
  let obj = taskObjs.get(t.id);
  if (!obj) {
    const sprite = makeSprite(labelTexture(t.title.slice(0, 20), t.assignee_name ?? "unclaimed", "#8a90b4"), 4.6, 1.45);
    const pos = slotFor(index, total);
    sprite.position.copy(pos);
    scene.add(sprite);
    obj = { sprite, pos, status: t.status, assignee: t.assignee_name };
    taskObjs.set(t.id, obj);
  }
  return obj;
}

function ensureAgent(a, index, total) {
  let obj = agentObjs.get(a.id);
  if (!obj) {
    const color = new THREE.Color(a.color);
    const group = new THREE.Group();
    const orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 3),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.35 })
    );
    group.add(orb);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 20, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, side: THREE.BackSide })
    );
    group.add(halo);
    const light = new THREE.PointLight(color, 12, 12);
    group.add(light);
    const label = makeSprite(labelTexture(a.name, a.intent, a.color), 4.4, 1.4);
    label.position.set(0, 1.35, 0);
    group.add(label);
    const pos = slotFor(index, total);
    group.position.copy(pos);
    scene.add(group);
    obj = { group, orb, halo, label, color: a.color, target: pos.clone(), intent: a.intent, name: a.name };
    agentObjs.set(a.id, obj);
  }
  return obj;
}

function spawnTrail(from, to, color) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true })
  );
  mesh.position.copy(from);
  scene.add(mesh);
  trails.push({ mesh, from: from.clone(), to: to.clone(), t: 0, life: 0.75 });
}

function spawnPulse(pos, color) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.55, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(pos).setY(0.05);
  scene.add(ring);
  pulses.push({ ring, t: 0, life: 0.9 });
}

/* ───────────────────────── data ───────────────────────── */

const params = new URLSearchParams(location.search);
let token = params.get("token") || localStorage.getItem("umcp_token") || "";
let workspace = params.get("workspace") || localStorage.getItem("umcp_workspace") || "";
let lastEventId = 0;
let connected = false;

const $ = (id) => document.getElementById(id);

function setStatus(ok, text) {
  $("dot").className = ok ? "ok" : "err";
  $("conntxt").textContent = text;
}

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function colorFor(name) {
  const obj = [...agentObjs.values()].find((o) => o.name === name);
  return obj ? new THREE.Color(obj.color) : new THREE.Color("#5ad7e8");
}

async function poll() {
  try {
    const state = await api(`/ui/api/state?workspace=${encodeURIComponent(workspace)}`);
    connected = true;
    setStatus(true, `live · ${new Date(state.generated_at).toLocaleTimeString("en-GB", { hour12: false })}`);

    // header
    $("wsname").textContent = state.workspace.name;
    $("serverline").textContent = `universal-workspace-mcp · ${state.server.version} · uptime ${state.server.uptime_s}s`;
    $("stats").innerHTML =
      `<span>TASKS <b>${state.stats.tasks_done}/${state.stats.tasks_total}</b></span>` +
      `<span>FILES <b>${state.stats.files_written}</b></span>` +
      `<span>EVENTS <b>${state.stats.events_total}</b></span>` +
      `<span>MEM <b>${state.stats.memories}</b></span>` +
      `<span>PROCS <b>${state.stats.processes_running}</b></span>` +
      `<span>SESS <b>${state.stats.sessions_active}</b></span>`;

    // agents (3D + panel)
    state.agents.forEach((a, i) => {
      const obj = ensureAgent(a, i, state.agents.length);
      obj.intent = a.intent;
      const owned = state.tasks.find((t) => t.assignee_name === a.name);
      const taskObj = owned ? taskObjs.get(owned.id) : null;
      const base = taskObj ? taskObj.pos.clone().setY(1.15) : slotFor(i, state.agents.length);
      obj.target.copy(base);
      if (obj.intent !== obj.lastIntent) {
        obj.label.material.map.dispose();
        obj.label.material.map = labelTexture(a.name, a.intent, a.color);
        obj.label.material.needsUpdate = true;
        obj.lastIntent = a.intent;
      }
      obj.active = a.active;
    });
    // park agents whose tasks are gone
    for (const [id, obj] of agentObjs) {
      if (!state.agents.find((a) => a.id === id)) {
        scene.remove(obj.group);
        agentObjs.delete(id);
      }
    }

    $("agents-count").textContent = `${state.agents.length}`;
    $("agents").innerHTML = state.agents
      .map(
        (a) => `<div class="acard ${a.active ? "" : "idle"}" style="border-left-color:${a.color}">
          <div class="row1"><i class="dot" style="background:${a.color}"></i><span class="nm" style="color:${a.color}">${a.name}</span></div>
          <div class="intent">${a.intent}</div>
          <div class="row2"><span>files ${a.files_written}</span><span>claimed ${a.tasks_claimed}</span><span>done ${a.tasks_done}</span><span>${a.last_seen ? new Date(a.last_seen).toLocaleTimeString("en-GB", { hour12: false }) : ""}</span></div>
        </div>`
      )
      .join("");

    // tasks (3D cards + panel)
    state.tasks.forEach((t, i) => {
      const obj = ensureTask(t, i, state.tasks.length);
      obj.status = t.status;
      const color = t.status === "done" ? "#72e6a0" : t.assignee_name ? colorFor(t.assignee_name).getStyle() : "#8a90b4";
      obj.sprite.material.map.dispose();
      obj.sprite.material.map = labelTexture(t.title.slice(0, 20), t.assignee_name ?? "unclaimed", color, t.status);
      obj.sprite.material.needsUpdate = true;
    });
    $("tasks-count").textContent = `${state.stats.tasks_done}/${state.stats.tasks_total}`;
    $("tasks").innerHTML = state.tasks
      .map(
        (t) => `<div class="trow">
          <span class="g" style="color:${t.status === "done" ? "#72e6a0" : t.status === "in_progress" ? "#ffd479" : "#5b6288"}">${t.status === "done" ? "✓" : t.status === "in_progress" ? "~" : "·"}</span>
          <span class="t">${t.title}</span>
          <span class="who" style="color:${t.assignee_name ? colorFor(t.assignee_name).getStyle() : "#5b6288"}">${t.assignee_name ?? "—"}</span>
          <span class="pr">P${t.priority}</span>
        </div>`
      )
      .join("");

    // feed + trails for new events
    const fresh = state.events.filter((e) => e.id > lastEventId).reverse();
    if (fresh.length) {
      const feed = $("feed");
      for (const e of fresh) {
        const c = e.agent_name ? colorFor(e.agent_name).getStyle() : "#8a90b4";
        const row = document.createElement("div");
        row.className = "f new";
        row.innerHTML =
          `<span class="tm">${new Date(e.created_at).toLocaleTimeString("en-GB", { hour12: false })}</span>` +
          `<span class="ag" style="color:${c}">${e.agent_name ?? "server"}</span>` +
          `<span class="ac">${e.action}</span>` +
          `<span class="tg">${(e.target ?? "").slice(0, 40)}</span>`;
        feed.prepend(row);
      }
      while (feed.children.length > 40) feed.removeChild(feed.lastChild);
      lastEventId = Math.max(...fresh.map((e) => e.id));

      // 3D feedback: energy trail from the agent to the core
      for (const e of fresh) {
        if (!e.agent_name) continue;
        const agentObj = [...agentObjs.values()].find((o) => o.name === e.agent_name);
        if (!agentObj) continue;
        if (["file.write", "file.edit", "task.updated", "task.completed", "exec.executed", "brain.update", "memory.add"].includes(e.action)) {
          spawnTrail(agentObj.group.position.clone(), new THREE.Vector3(0, 1.2, 0), agentObj.color);
          spawnPulse(new THREE.Vector3(0, 0.05, 0), agentObj.color);
        }
      }
    }
  } catch (err) {
    setStatus(false, `error: ${String(err.message || err).slice(0, 40)}`);
    connected = false;
  }
}

/* ───────────────────────── loop ───────────────────────── */

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  core.rotation.y = t * 0.35;
  core.children[0].rotation.z = Math.sin(t * 0.6) * 0.25;

  for (const obj of agentObjs.values()) {
    obj.group.position.lerp(obj.target, 0.045);
    obj.orb.rotation.y = t * 0.8;
    obj.orb.position.y = Math.sin(t * 1.6 + obj.group.position.x) * 0.14;
    obj.halo.scale.setScalar(1 + Math.sin(t * 2 + obj.group.position.z) * 0.06);
    obj.label.position.y = 1.45 + Math.sin(t * 1.6) * 0.05;
  }
  for (const obj of taskObjs.values()) {
    obj.sprite.position.y = obj.pos.y + Math.sin(t * 1.1 + obj.pos.x) * 0.16;
  }

  for (let i = trails.length - 1; i >= 0; i--) {
    const tr = trails[i];
    tr.t += 0.03;
    const k = Math.min(1, tr.t);
    tr.mesh.position.lerpVectors(tr.from, tr.to, k);
    tr.mesh.material.opacity = Math.max(0, 1 - tr.t / tr.life);
    tr.mesh.scale.setScalar(1 + k * 2.5);
    if (tr.t >= tr.life) {
      scene.remove(tr.mesh);
      trails.splice(i, 1);
    }
  }
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.t += 0.02;
    p.ring.scale.setScalar(1 + p.t * 6);
    p.ring.material.opacity = Math.max(0, 0.6 - p.t * 0.7);
    if (p.t >= p.life) {
      scene.remove(p.ring);
      pulses.splice(i, 1);
    }
  }

  camera.position.x = Math.sin(t * 0.12) * 3.2;
  camera.position.z = 16 - Math.cos(t * 0.12) * 1.2;
  camera.lookAt(0, 1.4, 0);

  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ───────────────────────── boot ───────────────────────── */

$("token").value = token;
$("workspace").value = workspace;

async function connect() {
  token = $("token").value.trim();
  workspace = $("workspace").value.trim();
  if (!token || !workspace) {
    $("gate-msg").textContent = "token aur workspace dono chahiye";
    return;
  }
  localStorage.setItem("umcp_token", token);
  localStorage.setItem("umcp_workspace", workspace);
  setStatus(false, "connecting…");
  const ok = await (async () => {
    try {
      await api(`/ui/api/state?workspace=${encodeURIComponent(workspace)}`);
      return true;
    } catch (e) {
      $("gate-msg").textContent = String(e.message || e).slice(0, 90);
      return false;
    }
  })();
  if (ok) {
    $("gate").classList.add("hidden");
    poll();
    setInterval(poll, 1000);
  }
}

$("connect").addEventListener("click", connect);
if (token && workspace) connect();
