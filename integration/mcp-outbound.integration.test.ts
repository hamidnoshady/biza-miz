/**
 * Outbound MCP servers, against a real database and a real HTTP server.
 *
 * The pure halves have their own tests (`guard`, `client`, `naming`). What can
 * only be proved here is the feature the tenant actually buys:
 *
 *  - a registration stores the credential encrypted and **never** returns it;
 *  - discovery persists the tool list, and a later turn builds namespaced tools
 *    without another network call;
 *  - a call reaches the remote server, is recorded in the audit table, and the
 *    row carries no argument or result;
 *  - disabling the server, or narrowing the per-tool allowlist, refuses on the
 *    very next call — no cache to wait out;
 *  - a URL that is not on the deployment's allowlist cannot be registered at all.
 *
 * The remote server is a throwaway `node:http` listener on loopback, which is why
 * `MCP_OUTBOUND_ALLOW_LOOPBACK_HTTP` is set here: production refuses loopback,
 * and the test uses the same code path with the development affordance only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/mcp/outbound/service");
let remote: Server;
let remoteUrl = "";
let businessId = "";

const seen: Array<Record<string, unknown>> = [];

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

const readTool = { description: "Read pages", inputSchema: { properties: {}, type: "object" }, name: "findPages" };
const writeTool = { description: "Publish a page", inputSchema: { properties: {}, type: "object" }, name: "publishPage" };

beforeAll(async () => {
  databaseName = `pos_outbound_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "integration-test-jwt-secret";

  // A loopback listener is only reachable because the deployment explicitly
  // allows it; the guard's own tests prove the production refusal.
  remote = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}") as { id?: unknown; method?: string; params?: { name?: string } };
      seen.push({ headers: request.headers, method: payload.method, name: payload.params?.name });

      if (payload.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
        response.end(
          JSON.stringify({
            id: payload.id,
            jsonrpc: "2.0",
            result: { capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "mock-cms", version: "1.0.0" } },
          }),
        );
        return;
      }
      if (payload.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result: { tools: [readTool, writeTool] } }));
        return;
      }
      if (payload.method === "tools/call") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: payload.id,
            jsonrpc: "2.0",
            result: { content: [{ text: `called ${payload.params?.name}`, type: "text" }], isError: false },
          }),
        );
        return;
      }
      response.writeHead(202);
      response.end();
    });
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  remoteUrl = `http://localhost:${(remote.address() as AddressInfo).port}/mcp`;
  process.env.MCP_OUTBOUND_ALLOW_LOOPBACK_HTTP = "true";
  process.env.MCP_OUTBOUND_ALLOWED_HOSTS = `localhost:${(remote.address() as AddressInfo).port}`;

  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/mcp/outbound/service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => remote.close(() => resolve()));
  await db?.end();
  await dbLib?.getPool().end().catch(() => undefined);
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  seen.length = 0;
  await db.query("DELETE FROM mcp_external_calls");
  await db.query("DELETE FROM mcp_external_servers");
  await db.query("DELETE FROM businesses");

  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Acme', $1) RETURNING id",
    [`acme-${randomUUID().slice(0, 8)}`],
  );
  businessId = business.rows[0].id;
});

async function register(overrides: Record<string, unknown> = {}) {
  const result = await service.createExternalMcpServer({
    authKind: "bearer",
    bearerToken: "super-secret-token",
    businessId,
    enabled: true,
    label: "Acme CMS",
    slug: "acme-cms",
    url: remoteUrl,
    ...overrides,
  });
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.data;
}

describe("registration", () => {
  it("stores the credential encrypted and never returns it", async () => {
    const server = await register();

    const raw = await db.query<{ bearer_token_ciphertext: string }>(
      "SELECT bearer_token_ciphertext FROM mcp_external_servers WHERE id = $1",
      [server.id],
    );
    const stored = raw.rows[0].bearer_token_ciphertext;
    // v1.<iv>.<ciphertext>.<tag> — the integrations ciphertext envelope.
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain("super-secret-token");
    expect(JSON.stringify(server)).not.toContain("super-secret-token");
    expect(server).not.toHaveProperty("bearerToken");
  });

  it("refuses a URL the deployment has not allowed", async () => {
    const result = await service.createExternalMcpServer({
      authKind: "none",
      businessId,
      label: "Elsewhere",
      slug: "elsewhere",
      url: "https://not-allowed.example.com/api/mcp",
    });

    expect(result).toEqual({ error: "url_not_allowed", ok: false });
  });

  it("refuses a duplicate slug for the same business", async () => {
    await register();
    const second = await service.createExternalMcpServer({
      authKind: "none",
      businessId,
      label: "Second",
      slug: "acme-cms",
      url: remoteUrl,
    });

    expect(second).toEqual({ error: "duplicate_slug", ok: false });
  });
});

describe("discovery", () => {
  it("persists the tool list and clears a previous error", async () => {
    const server = await register();
    const result = await service.discoverExternalMcpServer(businessId, server.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.info.name).toBe("mock-cms");
    expect(result.data.server.discoveredTools.map((tool) => tool.name)).toEqual(["findPages", "publishPage"]);
    expect(result.data.server.lastError).toBeNull();
    expect(result.data.server.lastDiscoveredAt).not.toBeNull();
  });

  it("records a failure instead of silently listing nothing", async () => {
    // Register a host that passes the URL check but has nothing listening on the
    // port the listener used for itself — a refused connection, not a DNS failure.
    const deadPort = (remote.address() as AddressInfo).port + 1;
    const previous = process.env.MCP_OUTBOUND_ALLOWED_HOSTS;
    process.env.MCP_OUTBOUND_ALLOWED_HOSTS = `localhost:${deadPort}`;
    const result = await service.createExternalMcpServer({
      authKind: "none",
      businessId,
      label: "Dead",
      slug: "dead",
      url: `http://localhost:${deadPort}/mcp`,
    });
    if (!result.ok) throw new Error(result.error);

    try {
      // The host is allowlisted for this attempt, so the failure is the connection
      // rather than the policy — which is the case the operator needs recorded.
      await expect(service.discoverExternalMcpServer(businessId, result.data.id)).rejects.toBeTruthy();
    } finally {
      process.env.MCP_OUTBOUND_ALLOWED_HOSTS = previous;
    }

    const stored = await service.getExternalMcpServer(businessId, result.data.id);
    expect(stored?.lastError).toContain("could not be reached");
  });
});

describe("invocation", () => {
  it("calls the remote tool with the stored bearer key and audits the outcome", async () => {
    const server = await register();
    const discovery = await service.discoverExternalMcpServer(businessId, server.id);
    expect(discovery.ok).toBe(true);

    const name = service.externalToolName("acme-cms", "findPages");
    const result = await service.callExternalMcpTool({
      actorUserId: null,
      args: { limit: 5 },
      businessId,
      name,
    });

    expect(result).toEqual({ data: { content: [{ text: "called findPages", type: "text" }], isError: false }, ok: true });
    expect(seen.some((entry) => entry.method === "tools/call" && entry.name === "findPages")).toBe(true);
    // The credential travelled as a header, never in the body.
    const call = seen.find((entry) => entry.method === "tools/call");
    expect((call?.headers as Record<string, string>).authorization).toBe("Bearer super-secret-token");

    const calls = await service.listExternalMcpCalls(businessId, { serverId: server.id });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ errorCode: null, status: "ok", toolName: "findPages" });
    // The audit row carries no arguments and no result.
    expect(JSON.stringify(calls[0])).not.toContain("limit");
    expect(JSON.stringify(calls[0])).not.toContain("called findPages");
  });

  it("refuses a disabled server and a tool outside the allowlist on the next call", async () => {
    const server = await register();
    await service.discoverExternalMcpServer(businessId, server.id);
    const name = service.externalToolName("acme-cms", "findPages");

    await service.updateExternalMcpServer({ allowedTools: ["publishPage"], businessId, id: server.id });
    const narrowed = await service.callExternalMcpTool({ args: {}, businessId, name });
    expect(narrowed.ok).toBe(false);

    await service.updateExternalMcpServer({ businessId, enabled: false, id: server.id });
    const disabled = await service.callExternalMcpTool({ args: {}, businessId, name });
    expect(disabled.ok).toBe(false);
    expect(JSON.stringify(disabled)).toContain("غیرفعال");
  });

  it("offers only namespaced tools to a turn, honouring the agent allowlist", async () => {
    const server = await register();
    await service.discoverExternalMcpServer(businessId, server.id);

    const all = await service.externalToolsForTurn(businessId, {});
    expect(all.map((tool) => tool.function.name)).toEqual([
      service.externalToolName("acme-cms", "findPages"),
      service.externalToolName("acme-cms", "publishPage"),
    ]);
    expect(all[0]!.function.description).toContain("Acme CMS");

    const narrowed = await service.externalToolsForTurn(businessId, {
      toolAllowlist: [service.externalToolName("acme-cms", "findPages")],
    });
    expect(narrowed).toHaveLength(1);

    // A disabled server contributes nothing, even with a stale discovery row.
    await service.updateExternalMcpServer({ businessId, enabled: false, id: server.id });
    expect(await service.externalToolsForTurn(businessId, {})).toEqual([]);
  });
});
