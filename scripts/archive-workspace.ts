import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const slug = process.argv[2];
if (!slug) { console.error("usage: tsx scripts/archive-workspace.ts <slug>"); process.exit(1); }
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.SMOKE_TOKEN}` } },
});
const client = new Client({ name: "archive", version: "0.1.0" });
await client.connect(transport);
const res = await client.callTool({ name: "workspace_delete", arguments: { slug, confirm_slug: slug } });
console.log(JSON.stringify(res.content, null, 2));
await client.close();
process.exit(0);
