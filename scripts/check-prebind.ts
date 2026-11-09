/** Quick check: agent_register and session_create before any workspace_open. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "check", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.UMCP_TOKEN}` } },
}));
for (const [name, args] of [
  ["agent_register", { name: "opencode-builder", kind: "agent" }],
  ["session_create", { workspace: "pocket-ledger", label: "pre-bind check" }],
] as Array<[string, Record<string, unknown>]>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  console.log(`${name}: ${res.isError ? "ERROR" : "ok"} — ${text.slice(0, 200)}`);
}
await client.close();
process.exit(0);
