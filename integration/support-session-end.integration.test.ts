/**
 * «پایان نشست» — ending a support session from inside the tenant app.
 *
 * The regression: the banner's DELETE /api/support-access was refused by the
 * read-only guard (it is a DELETE, so it looked like a mutation) before the
 * handler ever ran, so a read-only operator could not leave, the grant stayed
 * live and the tenant cookie kept working. These tests drive the real route
 * handler through the real `withTenantScope` → `getSession` → `activeGrant`
 * chain with a real signed cookie; only `next/headers` is replaced, because
 * outside a Next request there is no cookie store to read.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { SessionPayload } from "../src/lib/auth-edge";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let authEdge: typeof import("../src/lib/auth-edge");
let auth: typeof import("../src/lib/auth");
let platformService: typeof import("../src/lib/platform-service");
let employeeService: typeof import("../src/lib/employee-service");
let route: typeof import("../src/app/api/support-access/route");

const bizA = { id: "", ownerId: "" };
const bizB = { id: "", ownerId: "" };
const operator = { id: "" };
const otherOperator = { id: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_support_end_${randomUUID().replaceAll("-", "")}`;
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
  authEdge = await import("../src/lib/auth-edge");
  auth = await import("../src/lib/auth");
  platformService = await import("../src/lib/platform-service");
  employeeService = await import("../src/lib/employee-service");
  route = await import("../src/app/api/support-access/route");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function makeBusiness(target: { id: string; ownerId: string }, name: string) {
  const slug = `sup-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, subdomain) VALUES ($1, $2, $2) RETURNING id",
    [name, slug],
  );
  target.id = rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash, is_active) VALUES ($1, 'owner', 'Owner', 'x', true) RETURNING id`,
    [target.id],
  );
  target.ownerId = owner.rows[0].id;
}

beforeEach(async () => {
  jar.clear();
  await db.query("DELETE FROM platform_audit_log");
  await db.query("DELETE FROM impersonation_grants");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_admins");
  await makeBusiness(bizA, "Business A");
  await makeBusiness(bizB, "Business B");
  const a = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ('op@example.com', 'x', 'Operator', 'engineer') RETURNING id`,
  );
  operator.id = a.rows[0].id;
  const b = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ('op2@example.com', 'x', 'Other', 'engineer') RETURNING id`,
  );
  otherOperator.id = b.rows[0].id;
});

type Mode = "read_only" | "controlled";

/** Start a grant the way the console does and mint the tenant cookie the handoff would. */
async function startSupport(business: { id: string }, adminId = operator.id, mode: Mode = "read_only") {
  const { grant, userId, fullName } = await platformService.startImpersonation({
    adminId,
    businessId: business.id,
    mode,
    reason: "بررسی مشکل گزارش‌شده توسط مشتری",
    allowedCapabilities: mode === "controlled" ? ["printer.test"] : [],
  });
  const payload: SessionPayload = {
    sub: userId,
    role: "owner",
    businessId: business.id,
    locationId: null,
    fullName,
    imp: { grantId: grant.id, adminId, mode, allowedCapabilities: grant.allowedCapabilities },
  };
  return { grant, token: await authEdge.signSession(payload) };
}

/** The business owner's own session — like every tenant session, it names a revocable row (#854 follow-up). */
async function ownerToken(business: { id: string; ownerId: string }) {
  const { session } = await dbLib.withTenant(business.id, () =>
    employeeService.createSession(business.ownerId, business.id, { loginMethod: "password" }),
  );
  return authEdge.signSession({
    sub: business.ownerId,
    role: "owner",
    businessId: business.id,
    locationId: null,
    fullName: "Owner",
    employeeSessionId: session.id,
  });
}

function useCookie(token: string | null) {
  jar.clear();
  if (token) jar.set(authEdge.SESSION_COOKIE, token);
}

function request(method: string, query = "", body?: unknown) {
  return new NextRequest(`http://localhost/api/support-access${query}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function grantRow(id: string) {
  const { rows } = await db.query<{ ended_at: Date | null; revoked_at: Date | null; ended_by_type: string | null; ended_by_id: string | null; expires_at: Date }>(
    "SELECT ended_at, revoked_at, ended_by_type, ended_by_id, expires_at FROM impersonation_grants WHERE id = $1",
    [id],
  );
  return rows[0];
}

async function auditRows(grantId: string) {
  const { rows } = await db.query<{ action: string; platform_admin_id: string | null; business_id: string | null; payload: Record<string, unknown>; user_agent: string | null }>(
    "SELECT action, platform_admin_id, business_id, payload, user_agent FROM platform_audit_log WHERE entity_id = $1 AND action <> 'support_session.started' ORDER BY id",
    [grantId],
  );
  return rows;
}

function clearedCookie(response: Response): boolean {
  const header = response.headers.get("set-cookie") ?? "";
  return header.includes(`${authEdge.SESSION_COOKIE}=;`) && /max-age=0/i.test(header);
}

describe("the operator ends their own support session (the banner's «پایان نشست»)", () => {
  it("a read-only session can end itself: 200, grant ended, cookie cleared, audit written", async () => {
    const { grant, token } = await startSupport(bizA);
    useCookie(token);

    const response = await route.DELETE(request("DELETE", `?grantId=${grant.id}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      sessionId: grant.id,
      status: "ended",
      redirectTo: `/platform/businesses/${bizA.id}/support`,
    });
    expect(clearedCookie(response)).toBe(true);

    const row = await grantRow(grant.id);
    expect(row.ended_at).not.toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(row.ended_by_type).toBe("operator");
    expect(row.ended_by_id).toBe(operator.id);

    const audit = await auditRows(grant.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "support_session.ended", platform_admin_id: operator.id, business_id: bizA.id, user_agent: "vitest" });
    expect(audit[0].payload).toMatchObject({
      sessionId: grant.id,
      operatorId: operator.id,
      businessId: bizA.id,
      source: "manual",
      channel: "tenant_banner",
      endedByType: "operator",
    });
    expect(typeof audit[0].payload.startedAt).toBe("string");
    expect(typeof audit[0].payload.endedAt).toBe("string");
    expect(audit[0].payload.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("a controlled session can end itself too", async () => {
    const { grant, token } = await startSupport(bizA, operator.id, "controlled");
    useCookie(token);
    const response = await route.DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect((await grantRow(grant.id)).ended_by_type).toBe("operator");
  });

  it("the old support cookie is rejected afterwards, on every path that reads it", async () => {
    const { grant, token } = await startSupport(bizA);
    useCookie(token);
    expect(await auth.resolveSessionFromToken(token)).not.toBeNull();
    expect((await route.GET()).status).toBe(200);

    await route.DELETE(request("DELETE", `?grantId=${grant.id}`));

    // A browser that kept (or replayed) the old token gets nothing back.
    useCookie(token);
    expect(await auth.resolveSessionFromToken(token)).toBeNull();
    expect((await route.GET()).status).toBe(401);
    // …and what a page render sees is "a support session that is over", which
    // sends the operator to the console instead of back into the tenant.
    expect((await auth.endedSupportSessionClaims())?.imp.grantId).toBe(grant.id);
  });

  it("ending twice is idempotent: 200 not_active, cookie cleared again, one audit row", async () => {
    const { grant, token } = await startSupport(bizA);
    useCookie(token);
    expect((await route.DELETE(request("DELETE"))).status).toBe(200);

    useCookie(token);
    const again = await route.DELETE(request("DELETE"));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, status: "not_active", redirectTo: `/platform/businesses/${bizA.id}/support` });
    expect(clearedCookie(again)).toBe(true);
    expect(await auditRows(grant.id)).toHaveLength(1);
  });

  it("concurrent ends settle on exactly one close and one audit row", async () => {
    const { grant } = await startSupport(bizA);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        platformService.closeSupportSession(grant.id, { type: "operator", adminId: operator.id, businessId: bizA.id }, { channel: "test" }),
      ),
    );
    expect(results.filter((r) => r.status === "ended")).toHaveLength(1);
    expect(results.filter((r) => r.status === "not_active")).toHaveLength(4);
    expect(await auditRows(grant.id)).toHaveLength(1);
  });

  it("an expired session is stamped expired (not 'ended'), audited as such, and cannot come back", async () => {
    const { grant, token } = await startSupport(bizA);
    await db.query("UPDATE impersonation_grants SET expires_at = now() - interval '2 minutes' WHERE id = $1", [grant.id]);
    useCookie(token);
    expect(await auth.resolveSessionFromToken(token)).toBeNull();

    const response = await route.DELETE(request("DELETE", `?grantId=${grant.id}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "expired" });
    expect(clearedCookie(response)).toBe(true);

    const row = await grantRow(grant.id);
    expect(row.ended_by_type).toBe("system");
    expect(row.ended_by_id).toBeNull();
    expect(row.ended_at?.getTime()).toBe(row.expires_at.getTime());
    const audit = await auditRows(grant.id);
    expect(audit.map((a) => a.action)).toEqual(["support_session.expired"]);
    expect(audit[0].payload).toMatchObject({ source: "expired", endedByType: "system" });

    // Pushing the expiry forward again does not revive a closed grant.
    await db.query("UPDATE impersonation_grants SET expires_at = now() + interval '10 minutes' WHERE id = $1", [grant.id]);
    expect(await auth.resolveSessionFromToken(token)).toBeNull();
  });

  it("a stale tab naming an older session cannot end the newer one", async () => {
    const first = await startSupport(bizA);
    await platformService.closeSupportSession(first.grant.id, { type: "operator", adminId: operator.id }, { channel: "test" });
    const second = await startSupport(bizA);
    useCookie(second.token);

    const response = await route.DELETE(request("DELETE", `?grantId=${first.grant.id}`));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "support_session_mismatch" });
    expect(clearedCookie(response)).toBe(false);
    expect(await platformService.activeGrant(second.grant.id, operator.id, bizA.id)).not.toBeNull();
  });

  it("the grant id in the query cannot redirect the close to another operator's session (IDOR)", async () => {
    const mine = await startSupport(bizA);
    const theirs = await startSupport(bizA, otherOperator.id);
    useCookie(mine.token);

    expect((await route.DELETE(request("DELETE", `?grantId=${theirs.grant.id}`))).status).toBe(409);
    expect(await platformService.activeGrant(theirs.grant.id, otherOperator.id, bizA.id)).not.toBeNull();
    expect(await platformService.activeGrant(mine.grant.id, operator.id, bizA.id)).not.toBeNull();
  });

  it("another operator cannot end a session that is not theirs", async () => {
    const { grant } = await startSupport(bizA);
    expect(
      await platformService.closeSupportSession(grant.id, { type: "operator", adminId: otherOperator.id }, { channel: "test" }),
    ).toEqual({ status: "not_active" });
    expect(await platformService.activeGrant(grant.id, operator.id, bizA.id)).not.toBeNull();
    expect(await auditRows(grant.id)).toHaveLength(0);
  });

  it("ending the session on Business A leaves Business B, other operators and normal users untouched", async () => {
    const a = await startSupport(bizA);
    const b = await startSupport(bizB);
    const otherOnA = await startSupport(bizA, otherOperator.id);
    const ownerA = await ownerToken(bizA);
    const ownerB = await ownerToken(bizB);

    useCookie(a.token);
    expect((await route.DELETE(request("DELETE"))).status).toBe(200);

    expect(await auth.resolveSessionFromToken(a.token)).toBeNull();
    expect(await auth.resolveSessionFromToken(b.token)).not.toBeNull();
    expect(await auth.resolveSessionFromToken(otherOnA.token)).not.toBeNull();
    expect((await auth.resolveSessionFromToken(ownerA))?.sub).toBe(bizA.ownerId);
    expect((await auth.resolveSessionFromToken(ownerB))?.sub).toBe(bizB.ownerId);
  });

  it("the operator's platform identity is untouched and a new session can start straight away", async () => {
    const before = await db.query("SELECT token_version, is_active FROM platform_admins WHERE id = $1", [operator.id]);
    const { token } = await startSupport(bizA);
    useCookie(token);
    await route.DELETE(request("DELETE"));
    const after = await db.query("SELECT token_version, is_active FROM platform_admins WHERE id = $1", [operator.id]);
    expect(after.rows[0]).toEqual(before.rows[0]);

    const next = await startSupport(bizA);
    expect(await auth.resolveSessionFromToken(next.token)).not.toBeNull();
  });
});

describe("read-only enforcement is unchanged around the exit", () => {
  it("a live read-only session may read but may not change the support policy", async () => {
    const { token } = await startSupport(bizA);
    useCookie(token);
    expect((await route.GET()).status).toBe(200);
    const patch = await route.PATCH(request("PATCH", "", { policy: "disabled" }));
    expect(patch.status).toBe(403);
    expect(await patch.json()).toEqual({ error: "impersonation_read_only" });
    const policy = await db.query("SELECT support_access_policy FROM businesses WHERE id = $1", [bizA.id]);
    expect(policy.rows[0].support_access_policy).toBe("standard");
  });
});

describe("the business revokes a support session from its own settings", () => {
  it("an owner revokes a live grant on their business: revoked + tenant_revoked audit", async () => {
    const { grant, token } = await startSupport(bizA);
    useCookie(await ownerToken(bizA));
    const response = await route.DELETE(request("DELETE", `?grantId=${grant.id}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sessionId: grant.id, status: "revoked" });
    expect(clearedCookie(response)).toBe(false);

    const row = await grantRow(grant.id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.ended_by_type).toBe("tenant_admin");
    expect(row.ended_by_id).toBe(bizA.ownerId);
    expect((await auditRows(grant.id)).map((a) => a.action)).toEqual(["support_session.tenant_revoked"]);
    expect(await auth.resolveSessionFromToken(token)).toBeNull();
  });

  it("an owner of Business B cannot revoke Business A's grant by id", async () => {
    const { grant } = await startSupport(bizA);
    useCookie(await ownerToken(bizB));
    const response = await route.DELETE(request("DELETE", `?grantId=${grant.id}`));
    expect(response.status).toBe(409);
    expect(await platformService.activeGrant(grant.id, operator.id, bizA.id)).not.toBeNull();
  });

  it("a malformed grant id is a clean 409, not a database error", async () => {
    useCookie(await ownerToken(bizA));
    expect((await route.DELETE(request("DELETE", "?grantId=not-a-uuid"))).status).toBe(409);
  });

  it("a signed-out caller gets 401", async () => {
    useCookie(null);
    expect((await route.DELETE(request("DELETE", `?grantId=${randomUUID()}`))).status).toBe(401);
  });
});

describe("the console's kill switch shares the same lifecycle", () => {
  it("revoke closes the grant, audits it under the revoking admin, and refuses a second close", async () => {
    const { grant, token } = await startSupport(bizA);
    expect(
      await platformService.closeSupportSession(grant.id, { type: "platform_admin", adminId: otherOperator.id }, { channel: "platform_console" }),
    ).toMatchObject({ status: "revoked" });
    const audit = await auditRows(grant.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "support_session.revoked", platform_admin_id: otherOperator.id, business_id: bizA.id });
    expect(await auth.resolveSessionFromToken(token)).toBeNull();

    // The operator's own banner still gets them out cleanly afterwards.
    useCookie(token);
    const response = await route.DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_active" });
    expect(clearedCookie(response)).toBe(true);
  });
});
