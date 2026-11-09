import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type http from "node:http";

// Set env BEFORE importing anything that reads it.
const tmp = mkdtempSync(path.join(os.tmpdir(), "umcp-int-"));
process.env.DATA_DIR = tmp;
process.env.TOKEN_PEPPER = "integration-test-pepper-0123456789abcdef";
process.env.LOG_LEVEL = "error";
process.env.EXEC_MODE = "restricted";

const { createAppServices } = await import("../../src/container.js");
const { createHttpApp } = await import("../../src/transport/http.js");
const { mintToken } = await import("../../src/security/authenticate.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

let app: { server: http.Server; close: () => Promise<void> } | null = null;
let port = 0;
let token = "";
let db: import("../../src/database/db.js").Db;

beforeAll(async () => {
  const services = createAppServices();
  db = services.db;

  const userId = randomUUID();
  db.prepare(`INSERT INTO users (id, display_name, role) VALUES (?, 'test-owner', 'owner')`).run(userId);
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents (id, user_id, name, kind) VALUES (?, ?, 'integration', 'cli')`).run(agentId, userId);
  ({ token } = mintToken(db, services.config.tokenPepper, { userId, agentId, name: "integration-token", scopes: [] }));

  app = createHttpApp(services);
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const addr = app!.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function mcpClient(tok = token) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tok}` } },
  });
  const client = new Client({ name: "integration-test", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

const parseResult = (res: Awaited<ReturnType<Client["callTool"]>>) => {
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
  return { isErr: Boolean(res.isError), data: JSON.parse(text) };
};

describe("MCP server end-to-end", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    expect(res.status).toBe(401);
  });

  it("serves /health without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("exposes the full tool catalog", async () => {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(45);
    expect(tools.map((t) => t.name)).toContain("workspace_create");
    expect(tools.map((t) => t.name)).toContain("terminal_execute");
    await client.close();
  });

  it("runs the complete workflow: create → open → write → plan → exec", async () => {
    const client = await mcpClient();

    const created = await client.callTool({ name: "workspace_create", arguments: { name: "Integration Test" } });
    const ws = parseResult(created);
    expect(ws.isErr).toBe(false);
    const slug = ws.data.slug as string;
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(existsSync(path.join(tmp, "workspaces", slug, "Brain.md"))).toBe(true);
    expect(existsSync(path.join(tmp, "workspaces", slug, "PLAN.md"))).toBe(true);

    const opened = await client.callTool({ name: "workspace_open", arguments: { slug } });
    expect(parseResult(opened).isErr).toBe(false);

    // file roundtrip with optimistic concurrency
    const written = await client.callTool({ name: "file_write", arguments: { path: "src/app.ts", content: "const x = 1;\n" } });
    const writeData = parseResult(written);
    expect(writeData.isErr).toBe(false);
    const hash = writeData.data.hash as string;

    // stale hash must be rejected
    const stale = await client.callTool({ name: "file_write", arguments: { path: "src/app.ts", content: "const x = 2;\n", expected_hash: "0".repeat(64) } });
    const staleData = parseResult(stale);
    expect(staleData.isErr).toBe(true);
    expect(staleData.data.code).toBe("HASH_CONFLICT");

    // correct hash passes
    const updated = await client.callTool({ name: "file_write", arguments: { path: "src/app.ts", content: "const x = 2;\n", expected_hash: hash } });
    expect(parseResult(updated).isErr).toBe(false);

    // plan → task → complete
    const planRes = await client.callTool({ name: "plan_create", arguments: { title: "Integration plan" } });
    expect(parseResult(planRes).isErr).toBe(false);
    const taskRes = await client.callTool({ name: "task_create", arguments: { title: "do the thing", priority: 1 } });
    const taskData = parseResult(taskRes);
    expect(taskData.isErr).toBe(false);
    const doneRes = await client.callTool({ name: "task_complete", arguments: { task_id: taskData.data.id } });
    expect(parseResult(doneRes).data.plan_completed).toBe(true);

    // PLAN.md reflects the plan
    const planMd = readFileSync(path.join(tmp, "workspaces", slug, "PLAN.md"), "utf8");
    expect(planMd).toContain("Integration plan");

    // memory
    const memRes = await client.callTool({ name: "memory_add", arguments: { kind: "decision", title: "test decision", content: "we test integration early" } });
    expect(parseResult(memRes).isErr).toBe(false);
    const searchRes = await client.callTool({ name: "memory_search", arguments: { query: "integration early" } });
    expect(parseResult(searchRes).data.count).toBeGreaterThanOrEqual(1);

    // execution: allowed and denied
    const okRes = await client.callTool({ name: "terminal_execute", arguments: { command: "echo umcp-test", wait: true } });
    const okData = parseResult(okRes);
    expect(okData.isErr).toBe(false);
    expect(okData.data.stdoutTail).toContain("umcp-test");

    const deniedRes = await client.callTool({ name: "terminal_execute", arguments: { command: "rm -rf /", wait: true } });
    const deniedData = parseResult(deniedRes);
    expect(deniedData.isErr).toBe(true);
    expect(deniedData.data.code).toBe("EXEC_DENIED");

    // path traversal is rejected through the file tools
    const escapeRes = await client.callTool({ name: "file_read", arguments: { path: "../../etc/passwd" } });
    expect(parseResult(escapeRes).data.code).toBe("PATH_ESCAPE");

    await client.close();
  }, 30_000);
});
