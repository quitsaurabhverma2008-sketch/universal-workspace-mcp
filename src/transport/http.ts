import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "../config/env.js";
import type { Db } from "../database/db.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionContext, Principal } from "../types.js";
import { verifyBearer } from "../security/authenticate.js";
import { buildMcpServer, SERVER_VERSION, SERVER_NAME } from "../server.js";
import { RateLimiter } from "./ratelimit.js";
import { logger } from "../utils/logger.js";
import { buildUiState, listUiWorkspaces, uiDb } from "../ui/state.js";

export interface HttpServices {
  db: Db;
  config: AppConfig;
}

interface RegisteredSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ctx: SessionContext;
}

export interface HttpApp {
  server: http.Server;
  /** Best-effort graceful shutdown: close transports, then the HTTP listener. */
  close: () => Promise<void>;
}

/* ── static UI assets ──────────────────────────────────────────────── */

const UI_DIR_CANDIDATES = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui"), // dist/transport → dist/ui
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "ui"), // running from src/
];
const THREE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  "three",
  "build",
  "three.module.js"
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function uiAssetPath(file: string): string | null {
  for (const dir of UI_DIR_CANDIDATES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function serveFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  const data = await fsp.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  sendJson(res, httpStatus, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function isLoopbackOrigin(host: string): boolean {
  try {
    const hostname = new URL(host).hostname;
    return ["127.0.0.1", "localhost", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

/** Origin check against DNS rebinding. CLI MCP clients send no Origin — allowed. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (host && origin.includes(`://${host}`)) return true; // same host
  return isLoopbackOrigin(origin); // local dev tooling
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; error: "too_large" | "bad_json" }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) return { ok: false, error: "too_large" };
    chunks.push(buf);
  }
  if (chunks.length === 0) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: "bad_json" };
  }
}

export function createHttpApp(services: HttpServices): HttpApp {
  const { db, config } = services;
  const sessions = new Map<string, RegisteredSession>();
  const rateLimiter = new RateLimiter(config.rateLimitPerMin);
  const startedAt = Date.now();

  const createSessionRow = (sessionId: string, principal: Principal, client?: { name?: string; version?: string }) => {
    db.prepare(
      `INSERT INTO sessions (id, agent_id, user_id, client_name, client_version, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(sessionId, principal.agentId, principal.userId, client?.name?.slice(0, 120) ?? null, client?.version?.slice(0, 60) ?? null);
  };

  const closeSessionRow = (sessionId: string) => {
    try {
      db.prepare(`UPDATE sessions SET status = 'ended', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'active'`).run(sessionId);
    } catch (error) {
      logger.error({ err: error, sessionId }, "failed to close session row");
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    void (async () => {
      try {
        // ── Health (unauthenticated, minimal) ───────────────────────
        if (pathname === "/health") {
          if (req.method !== "GET") return sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET only" } });
          return sendJson(res, 200, { status: "ok", name: SERVER_NAME, version: SERVER_VERSION, uptime_s: Math.floor((Date.now() - startedAt) / 1000) });
        }

        // ── Web UI (3D live squad view) ────────────────────────────
        if (pathname === "/ui" || pathname.startsWith("/ui/")) {
          // static shell (no secrets inside)
          if (req.method === "GET" && (pathname === "/ui" || pathname === "/ui/")) {
            const idx = uiAssetPath("index.html");
            if (!idx) return sendJson(res, 500, { error: { code: "INTERNAL", message: "ui assets missing" } });
            return serveFile(res, idx, MIME[".html"]!);
          }
          if (req.method === "GET" && pathname === "/ui/app.js") {
            const p = uiAssetPath("app.js");
            if (!p) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "app.js missing" } });
            return serveFile(res, p, MIME[".js"]!);
          }
          if (req.method === "GET" && pathname === "/ui/style.css") {
            const p = uiAssetPath("style.css");
            if (!p) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "style.css missing" } });
            return serveFile(res, p, MIME[".css"]!);
          }
          if (req.method === "GET" && pathname === "/ui/three.module.js") {
            if (!fs.existsSync(THREE_PATH)) {
              return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "three.js not installed" } });
            }
            return serveFile(res, THREE_PATH, MIME[".js"]!);
          }

          // API — requires the same bearer token as MCP
          if (pathname.startsWith("/ui/api/")) {
            const authHeader = req.headers.authorization ?? "";
            const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
            let principal: Principal;
            try {
              principal = verifyBearer(db, config.tokenPepper, bearer);
            } catch {
              return sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
            }
            if (!rateLimiter.allow(principal.tokenId)) {
              return sendJson(res, 429, { error: { code: "RATE_LIMITED", message: "rate limit exceeded" } });
            }
            try {
              if (pathname === "/ui/api/state") {
                const slug = url.searchParams.get("workspace") ?? "";
                const state = buildUiState(uiDb, principal, slug, {
                  name: SERVER_NAME,
                  version: SERVER_VERSION,
                  started_at: new Date(startedAt).toISOString(),
                  uptime_s: Math.floor((Date.now() - startedAt) / 1000),
                });
                return sendJson(res, 200, state);
              }
              if (pathname === "/ui/api/workspaces") {
                return sendJson(res, 200, { workspaces: listUiWorkspaces(uiDb, principal) });
              }
            } catch (error) {
              return sendJson(res, 404, {
                error: { code: "NOT_FOUND", message: error instanceof Error ? error.message : "not found" },
              });
            }
            return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown ui endpoint" } });
          }

          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown ui path" } });
        }

        // ── Everything else requires the /mcp path ───────────────────
        if (pathname !== "/mcp") {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "routes: GET /health, ALL /mcp, GET /ui" } });
        }
        if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
          return sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST, GET, DELETE only" } }, { allow: "POST, GET, DELETE" });
        }
        if (!originAllowed(req)) {
          return sendJson(res, 403, { error: { code: "FORBIDDEN", message: "origin not allowed" } });
        }

        // ── Authentication ───────────────────────────────────────────
        const authHeader = req.headers.authorization ?? "";
        const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
        let principal: Principal;
        try {
          principal = verifyBearer(db, config.tokenPepper, bearer);
        } catch (error) {
          const code = (error as { code?: string })?.code === "UNAUTHORIZED" ? "UNAUTHORIZED" : "INTERNAL";
          logger.warn({ path: pathname, reason: code }, "auth failed");
          return sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }, { "www-authenticate": 'Bearer realm="universal-mcp"' });
        }

        if (!rateLimiter.allow(principal.tokenId)) {
          logger.warn({ tokenId: principal.tokenId }, "rate limit exceeded");
          return sendJson(
            res,
            429,
            { error: { code: "RATE_LIMITED", message: "rate limit exceeded" } },
            { "retry-after": String(Math.ceil(rateLimiter.retryAfterMs(principal.tokenId) / 1000)) }
          );
        }

        // ── MCP transport dispatch ───────────────────────────────────
        const sessionIdHeader = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

        if (req.method === "POST") {
          const parsed = await readBody(req, config.maxBodyBytes);
          if (!parsed.ok) {
            return parsed.error === "too_large"
              ? sendJson(res, 413, { error: { code: "TOO_LARGE", message: "request body exceeds limit" } })
              : sendRpcError(res, 400, -32700, "Parse error: body is not valid JSON");
          }
          const body = parsed.body as { method?: string; params?: { clientInfo?: { name?: string; version?: string } } } | undefined;

          let registered = sessionId ? sessions.get(sessionId) : undefined;

          if (!registered) {
            if (sessionId) {
              return sendRpcError(res, 404, -32001, "Session not found — re-initialize");
            }
            if (body?.method !== "initialize") {
              return sendRpcError(res, 400, -32000, "Bad Request: a new session requires an initialize request (or pass Mcp-Session-Id)");
            }

            // Fresh MCP session — create server + transport pair
            const ctx: SessionContext = { principal, sessionRowId: "", boundWorkspaceId: null };
            const mcpServer = buildMcpServer(services, ctx);

            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                ctx.sessionRowId = sid;
                createSessionRow(sid, principal, body?.params?.clientInfo);
                sessions.set(sid, { transport, server: mcpServer, ctx });
                logger.info({ sessionId: sid, client: body?.params?.clientInfo, user: principal.userId, agent: principal.agentName }, "mcp session initialized");
              },
              onsessionclosed: (sid) => {
                closeSessionRow(sid);
                sessions.delete(sid);
                logger.info({ sessionId: sid }, "mcp session closed");
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) {
                closeSessionRow(transport.sessionId);
                sessions.delete(transport.sessionId);
              }
            };

            await mcpServer.connect(transport);
            registered = { transport, server: mcpServer, ctx };
          }

          await registered.transport.handleRequest(req, res, body);
          return;
        }

        // GET (SSE stream) and DELETE (session end) need a known session
        if (!sessionId) {
          return sendRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header required for GET/DELETE");
        }
        const registered = sessions.get(sessionId);
        if (!registered) {
          return sendRpcError(res, 404, -32001, "Session not found — re-initialize");
        }
        await registered.transport.handleRequest(req, res);
      } catch (error) {
        logger.error({ err: error }, "unhandled http error");
        if (!res.headersSent) {
          sendJson(res, 500, { error: { code: "INTERNAL", message: "internal server error" } });
        } else {
          res.end();
        }
      }
    })();
  });

  const close = async (): Promise<void> => {
    const closers: Promise<void>[] = [];
    for (const [, registered] of sessions) {
      closers.push(registered.server.close().catch(() => undefined));
    }
    sessions.clear();
    await Promise.all(closers);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, close };
}
