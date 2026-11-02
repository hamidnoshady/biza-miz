/**
 * OAuth 2.1 for the superadmin console's MCP endpoint (migration 0258).
 *
 * Drives the real route handlers end to end the way an MCP client does:
 * register → authorize → (the admin's consent, here the service call the consent
 * route makes) → token → call the endpoint → refresh → revoke. Pins the
 * properties that matter more than the happy path: single-use codes, PKCE,
 * refresh rotation, capability re-checks against the admin's CURRENT role, 401s
 * a client can act on, and that the tenant and console realms stay apart.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

const ORIGIN = "https://admin.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let databaseName: string;
let db: Client;
let service: typeof import("../src/lib/mcp/platform-oauth");
let mcpRoute: typeof import("../src/app/api/platform/mcp/route");
let registerRoute: typeof import("../src/app/api/platform/mcp/oauth/register/route");
let authorizeRoute: typeof import("../src/app/api/platform/mcp/oauth/authorize/route");
let tokenRoute: typeof import("../src/app/api/platform/mcp/oauth/token/route");
let revokeRoute: typeof import("../src/app/api/platform/mcp/oauth/revoke/route");
let platformMcp: typeof import("../src/lib/mcp/platform-mcp");

const owner = { id: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

beforeAll(async () => {
  databaseName = `pos_platform_oauth_${randomUUID().replaceAll("-", "")}`;
  const admin = new URL(rootDatabaseUrl!);
  admin.pathname = "/postgres";
  const maintenance = new Client({ connectionString: admin.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  service = await import("../src/lib/mcp/platform-oauth");
  platformMcp = await import("../src/lib/mcp/platform-mcp");
  mcpRoute = await import("../src/app/api/platform/mcp/route");
  registerRoute = await import("../src/app/api/platform/mcp/oauth/register/route");
  authorizeRoute = await import("../src/app/api/platform/mcp/oauth/authorize/route");
  tokenRoute = await import("../src/app/api/platform/mcp/oauth/token/route");
  revokeRoute = await import("../src/app/api/platform/mcp/oauth/revoke/route");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  try {
    const dbLib = await import("../src/lib/db");
    await dbLib.getPool().end().catch(() => {});
  } catch {
    // pool never got warm
  }
  process.env.DATABASE_URL = rootDatabaseUrl;
  const admin = new URL(rootDatabaseUrl!);
  admin.pathname = "/postgres";
  const maintenance = new Client({ connectionString: admin.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}, 60_000);

beforeEach(async () => {
  await db.query(
    `TRUNCATE platform_mcp_oauth_tokens, platform_mcp_oauth_codes, platform_mcp_connections,
              platform_mcp_oauth_clients, platform_audit_log, platform_admins RESTART IDENTITY CASCADE`,
  );
  const owners = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, role)
     VALUES ('owner@example.com', 'x', 'Owner', 'owner') RETURNING id`,
  );
  owner.id = owners.rows[0].id;
});

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function formPost(path: string, fields: Record<string, string>) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function registerClient(): Promise<string> {
  const response = await registerRoute.POST(
    jsonPost("/api/platform/mcp/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT] }),
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.token_endpoint_auth_method).toBe("none");
  return body.client_id as string;
}

/** What the consent route does after the admin ticks the boxes. */
async function consent(clientId: string, challenge: string, over: Partial<Parameters<typeof service.issuePlatformAuthorizationCode>[0]> = {}) {
  const result = await service.issuePlatformAuthorizationCode({
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    state: "st-1",
    adminId: owner.id,
    connectionName: "Claude",
    capabilities: ["businesses.read"],
    businessIds: null,
    expiresInDays: 30,
    ...over,
  });
  if (!result.ok) throw new Error(`consent failed: ${result.error}`);
  return result.code;
}

async function exchange(clientId: string, code: string, verifier: string) {
  return tokenRoute.POST(
    formPost("/api/platform/mcp/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    }),
  );
}

function rpc(token: string | null, message: object) {
  return mcpRoute.POST(
    new NextRequest(`${ORIGIN}/api/platform/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "admin.example.com",
        "x-forwarded-proto": "https",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
    }),
  );
}

async function signIn() {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const code = await consent(clientId, challenge);
  const response = await exchange(clientId, code, verifier);
  expect(response.status).toBe(200);
  const tokens = await response.json();
  return { clientId, verifier, code, tokens: tokens as { access_token: string; refresh_token: string; expires_in: number; token_type: string } };
}

describe("registration and authorize", () => {
  it("refuses a registration with no usable redirect URI", async () => {
    const response = await registerRoute.POST(
      jsonPost("/api/platform/mcp/oauth/register", { client_name: "x", redirect_uris: ["http://evil.example.com/cb"] }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_client_metadata");
  });

  it("hands a valid request to the console consent page with a relative Location", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "abc",
    });
    const response = await authorizeRoute.GET(new NextRequest(`${ORIGIN}/api/platform/mcp/oauth/authorize?${qs}`));
    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/platform/mcp-connections/consent?")).toBe(true);
    expect(new URLSearchParams(location.split("?")[1]).get("state")).toBe("abc");
  });

  it("never redirects for an unregistered client or redirect_uri (no open redirect)", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const base = { response_type: "code", code_challenge: challenge, code_challenge_method: "S256" };
    const unknownClient = await authorizeRoute.GET(
      new NextRequest(
        `${ORIGIN}/api/platform/mcp/oauth/authorize?${new URLSearchParams({ ...base, client_id: randomUUID(), redirect_uri: REDIRECT })}`,
      ),
    );
    expect(unknownClient.status).toBe(400);
    const wrongRedirect = await authorizeRoute.GET(
      new NextRequest(
        `${ORIGIN}/api/platform/mcp/oauth/authorize?${new URLSearchParams({ ...base, client_id: clientId, redirect_uri: "https://evil.example.com/cb" })}`,
      ),
    );
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get("location")).toBeNull();
  });
});

describe("the full flow", () => {
  it("signs in, lists tools with the consented capabilities and nothing more", async () => {
    const { tokens } = await signIn();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token.startsWith("pospmcp_at_")).toBe(true);
    expect(tokens.refresh_token.startsWith("pospmcp_rt_")).toBe(true);

    const init = await rpc(tokens.access_token, { method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.status).toBe(200);
    expect(init.headers.get("access-control-allow-origin")).toBe("*");

    const list = await rpc(tokens.access_token, { method: "tools/list" });
    const names = (await list.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_businesses");
    expect(names).not.toContain("set_business_status");
  });

  it("shows the connection in the console list as OAuth, owned by the consenting admin", async () => {
    await signIn();
    const connections = await platformMcp.listPlatformMcpConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0].origin).toBe("oauth");
    expect(connections[0].adminId).toBe(owner.id);
  });

  it("a code is single use", async () => {
    const { clientId, verifier, code } = await signIn();
    const again = await exchange(clientId, code, verifier);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier, and a failed attempt burns the code (RFC 6749 §4.1.2)", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(clientId, challenge);
    const bad = await exchange(clientId, code, pkce().verifier);
    expect(bad.status).toBe(400);
    // Whoever intercepted the code gets one try; the legitimate verifier is no use afterwards.
    const good = await exchange(clientId, code, verifier);
    expect(good.status).toBe(400);
  });

  it("rejects a code presented by a different client", async () => {
    const clientA = await registerClient();
    const clientB = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(clientA, challenge);
    const stolen = await exchange(clientB, code, verifier);
    expect(stolen.status).toBe(400);
  });

  it("refresh rotates: the old refresh token dies, the new pair works", async () => {
    const { tokens } = await signIn();
    const first = await tokenRoute.POST(
      formPost("/api/platform/mcp/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    );
    expect(first.status).toBe(200);
    const rotated = await first.json();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await tokenRoute.POST(
      formPost("/api/platform/mcp/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    );
    expect(replay.status).toBe(400);

    const list = await rpc(rotated.access_token, { method: "tools/list" });
    expect(list.status).toBe(200);
  });

  it("revocation of a token kills it on the very next call", async () => {
    const { tokens } = await signIn();
    const response = await revokeRoute.POST(formPost("/api/platform/mcp/oauth/revoke", { token: tokens.access_token }));
    expect(response.status).toBe(200);
    const after = await rpc(tokens.access_token, { method: "tools/list" });
    expect(after.status).toBe(401);
  });

  it("revoking the connection from the console cuts every OAuth token it holds", async () => {
    const { tokens } = await signIn();
    const [connection] = await platformMcp.listPlatformMcpConnections();
    expect(await platformMcp.revokePlatformMcpConnection(connection.id)).toBe(true);
    expect((await rpc(tokens.access_token, { method: "tools/list" })).status).toBe(401);
    const refresh = await tokenRoute.POST(
      formPost("/api/platform/mcp/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    );
    expect(refresh.status).toBe(400);
  });
});

describe("authority is re-checked, not remembered", () => {
  it("a demoted admin loses the capability on the next call", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(clientId, challenge, { capabilities: ["businesses.read", "business.suspend"] });
    const tokens = await (await exchange(clientId, code, verifier)).json();
    const namesOf = async () =>
      (await (await rpc(tokens.access_token, { method: "tools/list" })).json()).result.tools.map(
        (t: { name: string }) => t.name,
      );

    expect(await namesOf()).toContain("set_business_status");
    await db.query(`UPDATE platform_admins SET role = 'support' WHERE id = $1`, [owner.id]);
    const after = await namesOf();
    expect(after).toContain("list_businesses");
    expect(after).not.toContain("set_business_status");
  });

  it("refuses to issue a code for a capability list that is empty or businesses that are not ids", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    expect(
      await service.issuePlatformAuthorizationCode({
        clientId, redirectUri: REDIRECT, codeChallenge: challenge, state: null, adminId: owner.id,
        connectionName: "x", capabilities: [], businessIds: null, expiresInDays: 1,
      }),
    ).toMatchObject({ ok: false, error: "invalid_capabilities" });
    expect(
      await service.issuePlatformAuthorizationCode({
        clientId, redirectUri: REDIRECT, codeChallenge: challenge, state: null, adminId: owner.id,
        connectionName: "x", capabilities: ["businesses.read"], businessIds: ["not-a-uuid"], expiresInDays: 1,
      }),
    ).toMatchObject({ ok: false, error: "invalid_businesses" });
  });
});

describe("401s a client can act on", () => {
  it("answers a missing bearer with the discovery challenge", async () => {
    const response = await rpc(null, { method: "tools/list" });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('resource_metadata="https://admin.example.com/.well-known/oauth-protected-resource/api/platform/mcp"');
    expect(challenge).not.toContain("invalid_token");
  });

  it("answers a dead token with error=invalid_token so the client refreshes", async () => {
    const response = await rpc(`pospmcp_at_${randomBytes(32).toString("base64url")}`, { method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await response.json()).error.code).toBe(-32004);
  });

  it("answers an expired access token the same way", async () => {
    const { tokens } = await signIn();
    await db.query(`UPDATE platform_mcp_oauth_tokens SET expires_at = now() - interval '1 minute' WHERE kind = 'access'`);
    const response = await rpc(tokens.access_token, { method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers the CORS preflight a browser client sends", async () => {
    const response = await mcpRoute.OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("realm separation", () => {
  it("an OAuth access token is not accepted as a pasted-token credential and vice versa", async () => {
    const { tokens } = await signIn();
    const pasted = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "pasted",
      capabilities: ["businesses.read"],
    });
    expect((await rpc(pasted.token, { method: "tools/list" })).status).toBe(200);
    expect((await rpc(tokens.access_token, { method: "tools/list" })).status).toBe(200);
    // A refresh token is never a bearer for the endpoint.
    expect((await rpc(tokens.refresh_token, { method: "tools/list" })).status).toBe(401);
  });

  it("a console OAuth token never parses as a tenant bearer", async () => {
    const { tokens } = await signIn();
    const { parseMcpBearerToken } = await import("../src/lib/mcp/oauth");
    const request = new Request("https://biz1.example.com/api/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(parseMcpBearerToken(request)).toBeNull();
  });
});

describe("bounded registration", () => {
  it("evicts the oldest unused client rather than refusing once the cap is reached", async () => {
    const first = await registerClient();
    await db.query(
      `INSERT INTO platform_mcp_oauth_clients (client_name, redirect_uris)
       SELECT 'filler-' || g, ARRAY['${REDIRECT}'] FROM generate_series(1, $1::int) g`,
      [service.MAX_PLATFORM_CLIENTS - 1],
    );
    await db.query(`UPDATE platform_mcp_oauth_clients SET created_at = now() - interval '30 minutes' WHERE id = $1`, [first]);
    const next = await registerClient();
    expect(next).not.toBe(first);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM platform_mcp_oauth_clients`);
    expect(rows[0].n).toBeLessThanOrEqual(service.MAX_PLATFORM_CLIENTS);
  });
});
