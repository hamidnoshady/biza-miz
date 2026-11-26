/**
 * #1386 — phone-native password recovery against a real database.
 *
 * The service's pure decisions are unit-tested beside it. What this file pins
 * is the part only Postgres can answer: that the write is atomic, that the
 * purpose-bound code is single-use, and that a successful recovery revokes the
 * sessions and device trust it must.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let identity: typeof import("../src/lib/iam/global-identity-service");
let otp: typeof import("../src/lib/otp-challenge");
let recovery: typeof import("../src/lib/password-recovery");
let provisioning: typeof import("../src/lib/business-provisioning");
let employeeService: typeof import("../src/lib/employee-service");
let passwordReset: typeof import("../src/lib/password-reset");
let teamService: typeof import("../src/lib/team-service");
let phoneOtp: typeof import("../src/lib/phone-otp");

const owner = {
  platformUserId: "",
  businessId: "",
  membershipId: "",
  phone: "+989121230001",
};

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

async function issueRecoveryCode(code: string, purpose: "password_recovery" | "login" = "password_recovery") {
  return otp.issueOtpChallenge({
    subjectRealm: recovery.PASSWORD_RECOVERY_REALM,
    subjectId: await otp.phoneDerivedSubject(owner.phone),
    purpose,
    candidatePhoneE164: owner.phone,
    code,
  });
}

beforeAll(async () => {
  databaseName = `pos_password_recovery_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  db = await import("../src/lib/db");
  identity = await import("../src/lib/iam/global-identity-service");
  otp = await import("../src/lib/otp-challenge");
  recovery = await import("../src/lib/password-recovery");
  provisioning = await import("../src/lib/business-provisioning");
  employeeService = await import("../src/lib/employee-service");
  passwordReset = await import("../src/lib/password-reset");
  teamService = await import("../src/lib/team-service");
  phoneOtp = await import("../src/lib/phone-otp");

  const business = await provisioning.provisionBusiness({
    businessName: "کافهٔ بازیابی",
    ownerName: "مالک",
    email: `recovery-${randomUUID()}@example.com`,
    password: "existing-password",
    seedChartOfAccounts: false,
  });
  owner.businessId = business.businessId;
  owner.membershipId = business.userId;
  owner.platformUserId = business.platformUserId;

  const claimed = await identity.claimVerifiedPhone({
    platformUserId: owner.platformUserId,
    phone: owner.phone,
  });
  expect(claimed.ok).toBe(true);
}, 180_000);

afterAll(async () => {
  await db?.getPool().end().catch(() => {});
  delete (globalThis as { pgPool?: unknown }).pgPool;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("phone password recovery", () => {
  it("rejects a code minted for another purpose without touching the password", async () => {
    await issueRecoveryCode("111111", "login");

    const result = await recovery.verifyPhonePasswordRecovery({
      phone: owner.phone,
      code: "111111",
      newPassword: "new-password-123",
      confirmPassword: "new-password-123",
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });

  it("replaces the password, revokes trust/sessions, audits, and refuses replay", async () => {
    // A live trusted device and an open session earned under the old password.
    await db.query(
      `INSERT INTO trusted_devices
         (business_id, user_id, platform_user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
      [owner.businessId, owner.membershipId, owner.platformUserId, "a".repeat(64)],
    );
    // `createSession` also creates the employee profile the session row points
    // at, which is what a real password login does.
    await employeeService.createSession(owner.membershipId, owner.businessId, {
      loginMethod: "password",
    });

    await issueRecoveryCode("222222");
    const result = await recovery.verifyPhonePasswordRecovery({
      phone: "۰۹۱۲۱۲۳۰۰۰۱",
      code: "۲۲۲۲۲۲",
      newPassword: "new-password-123",
      confirmPassword: "new-password-123",
    });

    expect(result).toMatchObject({ ok: true });

    const { rows: users } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [owner.platformUserId],
    );
    expect(await bcrypt.compare("new-password-123", users[0].password_hash)).toBe(true);
    expect(users[0].token_version).toBeGreaterThanOrEqual(2);

    const { rows: trust } = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM trusted_devices
        WHERE platform_user_id = $1`,
      [owner.platformUserId],
    );
    expect(trust[0]?.revoked_at).not.toBeNull();
    expect(trust[0]?.revoked_reason).toBe("password_reset");

    const { rows: sessions } = await db.query<{ revoked_at: Date | null }>(
      `SELECT es.revoked_at
         FROM employee_sessions es
         JOIN users u ON u.id = es.employee_id
        WHERE u.platform_user_id = $1`,
      [owner.platformUserId],
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((row) => row.revoked_at !== null)).toBe(true);

    const { rows: audits } = await db.query<{ action: string; payload: { method?: string } }>(
      `SELECT action, payload FROM platform_audit_log
        WHERE entity_id = $1 AND action = 'auth.password_recovered_by_phone'`,
      [owner.platformUserId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].payload.method).toBe("phone_otp");

    // The same code cannot be spent twice.
    const replay = await recovery.verifyPhonePasswordRecovery({
      phone: owner.phone,
      code: "222222",
      newPassword: "another-password-123",
      confirmPassword: "another-password-123",
    });
    expect(replay).toEqual({ ok: false, error: "invalid_code" });
  });

  it("creates a first password only while the identity still has none", async () => {
    await db.query(`UPDATE platform_users SET password_hash = NULL WHERE id = $1`, [
      owner.platformUserId,
    ]);

    const created = await passwordReset.setInitialPasswordForPlatformUser({
      platformUserId: owner.platformUserId,
      newPassword: "first-password-123",
      lockoutKey: owner.phone,
    });
    expect(created.ok).toBe(true);

    // A second creation must not overwrite a password it did not prove.
    const second = await passwordReset.setInitialPasswordForPlatformUser({
      platformUserId: owner.platformUserId,
      newPassword: "attacker-password-123",
      lockoutKey: owner.phone,
    });
    expect(second).toEqual({ ok: false, error: "not_found" });

    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [owner.platformUserId],
    );
    expect(await bcrypt.compare("first-password-123", rows[0].password_hash)).toBe(true);
  });
});

/**
 * #1386 — the single-use guarantee under real concurrency.
 *
 * `redeemOtpChallenge` locks the challenge row `FOR UPDATE`, so of N verifies
 * racing on one code exactly one may consume it. The unit suites mock the
 * database and cannot prove that; these run N requests in parallel against
 * real Postgres on separate pool connections.
 */
describe("concurrent redemption of one code (#1386)", () => {
  const RACERS = 5;

  it("lets exactly one of N parallel recoveries replace the password", async () => {
    await issueRecoveryCode("333333");
    const passwords = Array.from({ length: RACERS }, (_, i) => `racer-password-${i}-123`);

    const results = await Promise.all(
      passwords.map((newPassword) =>
        recovery.verifyPhonePasswordRecovery({
          phone: owner.phone,
          code: "333333",
          newPassword,
          confirmPassword: newPassword,
        }),
      ),
    );

    const winners = results.flatMap((result, i) => (result.ok ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const [i, result] of results.entries()) {
      if (i !== winners[0]) expect(result).toEqual({ ok: false, error: "invalid_code" });
    }

    // The stored password is the winner's, and no loser's write landed.
    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [owner.platformUserId],
    );
    expect(await bcrypt.compare(passwords[winners[0]], rows[0].password_hash)).toBe(true);

    const { rows: audits } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform_audit_log
        WHERE entity_id = $1 AND action = 'auth.password_recovered_by_phone'`,
      [owner.platformUserId],
    );
    // One from the earlier sequential test, one from this race — never RACERS.
    expect(Number(audits[0].n)).toBe(2);
  });

  it("consumes a phone-OTP login code exactly once under parallel verifies", async () => {
    const subjectId = await otp.phoneDerivedSubject(owner.phone);
    await otp.issueOtpChallenge({
      subjectRealm: phoneOtp.PENDING_PHONE_REALM,
      subjectId,
      purpose: "login",
      candidatePhoneE164: owner.phone,
      code: "444444",
    });

    const results = await Promise.all(
      Array.from({ length: RACERS }, () =>
        otp.redeemOtpChallenge({
          subjectRealm: phoneOtp.PENDING_PHONE_REALM,
          subjectId,
          purpose: "login",
          code: "444444",
          expectedPhoneE164: owner.phone,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(RACERS - 1);

    const { rows } = await db.query<{ consumed: number }>(
      `SELECT count(*)::int AS consumed FROM mfa_challenges
        WHERE subject_realm = $1 AND subject_id = $2 AND purpose = 'login'
          AND consumed_at IS NOT NULL`,
      [phoneOtp.PENDING_PHONE_REALM, subjectId],
    );
    expect(rows[0].consumed).toBe(1);

    // And a later sequential replay of the same code is refused too.
    const replay = await otp.redeemOtpChallenge({
      subjectRealm: phoneOtp.PENDING_PHONE_REALM,
      subjectId,
      purpose: "login",
      code: "444444",
      expectedPhoneE164: owner.phone,
    });
    expect(replay.ok).toBe(false);
  });
});

describe("verifyPassword on a passwordless identity (#1386)", () => {
  it("returns false for a NULL hash instead of throwing out of bcrypt", async () => {
    await db.query(`UPDATE platform_users SET password_hash = NULL WHERE id = $1`, [
      owner.platformUserId,
    ]);

    await expect(teamService.verifyPassword(owner.membershipId, "")).resolves.toBe(false);
    await expect(teamService.verifyPassword(owner.membershipId, "anything-123")).resolves.toBe(
      false,
    );
  });
});
