/** Debug: one full claim cycle with verbose output. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "claim-debug", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.UMCP_TOKEN}` } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  try { return { isErr: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { isErr: Boolean(res.isError), data: text }; }
};

const opened = await call("workspace_open", { slug: "aurora-home" });
console.log("open:", opened.isErr ? opened.data : "ok");

const listed = await call("task_list", { status: "pending", limit: 10 });
console.log("pending tasks:", JSON.stringify(listed.data, null, 2));

const tasks = (listed.data.tasks ?? []) as Array<{ id: string; priority: number; assignee_agent: string | null; updated_at: string; title: string }>;
const t = tasks.sort((a, b) => a.priority - b.priority).find((x) => !x.assignee_agent);
if (t) {
  console.log("attempting claim on:", t.title, "updated_at=", t.updated_at);
  const claim = await call("task_update", { task_id: t.id, status: "in_progress", assignee_agent: "claim-debug", expected_updated_at: t.updated_at });
  console.log("claim isErr:", claim.isErr);
  console.log("claim data:", JSON.stringify(claim.data, null, 2));
}
await client.close();
process.exit(0);
