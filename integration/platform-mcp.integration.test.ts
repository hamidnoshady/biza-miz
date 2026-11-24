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
/**
 * Issue #1430 fixtures: one login-holding person on the first business, with a
 * safe MFA enrolment and a second membership on the other business so
 * cross-business redaction has something to redact.
 */
const ownerProfile = {
  membershipId: "",
  platformUserId: "",
  email: "",
  passwordHash: "",
  otherMembershipId: "",
};

/** The subset of `OwnerProfile` these tests assert on (the rest is compared whole). */
interface OwnerProfilePayload {
  membershipId: string;
  role: string;
  fullName: string;
  email: string | null;
  membershipActive: boolean;
  membershipCount: number;
  otherBusinesses: { id: string; name: string }[];
  mfa: {
    method: string | null;
    phoneE164: string | null;
    confirmedAt: string | null;
    recoveryCodesRemaining: number;
  };
  branchAccess: { locationId: string | null; locationName: string | null };
}

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Issue #1194 — these suites drive the Central realm, so the process must say
 * it is Central. The platform guard (`src/lib/platform-runtime-guard.ts`) now
 * answers 404 for `/api/platform/*` on any install whose `DEPLOYMENT_ROLE` is
 * not `central`, and an unset role infers `site` from an otherwise empty
 * environment. Declaring the role here keeps the suite honest: it exercises the
 * same code path a Central deployment runs, and a site run is covered by
 * `src/lib/platform-realm-isolation.test.ts` instead.
 */
const previousDeploymentRole = process.env.DEPLOYMENT_ROLE;

beforeAll(async () => {
  // The Central realm exists only on a central deployment (#1194).
  process.env.DEPLOYMENT_ROLE = "central";
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
  if (previousDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = previousDeploymentRole;
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

/** One `tools/call` round-trip, returning the JSON payload the client sees. */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; data: unknown }> {
  const response = await platformRpc(token, {
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = await response.json();
  const text = body.result?.content?.[0]?.text ?? "";
  try {
    return { text, data: JSON.parse(text) };
  } catch {
    return { text, data: text };
  }
}

/**
 * Issue #1430 directory fixtures: two rows that differ in every filter the
 * console offers, so a parity test proves the filter ran rather than merely
 * returning both rows. Runs inside the tests that need it, not in the shared
 * `beforeEach`, to keep the other suites' setup cost unchanged.
 */
async function prepareDirectoryFixtures(): Promise<void> {
  await db.query(
    `UPDATE businesses b
        SET plan = v.plan, industry = v.industry, created_at = v.created_at
       FROM (VALUES
              ($1::uuid, 'free'::text, 'food_service'::text, now() - interval '10 days'),
              ($2::uuid, 'pro'::text, 'jewelry'::text, now() - interval '1 day')
            ) AS v(id, plan, industry, created_at)
      WHERE b.id = v.id`,
    [biz.id, otherBiz.id],
  );
  const location = await db.query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1`,
    [biz.id],
  );
  // "active" means "has an order"; the second business stays idle.
  await db.query(
    `INSERT INTO orders (location_id, order_number, type, status, total)
     VALUES ($1, 1, 'takeaway', 'completed', 1000)`,
    [location.rows[0].id],
  );
}

/**
 * Issue #1430 owner-profile fixtures: the first business's owner identity also
 * manages the second business (so `otherBusinesses` has something to redact),
 * with a confirmed SMS factor, one unused recovery code and a TOTP secret that
 * must never leave the database.
 */
async function prepareOwnerProfileFixtures(): Promise<void> {
  const ownerRow = await db.query<{
    membership_id: string;
    platform_user_id: string;
    email: string;
    password_hash: string;
    other_membership_id: string;
  }>(
    `WITH owner AS (
       SELECT u.id AS membership_id, u.platform_user_id,
              p.email::text AS email, p.password_hash
         FROM users u JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.business_id = $1 AND u.role::text = 'owner'
        LIMIT 1
     ), manager AS (
       INSERT INTO users (business_id, platform_user_id, role, full_name)
       SELECT $2::uuid, platform_user_id, 'manager', 'Owner One' FROM owner
       RETURNING id
     )
     SELECT owner.*, manager.id AS other_membership_id FROM owner, manager`,
    [biz.id, otherBiz.id],
  );
  ownerProfile.membershipId = ownerRow.rows[0].membership_id;
  ownerProfile.platformUserId = ownerRow.rows[0].platform_user_id;
  ownerProfile.email = ownerRow.rows[0].email;
  ownerProfile.passwordHash = ownerRow.rows[0].password_hash;
  ownerProfile.otherMembershipId = ownerRow.rows[0].other_membership_id;

  await db.query(
    `DELETE FROM mfa_enrolments
      WHERE subject_realm = 'platform_user' AND subject_id = $1`,
    [ownerProfile.platformUserId],
  );
  await db.query(
    `DELETE FROM mfa_recovery_codes
      WHERE subject_realm = 'platform_user' AND subject_id = $1`,
    [ownerProfile.platformUserId],
  );
  await db.query(
    `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, phone_e164, is_primary, confirmed_at)
     VALUES ('platform_user', $1, 'sms_otp', '+989121234567', true, now())`,
    [ownerProfile.platformUserId],
  );
  await db.query(
    `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, totp_secret, confirmed_at)
     VALUES ('platform_user', $1, 'totp', $2, now())`,
    [ownerProfile.platformUserId, Buffer.from("super-secret-totp")],
  );
  await db.query(
    `INSERT INTO mfa_recovery_codes (subject_realm, subject_id, code_hash)
     VALUES ('platform_user', $1, 'hashed-recovery-code')`,
    [ownerProfile.platformUserId],
  );
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

describe("platform MCP business directory (issue #1430)", () => {
  it("returns exactly what queryBusinesses returns for the console's filters", async () => {
    await prepareDirectoryFixtures();
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    const { queryBusinesses } = await import("../src/lib/platform-service");
    const today = new Date().toISOString().slice(0, 10);
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

    // Each pair is the tool's argument object and the canonical console query
    // it must become. The two fixtures differ in plan, industry, creation date
    // and order activity, so a filter that silently did nothing would return
    // both rows and fail the equality.
    const cases: { args: Record<string, unknown>; query: Record<string, unknown> }[] = [
      { args: { search: "Cafe" }, query: { search: "Cafe" } },
      { args: { status: "active" }, query: { status: "active" } },
      { args: { plan: "pro" }, query: { plan: "pro" } },
      { args: { industry: "jewelry" }, query: { industry: "jewelry" } },
      { args: { activity: "active" }, query: { activity: "active" } },
      { args: { activity: "idle" }, query: { activity: "idle" } },
      {
        args: { createdFrom: sixDaysAgo, createdTo: today },
        query: { createdFrom: sixDaysAgo, createdTo: today },
      },
      { args: { sort: "name", sortDir: "asc" }, query: { sort: "name", sortDir: "asc" } },
      { args: { sort: "oldest" }, query: { sort: "oldest" } },
      { args: { page: 2, pageSize: 1 }, query: { page: 2, pageSize: 1 } },
      // The pre-#1430 shape keeps meaning the same rows.
      { args: { limit: 1, offset: 1 }, query: { page: 2, pageSize: 1 } },
    ];

    for (const { args, query } of cases) {
      const result = await callTool(token, "list_businesses", args);
      const expected = await queryBusinesses(query as never);
      expect(result.data, JSON.stringify(args)).toEqual(JSON.parse(JSON.stringify(expected)));
    }

    // Prove the filters are discriminating, not vacuous.
    const pro = await callTool(token, "list_businesses", { plan: "pro" });
    expect(pro.data).toMatchObject({ total: 1 });
    expect(JSON.stringify(pro.data)).toContain("Cafe Two");
    const active = await callTool(token, "list_businesses", { activity: "active" });
    expect(active.data).toMatchObject({ total: 1 });
    expect(JSON.stringify(active.data)).toContain("Cafe One");
  });

  it("refuses invalid filters with a clear result and an audit row, never a silent widening", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    await db.query(`TRUNCATE platform_audit_log`);

    for (const args of [
      { pageSize: 101 },
      { page: 0 },
      { industry: "not_a_trade" },
      { createdFrom: "2026-13-01" },
      { createdFrom: "2026-06-02", createdTo: "2026-06-01" },
      { page: 1, offset: 5 },
    ]) {
      const result = await callTool(token, "list_businesses", args);
      expect(result.text, JSON.stringify(args)).toContain("invalid_arguments");
      expect(result.data, JSON.stringify(args)).toMatchObject({
        error: "invalid_arguments",
        message: expect.any(String),
      });
    }

    const audit = await db.query<{ outcome: string }>(
      `SELECT payload->>'outcome' AS outcome FROM platform_audit_log
        WHERE action = 'platform_mcp.call' AND payload->>'tool' = 'list_businesses'`,
    );
    expect(audit.rows).toHaveLength(6);
    expect(audit.rows.every((row) => row.outcome === "invalid_arguments")).toBe(true);
  });
});

describe("platform MCP owner profile (issue #1430)", () => {
  it("returns the console DTO and safe MFA state, never credential material", async () => {
    await prepareOwnerProfileFixtures();
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    const { listBusinessOwnerProfiles } = await import("../src/lib/platform-owner-profile");

    const result = await callTool(token, "get_business_owner_profile", { businessId: biz.id });
    const consoleProfiles = await listBusinessOwnerProfiles(biz.id);
    expect(result.data).toEqual({
      businessId: biz.id,
      found: true,
      profiles: JSON.parse(JSON.stringify(consoleProfiles)),
    });

    const data = result.data as { profiles: OwnerProfilePayload[] };
    const profile = data.profiles.find((p) => p.membershipId === ownerProfile.membershipId);
    expect(profile).toMatchObject({
      role: "owner",
      fullName: "Owner One",
      email: ownerProfile.email,
      membershipActive: true,
      membershipCount: 2,
      mfa: {
        method: "sms_otp",
        phoneE164: "+989121234567",
        recoveryCodesRemaining: 1,
      },
      branchAccess: { locationId: null, locationName: null },
    });
    expect(profile!.mfa.confirmedAt).toBeTruthy();
    expect(profile!.otherBusinesses.map((b: { id: string }) => b.id)).toEqual([otherBiz.id]);

    // The console profile never carried a secret; the MCP read must not start.
    expect(result.text).not.toContain(ownerProfile.passwordHash);
    expect(result.text).not.toContain("super-secret-totp");
    expect(result.text).not.toContain("hashed-recovery-code");
    expect(result.text).not.toContain("password_hash");
    expect(result.text).not.toContain("totp_secret");
  });

  it("denies a credential without businesses.read before reading a profile", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["audit.read"] });

    const listed = await platformRpc(token, { method: "tools/list" });
    const listedBody = await listed.json();
    expect(listedBody.result.tools.map((t: { name: string }) => t.name)).not.toContain(
      "get_business_owner_profile",
    );

    const result = await callTool(token, "get_business_owner_profile", { businessId: biz.id });
    expect(result.text).toContain("denied");
    expect(result.text).toContain("capability");
    const audit = await db.query<{ outcome: string }>(
      `SELECT payload->>'outcome' AS outcome FROM platform_audit_log
        WHERE action = 'platform_mcp.call' AND payload->>'tool' = 'get_business_owner_profile'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.outcome).toBe("denied_capability");
  });

  it("stays inside the bridge list, reads one business per call and redacts other tenants", async () => {
    await prepareOwnerProfileFixtures();
    const scoped = await mint({
      adminId: owner.id,
      capabilities: ["businesses.read"],
      businessIds: [biz.id],
    });

    const own = await callTool(scoped, "get_business_owner_profile", { businessId: biz.id });
    expect(own.data).toMatchObject({ businessId: biz.id, found: true });
    const profile = (own.data as { profiles: OwnerProfilePayload[] }).profiles.find(
      (p) => p.membershipId === ownerProfile.membershipId,
    );
    // The identity really belongs to two businesses; the scoped credential is
    // only allowed to learn about the one it was minted for.
    expect(profile!.membershipCount).toBe(2);
    expect(profile!.otherBusinesses).toEqual([]);

    const outside = await callTool(scoped, "get_business_owner_profile", { businessId: otherBiz.id });
    expect(outside.text).toContain("outside this credential's bridge list");

    const unscoped = await mint({ adminId: owner.id, capabilities: ["businesses.read"] });
    const batch = await callTool(unscoped, "get_business_owner_profile", {
      businessIds: [biz.id, otherBiz.id],
    });
    expect(batch.text).toContain("exactly one business");

    const exact = await callTool(unscoped, "get_business_owner_profile", {
      businessId: biz.id,
      membershipId: ownerProfile.membershipId,
    });
    expect((exact.data as { profiles: unknown[] }).profiles).toHaveLength(1);

    // A membership from the other business is not a profile of this one: the
    // read stays scoped to the explicitly selected business.
    const crossed = await callTool(unscoped, "get_business_owner_profile", {
      businessId: biz.id,
      membershipId: ownerProfile.otherMembershipId,
    });
    expect(crossed.data).toMatchObject({ businessId: biz.id, found: true, profiles: [] });

    const missingId = randomUUID();
    const missing = await callTool(unscoped, "get_business_owner_profile", { businessId: missingId });
    expect(missing.data).toEqual({ businessId: missingId, found: false, profiles: [] });
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

describe("platform MCP token diagnostics (issue #1126)", () => {
  it("reports a valid token with its minted capabilities and current role", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read", "features.write"] });
    const diagnosis = await platformMcp.diagnosePlatformMcpToken(token);
    expect(diagnosis.status).toBe("valid");
    expect(diagnosis.connection?.capabilities).toEqual(["businesses.read", "features.write"]);
    expect(diagnosis.connection?.adminRole).toBe("owner");
  });

  it("names the wrong realm for tenant-shaped tokens", async () => {
    for (const prefix of ["posmcp_", "posmcp_at_", "posmcp_rt_"]) {
      const diagnosis = await platformMcp.diagnosePlatformMcpToken(`${prefix}abc`);
      expect(diagnosis.status, prefix).toBe("wrong_realm");
      expect(diagnosis.connection, prefix).toBeNull();
    }
  });

  it("reports malformed for garbage and unknown for a well-formed but unminted token", async () => {
    expect((await platformMcp.diagnosePlatformMcpToken("not-a-token")).status).toBe("malformed");
    expect((await platformMcp.diagnosePlatformMcpToken("")).status).toBe("malformed");
    const ghost = `pospmcp_${"ab".repeat(24)}`;
    const diagnosis = await platformMcp.diagnosePlatformMcpToken(ghost);
    expect(diagnosis.status).toBe("unknown");
    expect(diagnosis.connection).toBeNull();
  });

  it("distinguishes revoked from expired", async () => {
    const { token: revokedToken, connection } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "revoked",
      capabilities: ["businesses.read"],
    });
    await platformMcp.revokePlatformMcpConnection(connection.id);
    const revoked = await platformMcp.diagnosePlatformMcpToken(revokedToken);
    expect(revoked.status).toBe("revoked");
    expect(revoked.connection?.id).toBe(connection.id);

    const { token: expiringToken } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "expiring",
      capabilities: ["businesses.read"],
      expiresInDays: 1,
    });
    await db.query(
      `UPDATE platform_mcp_connections SET expires_at = now() - interval '1 hour' WHERE name = 'expiring'`,
    );
    const expired = await platformMcp.diagnosePlatformMcpToken(expiringToken);
    expect(expired.status).toBe("expired");
  });

  it("reports admin_inactive when the minter is deactivated", async () => {
    const token = await mint({ adminId: supportAdmin.id, capabilities: ["businesses.read"] });
    await db.query(`UPDATE platform_admins SET is_active = false WHERE id = $1`, [supportAdmin.id]);
    const diagnosis = await platformMcp.diagnosePlatformMcpToken(token);
    expect(diagnosis.status).toBe("admin_inactive");
  });

  it("a demoted minter keeps the minted list but the catalogue follows the current role", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["businesses.read", "features.write"] });
    await db.query(`UPDATE platform_admins SET role = 'support' WHERE id = $1`, [owner.id]);
    const diagnosis = await platformMcp.diagnosePlatformMcpToken(token);
    expect(diagnosis.status).toBe("valid");
    expect(diagnosis.connection?.capabilities).toEqual(["businesses.read", "features.write"]);
    expect(diagnosis.connection?.adminRole).toBe("support");
    const names = platformMcp.platformMcpToolCatalogue(diagnosis.connection!).map((t) => t.name);
    expect(names).toContain("list_businesses");
    expect(names).not.toContain("set_business_feature");
  });

  it("never bumps last_used_at: a diagnosis is not usage", async () => {
    const { token, connection } = await platformMcp.createPlatformMcpConnection({
      adminId: owner.id,
      name: "diagnosed",
      capabilities: ["businesses.read"],
    });
    await platformMcp.diagnosePlatformMcpToken(token);
    const row = await db.query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM platform_mcp_connections WHERE id = $1`,
      [connection.id],
    );
    expect(row.rows[0].last_used_at).toBeNull();
  });
});
