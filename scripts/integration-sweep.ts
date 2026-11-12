/**
 * Post-race cleanup: everything still untracked/modified is swept into one
 * integration commit (branches/PLAN.md/Brain.md/logs). Runs THROUGH MCP.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "sweep", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.UMCP_TOKEN}` } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  try { return { isErr: Boolean(res.isError), data: JSON.parse(text) as Record<string, unknown> }; }
  catch { return { isErr: Boolean(res.isError), data: text as unknown as Record<string, unknown> }; }
};
const ws = await call("workspace_open", { slug: "aurora-showcase" });
console.log("open:", ws.isErr ? "ERR" : "ok");
const status = await call("terminal_execute", {
  command: "git status --porcelain",
  wait: true,
});
console.log("status:\n", (status.data as { stdoutTail?: string }).stdoutTail);
const sweep = await call("terminal_execute", {
  command: 'git add -A && git -c user.name=agent-gamma -c user.email=agent-gamma@mcp commit --quiet -m "integration: sweep remaining agent artifacts" && git log --oneline',
  wait: true,
});
console.log("sweep:\n", (sweep.data as { stdoutTail?: string }).stdoutTail);
const pl = await call("task_list", {});
const tasks = (pl.data.tasks ?? []) as Array<Record<string, unknown>>;
console.log("tasks:", tasks.map((t) => `${t.priority}:${t.status}:${t.assignee_name}`).join(" | "));
await client.close();
process.exit(0);
