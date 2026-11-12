/**
 * Give every seat its own starter plan + task (run with seat tokens).
 *
 *   npx tsx scripts/seed-seat-workspaces.ts <seat>=<token> ...
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const seats: Array<{ seat: string; token: string; ws: string }> = [];
for (const arg of process.argv.slice(2)) {
  const [seat, token] = arg.split("=");
  if (seat && token) seats.push({ seat, token, ws: `${seat}-space` });
}
if (seats.length === 0) {
  console.error("usage: seed-seat-workspaces.ts <seat>=<token> [...]");
  process.exit(1);
}

for (const s of seats) {
  const c = new Client({ name: `seed-${s.seat}`, version: "0.1.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
  }));
  const call = async (n: string, a: Record<string, unknown>) => {
    const r = await c.callTool({ name: n, arguments: a });
    const t = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isErr: Boolean(r.isError), data: t };
  };
  await call("workspace_open", { slug: s.ws });
  const plan = await call("plan_create", {
    title: `${s.seat} — first sprint`,
    summary: `Private plan for seat '${s.seat}'. Only this seat's token can see it.`,
  });
  const task = await call("task_create", {
    title: "Explore the workspace and write your first Brain.md entry",
    priority: 1,
  });
  const mem = await call("brain_update", {
    section: "Mission",
    content: `Private workspace of seat '${s.seat}'. The owner agent works here alone; other seats are rejected (FORBIDDEN).`,
    mode: "replace",
  });
  console.log(`${s.seat.padEnd(8)} plan=${plan.isErr ? "ERR" : "ok"} task=${task.isErr ? "ERR" : "ok"} brain=${mem.isErr ? "ERR" : "ok"}`);
  await c.close();
}
