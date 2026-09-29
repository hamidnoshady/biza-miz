/**
 * Phase 17 security review: `imp.grantId`'s own doc comment (auth-edge.ts)
 * always claimed it was "re-checked live on the server, never trusted
 * alone," but nothing ever called `activeGrant` outside its own definition —
 * ending or revoking a grant stamped the row without affecting the
 * already-minted session at all. `getSession()` (auth.ts) now calls
 * `activeGrant` for every session carrying an `imp` claim; this proves the
 * primitive it depends on — start/end/revoke/expiry — is correct.
 */
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
let platformService: typeof import("../src/lib/platform-service");

const biz = { id: "" };
const admin = { id: "" };
const otherAdmin = { id: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_impersonation_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  platformService = await import("../src/lib/platform-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM impersonation_grants");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_admins");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Impersonation Co', $1) RETURNING id",
    [`imp-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  await db.query(
    `INSERT INTO users (business_id, role, full_name, pin_hash, is_active) VALUES ($1, 'owner', 'Owner', 'x', true)`,
    [biz.id],
  );

  const adminRow = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ('admin@example.com', 'x', 'Admin') RETURNING id`,
  );
  admin.id = adminRow.rows[0].id;

  const otherAdminRow = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ('other-admin@example.com', 'x', 'Other Admin') RETURNING id`,
  );
  otherAdmin.id = otherAdminRow.rows[0].id;
});

describe("startImpersonation / activeGrant", () => {
  it("rejects blank and uninformative reasons", async () => {
    await expect(platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "   ",
    })).rejects.toThrow("reason_too_short");
  });

  it("a fresh grant is live", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    const live = await platformService.activeGrant(grant.id, admin.id, biz.id);
    expect(live?.id).toBe(grant.id);
  });

  it("does not match a different admin or a different business", async () => {
    const { grant } = await platformService.startImpersonation({ adminId: admin.id, businessId: biz.id, mode: "read_only", reason: "بررسی مشکل فنی مشتری" });
    expect(await platformService.activeGrant(grant.id, otherAdmin.id, biz.id)).toBeNull();
    expect(await platformService.activeGrant(grant.id, admin.id, randomUUID())).toBeNull();
  });

  it("serializes concurrent starts and leaves exactly one live session", async () => {
    const attempts = await Promise.allSettled([
      platformService.startImpersonation({ adminId: admin.id, businessId: biz.id, mode: "read_only", reason: "بررسی همزمان مشکل چاپگر" }),
      platformService.startImpersonation({ adminId: admin.id, businessId: biz.id, mode: "controlled", reason: "بررسی همزمان مشکل اتصال" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const count = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM impersonation_grants
        WHERE platform_admin_id = $1 AND business_id = $2
          AND ended_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [admin.id, biz.id],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });
});

const channel = { channel: "test" };

describe("closeSupportSession (operator) — the admin leaving on their own", () => {
  it("makes activeGrant stop returning the grant immediately", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
      reason: "بررسی مشکل فنی مشتری",
    });
    expect(await platformService.activeGrant(grant.id, admin.id, biz.id)).not.toBeNull();

    expect(await platformService.closeSupportSession(grant.id, { type: "operator", adminId: admin.id }, channel)).toMatchObject({ status: "ended" });
    expect(await platformService.activeGrant(grant.id, admin.id, biz.id)).toBeNull();
  });

  it("another admin cannot end someone else's grant this way", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
      reason: "بررسی مشکل فنی مشتری",
    });
    expect(await platformService.closeSupportSession(grant.id, { type: "operator", adminId: otherAdmin.id }, channel)).toEqual({ status: "not_active" });
    // Still live: an operator close is scoped to the operator's own grants.
    expect(await platformService.activeGrant(grant.id, admin.id, biz.id)).not.toBeNull();
  });
});

describe("closeSupportSession (platform_admin) — the kill switch", () => {
  it("makes activeGrant stop returning the grant immediately, same as ending it", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
      reason: "بررسی مشکل فنی مشتری",
    });
    expect(await platformService.activeGrant(grant.id, admin.id, biz.id)).not.toBeNull();

    expect(await platformService.closeSupportSession(grant.id, { type: "platform_admin", adminId: otherAdmin.id }, channel)).toMatchObject({ status: "revoked" });
    expect(await platformService.activeGrant(grant.id, admin.id, biz.id)).toBeNull();
  });

  it("a revoked grant cannot also be ended, and vice versa", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
      reason: "بررسی مشکل فنی مشتری",
    });
    await platformService.closeSupportSession(grant.id, { type: "platform_admin", adminId: otherAdmin.id }, channel);

    const { rows } = await db.query<{ ended_at: string | null; revoked_at: string | null }>(
      "SELECT ended_at, revoked_at FROM impersonation_grants WHERE id = $1",
      [grant.id],
    );
    expect(rows[0].revoked_at).not.toBeNull();

    // A closed grant is never closed (or reopened) a second time.
    expect(await platformService.closeSupportSession(grant.id, { type: "operator", adminId: admin.id }, channel)).toEqual({ status: "not_active" });
    const after = await db.query<{ ended_at: string | null }>(
      "SELECT ended_at FROM impersonation_grants WHERE id = $1",
      [grant.id],
    );
    expect(after.rows[0].ended_at).toBeNull();
  });
});

describe("expiry", () => {
  it("an expired grant is not live even though never explicitly ended or revoked", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    await db.query("UPDATE impersonation_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      grant.id,
    ]);
    expect(await platformService.activeGrant(grant.id, admin.id, biz.id)).toBeNull();
  });
});

describe("redeemImpersonationHandoff — the business-origin half", () => {
  it("redeems a fresh handoff into the owner membership its grant names", async () => {
    const { grant, handoff, userId, fullName } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
      reason: "بررسی مشکل فنی مشتری",
    });

    const result = await platformService.redeemImpersonationHandoff(handoff.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grantId).toBe(grant.id);
    expect(result.adminId).toBe(admin.id);
    expect(result.mode).toBe("full");
    expect(result.userId).toBe(userId);
    expect(result.fullName).toBe(fullName);
    expect(result.businessId).toBe(biz.id);
    expect(result.businessSlug).toBeTruthy();
    expect(result.businessSubdomain).toBeTruthy();
  });

  it("is single-use: a second redemption of the same token fails", async () => {
    const { handoff } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    expect(await platformService.redeemImpersonationHandoff(handoff.token)).toMatchObject({ ok: true });
    expect(await platformService.redeemImpersonationHandoff(handoff.token)).toEqual({
      ok: false,
      error: "used",
    });
  });

  it("rejects a token that was never minted", async () => {
    expect(await platformService.redeemImpersonationHandoff("impho_never-minted")).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("refuses a handoff whose grant has been revoked", async () => {
    const { grant, handoff } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
      reason: "بررسی مشکل فنی مشتری",
    });
    await platformService.closeSupportSession(grant.id, { type: "platform_admin", adminId: otherAdmin.id }, channel);
    expect(await platformService.redeemImpersonationHandoff(handoff.token)).toEqual({
      ok: false,
      error: "grant_inactive",
    });
  });

  it("refuses a handoff whose grant has expired", async () => {
    const { grant, handoff } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    await db.query("UPDATE impersonation_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      grant.id,
    ]);
    expect(await platformService.redeemImpersonationHandoff(handoff.token)).toEqual({
      ok: false,
      error: "grant_inactive",
    });
  });

  it("refuses a handoff that expired on its own clock, grant still live", async () => {
    const { grant, handoff } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    await db.query(
      "UPDATE impersonation_handoffs SET expires_at = now() - interval '1 minute' WHERE grant_id = $1",
      [grant.id],
    );
    expect(await platformService.redeemImpersonationHandoff(handoff.token)).toEqual({
      ok: false,
      error: "expired",
    });
  });
});

/**
 * Session ownership + the real resume (issue #755 §4).
 *
 * The console used to pick "the first active grant", label it its own, and its
 * «ادامه نشست فعلی» opened the *create* dialog. Ownership is now decided by the
 * server (`isMine`) and resume hands off into the same grant — never a new one,
 * and never someone else's.
 */
describe("support-session ownership and resume", () => {
  it("marks a grant as mine only for the admin who holds it", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    const mine = await platformService.listGrants(biz.id, admin.id);
    expect(mine.find((g) => g.id === grant.id)?.isMine).toBe(true);

    const theirs = await platformService.listGrants(biz.id, otherAdmin.id);
    expect(theirs.find((g) => g.id === grant.id)?.isMine).toBe(false);
  });

  it("resumes my own live session into the same grant, with a redeemable handoff", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });

    const resumed = await platformService.resumeImpersonation({
      grantId: grant.id,
      adminId: admin.id,
      businessId: biz.id,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.grant.id).toBe(grant.id);

    const redeemed = await platformService.redeemImpersonationHandoff(resumed.handoff.token);
    expect(redeemed).toMatchObject({ ok: true, grantId: grant.id, adminId: admin.id });
  });

  it("cannot resume another operator's session", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    expect(
      await platformService.resumeImpersonation({
        grantId: grant.id,
        adminId: otherAdmin.id,
        businessId: biz.id,
      }),
    ).toEqual({ ok: false, error: "not_active" });
  });

  it("cannot resume a session that ended, or one that expired", async () => {
    const ended = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    await platformService.closeSupportSession(ended.grant.id, { type: "operator", adminId: admin.id }, channel);
    expect(
      await platformService.resumeImpersonation({
        grantId: ended.grant.id,
        adminId: admin.id,
        businessId: biz.id,
      }),
    ).toEqual({ ok: false, error: "not_active" });

    const expired = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    await db.query("UPDATE impersonation_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expired.grant.id,
    ]);
    expect(
      await platformService.resumeImpersonation({
        grantId: expired.grant.id,
        adminId: admin.id,
        businessId: biz.id,
      }),
    ).toEqual({ ok: false, error: "not_active" });
  });

  it("records the re-entry in the audit trail", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
      reason: "بررسی مشکل فنی مشتری",
    });
    await platformService.resumeImpersonation({
      grantId: grant.id,
      adminId: admin.id,
      businessId: biz.id,
    });
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_audit_log
        WHERE action = 'support_session.resumed' AND entity_id = $1`,
      [grant.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

});
