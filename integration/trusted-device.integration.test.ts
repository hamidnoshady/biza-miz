/**
 * Issue #885 — the seven-day trusted-device service, against a real database.
 *
 * The policy this proves is the confirmed one: trust is scoped to account +
 * tenant + device, it lasts exactly seven days, it is revocable, ordinary
 * logins do not extend it, and the security events the policy names take it
 * back. Each of those is a separate way this feature could quietly become a
 * hole, and none of them is visible from a unit test, because the interesting
 * behaviour is in the row and its expiry column rather than in a pure
 * function.
 *
 * What is deliberately *not* asserted here: that a trusted device can sign in.
 * It cannot, and that is the point — trust waives a routine OTP/MFA challenge
 * and never substitutes for a primary credential, so there is no "sign in with
 * trust" path to test.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let trustedDevice: typeof import("../src/lib/trusted-device");

const biz = { id: "", locationId: "" };
const otherBiz = { id: "" };
const member = { a: "", b: "" };

/** One day, for clock arithmetic against the seven-day window. */
const DAY_MS = 86_400_000;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_trusted_dev_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({
    connectionString: (() => {
      const url = new URL(rootDatabaseUrl!);
      url.pathname = "/postgres";
      return url.toString();
    })(),
  });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const businesses = await db.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('کافه آزمون'), ('کافه دوم') RETURNING id`,
  );
  biz.id = businesses.rows[0].id;
  otherBiz.id = businesses.rows[1].id;

  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ مرکزی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;

  const members = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name)
     VALUES ($1, $2, 'cashier', 'الف'), ($1, $2, 'cashier', 'ب') RETURNING id`,
    [biz.id, biz.locationId],
  );
  member.a = members.rows[0].id;
  member.b = members.rows[1].id;

  // The service under test resolves its pool from the environment, so it has
  // to be pointed at this database before the first call — otherwise it runs
  // against the maintenance database and reports that `trusted_devices` does
  // not exist, which is a test-harness fault rather than a finding.
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  trustedDevice = await import("../src/lib/trusted-device");
}, 120_000);

afterAll(async () => {
  await db?.end().catch(() => {});
  await dbLib?.closeDatabasePool().catch(() => {});
  if (rootDatabaseUrl) process.env.DATABASE_URL = rootDatabaseUrl;
  if (!rootDatabaseUrl) return;
  const maintenance = new Client({
    connectionString: (() => {
      const url = new URL(rootDatabaseUrl!);
      url.pathname = "/postgres";
      return url.toString();
    })(),
  });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
});

describe("issueTrustedDevice / verifyTrustedDevice", () => {
  it("trusts the exact account and tenant it was issued for, and nobody else", async () => {
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        factorSummary: "phone_otp",
      }),
    );

    // Exactly seven days out, not a day more.
    expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * DAY_MS);
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * DAY_MS);

    const scope = { businessId: biz.id, userId: member.a };
    expect(await trustedDevice.verifyTrustedDevice({ ...scope, token: issued.token })).toEqual({
      trusted: true,
      expiresAt: issued.expiresAt,
    });

    // The three ways the scoping rule can fail, each of which the old
    // membership-wide `otp_login_at` window got wrong by construction.
    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.b,
        token: issued.token,
      }),
    ).toEqual({ trusted: false, reason: "wrong_subject" });
    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: otherBiz.id,
        userId: member.a,
        token: issued.token,
      }),
    ).toEqual({ trusted: false, reason: "wrong_subject" });

    // A device this account never trusted.
    expect(
      await trustedDevice.verifyTrustedDevice({
        ...scope,
        token: `tdev_${randomUUID().replaceAll("-", "")}`,
      }),
    ).toEqual({ trusted: false, reason: "missing" });
    // Absent, blank and wrong-shaped credentials are all simply absent.
    for (const token of [null, undefined, "", "   ", "not-a-trust-token"]) {
      expect(await trustedDevice.verifyTrustedDevice({ ...scope, token })).toEqual({
        trusted: false,
        reason: "missing",
      });
    }
  });

  it("expires at the seven-day boundary and not a moment before", async () => {
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );
    const scope = { businessId: biz.id, userId: member.a };

    // The last millisecond of the seventh day still counts.
    const justInside = new Date(issued.expiresAt.getTime() - 1);
    expect(
      await trustedDevice.verifyTrustedDevice({ ...scope, token: issued.token, now: justInside }),
    ).toEqual({ trusted: true, expiresAt: issued.expiresAt });

    // The instant it lapses, it does not.
    expect(
      await trustedDevice.verifyTrustedDevice({
        ...scope,
        token: issued.token,
        now: issued.expiresAt,
      }),
    ).toEqual({ trusted: false, reason: "expired" });
    expect(
      await trustedDevice.verifyTrustedDevice({
        ...scope,
        token: issued.token,
        now: new Date(issued.expiresAt.getTime() + 1),
      }),
    ).toEqual({ trusted: false, reason: "expired" });
  });

  it("refuses a revoked device, and revocation is idempotent", async () => {
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );
    const scope = { businessId: biz.id, userId: member.a };

    const devices = await dbLib.withTenant(biz.id, () =>
      trustedDevice.listTrustedDevices(biz.id, member.a),
    );
    const row = devices.find((d) => !d.revokedAt && d.expiresAt.getTime() === issued.expiresAt.getTime())!;
    expect(row).toBeDefined();

    expect(
      await dbLib.withTenant(biz.id, () =>
        trustedDevice.revokeTrustedDevice({
          businessId: biz.id,
          userId: member.a,
          id: row.id,
        }),
      ),
    ).toBe(true);

    expect(await trustedDevice.verifyTrustedDevice({ ...scope, token: issued.token })).toEqual({
      trusted: false,
      reason: "revoked",
    });

    // A second revocation of the same row is a no-op, not an error — the
    // button may be pressed twice and a lost device may be revoked after the
    // row was already cleared.
    expect(
      await dbLib.withTenant(biz.id, () =>
        trustedDevice.revokeTrustedDevice({
          businessId: biz.id,
          userId: member.a,
          id: row.id,
        }),
      ),
    ).toBe(false);
  });

  it("cannot be used by another member even with the row id (tenant isolation)", async () => {
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );
    const devices = await dbLib.withTenant(biz.id, () =>
      trustedDevice.listTrustedDevices(biz.id, member.a),
    );
    const row = devices.find((d) => !d.revokedAt && d.expiresAt.getTime() === issued.expiresAt.getTime())!;

    // Member B must not see, or be able to revoke, member A's device: the
    // revocation is keyed on the session's own membership.
    expect(
      await dbLib.withTenant(biz.id, () => trustedDevice.listTrustedDevices(biz.id, member.b)),
    ).toHaveLength(0);
    expect(
      await dbLib.withTenant(biz.id, () =>
        trustedDevice.revokeTrustedDevice({
          businessId: biz.id,
          userId: member.b,
          id: row.id,
        }),
      ),
    ).toBe(false);
  });
});

describe("security events invalidate trust", () => {
  it("offboarding a membership revokes the trust it earned", async () => {
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.b }),
    );
    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.b,
        token: issued.token,
      }),
    ).toEqual({ trusted: true, expiresAt: issued.expiresAt });

    // The same statement team-service runs, including the `platform_user_id =
    // NULL` that makes a later platform-keyed revocation find nothing — which
    // is why the revocation has to happen in the same transaction.
    await db.query(
      `UPDATE users
          SET is_active = false, membership_status = 'offboarded',
              location_scope = 'none', pin_hash = NULL, password_hash = NULL,
              platform_user_id = NULL, membership_revision = membership_revision + 1
        WHERE id = $1 AND business_id = $2`,
      [member.b, biz.id],
    );
    await db.query(
      `UPDATE trusted_devices
          SET revoked_at = now(), revoked_reason = 'member_offboarded'
        WHERE business_id = $2 AND user_id = $1 AND revoked_at IS NULL`,
      [member.b, biz.id],
    );

    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.b,
        token: issued.token,
      }),
    ).toEqual({ trusted: false, reason: "revoked" });
  });

  it("tightening the MFA policy revokes trust earned under the weaker one", async () => {
    const mfaPolicy = await import("../src/lib/mfa-policy");

    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.b }),
    );
    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.b,
        token: issued.token,
      }),
    ).toEqual({ trusted: true, expiresAt: issued.expiresAt });

    // The owner switches the second-factor requirement on for managers. Every
    // exemption already granted was earned against the weaker rule, so it must
    // not survive the change.
    await dbLib.withTenant(biz.id, () =>
      mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: true, requireForAccountants: false }),
    );

    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.b,
        token: issued.token,
      }),
    ).toEqual({ trusted: false, reason: "revoked" });

    const { rows } = await db.query<{ revoked_reason: string }>(
      `SELECT revoked_reason FROM trusted_devices WHERE business_id = $1 AND user_id = $2
        ORDER BY trusted_at DESC LIMIT 1`,
      [biz.id, member.b],
    );
    expect(rows[0].revoked_reason).toBe("mfa_policy_tightened");
  });

  it("switching the requirement on for accountants revokes trust too", async () => {
    const mfaPolicy = await import("../src/lib/mfa-policy");

    // Baseline: managers already required, accountants not. The tests above
    // leave this business in a known state, but set it explicitly so this case
    // cannot silently inherit a different starting policy.
    await dbLib.withTenant(biz.id, () =>
      mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: false, requireForAccountants: false }),
    );

    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );
    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        token: issued.token,
      }),
    ).toEqual({ trusted: true, expiresAt: issued.expiresAt });

    /*
     * Only `requireForAccountants` moves. This is the case the change-detection
     * used to miss: it compared `requireForManagers` alone, so an owner could
     * turn the second factor on for every accountant in the business and not
     * one existing device exemption would be re-earned. Both switches exempt
     * the same routine challenge, so both must invalidate.
     */
    await dbLib.withTenant(biz.id, () =>
      mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: false, requireForAccountants: true }),
    );

    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        token: issued.token,
      }),
    ).toEqual({ trusted: false, reason: "revoked" });

    const { rows } = await db.query<{ revoked_reason: string }>(
      `SELECT revoked_reason FROM trusted_devices WHERE business_id = $1 AND user_id = $2
        ORDER BY trusted_at DESC LIMIT 1`,
      [biz.id, member.a],
    );
    expect(rows[0].revoked_reason).toBe("mfa_policy_tightened");
  });

  it("re-saving an unchanged MFA policy does not take anyone's trust", async () => {
    const mfaPolicy = await import("../src/lib/mfa-policy");

    // Establish a known baseline first: the test above tightened this same
    // business's policy, and the settings row persists across tests, so
    // writing `false` here would be a genuine change rather than a no-op.
    await dbLib.withTenant(biz.id, () =>
      mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: false, requireForAccountants: false }),
    );

    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );

    // Same value written twice. A no-op policy save must not log a member out
    // of their trusted devices — that would make the settings screen
    // destructive to open.
    await dbLib.withTenant(biz.id, async () => {
      await mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: false, requireForAccountants: false });
      await mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: false, requireForAccountants: false });
    });

    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        token: issued.token,
      }),
    ).toEqual({ trusted: true, expiresAt: issued.expiresAt });
  });

  it("a policy change in one business leaves another business's trust alone", async () => {
    const mfaPolicy = await import("../src/lib/mfa-policy");

    const here = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );
    const elsewhere = await dbLib.withTenant(otherBiz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: otherBiz.id, userId: member.a }),
    );

    await dbLib.withTenant(biz.id, () =>
      mfaPolicy.setMfaPolicy(biz.id, { requireForManagers: true, requireForAccountants: false }),
    );

    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        token: here.token,
      }),
    ).toEqual({ trusted: false, reason: "revoked" });

    // Tenant isolation: the revocation is scoped by business_id, so one
    // owner's policy decision cannot reach into another tenant's rows.
    expect(
      await dbLib.withTenant(otherBiz.id, () =>
        trustedDevice.verifyTrustedDevice({
          businessId: otherBiz.id,
          userId: member.a,
          token: elsewhere.token,
        }),
      ),
    ).toEqual({ trusted: true, expiresAt: elsewhere.expiresAt });
  });

  it("a global identity's trust is revocable across every membership it holds", async () => {
    const platformUserId = (
      await db.query<{ id: string }>(
        `INSERT INTO platform_users (email, full_name, password_hash)
         VALUES ($1, 'هویت جهانی', 'x') RETURNING id`,
        [`global-${randomUUID()}@example.test`],
      )
    ).rows[0].id;

    await db.query(`UPDATE users SET platform_user_id = $2 WHERE id = $1`, [
      member.a,
      platformUserId,
    ]);
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        platformUserId,
      }),
    );

    const revoked = await trustedDevice.revokeTrustedDevicesForPlatformUser({
      platformUserId,
      reason: "platform_password_reset",
    });
    expect(revoked).toBeGreaterThanOrEqual(1);

    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        token: issued.token,
      }),
    ).toEqual({ trusted: false, reason: "revoked" });
  });
});

describe("the stored row never contains the credential", () => {
  it("persists only a digest, so reading the table cannot be replayed", async () => {
    const issued = await dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({ businessId: biz.id, userId: member.a }),
    );
    const { rows } = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM trusted_devices
        WHERE business_id = $1 AND user_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [biz.id, member.a],
    );
    const stored = rows[0].token_hash;

    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(issued.token);
    expect(stored).not.toContain(issued.token);
    // The token itself appears nowhere in the row.
    expect(
      await trustedDevice.verifyTrustedDevice({
        businessId: biz.id,
        userId: member.a,
        token: stored,
      }),
    ).toEqual({ trusted: false, reason: "missing" });
  });
});

/**
 * The events that take trust back, and the audit trail that makes trust visible.
 * Each case issues a fresh device, fires the event through the real service, and
 * checks the same token no longer verifies — with the reason the row records.
 */
describe("revocation on the account's security events", () => {
  let platformUserId: string;

  async function revokedReason(userId: string): Promise<string | undefined> {
    const { rows } = await db.query<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM trusted_devices
        WHERE business_id = $1 AND user_id = $2 ORDER BY trusted_at DESC LIMIT 1`,
      [biz.id, userId],
    );
    return rows[0]?.revoked_reason ?? undefined;
  }

  async function freshTrust(userId: string, withIdentity: boolean) {
    return dbLib.withTenant(biz.id, () =>
      trustedDevice.issueTrustedDevice({
        businessId: biz.id,
        userId,
        platformUserId: withIdentity ? platformUserId : null,
        factorSummary: "password+totp",
      }),
    );
  }

  async function stillTrusted(userId: string, token: string) {
    const decision = await trustedDevice.verifyTrustedDevice({
      businessId: biz.id,
      userId,
      token,
    });
    return decision.trusted;
  }

  beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    platformUserId = (
      await db.query<{ id: string }>(
        `INSERT INTO platform_users (email, full_name, password_hash)
         VALUES ($1, 'هویت آزمون', $2) RETURNING id`,
        [`events-${randomUUID()}@example.test`, await bcrypt.hash("old-password-Aa1!", 4)],
      )
    ).rows[0].id;
    await db.query(`UPDATE users SET platform_user_id = $2 WHERE id = $1`, [
      member.a,
      platformUserId,
    ]);
  });

  it("issuing trust writes a grant row to the business's audit log", async () => {
    const issued = await freshTrust(member.a, true);
    expect(issued.token.startsWith("tdev_")).toBe(true);
    const { rows } = await db.query<{ payload: Record<string, unknown>; user_id: string }>(
      `SELECT payload, user_id FROM audit_log
        WHERE business_id = $1 AND action = 'auth.trusted_device_granted'
        ORDER BY id DESC LIMIT 1`,
      [biz.id],
    );
    expect(rows[0].user_id).toBe(member.a);
    expect(rows[0].payload.factorSummary).toBe("password+totp");
    expect(rows[0].payload.expiresAt).toBe(issued.expiresAt.toISOString());
    // The credential and its digest are facts nobody should find in an audit row.
    expect(JSON.stringify(rows[0].payload)).not.toContain(issued.token);
  });

  it("recording a trusted-device login writes the door and the waived factor", async () => {
    await dbLib.withTenant(biz.id, () =>
      trustedDevice.auditTrustedDeviceLogin({
        businessId: biz.id,
        userId: member.a,
        platformUserId,
        door: "password",
        waived: "mfa",
        expiresAt: new Date(Date.now() + DAY_MS),
      }),
    );
    const { rows } = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_log
        WHERE business_id = $1 AND action = 'auth.trusted_device_login'
        ORDER BY id DESC LIMIT 1`,
      [biz.id],
    );
    expect(rows[0].payload).toMatchObject({ door: "password", waived: "mfa", platformUserId });
  });

  it("an MFA reset takes the trust back", async () => {
    const mfa = await import("../src/lib/mfa-service");
    const issued = await freshTrust(member.a, true);
    expect(await stillTrusted(member.a, issued.token)).toBe(true);

    await mfa.resetAccountMfa("platform_user", platformUserId, 7);

    expect(await stillTrusted(member.a, issued.token)).toBe(false);
    expect(await revokedReason(member.a)).toBe("mfa_reset");
  });

  it("removing a second factor takes the trust back, and only this identity's", async () => {
    const mfa = await import("../src/lib/mfa-service");
    await db.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, confirmed_at)
       VALUES ('platform_user', $1, 'sms_otp', true, '+989121234567', now()),
              ('platform_user', $1, 'totp', false, NULL, now())`,
      [platformUserId],
    );
    const mine = await freshTrust(member.a, true);
    const someoneElses = await freshTrust(member.b, false);

    const removal = await mfa.removeMfaFactorChecked({
      subjectRealm: "platform_user",
      subjectId: platformUserId,
      method: "totp",
    });
    expect(removal.ok).toBe(true);

    expect(await stillTrusted(member.a, mine.token)).toBe(false);
    expect(await revokedReason(member.a)).toBe("mfa_factor_removed");
    // A different identity on the same tenant is untouched.
    expect(await stillTrusted(member.b, someoneElses.token)).toBe(true);
  });

  it("changing the password takes the trust back", async () => {
    const { changeOwnPassword } = await import("../src/lib/password-reset");
    const issued = await freshTrust(member.a, true);
    expect(await stillTrusted(member.a, issued.token)).toBe(true);

    const wrong = await changeOwnPassword({
      subjectRealm: "platform_user",
      subjectId: platformUserId,
      currentPassword: "not-the-password",
      newPassword: "New-password-Bb2!x",
    });
    expect(wrong.ok).toBe(false);
    // A refused change must not cost anyone their trust.
    expect(await stillTrusted(member.a, issued.token)).toBe(true);

    const changed = await changeOwnPassword({
      subjectRealm: "platform_user",
      subjectId: platformUserId,
      currentPassword: "old-password-Aa1!",
      newPassword: "New-password-Bb2!x",
    });
    expect(changed.ok).toBe(true);
    expect(await stillTrusted(member.a, issued.token)).toBe(false);
    expect(await revokedReason(member.a)).toBe("password_changed");
  });

  it("the failed attempt that locks the account takes the trust back; earlier ones do not", async () => {
    const employee = await import("../src/lib/employee-service");
    const issued = await freshTrust(member.b, false);

    // One short of the threshold: still trusted.
    for (let i = 0; i < 4; i += 1) {
      await dbLib.withTenant(biz.id, () =>
        employee.auditLoginFailure(biz.id, member.b, "invalid_pin"),
      );
    }
    expect(await stillTrusted(member.b, issued.token)).toBe(true);

    await dbLib.withTenant(biz.id, () =>
      employee.auditLoginFailure(biz.id, member.b, "invalid_pin"),
    );
    expect(await stillTrusted(member.b, issued.token)).toBe(false);
    expect(await revokedReason(member.b)).toBe("account_locked");
  });

  it("revokeTrustedDevicesForMember clears one membership and no other", async () => {
    const a = await freshTrust(member.a, false);
    const b = await freshTrust(member.b, false);
    const count = await dbLib.withTenant(biz.id, () =>
      trustedDevice.revokeTrustedDevicesForMember({
        businessId: biz.id,
        userId: member.a,
        reason: "test",
      }),
    );
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await stillTrusted(member.a, a.token)).toBe(false);
    expect(await stillTrusted(member.b, b.token)).toBe(true);
  });

  it("a member's manual revocation is idempotent and leaves their other devices alone", async () => {
    const first = await freshTrust(member.a, false);
    const second = await freshTrust(member.a, false);
    const [row] = (
      await dbLib.withTenant(biz.id, () => trustedDevice.listTrustedDevices(biz.id, member.a))
    ).filter((d) => !d.revokedAt);
    // Newest first: `row` is `second`'s entry.
    const ok = await dbLib.withTenant(biz.id, () =>
      trustedDevice.revokeTrustedDevice({ businessId: biz.id, userId: member.a, id: row.id }),
    );
    expect(ok).toBe(true);
    expect(await stillTrusted(member.a, second.token)).toBe(false);
    expect(await stillTrusted(member.a, first.token)).toBe(true);
    const again = await dbLib.withTenant(biz.id, () =>
      trustedDevice.revokeTrustedDevice({ businessId: biz.id, userId: member.a, id: row.id }),
    );
    expect(again).toBe(false);
  });
});
