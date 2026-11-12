#!/usr/bin/env node
/**
 * Live demo launcher — seeds a fresh workspace and starts the three-agent
 * swarm so you can watch it happen in the 3D UI.
 *
 *   npm run demo:live                      # workspace: live-demo
 *   DEMO_SLUG=aurora-2 npm run demo:live   # custom workspace
 *
 * Open the UI on the same workspace slug to watch it live:
 *   https://<your-url>/ui?token=<umcp_...>&workspace=<slug>
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = process.env.DEMO_SLUG ?? "live-demo";

// load .env (pepper + db path)
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* .env optional here — DB path is fixed below */
}

const { loadConfig } = await import("../src/config/env.js");
const { openDatabase } = await import("../src/database/db.js");
const { mintToken } = await import("../src/security/authenticate.js");
const { seedWorkspace } = await import("./seed-aurora.js");

const config = loadConfig();
const db = openDatabase(config.databasePath);

const user = db.prepare(`SELECT * FROM users ORDER BY created_at ASC LIMIT 1`).get() as { id: string } | undefined;
if (!user) {
  console.error("no user found — run `npm run setup` first");
  process.exit(1);
}

const SQUAD = ["agent-alpha", "agent-beta", "agent-gamma"];
const tokens: Record<string, string> = {};

const admin = mintToken(db, config.tokenPepper, { userId: user.id, agentId: null, name: "live-demo-seeder", scopes: [] });
tokens["__admin"] = admin.token;

for (const name of SQUAD) {
  let agent = db.prepare(`SELECT id FROM agents WHERE user_id = ? AND name = ?`).get(user.id, name) as { id: string } | undefined;
  if (!agent) {
    const id = randomUUID();
    db.prepare(`INSERT INTO agents (id, user_id, name, kind) VALUES (?, ?, ?, 'agent')`).run(id, user.id, name);
    agent = { id };
  }
  const { token } = mintToken(db, config.tokenPepper, { userId: user.id, agentId: agent.id, name: `${name}-live-demo`, scopes: [] });
  tokens[name] = token;
}
db.close();

console.log(`\n▶ seeding workspace '${SLUG}' …`);
const actualSlug = await seedWorkspace(SLUG, tokens["__admin"]);

console.log(`\n▶ launching 3 agents — watch them here:`);
console.log(`   http://127.0.0.1:3333/ui?workspace=${actualSlug}`);
console.log(`   (token: any of your own tokens, e.g. the one from npm run mint-token)\n`);

const started = Date.now();
const children = SQUAD.map((name) =>
  spawn("npx", ["tsx", path.join(ROOT, "scripts/trio-agent.ts")], {
    cwd: ROOT,
    env: { ...process.env, UMCP_TOKEN: tokens[name]!, AGENT_NAME: name, DEMO_SLUG: actualSlug },
    stdio: ["ignore", "inherit", "inherit"],
  })
);

await Promise.all(children.map((c) => new Promise<void>((resolve) => c.on("exit", () => resolve()))));
console.log(`\n✔ swarm finished in ${((Date.now() - started) / 1000).toFixed(1)}s — workspace '${actualSlug}'`);
process.exit(0);
