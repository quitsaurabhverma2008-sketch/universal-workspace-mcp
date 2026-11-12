/** Debug: workspace_open on aurora-demo with full error payload. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "debug-open", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.UMCP_TOKEN}` } },
}));
const res = await client.callTool({ name: "workspace_open", arguments: { slug: "aurora-demo" } });
const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
console.log("isErr:", res.isError);
console.log(text);
await client.close();
process.exit(0);
