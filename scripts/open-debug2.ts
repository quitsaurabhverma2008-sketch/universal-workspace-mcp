/** Debug: open + brain_update + plan_create in ONE session (mirrors seed-aurora.ts). */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "debug2", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.UMCP_TOKEN}` } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  console.log(`--- ${name} => isErr=${res.isError}`);
  console.log(text.slice(0, 400));
  console.log();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; }
};
await call("workspace_open", { slug: "aurora-demo" });
await call("brain_update", { section: "Mission", content: "debug mission", mode: "replace" });
await call("plan_create", { title: "debug plan", summary: "verify binding" });
await client.close();
process.exit(0);
