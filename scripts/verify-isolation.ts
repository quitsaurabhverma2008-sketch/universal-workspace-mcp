/**
 * Verifies seat isolation: each seat's token must reach ONLY its own workspace.
 *   npx tsx scripts/verify-isolation.ts seat-alpha=umcp_... seat-beta=umcp_...
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const seats = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const [seat, token] = arg.split("=");
  if (seat && token) seats.set(seat, token);
}
if (seats.size === 0) {
  console.error("usage: verify-isolation.ts <seat>=<token> [...]");
  process.exit(1);
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  try { return { isErr: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { isErr: Boolean(res.isError), data: text as unknown as Record<string, unknown> }; }
};

const workspaces = ["alpha-space", "beta-space", "gamma-space"];
let failures = 0;

for (const [seat, token] of seats) {
  const client = new Client({ name: `verify-${seat}`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));

  const list = await call(client, "workspace_list", {});
  const visible = ((list.data as { workspaces?: Array<{ slug: string }> }).workspaces ?? []).map((w) => w.slug);

  for (const ws of workspaces) {
    const res = await call(client, "workspace_open", { slug: ws });
    const code = (res.data as { code?: string }).code;
    const isOwn = ws.startsWith(seat);
    const ok = isOwn ? !res.isErr : res.isErr && code === "FORBIDDEN";
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${seat.padEnd(10)} → ${ws.padEnd(12)} ` +
      `${res.isErr ? `denied (${code})` : "allowed"}  ${isOwn ? "(expected: allowed)" : "(expected: FORBIDDEN)"}`
    );
  }
  console.log(`  ${seat} workspace_list → [${visible.join(", ")}]`);
  await client.close();
}

console.log(failures === 0 ? "\n✔ isolation verified — every seat sees only its own workspace" : `\n✘ ${failures} isolation violation(s)`);
process.exit(failures === 0 ? 0 : 1);
