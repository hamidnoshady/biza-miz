import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { generate as generateTotp } from "otplib";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

/**
 * The SMS transport, replaced by something that records instead of ringing.
 *
 * Issue #854 (P0.3) changed what a tenant administrator gets back from
 * `requestMemberPasswordReset`: the reset link is now *delivered to the account
 * holder's verified phone* and the administrator receives only a masked
 * destination. That makes the transport the only place the token exists in
 * plaintext, so capturing it here is how these tests play the part of the
 * person holding the phone — and the negative assertion (the caller's return
 * value contains no `token`) only means something because the token *was*
 * minted and sent.
 */
const sms = vi.hoisted(() => ({ sent: [] as { phone: string; code: string }[] }));

vi.mock("@/lib/sms-config", () => ({
  getPublicSmsConfig: async () => ({
    configured: true,
    hasStoredKey: true,
    keyHint: "••••1234",
    otpTemplate: "verify",
    fromEnvironment: false,
    updatedAt: null,
  }),
  getSmsProvider: async () => ({
    sendOtp: async (phone: string, code: string) => {
      sms.sent.push({ phone, code });
    },
  }),
}));

/** The number the shared manager proved they hold. */
const SHARED_MANAGER_PHONE = "+989121110000";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let team: typeof import("../src/lib/team-service");
let employeeService: typeof import("../src/lib/employee-service");
let passwordReset: typeof import("../src/lib/password-reset");
let mfaLib: typeof import("../src/lib/mfa");
let mfaService: typeof import("../src/lib/mfa-service");
let mfaEnrol: typeof import("../src/lib/mfa-enrol");
let mfaVerify: typeof import("../src/lib/mfa-verify");
let platformService: typeof import("../src/lib/platform-service");
let platformAuth: typeof import("../src/lib/platform-auth");
let loginCredsService: typeof import("../src/lib/iam/login-credentials-service");

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

function fakeTokenHash(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

beforeAll(async () => {
  databaseName = `pos_auth_sec_${randomUUID().replaceAll("-", "")}`;

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
  team = await import("../src/lib/team-service");
  employeeService = await import("../src/lib/employee-service");
  passwordReset = await import("../src/lib/password-reset");
  mfaLib = await import("../src/lib/mfa");
  mfaService = await import("../src/lib/mfa-service");
  mfaEnrol = await import("../src/lib/mfa-enrol");
  mfaVerify = await import("../src/lib/mfa-verify");
  platformService = await import("../src/lib/platform-service");
  platformAuth = await import("../src/lib/platform-auth");
  loginCredsService = await import("../src/lib/iam/login-credentials-service");

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
  sms.sent.length = 0;
  await db.query("DELETE FROM auth_password_resets");
  await db.query("DELETE FROM auth_admin_sessions");
  await db.query("DELETE FROM mfa_challenges");
  await db.query("DELETE FROM mfa_recovery_codes");
  await db.query("DELETE FROM mfa_enrolments");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
  await db.query("DELETE FROM platform_admins");
});

async function seedTwoBusinessesWithSharedManager() {
  const sharedPassHash = await bcrypt.hash("OriginalPass!123", 10);
  const sharedIdentity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name, token_version)
     VALUES ('shared.manager@example.com', $1, 'Shared Manager', 1)
     RETURNING id`,
    [sharedPassHash],
  );
  const sharedPlatformUserId = sharedIdentity.rows[0].id;

  const ownerAPassHash = await bcrypt.hash("OwnerAPass!123", 10);
  const ownerAIdentity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name, token_version)
     VALUES ('owner.a@example.com', $1, 'Owner A', 1)
     RETURNING id`,
    [ownerAPassHash],
  );

  const bizA = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('Cafe Alpha', $1) RETURNING id`,
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  const locA = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main A') RETURNING id`,
    [bizA.rows[0].id],
  );
  const ownerA = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'owner', 'Owner A', 'owner.a@example.com') RETURNING id`,
    [bizA.rows[0].id, ownerAIdentity.rows[0].id],
  );
  const memberA = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email,
                        phone_e164, phone_verified_at)
     VALUES ($1, $2, 'manager', 'Shared Manager', 'shared.manager@example.com', $3, now())
     RETURNING id`,
    [bizA.rows[0].id, sharedPlatformUserId, SHARED_MANAGER_PHONE],
  );

  const bizB = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('Bistro Beta', $1) RETURNING id`,
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  const locB = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main B') RETURNING id`,
    [bizB.rows[0].id],
  );
  const memberB = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'manager', 'Shared Manager', 'shared.manager@example.com') RETURNING id`,
    [bizB.rows[0].id, sharedPlatformUserId],
  );

  return {
    sharedPlatformUserId,
    bizAId: bizA.rows[0].id,
    locAId: locA.rows[0].id,
    ownerAId: ownerA.rows[0].id,
    ownerAPlatformUserId: ownerAIdentity.rows[0].id,
    memberAId: memberA.rows[0].id,
    bizBId: bizB.rows[0].id,
    locBId: locB.rows[0].id,
    memberBId: memberB.rows[0].id,
  };
}

describe("Issue #809 — P0 cross-tenant password overwrite protection & tenant session revocation", () => {
  it("forbids a tenant owner from overwriting another member's global platform_users password", async () => {
    const seeded = await seedTwoBusinessesWithSharedManager();

    await expect(
      dbLib.withTenant(seeded.bizAId, () =>
        team.setPassword(seeded.bizAId, seeded.memberAId, "HackedByBizA!999", seeded.ownerAId),
      ),
    ).rejects.toThrow("cross_user_password_reset_forbidden");

    const { rows } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [seeded.sharedPlatformUserId],
    );
    expect(rows[0].token_version).toBe(1);
    expect(await bcrypt.compare("OriginalPass!123", rows[0].password_hash)).toBe(true);
    expect(await bcrypt.compare("HackedByBizA!999", rows[0].password_hash)).toBe(false);
  });

  it("delivers the reset link to the holder and revokes every business' sessions when it is redeemed", async () => {
    const seeded = await seedTwoBusinessesWithSharedManager();

    // Seed active employee_sessions in both Business A and Business B
    const sessA = await dbLib.withTenant(seeded.bizAId, () =>
      employeeService.createSession(seeded.memberAId, seeded.bizAId, {
        locationId: seeded.locAId,
        deviceLabel: "Biz A Browser",
      }),
    );
    const sessB = await dbLib.withTenant(seeded.bizBId, () =>
      employeeService.createSession(seeded.memberBId, seeded.bizBId, {
        locationId: seeded.locBId,
        deviceLabel: "Biz B Browser",
      }),
    );

    const revoked = await dbLib.withTenant(seeded.bizAId, () =>
      team.revokeMemberTenantSessions(seeded.bizAId, seeded.memberAId, seeded.ownerAId),
    );
    expect(revoked.revokedCount).toBe(1);

    const checkA = await dbLib.withTenant(seeded.bizAId, () =>
      dbLib.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
        [sessA.session.id],
      ),
    );
    const checkB = await dbLib.withTenant(seeded.bizBId, () =>
      dbLib.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
        [sessB.session.id],
      ),
    );
    expect(checkA.rows[0].revoked_at).not.toBeNull();
    expect(checkB.rows[0].revoked_at).toBeNull();

    // Issue user-controlled reset link from Business A.
    //
    // Issue #854 (P0.3): the administrator who *triggers* recovery must not
    // receive the credential that completes it. The return value is asserted to
    // be free of anything spendable — a token, a URL, a code — and the link is
    // read back from the SMS the account holder received instead.
    const issued = await dbLib.withTenant(seeded.bizAId, () =>
      team.requestMemberPasswordReset(
        seeded.bizAId,
        seeded.memberAId,
        seeded.ownerAId,
        { origin: "https://app.example.com" },
      ),
    );
    expect(issued.email).toBe("shared.manager@example.com");
    expect(issued.channel).toBe("sms");
    expect(issued.deliveredTo).toBe("+989***0000");
    expect(issued).not.toHaveProperty("token");
    expect(issued).not.toHaveProperty("url");
    expect(JSON.stringify(issued)).not.toContain("reset-password");

    // The holder's phone is the only place the link exists.
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].phone).toBe(SHARED_MANAGER_PHONE);
    const deliveredLink = sms.sent[0].code;
    expect(deliveredLink).toContain("https://app.example.com/reset-password?token=");
    const issuedToken = decodeURIComponent(
      deliveredLink.slice(deliveredLink.indexOf("token=") + "token=".length),
    );
    expect(issuedToken).toHaveLength(43);

    const preview = await passwordReset.previewPasswordResetToken(issuedToken);
    expect(preview).toMatchObject({
      subjectRealm: "platform_user",
      email: "shared.manager@example.com",
    });

    const consumed = await passwordReset.consumePasswordResetToken({
      token: issuedToken,
      newPassword: "UserChosenNewPass!456",
    });
    expect(consumed).toMatchObject({
      ok: true,
      subjectRealm: "platform_user",
      subjectId: seeded.sharedPlatformUserId,
      tokenVersion: 2,
    });

    // Consuming the reset token increments token_version and revokes all employee_sessions (including Business B)
    const afterB = await dbLib.withTenant(seeded.bizBId, () =>
      dbLib.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
        [sessB.session.id],
      ),
    );
    expect(afterB.rows[0].revoked_at).not.toBeNull();

    // Token is single-use
    const replay = await passwordReset.consumePasswordResetToken({
      token: issuedToken,
      newPassword: "AnotherPass!789",
    });
    expect(replay).toEqual({ ok: false, error: "token_used" });
  });
});

describe("Issue #809 — P0 self password change increments token_version and revokes other sessions", () => {
  it("verifies current password, bumps token_version, and keeps only the caller's current employee_session", async () => {
    const seeded = await seedTwoBusinessesWithSharedManager();

    const currentSess = await dbLib.withTenant(seeded.bizAId, () =>
      employeeService.createSession(seeded.ownerAId, seeded.bizAId, {
        locationId: seeded.locAId,
        deviceLabel: "Owner Current Browser",
      }),
    );
    const otherSess = await dbLib.withTenant(seeded.bizAId, () =>
      employeeService.createSession(seeded.ownerAId, seeded.bizAId, {
        locationId: seeded.locAId,
        deviceLabel: "Owner Old Browser",
      }),
    );

    const wrongCurrent = await passwordReset.changeOwnPassword({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerAPlatformUserId,
      currentPassword: "WrongPassword!000",
      newPassword: "BrandNewOwnerPass!123",
    });
    expect(wrongCurrent).toEqual({ ok: false, error: "invalid_current_password" });

    const changed = await passwordReset.changeOwnPassword({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerAPlatformUserId,
      currentPassword: "OwnerAPass!123",
      newPassword: "BrandNewOwnerPass!123",
      keepEmployeeSessionId: currentSess.session.id,
    });
    expect(changed).toEqual({ ok: true, tokenVersion: 2 });

    const checkCurrent = await dbLib.withTenant(seeded.bizAId, () =>
      dbLib.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
        [currentSess.session.id],
      ),
    );
    const checkOther = await dbLib.withTenant(seeded.bizAId, () =>
      dbLib.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
        [otherSess.session.id],
      ),
    );
    expect(checkCurrent.rows[0].revoked_at).toBeNull();
    expect(checkOther.rows[0].revoked_at).not.toBeNull();
  });
});

describe("Issue #809 — P1 two-step MFA confirmation, deterministic primary selection, and phone-OTP second factor", () => {
  it("keeps newly enrolled TOTP unconfirmed until proven with a valid code, then mints recovery codes and enforces single primary", async () => {
    const seeded = await seedTwoBusinessesWithSharedManager();
    const subjectId = seeded.ownerAPlatformUserId;

    const staged = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId,
      email: "owner.a@example.com",
      method: "totp",
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok || !staged.totpSecret) throw new Error("expected staged totp");
    expect(staged.status).toBe("pending_confirmation");
    expect(staged.recoveryCodes).toEqual([]);

    // Unconfirmed enrolment is NOT counted as active
    const allBefore = await mfaService.getAccountMfaEnrolments("platform_user", subjectId);
    expect(allBefore).toHaveLength(1);
    expect(allBefore[0].confirmed_at).toBeNull();
    expect(allBefore[0].is_primary).toBe(false);
    expect(mfaService.filterActiveMfaEnrolments(allBefore)).toEqual([]);

    /**
     * Issue #854 (P1.11): the default is now the strict one — a step-up must
     * not finish somebody's half-done enrolment — so the one ceremony that
     * *is* about confirming a pending factor asks for it explicitly.
     */
    // Wrong code does not confirm the enrolment
    const badVerify = await mfaVerify.verifyAndConfirmMfaCode({
      subjectRealm: "platform_user",
      subjectId,
      method: "totp",
      code: "000000",
      useRecoveryCode: false,
      confirmPendingEnrolment: true,
    });
    expect(badVerify.outcome).toBe("rejected");
    expect(
      mfaService.filterActiveMfaEnrolments(
        await mfaService.getAccountMfaEnrolments("platform_user", subjectId),
      ),
    ).toEqual([]);

    // Valid TOTP code confirms the enrolment, sets is_primary = true, and mints 10 recovery codes
    const validCode = await generateTotp({ secret: staged.totpSecret });
    const goodVerify = await mfaVerify.verifyAndConfirmMfaCode({
      subjectRealm: "platform_user",
      subjectId,
      method: "totp",
      code: validCode,
      useRecoveryCode: false,
      confirmPendingEnrolment: true,
    });
    expect(goodVerify.outcome).toBe("totp");
    expect(goodVerify.wasUnconfirmed).toBe(true);
    expect(goodVerify.recoveryCodes).toHaveLength(10);

    const activeAfter = mfaService.filterActiveMfaEnrolments(
      await mfaService.getAccountMfaEnrolments("platform_user", subjectId),
    );
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter[0].method).toBe("totp");
    expect(activeAfter[0].is_primary).toBe(true);
    expect(activeAfter[0].confirmed_at).not.toBeNull();

    // Phone-OTP primary login requires a distinct second factor (totp, never sms_otp)
    const distinctForPhone = mfaLib.distinctSecondFactorMethods(activeAfter, "phone_otp");
    expect(distinctForPhone).toEqual(["totp"]);
    expect(
      mfaLib.shouldChallengeMfaOnLogin({
        appliesToRole: true,
        hasConfirmedEnrolment: activeAfter.length > 0,
        requirement: "not_required",
      }),
    ).toBe(true);

    // Hybrid login credentials replicate token_version and confirmed MFA enrolments
    const replicated = await loginCredsService.buildLoginCredentials(seeded.bizAId);
    const ownerCred = replicated.find((c) => c.membershipId === seeded.ownerAId);
    expect(ownerCred).toBeDefined();
    expect(ownerCred?.mfa).toHaveLength(1);
    expect(ownerCred?.mfa[0].method).toBe("totp");
  });
});

describe("Issue #809 — P1 Superadmin lifecycle, last-owner protection, and session revocation", () => {
  it("creates admins, blocks deactivating/demoting the last active owner, and revokes sessions on password change or admin revocation", async () => {
    const seedOwner = await db.query<{ id: string }>(
      `INSERT INTO platform_admins (email, password_hash, full_name, role, is_active, token_version)
       VALUES ('root.owner@example.com', $1, 'Root Owner', 'owner', true, 1)
       RETURNING id`,
      [await bcrypt.hash("RootOwnerPass!123", 10)],
    );
    const rootOwnerId = seedOwner.rows[0].id;

    // Cannot deactivate or demote the last active platform owner
    const demoteLast = await dbLib.withoutTenantScope("platform", () =>
      platformService.updatePlatformAdmin({
        actorAdminId: rootOwnerId,
        targetAdminId: rootOwnerId,
        role: "support",
      }),
    );
    expect(demoteLast).toEqual({ ok: false, error: "last_platform_owner" });

    // Create a support admin -> issues invitation reset token
    const createdSupport = await dbLib.withoutTenantScope("platform", () =>
      platformService.createPlatformAdmin({
        actorAdminId: rootOwnerId,
        email: "support.op@example.com",
        fullName: "Support Op",
        role: "support",
      }),
    );
    expect(createdSupport.ok).toBe(true);
    if (!createdSupport.ok) throw new Error("expected support creation");
    expect(createdSupport.resetToken).toBeTruthy();

    // Create an active console session for the support admin
    const sessId = await dbLib.withoutTenantScope("platform", () =>
      platformAuth.createPlatformAdminSession({
        adminId: createdSupport.admin.id,
        tokenVersion: 1,
        mfaVerified: true,
        deviceLabel: "Operator Browser",
        ipAddress: "127.0.0.1",
      }),
    );
    expect(sessId).toBeTruthy();

    const activeBefore = await dbLib.withoutTenantScope("platform", () =>
      platformAuth.listPlatformAdminSessions(createdSupport.admin.id, sessId),
    );
    expect(activeBefore).toHaveLength(1);

    // Revoking sessions bumps token_version and revokes auth_admin_sessions
    const revoked = await dbLib.withoutTenantScope("platform", () =>
      platformService.revokePlatformAdminAccessSessions({
        actorAdminId: rootOwnerId,
        targetAdminId: createdSupport.admin.id,
      }),
    );
    expect(revoked.ok).toBe(true);

    const activeAfter = await dbLib.withoutTenantScope("platform", () =>
      platformAuth.listPlatformAdminSessions(createdSupport.admin.id, sessId),
    );
    expect(activeAfter).toHaveLength(0);
  });
});
