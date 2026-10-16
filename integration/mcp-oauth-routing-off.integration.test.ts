/**
 * The MCP OAuth flow through its real route handlers, on a deployment that
 * serves businesses at `{label}.{ROOT_DOMAIN}` with `SUBDOMAIN_ROUTING=off`.
 *
 * That shape used to answer every register/authorize/token call with
 * `unknown resource host (ambiguous)`: with routing off the resolver never read
 * the host, found more than one business, and gave up — so no standard MCP
 * client (Claude, the MCP Inspector) could connect, while a pasted static token
 * kept working. This file walks the whole flow over HTTP-shaped requests:
 * register → authorize → consent → token → initialize → tools/list, plus the
 * static-token path and the error a host that names no business now gets.
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const ROOT = "app.test";
const REDIRECT_URI = "http://127.0.0.1:6274/oauth/callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let oauthService: typeof import("../src/lib/mcp/oauth-service");
let connections: typeof import("../src/lib/mcp/connections-service");
let registerRoute: typeof import("../src/app/api/mcp/oauth/register/route");
let authorizeRoute: typeof import("../src/app/api/mcp/oauth/authorize/route");
let tokenRoute: typeof import("../src/app/api/mcp/oauth/token/route");
let mcpRoute: typeof import("../src/app/api/mcp/route");

const savedEnv = {
  ROOT_DOMAIN: process.env.ROOT_DOMAIN,
  SUBDOMAIN_ROUTING: process.env.SUBDOMAIN_ROUTING,
};

const titea = { businessId: "", locationId: "", userId: "" };
const other = { businessId: "", locationId: "", userId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function seed(name: string, subdomain: string) {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, subdomain) VALUES ($1, $2, $3) RETURNING id",
    [name, `${subdomain}-${randomUUID().slice(0, 8)}`, subdomain],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مالک', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  await db.query(
    "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'api_platform', true)",
    [businessId],
  );
  return { businessId, locationId: location.rows[0].id, userId: user.rows[0].id };
}

function request(host: string, path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`https://${host}${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { host, ...(init.headers ?? {}) },
  });
}

function rpc(host: string, token: string, method: string, id = 1) {
  return mcpRoute.POST(
    request(host, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } }
        : {} }),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
    }),
  );
}

beforeAll(async () => {
  process.env.ROOT_DOMAIN = ROOT;
  process.env.SUBDOMAIN_ROUTING = "off";

  databaseName = `pos_mcp_off_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  dbLib = await import("../src/lib/db");
  oauthService = await import("../src/lib/mcp/oauth-service");
  connections = await import("../src/lib/mcp/connections-service");
  registerRoute = await import("../src/app/api/mcp/oauth/register/route");
  authorizeRoute = await import("../src/app/api/mcp/oauth/authorize/route");
  tokenRoute = await import("../src/app/api/mcp/oauth/token/route");
  mcpRoute = await import("../src/app/api/mcp/route");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  // Two businesses: the shape that used to make the resolver say "ambiguous".
  Object.assign(titea, await seed("چایخانه تی تی", "titea"));
  Object.assign(other, await seed("Other", "other"));
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("MCP OAuth with SUBDOMAIN_ROUTING=off", () => {
  const host = `titea.${ROOT}`;

  it("goes register → authorize → consent → token → initialize → tools/list", async () => {
    const registered = await registerRoute.POST(
      request(host, "/api/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "probe",
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    expect(client.client_id).toBeTruthy();
    const { rows } = await db.query("SELECT business_id FROM mcp_oauth_clients WHERE id::text = $1", [
      client.client_id,
    ]);
    expect(rows[0].business_id).toBe(titea.businessId);

    const authorize = await authorizeRoute.GET(
      request(
        host,
        `/api/mcp/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: REDIRECT_URI,
          code_challenge: CHALLENGE,
          code_challenge_method: "S256",
          scope: "pos.read pos.write",
          state: "s1",
          resource: `https://${host}/api/mcp`,
        })}`,
      ),
    );
    // Hands the browser to the consent page on the same origin.
    expect(authorize.status).toBeGreaterThanOrEqual(300);
    expect(authorize.status).toBeLessThan(400);
    const location = authorize.headers.get("location") ?? "";
    expect(location).toMatch(/^\/mcp\/consent\?/);
    // Next.js rewrites 127.0.0.1 to localhost inside request URLs; the
    // registered spelling must survive that, or the code goes nowhere.
    expect(new URLSearchParams(location.split("?")[1]).get("redirect_uri")).toBe(REDIRECT_URI);

    // The consent page is a signed-in dashboard screen; its POST calls this.
    const issued = await dbLib.withTenant(titea.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: titea.businessId,
        clientId: client.client_id,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        state: "s1",
        requestedScopes: ["pos.read", "pos.write"],
        approvedScopes: ["pos.read", "pos.write"],
        writeMode: "approve",
        locationId: titea.locationId,
        userId: titea.userId,
        connectionName: "probe",
      }),
    );
    if (!issued.ok) throw new Error("consent failed");

    const token = await tokenRoute.POST(
      request(host, "/api/mcp/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: issued.code,
          code_verifier: VERIFIER,
          client_id: client.client_id,
          redirect_uri: REDIRECT_URI,
          resource: `https://${host}/api/mcp`,
        }).toString(),
      }),
    );
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope).toBe("pos.read pos.write");

    const init = await rpc(host, tokens.access_token, "initialize");
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { protocolVersion: string } };
    expect(initBody.result.protocolVersion).toBe("2025-06-18");

    const listed = await rpc(host, tokens.access_token, "tools/list", 2);
    const oauthTools = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(oauthTools.length).toBeGreaterThan(0);

    // The same grant through a static token yields the same tool set.
    const minted = await dbLib.withTenant(titea.businessId, () =>
      connections.createStaticMcpConnection(titea.businessId, titea.userId, {
        name: "static",
        locationId: titea.locationId,
        scopes: ["pos.read", "pos.write"],
        writeMode: "approve",
        grants: { apps: {}, branches: "all" },
      }),
    );
    if (!minted.ok) throw new Error("mint failed");
    const staticListed = await rpc(host, minted.token, "tools/list", 3);
    expect(staticListed.status).toBe(200);
    const staticTools = ((await staticListed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(staticTools.map((t) => t.name).sort()).toEqual(oauthTools.map((t) => t.name).sort());

    // Refresh works on the same host.
    const refreshed = await tokenRoute.POST(
      request(host, "/api/mcp/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }).toString(),
      }),
    );
    expect(refreshed.status).toBe(200);
  });

  it("refuses a titea token on another business's host", async () => {
    const minted = await dbLib.withTenant(titea.businessId, () =>
      connections.createStaticMcpConnection(titea.businessId, titea.userId, {
        name: "static",
        locationId: titea.locationId,
        scopes: ["pos.read"],
        writeMode: "approve",
        grants: { apps: {}, branches: "all" },
      }),
    );
    if (!minted.ok) throw new Error("mint failed");
    const response = await rpc(`other.${ROOT}`, minted.token, "tools/list");
    expect(response.status).toBe(401);
  });

  it("keeps the static token working on the apex, where the token names the business", async () => {
    const minted = await dbLib.withTenant(titea.businessId, () =>
      connections.createStaticMcpConnection(titea.businessId, titea.userId, {
        name: "static",
        locationId: titea.locationId,
        scopes: ["pos.read"],
        writeMode: "approve",
        grants: { apps: {}, branches: "all" },
      }),
    );
    if (!minted.ok) throw new Error("mint failed");
    const response = await rpc(ROOT, minted.token, "tools/list");
    expect(response.status).toBe(200);
  });

  it("answers a host that names no business with a plain OAuth error, not the internal code", async () => {
    const response = await registerRoute.POST(
      request(ROOT, "/api/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).not.toContain("unknown resource host");
    expect(body.error_description).not.toContain("ambiguous");
  });
});
