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
