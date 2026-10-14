/**
 * Issue #883 wave 3 — the Superadmin console's MCP surface. These tests pin
 * the non-negotiables the realm split promised:
 *
 *   1. The token families never cross: a tenant `posmcp_` token authenticates
 *      nothing at /api/platform/mcp, and a console `pospmcp_` token
 *      authenticates nothing at /api/mcp.
 *   2. Capabilities are per-tool and re-verified against the admin's CURRENT
 *      role — the downgrade case the issue names explicitly.
 *   3. Bridging into a tenant always names the business, honours the
 *      credential's bridge list, and reports a per-business outcome.
 *   4. Every call (including denials) leaves a platform_audit_log row.
 *   5. Revocation cuts the credential on its very next call.
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

let databaseName: string;
let db: Client;
let platformMcp: typeof import("../src/lib/mcp/platform-mcp");
let route: typeof import("../src/app/api/platform/mcp/route");

const owner = { id: "" };
const supportAdmin = { id: "" };
const biz = { id: "" };
const otherBiz = { id: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_platform_mcp_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: (() => { const u = new URL(rootDatabaseUrl!); u.pathname = "/postgres"; return u.toString(); })() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  platformMcp = await import("../src/lib/mcp/platform-mcp");
  route = await import("../src/app/api/platform/mcp/route");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  try {
    const dbLib = await import("../src/lib/db");
    await dbLib.getPool().end().catch(() => {});
  } catch {
    // pool never got warm — nothing to close
  }
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: (() => { const u = new URL(rootDatabaseUrl!); u.pathname = "/postgres"; return u.toString(); })() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}, 60_000);

beforeEach(async () => {
  await db.query(`TRUNCATE platform_audit_log, platform_mcp_connections, platform_admins RESTART IDENTITY CASCADE`);
  await db.query(`DELETE FROM businesses`);

  // Provision REAL businesses through the console's own path so every tool
  // reads (identity, features, directory) see the same shape the console
  // sees — including the location row the tenant-insert relies on.
  const { provisionBusiness } = await import("../src/lib/business-provisioning");
  const one = await provisionBusiness({
    businessName: "Cafe One",
    ownerName: "Owner One",
    email: "owner1@example.com",
    password: "password-one",
    industry: "food_service",
    subdomain: "cafe-one-mcptest",
  });
  biz.id = one.businessId;
  const two = await provisionBusiness({
    businessName: "Cafe Two",
    ownerName: "Owner Two",
    email: "owner2@example.com",
    password: "password-two",
    industry: "food_service",
    subdomain: "cafe-two-mcptest",
  });
  otherBiz.id = two.businessId;

  const owners = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, role)
     VALUES ('owner@example.com', 'x', 'Owner', 'owner') RETURNING id`,
  );
  owner.id = owners.rows[0].id;
  const supports = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, role)
     VALUES ('support@example.com', 'x', 'Support', 'support') RETURNING id`,
  );
  supportAdmin.id = supports.rows[0].id;
});

function platformRpc(token: string, message: object) {
  const request = new NextRequest("https://console.example.com/api/platform/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
  });
  return route.POST(request);
}

async function mint(opts: {
  adminId: string;
  capabilities: string[];
  businessIds?: string[] | null;
  expiresInDays?: number | null;
}): Promise<string> {
  const { token } = await platformMcp.createPlatformMcpConnection({
    adminId: opts.adminId,
    name: "test-connector",
    capabilities: opts.capabilities as never,
    businessIds: opts.businessIds ?? null,
    expiresInDays: opts.expiresInDays ?? null,
  });
  return token;
}

describe("platform MCP realm separation", () => {
  it("a tenant posmcp_ token authenticates nothing", async () => {
    // Forge one shaped exactly like the tenant family and hash it the same
    // way — the parse rule (prefix) must reject before comparison.
    const fake = `posmcp_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const auth = await platformMcp.authenticatePlatformMcp(fake);
    expect(auth).toBeNull();
  });

  it("a console token never authenticates at the tenant endpoint", async () => {
    const { parseMcpBearerToken } = await import("../src/lib/mcp/oauth");
    const { token } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "x",
      capabilities: ["businesses.read"],
    });
    expect(token.startsWith("pospmcp_")).toBe(true);
    // The tenant parse is the whole firewall: it must return null, not error.
    const tenantRequest = new Request("https://biz1.example.com/api/mcp", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(parseMcpBearerToken(tenantRequest)).toBeNull();
  });
});

describe("platform MCP tools", () => {
  it("tools/list shows exactly the granted capability set", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    const response = await platformRpc(token, { method: "tools/list" });
    const body = await response.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_businesses");
    expect(names).toContain("get_business_identity");
    expect(names).not.toContain("set_business_feature");
    expect(names).not.toContain("set_business_status");
  });

  it("list_businesses returns the directory rows", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    const response = await platformRpc(token, {
      method: "tools/call",
      params: { name: "list_businesses", arguments: { search: "Cafe" } },
    });
    const body = await response.json();
    expect(body.error).toBeUndefined();
    const text = body.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(JSON.stringify(parsed)).toContain("Cafe One");
  });

  it("a capability the credential lacks is denied, and audited", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    const response = await platformRpc(token, {
      method: "tools/call",
      params: { name: "set_business_feature", arguments: { businessId: biz.id, flagKey: "x", enabled: true } },
    });
    const body = await response.json();
    const text = body.result.content[0].text;
    expect(text).toContain("denied");
    expect(text).toContain("capability");
    const audit = await db.query(
      `SELECT outcome FROM (SELECT payload->>'outcome' AS outcome FROM platform_audit_log
         WHERE action = 'platform_mcp.call' ORDER BY created_at DESC LIMIT 1) s`,
    );
    expect(audit.rows[0].outcome).toBe("denied_capability");
  });

  it("the admin's role demotion takes the capability away on the next call", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read", "features.write"] });
    await db.query(`UPDATE platform_admins SET role = 'support' WHERE id = $1`, [owner.id]);
    const response = await platformRpc(token, {
      method: "tools/call",
      params: { name: "set_business_feature", arguments: { businessId: biz.id, flagKey: "x", enabled: true } },
    });
    const body = await response.json();
    expect(body.result.content[0].text).toContain("denied");
  });

  it("bridging outside the minted business list is denied", async () => {
    const token = await mint({
      adminId: owner.id,
      capabilities: ["business.reports.read"],
      businessIds: [biz.id],
    });
    const response = await platformRpc(token, {
      method: "tools/call",
      params: { name: "list_business_features", arguments: { businessId: otherBiz.id } },
    });
    const body = await response.json();
    expect(body.result.content[0].text).toContain("outside this credential's bridge list");
  });

  it("a batch bridge reports one outcome per requested business, including failures", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["features.write"] });
    const missing = randomUUID();
    const response = await platformRpc(token, {
      method: "tools/call",
      params: {
        name: "set_business_feature",
        arguments: { businessIds: [biz.id, missing], flagKey: "api_platform", enabled: true },
      },
    });
    const body = await response.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.perBusiness[biz.id]).toMatchObject({ ok: true, flag: "api_platform" });
    expect(parsed.perBusiness[missing].ok).toBe(false);
    // And the one that ran really ran:
    const flag = await db.query(
      `SELECT enabled FROM business_features WHERE business_id = $1 AND flag_key = 'api_platform'`,
      [biz.id],
    );
    expect(flag.rows[0]?.enabled).toBe(true);
  });

  it("suspending a business goes through the console setter and is audited", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["business.suspend"] });
    const response = await platformRpc(token, {
      method: "tools/call",
      params: { name: "set_business_status", arguments: { businessId: biz.id, status: "suspended" } },
    });
    const body = await response.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.perBusiness[biz.id]).toMatchObject({ ok: true });
    const status = await db.query<{ status: string }>(`SELECT status::text AS status FROM businesses WHERE id = $1`, [biz.id]);
    expect(status.rows[0].status).toBe("suspended");
    const audit = await db.query(
      `SELECT payload->>'outcome' AS outcome FROM platform_audit_log
        WHERE action = 'platform_mcp.call' AND payload->>'tool' = 'set_business_status'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0].outcome).toBe("ok");
  });

  it("revocation cuts the credential on its next call", async () => {
    const { token, connection } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "short-lived",
      capabilities: ["businesses.read"],
    });
    await platformMcp.revokePlatformMcpConnection(connection.id);
    const response = await platformRpc(token, { method: "tools/list" });
    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("Invalid, expired or revoked");
  });

  it("expiry makes the token dead even before revocation", async () => {
    const { token } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "expiring",
      capabilities: ["businesses.read"],
      expiresInDays: 1,
    });
    // Backdate the expiry the migration check allows: created_at is now, so
    // adjust expires_at to the past only via update of both columns (the
    // tenant-table CHECK the hardening suite hit exists here too? No — this
    // table has no such CHECK; set directly.)
    await db.query(`UPDATE platform_mcp_connections SET expires_at = now() - interval '1 hour'`);
    const auth = await platformMcp.authenticatePlatformMcp(token);
    expect(auth).toBeNull();
  });

  it("every successful call leaves an audit row keyed on the credential", async () => {
    const { token, connection } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "audited",
      capabilities: ["businesses.read"],
    });
    await db.query(`TRUNCATE platform_audit_log`);
    await platformRpc(token, { method: "tools/call", params: { name: "list_businesses", arguments: {} } });
    const audit = await db.query<{ entity_id: string; admin_id: string }>(
      `SELECT entity_id, platform_admin_id AS admin_id FROM platform_audit_log WHERE action = 'platform_mcp.call'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].entity_id).toBe(connection.id);
    expect(audit.rows[0].admin_id).toBe(owner.id);
  });
});

describe("platform MCP credential hygiene", () => {
  it("only the SHA-256 hash and a token prefix are stored; the raw token never is", async () => {
    const { token, connection } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "hygiene",
      capabilities: ["businesses.read"],
    });
    const row = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM platform_mcp_connections WHERE id = $1`,
      [connection.id],
    );
    expect(row.rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.rows[0].token_hash).not.toBe(token);
  });
});
