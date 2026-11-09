/**
 * End-to-end smoke test against a running server.
 * Usage: SMOKE_TOKEN=umcp_... npx tsx scripts/smoke.ts [base-url]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.argv[2] ?? "http://127.0.0.1:3333/mcp";
const TOKEN = process.env.SMOKE_TOKEN;
if (!TOKEN) {
  console.error("set SMOKE_TOKEN=umcp_... ");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(BASE), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? "";
  const isErr = Boolean(res.isError);
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  return { isErr, parsed };
};
const show = (label: string, r: { isErr: boolean; parsed: unknown }) => {
  console.log(`\n=== ${label}${r.isErr ? "  [ERROR]" : ""} ===`);
  console.log(JSON.stringify(r.parsed, null, 2).slice(0, 900));
};

const tools = await client.listTools();
console.log(`tools exposed: ${tools.tools.length}`);
console.log(tools.tools.map((t) => t.name).sort().join(", "));

show("workspace_create", await call("workspace_create", { name: "Smoke Test", slug: "smoke-test", description: "end-to-end smoke workspace" }));
show("workspace_open", await call("workspace_open", { slug: "smoke-test" }));
show("file_write", await call("file_write", { path: "src/hello.txt", content: "line one\nline two\n", create_dirs: true }));
const fw = await call("file_read", { path: "src/hello.txt" });
show("file_read", fw);
const hash = (fw.parsed as { hash?: string }).hash;
show("file_edit", await call("file_edit", { path: "src/hello.txt", old_string: "line one", new_string: "line ONE", expected_hash: hash }));
show("brain_update", await call("brain_update", { section: "Current State", content: "Smoke test ran; workspace is alive.", mode: "replace" }));
show("decision_record", await call("decision_record", { title: "Smoke decision", decision: "Use smoke tests pre-deploy", rationale: "fast feedback", alternatives: ["manual testing"] }));
show("memory_search", await call("memory_search", { query: "smoke" }));
show("plan_create", await call("plan_create", { title: "Smoke plan", summary: "verify the planning engine end to end" }));
const tc = await call("task_create", { title: "Verify tool roundtrip", priority: 1 });
show("task_create", tc);
const taskId = (tc.parsed as { id?: string }).id;
show("project_status", await call("project_status", {}));
show("task_complete", await call("task_complete", { task_id: taskId, note: "roundtrip ok" }));
show("terminal_execute", await call("terminal_execute", { command: "echo hello-from-sandbox", wait: true }));
show("exec_denied", await call("terminal_execute", { command: "rm -rf /", wait: true }));
show("session_history", await call("session_history", { limit: 10 }));
show("task_list", await call("task_list", {}));

await client.close();
console.log("\nSMOKE TEST DONE");
process.exit(0);
