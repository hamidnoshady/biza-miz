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
const biz = { id: "", slug: "" };
const otherBiz = { id: "", slug: "" };

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
  biz.slug = one.businessSlug;
  const two = await provisionBusiness({
    businessName: "Cafe Two",
    ownerName: "Owner Two",
    email: "owner2@example.com",
    password: "password-two",
    industry: "food_service",
    subdomain: "cafe-two-mcptest",
  });
  otherBiz.id = two.businessId;
  otherBiz.slug = two.businessSlug;

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

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await platformRpc(token, {
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = await response.json();
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

async function businessStatus(id: string): Promise<{
  status: string;
  archivedAt: string | null;
  suspendedAt: string | null;
}> {
  const result = await db.query<{
    status: string;
    archived_at: string | null;
    suspended_at: string | null;
  }>(
    `SELECT status::text AS status, archived_at, suspended_at FROM businesses WHERE id = $1`,
    [id],
  );
  return {
    status: result.rows[0].status,
    archivedAt: result.rows[0].archived_at,
    suspendedAt: result.rows[0].suspended_at,
  };
}

async function lifecycleAuditRows(id: string) {
  const result = await db.query<{
    admin_id: string;
    action: string;
    from_state: string;
    to_state: string;
    before_status: string;
    after_status: string;
    correlation_id: string;
    idempotency_key: string;
    connection_id: string;
    outcome: string;
    audit_action: string;
  }>(
    `SELECT platform_admin_id::text AS admin_id,
            action,
            payload->>'action' AS audit_action,
            payload->>'from' AS from_state,
            payload->>'to' AS to_state,
            payload->'before'->>'status' AS before_status,
            payload->'after'->>'status' AS after_status,
            payload->>'correlationId' AS correlation_id,
            payload->>'idempotencyKey' AS idempotency_key,
            payload->'actor'->>'connectionId' AS connection_id,
            payload->>'outcome' AS outcome
       FROM platform_audit_log
      WHERE business_id = $1
        AND action IN ('business.archived', 'business.active')
      ORDER BY id`,
    [id],
  );
  return result.rows;
}

async function connectionIdForToken(token: string): Promise<string> {
  const hash = createHash("sha256").update(token).digest("hex");
  const result = await db.query<{ id: string }>(
    `SELECT id FROM platform_mcp_connections WHERE token_hash = $1`,
    [hash],
  );
  return result.rows[0].id;
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

describe("platform MCP business archive and restore (issue #1431)", () => {
  it("previews, archives an active business, records before/after, and replays a retry", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["business.archive"] });
    const connectionId = await connectionIdForToken(token);

    const preview = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "archive-active-1",
    });
    expect(preview).toMatchObject({
      ok: false,
      preview: true,
      stepUpRequired: true,
      action: "archive",
      from: "active",
      to: "archived",
      stale: false,
      transitionValid: true,
      confirmationPhrase: `ARCHIVE ${biz.slug}`,
      requiredCapability: "business.archive",
      correlationId: `mcp:${connectionId}:archive-active-1`,
    });
    expect(await businessStatus(biz.id)).toMatchObject({ status: "active", archivedAt: null });
    expect(await lifecycleAuditRows(biz.id)).toHaveLength(0);

    const applied = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "archive-active-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
      correlationId: "corr-archive-active-1",
      reason: "customer closed",
    });
    expect(applied).toMatchObject({
      ok: true,
      replayed: false,
      action: "archive",
      from: "active",
      to: "archived",
      status: "archived",
      capability: "business.archive",
      auditAction: "business.archived",
      correlationId: "corr-archive-active-1",
    });
    expect(await businessStatus(biz.id)).toMatchObject({ status: "archived" });
    expect((await businessStatus(biz.id)).archivedAt).toBeTruthy();

    const audits = await lifecycleAuditRows(biz.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      admin_id: owner.id,
      action: "business.archived",
      audit_action: "archive",
      from_state: "active",
      to_state: "archived",
      before_status: "active",
      after_status: "archived",
      correlation_id: "corr-archive-active-1",
      idempotency_key: "archive-active-1",
      connection_id: connectionId,
      outcome: "succeeded",
    });

    const replayed = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "archive-active-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
      correlationId: "corr-archive-active-1-retry",
    });
    expect(replayed).toMatchObject({
      ok: true,
      replayed: true,
      from: "active",
      to: "archived",
      status: "archived",
      correlationId: "corr-archive-active-1",
      currentStatus: "archived",
    });
    expect(await lifecycleAuditRows(biz.id)).toHaveLength(1);
  });

  it("archives a suspended business and restores it only through business.archive", async () => {
    const token = await mint({
      adminId: owner.id,
      capabilities: ["business.archive", "business.suspend"],
    });

    const suspended = await callTool(token, "set_business_status", {
      businessId: biz.id,
      status: "suspended",
    });
    expect(
      (suspended.perBusiness as Record<string, unknown>)[biz.id],
    ).toMatchObject({ ok: true, status: "suspended" });

    const archived = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "suspended",
      idempotencyKey: "archive-suspended-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    expect(archived).toMatchObject({
      ok: true,
      action: "archive",
      from: "suspended",
      to: "archived",
      status: "archived",
    });

    const restored = await callTool(token, "restore_archived_business", {
      businessId: biz.id,
      expectedStatus: "archived",
      idempotencyKey: "restore-1",
      confirmation: `RESTORE ${biz.slug}`,
      confirm: true,
    });
    expect(restored).toMatchObject({
      ok: true,
      action: "restore",
      from: "archived",
      to: "active",
      status: "active",
      auditAction: "business.active",
    });
    const state = await businessStatus(biz.id);
    expect(state.status).toBe("active");
    expect(state.archivedAt).toBeNull();
    expect(state.suspendedAt).toBeNull();

    const audits = await lifecycleAuditRows(biz.id);
    expect(audits.map((row) => row.action)).toEqual(["business.archived", "business.active"]);
    expect(audits[1]).toMatchObject({
      audit_action: "restore",
      from_state: "archived",
      to_state: "active",
      before_status: "archived",
      after_status: "active",
      correlation_id: `mcp:${await connectionIdForToken(token)}:restore-1`,
    });
  });

  it("fails closed on stale state, wrong phrases, invalid transitions and key reuse", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["business.archive"] });

    const stale = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "suspended",
      idempotencyKey: "stale-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    expect(stale).toMatchObject({ ok: false, error: "stale_state", from: "active" });

    const wrongPhrase = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "wrong-phrase-1",
      confirmation: `RESTORE ${biz.slug}`,
      confirm: true,
    });
    expect(wrongPhrase).toMatchObject({ ok: false, error: "confirmation_mismatch" });

    const invalidRestore = await callTool(token, "restore_archived_business", {
      businessId: biz.id,
      expectedStatus: "archived",
      idempotencyKey: "restore-invalid-1",
      confirmation: `RESTORE ${biz.slug}`,
      confirm: true,
    });
    expect(invalidRestore).toMatchObject({ ok: false, error: "same_status" });

    const batch = await callTool(token, "archive_business", {
      businessId: biz.id,
      businessIds: [biz.id],
      expectedStatus: "active",
      idempotencyKey: "batch-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    expect(batch).toMatchObject({ ok: false, error: "batch_not_supported" });

    // A key that already belongs to one business can never authorize another.
    await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "shared-key-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    const crossBusiness = await callTool(token, "archive_business", {
      businessId: otherBiz.id,
      expectedStatus: "active",
      idempotencyKey: "shared-key-1",
      confirmation: `ARCHIVE ${otherBiz.slug}`,
      confirm: true,
    });
    expect(crossBusiness).toMatchObject({
      ok: false,
      error: "idempotency_conflict",
      reason: "key_reused_across_businesses",
    });
    expect((await businessStatus(otherBiz.id)).status).toBe("active");

    expect((await businessStatus(biz.id)).status).toBe("archived");
  });

  it("serialises concurrent archive attempts: exactly one mutation and one lifecycle row", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["business.archive"] });
    const attempt = (key: string) =>
      callTool(token, "archive_business", {
        businessId: biz.id,
        expectedStatus: "active",
        idempotencyKey: key,
        confirmation: `ARCHIVE ${biz.slug}`,
        confirm: true,
      });

    const [one, two] = await Promise.all([
      attempt("concurrent-1"),
      attempt("concurrent-2"),
    ]);
    const succeeded = [one, two].filter((result) => result.ok === true);
    const failed = [one, two].filter((result) => result.ok === false);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(["same_status", "transition_conflict"]).toContain(failed[0].error);
    expect((await businessStatus(biz.id)).status).toBe("archived");
    expect(await lifecycleAuditRows(biz.id)).toHaveLength(1);
  });

  it("keeps suspend/reactivate behavior and refuses the archived -> active bypass", async () => {
    const token = await mint({ adminId: owner.id, capabilities: ["business.suspend"] });

    const suspended = await callTool(token, "set_business_status", {
      businessId: biz.id,
      status: "suspended",
    });
    expect((suspended.perBusiness as Record<string, unknown>)[biz.id]).toMatchObject({
      ok: true,
      status: "suspended",
    });
    const reactivated = await callTool(token, "set_business_status", {
      businessId: biz.id,
      status: "active",
    });
    expect((reactivated.perBusiness as Record<string, unknown>)[biz.id]).toMatchObject({
      ok: true,
      status: "active",
    });

    const ownerToken = await mint({ adminId: owner.id, capabilities: ["business.archive"] });
    await callTool(ownerToken, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "archive-for-bypass-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });

    const bypass = await callTool(token, "set_business_status", {
      businessId: biz.id,
      status: "active",
    });
    expect((bypass.perBusiness as Record<string, unknown>)[biz.id]).toMatchObject({
      ok: false,
      error: "use_restore_archived_business",
      requiredCapability: "business.archive",
    });
    expect((await businessStatus(biz.id)).status).toBe("archived");
  });

  it("denies archive/restore to a role that does not hold business.archive, and audits the denial", async () => {
    const token = await mint({ adminId: supportAdmin.id, capabilities: ["business.archive"] });

    const list = await platformRpc(token, { method: "tools/list" });
    const body = await list.json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("archive_business");
    expect(names).not.toContain("restore_archived_business");

    const denied = await callTool(token, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "denied-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    expect(JSON.stringify(denied)).toContain("denied");
    expect(await lifecycleAuditRows(biz.id)).toHaveLength(0);

    const audit = await db.query<{ outcome: string }>(
      `SELECT payload->>'outcome' AS outcome
         FROM platform_audit_log
        WHERE action = 'platform_mcp.call' AND payload->>'tool' = 'archive_business'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].outcome).toBe("denied_capability");
  });

  it("refuses a business outside the credential's bridge list and a protected internal tenant", async () => {
    const scoped = await mint({
      adminId: owner.id,
      capabilities: ["business.archive"],
      businessIds: [otherBiz.id],
    });
    const outside = await callTool(scoped, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "outside-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    expect(JSON.stringify(outside)).toContain("outside this credential's bridge list");
    expect((await businessStatus(biz.id)).status).toBe("active");

    await db.query(`UPDATE businesses SET ownership_kind = 'platform_internal' WHERE id = $1`, [
      biz.id,
    ]);
    const ownerToken = await mint({ adminId: owner.id, capabilities: ["business.archive"] });
    const protectedResult = await callTool(ownerToken, "archive_business", {
      businessId: biz.id,
      expectedStatus: "active",
      idempotencyKey: "protected-1",
      confirmation: `ARCHIVE ${biz.slug}`,
      confirm: true,
    });
    expect(protectedResult).toMatchObject({
      ok: false,
      error: "protected_internal_business",
    });
    expect((await businessStatus(biz.id)).status).toBe("active");
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
