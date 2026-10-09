/**
 * Issue #854 — second pass, against a real database.
 *
 * The findings fixed after the first hardening file, each with the regression
 * test that fails when the fix is reverted:
 *
 *   - **GAP 1** the initial SMS enrolment send names its purpose explicitly,
 *     and first send → confirm completes the ceremony without a resend, in
 *     both realms;
 *   - **GAP 2** the strict SMS step-up is bound to the *confirmed* factor at
 *     redemption as well as issuance: a pending enrolment cannot satisfy it
 *     even via a crafted direct call, and removing the factor invalidates a
 *     challenge already minted for it;
 *   - **GAP 3** two concurrent removals of a two-factor account cannot both
 *     see two factors — the account lock serialises them and the second one
 *     refuses the last factor;
 *   - **GAP 4** sensitive access changes refuse blank or missing reasons and
 *     persist the validated reason with the actor and the change — on
 *     membership update, membership creation, custom-role create/update and
 *     invitation creation;
 *   - **GAP 6** the `membership.created` event carries the custom role the
 *     row actually stored, and a Hybrid/Local site applying that event grants
 *     the same role;
 *   - **GAP 7** every door-changing transaction takes the shared membership
 *     lock — proven by making one wait on the other — and a failed transition
 *     rolls back without touching credentials or audit;
 *   - **GAP 8** a phone-OTP login that still owes a second factor commits its
 *     verification stamps only after the MFA route finishes the ceremony, and
 *     the session keeps its `phone_otp` provenance; an abandoned ceremony
 *     commits nothing.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { generate as generateTotp } from "otplib";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/** SMS transport, recorded — the tests must be able to read the sent code. */
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

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let team: typeof import("../src/lib/team-service");
let mfaService: typeof import("../src/lib/mfa-service");
let mfaEnrol: typeof import("../src/lib/mfa-enrol");
let mfaVerify: typeof import("../src/lib/mfa-verify");
let otpChallenge: typeof import("../src/lib/otp-challenge");
let rolesService: typeof import("../src/lib/iam/roles-service");
let membershipLock: typeof import("../src/lib/membership-lock");
let loginCredentials: typeof import("../src/lib/iam/login-credentials-service");
let iamSync: typeof import("../src/lib/iam/sync");
let mfaPolicy: typeof import("../src/lib/mfa-policy");
let phoneOtpRequest: typeof import("../src/app/api/auth/phone-otp/request/route");
let phoneOtpVerify: typeof import("../src/app/api/auth/phone-otp/verify/route");
let mfaVerifyRoute: typeof import("../src/app/api/auth/mfa/verify/route");

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
  databaseName = `pos_auth_gaps_${randomUUID().replaceAll("-", "")}`;
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
  mfaService = await import("../src/lib/mfa-service");
  mfaEnrol = await import("../src/lib/mfa-enrol");
  mfaVerify = await import("../src/lib/mfa-verify");
  otpChallenge = await import("../src/lib/otp-challenge");
  rolesService = await import("../src/lib/iam/roles-service");
  membershipLock = await import("../src/lib/membership-lock");
  loginCredentials = await import("../src/lib/iam/login-credentials-service");
  iamSync = await import("../src/lib/iam/sync");
  mfaPolicy = await import("../src/lib/mfa-policy");
  phoneOtpRequest = await import("../src/app/api/auth/phone-otp/request/route");
  phoneOtpVerify = await import("../src/app/api/auth/phone-otp/verify/route");
  mfaVerifyRoute = await import("../src/app/api/auth/mfa/verify/route");

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
  await db.query("DELETE FROM mfa_challenges");
  await db.query("DELETE FROM mfa_enrolments");
  await db.query("DELETE FROM employee_credentials");
  await db.query("DELETE FROM employee_sessions");
  await db.query("DELETE FROM invitations");
  await db.query("DELETE FROM iam_events");
  await db.query("DELETE FROM audit_log");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
  // The resend/cooldown counters (P2.25) live here; each test starts cold.
  await db.query("DELETE FROM auth_login_attempts");
});

interface Seed {
  businessId: string;
  locationId: string;
  ownerId: string;
  ownerPlatformUserId: string;
  ownerEmail: string;
  ownerPassword: string;
}

async function seedBusiness(name: string, options: { ownerPhone?: string | null } = {}): Promise<Seed> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@example.com`;
  const ownerPassword = "owner-password-854";

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
    [businessId],
  );
  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, 'Owner') RETURNING id`,
    [ownerEmail, await bcrypt.hash(ownerPassword, 10)],
  );
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email, phone_e164, phone_verified_at)
     VALUES ($1, $2, 'owner', 'Owner', $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [businessId, identity.rows[0].id, ownerEmail, options.ownerPhone ?? null],
  );

  return {
    businessId,
    locationId: location.rows[0].id,
    ownerId: owner.rows[0].id,
    ownerPlatformUserId: identity.rows[0].id,
    ownerEmail,
    ownerPassword,
  };
}

/** A cashier membership with an active PIN credential — a working PIN door. */
async function seedCashierWithPin(seed: Seed, pin: string): Promise<string> {
  const cashier = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name) VALUES ($1, 'cashier', 'Cashier') RETURNING id`,
    [seed.businessId],
  );
  const cashierId = cashier.rows[0].id;
  await db.query(`INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
    cashierId,
    seed.businessId,
  ]);
  await db.query(
    `INSERT INTO employee_credentials (employee_id, business_id, credential_type, secret_hash, pin_blind_index)
     VALUES ($1, $2, 'pin', $3, $4)`,
    [
      cashierId,
      seed.businessId,
      await bcrypt.hash(pin, 10),
      await otpChallenge.pinBlindIndex(seed.businessId, pin),
    ],
  );
  return cashierId;
}

// ---------------------------------------------------------------------------
// GAP 1 — initial SMS enrolment completes without a resend, both realms
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 1 — initial SMS enrolment names its purpose and confirms on the first send", () => {
  it.each([
    ["platform_user", "tenant"],
    ["platform_admin", "platform"],
  ] as const)("completes initial send → confirm on the %s realm", async (realm, _label) => {
    const seeded = await seedBusiness("Enrol");
    let subjectId = seeded.ownerPlatformUserId;
    if (realm === "platform_admin") {
      const admin = await db.query<{ id: string }>(
        `INSERT INTO platform_admins (email, password_hash, full_name)
         VALUES ($1, $2, 'Admin') RETURNING id`,
        [`admin-${randomUUID().slice(0, 8)}@example.com`, await bcrypt.hash("admin-password", 4)],
      );
      subjectId = admin.rows[0].id;
    }

    // One enrolment call mints the challenge AND sends it — no separate
    // "resend" round trip is part of the happy path.
    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: realm,
      subjectId,
      email: `enrol-${randomUUID().slice(0, 8)}@example.com`,
      method: "sms_otp",
      phone: "+989121000001",
      sendSmsChallenge: true,
    });
    expect(enrolled.ok).toBe(true);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].phone).toBe("+989121000001");
    const code = sms.sent[0].code;

    // The confirm spends the enrolment purpose explicitly — the same call the
    // security-center screen makes, with no second send in between.
    const confirmed = await mfaVerify.verifyAndConfirmMfaCode({
      subjectRealm: realm,
      subjectId,
      method: "sms_otp",
      code,
      useRecoveryCode: false,
      confirmPendingEnrolment: true,
      smsPurposes: ["mfa_enrol_sms"],
    });
    expect(confirmed.outcome).toBe("sms_otp");

    const { rows } = await db.query<{ confirmed_at: Date | null; phone_e164: string | null }>(
      `SELECT confirmed_at, phone_e164 FROM mfa_enrolments WHERE subject_realm = $1 AND subject_id = $2`,
      [realm, subjectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed_at).not.toBeNull();
    expect(rows[0].phone_e164).toBe("+989121000001");
  });

  it("refuses to confirm an enrolment when the caller spends the wrong purpose", async () => {
    const seeded = await seedBusiness("PurposeBound");
    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000002",
      sendSmsChallenge: true,
    });
    expect(enrolled.ok).toBe(true);
    const code = sms.sent[0].code;

    // A login-purpose redemption cannot stand in for the enrolment ceremony.
    const wrongPurpose = await mfaVerify.verifyAndConfirmMfaCode({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code,
      useRecoveryCode: false,
      confirmPendingEnrolment: true,
      smsPurposes: ["mfa_login"],
    });
    expect(wrongPurpose.outcome).toBe("rejected");

    const { rows } = await db.query<{ confirmed_at: Date | null }>(
      `SELECT confirmed_at FROM mfa_enrolments WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [seeded.ownerPlatformUserId],
    );
    expect(rows[0]?.confirmed_at ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GAP 2 — strict SMS step-up stays bound to the confirmed factor
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 2 — strict SMS step-up binds to the confirmed factor", () => {
  it("refuses a pending SMS enrolment even through a crafted direct redemption", async () => {
    const seeded = await seedBusiness("PendingFactor");
    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000003",
      sendSmsChallenge: true,
    });
    expect(enrolled.ok).toBe(true);
    const code = sms.sent[0].code;

    // The strict path — what step-up uses — must reject the half-finished
    // factor outright, whatever the request claims.
    const direct = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code,
      smsPurposes: ["step_up_sms"],
    });
    expect(direct.outcome).toBe("rejected");
  });

  it("invalidates a minted step-up challenge when the factor is removed", async () => {
    const seeded = await seedBusiness("StaleChallenge");

    // A confirmed SMS factor, the only way the strict path mints at all.
    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000004",
      sendSmsChallenge: true,
    });
    expect(enrolled.ok).toBe(true);
    const confirm = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: sms.sent[0].code,
    });
    expect(confirm.outcome).toBe("sms_otp");

    // The enrolment send consumed this account's 60s challenge cooldown
    // (P2.25 working as designed); the step-up send is a fresh test step.
    await db.query(`DELETE FROM auth_login_attempts WHERE realm = 'mfa_challenge'`);

    // The step-up challenge is minted against the confirmed factor.
    const challenge = await mfaEnrol.issueSmsMfaChallenge({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      purpose: "step_up_sms",
    });
    expect(challenge.ok).toBe(true);
    const stepUpCode = sms.sent[sms.sent.length - 1].code;

    // Removing (or replacing) the factor must take the challenge down with it.
    const removal = await mfaService.removeMfaFactorChecked({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      allowRemoveLast: true,
    });
    expect(removal.ok).toBe(true);

    const spent = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: stepUpCode,
      smsPurposes: ["step_up_sms"],
    });
    expect(spent.outcome).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// P2.21 — replacing the only SMS factor is atomic and never factorless
// ---------------------------------------------------------------------------

describe("Issue #854 P2.21 — the only SMS factor can be replaced without going factorless", () => {
  it("swaps the number only after the new one proves itself", async () => {
    const seeded = await seedBusiness("ReplaceSms");

    // A confirmed SMS factor on the old number.
    const first = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000006",
      sendSmsChallenge: true,
    });
    expect(first.ok).toBe(true);
    const confirmed = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: sms.sent[sms.sent.length - 1].code,
      expectedPhoneE164: "+989121000006",
    });
    expect(confirmed.outcome).toBe("sms_otp");

    // The replacement request: same method, different number, flagged. The
    // confirmed row must survive staging untouched — the account stays
    // factor-ready the whole ceremony.
    await db.query(`DELETE FROM auth_login_attempts WHERE realm = 'mfa_challenge'`);
    const replace = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000007",
      sendSmsChallenge: true,
      replaceConfirmed: true,
    });
    expect(replace.ok).toBe(true);

    const midCeremony = await db.query<{ phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT phone_e164, confirmed_at FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'sms_otp'`,
      [seeded.ownerPlatformUserId],
    );
    expect(midCeremony.rows[0].phone_e164).toBe("+989121000006");
    expect(midCeremony.rows[0].confirmed_at).not.toBeNull();

    // Proving the new number commits the swap inside the confirmation.
    const done = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: sms.sent[sms.sent.length - 1].code,
      expectedPhoneE164: "+989121000007",
      audit: {
        businessId: seeded.businessId,
        actorUserId: seeded.ownerId,
        platformUserId: seeded.ownerPlatformUserId,
      },
    });
    expect(done.outcome).toBe("sms_otp");

    const after = await db.query<{ phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT phone_e164, confirmed_at FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'sms_otp'`,
      [seeded.ownerPlatformUserId],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].phone_e164).toBe("+989121000007");
    expect(after.rows[0].confirmed_at).not.toBeNull();

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'auth.mfa_factor_replaced'`,
    );
    expect(audit.rows[0].count).toBe("1");
  });

  it("still refuses to double-enrol the same confirmed method", async () => {
    const seeded = await seedBusiness("NoSecondSms");
    const first = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000008",
      sendSmsChallenge: true,
    });
    expect(first.ok).toBe(true);
    const confirmed = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: sms.sent[sms.sent.length - 1].code,
      expectedPhoneE164: "+989121000008",
    });
    expect(confirmed.outcome).toBe("sms_otp");

    // Same number: still already_enrolled — replacement means a *different*
    // number.
    const sameNumber = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000008",
      replaceConfirmed: true,
    });
    expect(sameNumber.ok).toBe(false);
    if (!sameNumber.ok) expect(sameNumber.error).toBe("already_enrolled");
  });
});

// ---------------------------------------------------------------------------
// GAP 3 — concurrent last-factor removal is serialised
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 3 — two concurrent removals cannot both see two factors", () => {
  it("lets exactly one of two parallel removals succeed on a two-factor account", async () => {
    const seeded = await seedBusiness("ConcurrentFactors");

    // Factor one: TOTP, confirmed immediately.
    const totp = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "totp",
    });
    expect(totp.ok).toBe(true);
    if (!totp.ok || !totp.totpSecret) throw new Error("totp enrolment failed");
    const totpConfirm = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "totp",
      code: await generateTotp({ secret: totp.totpSecret }),
    });
    expect(totpConfirm.outcome).toBe("totp");

    // Factor two: SMS, confirmed through its own ceremony.
    const smsEnrol = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "sms_otp",
      phone: "+989121000005",
      sendSmsChallenge: true,
    });
    expect(smsEnrol.ok).toBe(true);
    const smsConfirm = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: sms.sent[sms.sent.length - 1].code,
    });
    expect(smsConfirm.outcome).toBe("sms_otp");

    // Two removals, two different factors, one account — fired together.
    // Without the account lock each transaction sees two factors, each deletes
    // one, and the account ends factorless. With it, the second removal sees
    // the survivor and refuses to take the last one.
    const [first, second] = await Promise.all([
      mfaService.removeMfaFactorChecked({
        subjectRealm: "platform_user",
        subjectId: seeded.ownerPlatformUserId,
        method: "totp",
        allowRemoveLast: false,
      }),
      mfaService.removeMfaFactorChecked({
        subjectRealm: "platform_user",
        subjectId: seeded.ownerPlatformUserId,
        method: "sms_otp",
        allowRemoveLast: false,
      }),
    ]);

    const outcomes = [first.ok, second.ok].sort();
    expect(outcomes).toEqual([false, true]);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [seeded.ownerPlatformUserId],
    );
    expect(rows[0].count).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// GAP 4 — required access-change reasons
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 4 — sensitive access changes require a meaningful reason", () => {
  it("refuses blank and missing reasons on a membership access change, and persists a real one", async () => {
    const seeded = await seedBusiness("Reasons");
    const cashierId = await seedCashierWithPin(seeded, "1234");

    // The change: cashier → waiter. Same door model, different role — still an
    // access change, still needs a reason.
    const missing = dbLib.withTenant(seeded.businessId, () =>
      team.updateMembership({
        businessId: seeded.businessId,
        userId: cashierId,
        actorId: seeded.ownerId,
        role: "waiter",
      }),
    );
    await expect(missing).rejects.toThrow("reason_required");

    const blank = dbLib.withTenant(seeded.businessId, () =>
      team.updateMembership({
        businessId: seeded.businessId,
        userId: cashierId,
        actorId: seeded.ownerId,
        role: "waiter",
        reason: "        ",
      }),
    );
    await expect(blank).rejects.toThrow("reason_required");

    const short = dbLib.withTenant(seeded.businessId, () =>
      team.updateMembership({
        businessId: seeded.businessId,
        userId: cashierId,
        actorId: seeded.ownerId,
        role: "waiter",
        reason: "چرا؟",
      }),
    );
    await expect(short).rejects.toThrow("reason_too_short");

    // Nothing was written by the refusals.
    const refusals = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action LIKE 'team.%'`,
    );
    expect(refusals.rows[0].count).toBe("0");

    await dbLib.withTenant(seeded.businessId, () =>
      team.updateMembership({
        businessId: seeded.businessId,
        userId: cashierId,
        actorId: seeded.ownerId,
        role: "waiter",
        reason: "  جابه‌جایی به شیفت   شب طبق برنامهٔ جدید  ",
      }),
    );

    // The role changed...
    const member = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [cashierId]);
    expect(member.rows[0].role).toBe("waiter");

    // ...and the audit row carries the normalised reason with the actor.
    const audit = await db.query<{ payload: string; user_id: string }>(
      `SELECT payload::text AS payload, user_id::text AS user_id FROM audit_log WHERE action = 'team.member_updated'`,
    );
    expect(audit.rows).toHaveLength(1);
    const payload = JSON.parse(audit.rows[0].payload) as Record<string, unknown>;
    expect(payload.reason).toBe("جابه‌جایی به شیفت شب طبق برنامهٔ جدید");
    expect(payload).toHaveProperty("accessChange");
    expect(audit.rows[0].user_id).toBe(seeded.ownerId);

    // ...and the IAM event does too.
    const events = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM iam_events WHERE event_type = 'membership.system_role_changed'`,
    );
    expect(events.rows).toHaveLength(1);
    expect((JSON.parse(events.rows[0].payload) as Record<string, unknown>).reason).toBe(
      "جابه‌جایی به شیفت شب طبق برنامهٔ جدید",
    );
  });

  it("does not demand prose for edits that change no access", async () => {
    const seeded = await seedBusiness("SilentEdits");
    const cashierId = await seedCashierWithPin(seeded, "2345");

    // A rename is an administrative edit — no reason required.
    await dbLib.withTenant(seeded.businessId, () =>
      team.updateMembership({
        businessId: seeded.businessId,
        userId: cashierId,
        actorId: seeded.ownerId,
        fullName: "Renamed Cashier",
      }),
    );
    const member = await db.query<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [
      cashierId,
    ]);
    expect(member.rows[0].full_name).toBe("Renamed Cashier");
  });

  it("requires a reason when creating a member with extra access, and persists it on the event", async () => {
    const seeded = await seedBusiness("CreateReason");
    const roleId = await dbLib.withTenant(seeded.businessId, () =>
      rolesService.createTenantRole({
        businessId: seeded.businessId,
        actorId: seeded.ownerId,
        name: `Auditor-${randomUUID().slice(0, 6)}`,
        permissions: ["reports.view"],
        defaultLocationScope: "all",
        reason: "نقش حسابرس برای داشبورد مالی ساخته شد",
      }),
    );

    const email = `hire-${randomUUID().slice(0, 8)}@example.com`;
    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        team.createMembership({
          businessId: seeded.businessId,
          role: "accountant",
          fullName: "New Accountant",
          email,
          password: "starting-password-1",
          customRoleId: roleId,
          actorId: seeded.ownerId,
        }),
      ),
    ).rejects.toThrow("reason_required");

    const created = await dbLib.withTenant(seeded.businessId, () =>
      team.createMembership({
        businessId: seeded.businessId,
        role: "accountant",
        fullName: "New Accountant",
        email,
        password: "starting-password-1",
        customRoleId: roleId,
        reason: "استخدام حسابدار جدید برای شعبهٔ اصلی",
        actorId: seeded.ownerId,
      }),
    );

    const member = await db.query<{ custom_role_id: string | null }>(
      `SELECT custom_role_id FROM users WHERE id = $1`,
      [created.userId],
    );
    expect(member.rows[0].custom_role_id).toBe(roleId);

    const events = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM iam_events WHERE event_type = 'membership.created' AND entity_id = $1`,
      [created.userId],
    );
    const payload = JSON.parse(events.rows[0].payload) as {
      reason?: string | null;
      membership?: { customRoleId?: string | null };
    };
    expect(payload.reason).toBe("استخدام حسابدار جدید برای شعبهٔ اصلی");
    // GAP 6 lives in the same payload: the event says what the row stores.
    expect(payload.membership?.customRoleId).toBe(roleId);
  });

  it("requires reasons for custom-role writes and accepts a description-only edit without one", async () => {
    const seeded = await seedBusiness("RoleReasons");

    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        rolesService.createTenantRole({
          businessId: seeded.businessId,
          actorId: seeded.ownerId,
          name: `NoReason-${randomUUID().slice(0, 6)}`,
          permissions: [],
        }),
      ),
    ).rejects.toThrow("reason_required");

    const roleId = await dbLib.withTenant(seeded.businessId, () =>
      rolesService.createTenantRole({
        businessId: seeded.businessId,
        actorId: seeded.ownerId,
        name: `Shift-${randomUUID().slice(0, 6)}`,
        permissions: ["reports.view"],
        reason: "نقش جدید برای سرپرست شیفت‌ها تعریف شد",
      }),
    );

    // Permission change without a reason: refused.
    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        rolesService.updateTenantRole({
          businessId: seeded.businessId,
          actorId: seeded.ownerId,
          roleId,
          expectedRevision: 1,
          permissions: ["reports.view", "team.view"],
        }),
      ),
    ).rejects.toThrow("reason_required");

    // Description-only edit: no prose demanded.
    const revision = await dbLib.withTenant(seeded.businessId, () =>
      rolesService.updateTenantRole({
        businessId: seeded.businessId,
        actorId: seeded.ownerId,
        roleId,
        expectedRevision: 1,
        description: "فقط توضیح اصلاح شد",
      }),
    );
    expect(revision).toBe(2);

    // Permission change with a reason: accepted and recorded.
    await dbLib.withTenant(seeded.businessId, () =>
      rolesService.updateTenantRole({
        businessId: seeded.businessId,
        actorId: seeded.ownerId,
        roleId,
        expectedRevision: 2,
        permissions: ["reports.view", "team.view"],
        reason: "سرپرست شیفت به گزارش تیم نیاز پیدا کرد",
      }),
    );
    const events = await db.query<{ payload: string; actor_user_id: string | null }>(
      `SELECT payload::text AS payload, actor_user_id::text AS actor_user_id FROM iam_events
        WHERE event_type = 'tenant_role.permissions_changed' AND entity_id = $1
        ORDER BY sequence DESC LIMIT 1`,
      [roleId],
    );
    const payload = JSON.parse(events.rows[0].payload) as Record<string, unknown>;
    expect(payload.reason).toBe("سرپرست شیفت به گزارش تیم نیاز پیدا کرد");
    expect(events.rows[0].actor_user_id).toBe(seeded.ownerId);

    // The audit row carries the actor inside its payload too.
    const audit = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_log
        WHERE action = 'team.custom_role_updated' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [roleId],
    );
    expect((JSON.parse(audit.rows[0].payload) as Record<string, unknown>).actorId).toBe(seeded.ownerId);
  });

  it("requires a reason on invitations that grant extra access and carries it to the acceptance audit", async () => {
    const seeded = await seedBusiness("InviteReason");
    const roleId = await dbLib.withTenant(seeded.businessId, () =>
      rolesService.createTenantRole({
        businessId: seeded.businessId,
        actorId: seeded.ownerId,
        name: `Supervisor-${randomUUID().slice(0, 6)}`,
        permissions: ["team.view"],
        defaultLocationScope: "all",
        reason: "نقش سرپرست برای دعوت نیروی جدید ساخته شد",
      }),
    );

    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        team.createInvitation({
          businessId: seeded.businessId,
          email,
          role: "manager",
          fullName: "Invitee",
          customRoleId: roleId,
          actorId: seeded.ownerId,
        }),
      ),
    ).rejects.toThrow("reason_required");

    const { token } = await dbLib.withTenant(seeded.businessId, () =>
      team.createInvitation({
        businessId: seeded.businessId,
        email,
        role: "manager",
        fullName: "Invitee",
        customRoleId: roleId,
        reason: "دعوت سرپرست جدید برای شعبهٔ مرکزی",
        actorId: seeded.ownerId,
      }),
    );
    expect(token).toBeTruthy();

    // The stored invitation holds the validated reason...
    const invitation = await db.query<{ reason: string | null }>(
      `SELECT reason FROM invitations WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [seeded.businessId],
    );
    expect(invitation.rows[0].reason).toBe("دعوت سرپرست جدید برای شعبهٔ مرکزی");

    // ...and the acceptance audit inherits it.
    const accepted = await team.acceptInvitation(token, "invitee-password-1");
    expect(accepted.userId).toBeTruthy();
    const audit = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_log WHERE action = 'team.invitation_accepted'`,
    );
    const payload = JSON.parse(audit.rows[0].payload) as Record<string, unknown>;
    expect(payload.reason).toBe("دعوت سرپرست جدید برای شعبهٔ مرکزی");
  });
});

// ---------------------------------------------------------------------------
// GAP 6 — membership.created payload equals the persisted row
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 6 — membership.created describes the row that was written", () => {
  it("carries the custom role into a Hybrid site applying the event", async () => {
    const seeded = await seedBusiness("Fanout");
    const roleId = await dbLib.withTenant(seeded.businessId, () =>
      rolesService.createTenantRole({
        businessId: seeded.businessId,
        actorId: seeded.ownerId,
        name: `Replicated-${randomUUID().slice(0, 6)}`,
        permissions: ["reports.view"],
        defaultLocationScope: "all",
        reason: "نقش برای آزمایش همگام‌سازی ساخته شد",
      }),
    );

    const email = `replicated-${randomUUID().slice(0, 8)}@example.com`;
    const created = await dbLib.withTenant(seeded.businessId, () =>
      team.createMembership({
        businessId: seeded.businessId,
        role: "accountant",
        fullName: "Replicated Member",
        email,
        password: "starting-password-2",
        customRoleId: roleId,
        reason: "عضو جدید با نقش سفارشی برای همگام‌سازی",
        actorId: seeded.ownerId,
      }),
    );

    // Event payload equals the persisted state.
    const row = await db.query<{ custom_role_id: string | null; role: string }>(
      `SELECT custom_role_id, role::text AS role FROM users WHERE id = $1`,
      [created.userId],
    );
    const events = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM iam_events
        WHERE event_type = 'membership.created' AND entity_id = $1`,
      [created.userId],
    );
    const payload = JSON.parse(events.rows[0].payload) as {
      membership: { customRoleId: string | null; role: string; id: string };
    };
    expect(payload.membership.customRoleId).toBe(row.rows[0].custom_role_id);
    expect(payload.membership.customRoleId).toBe(roleId);
    expect(payload.membership.role).toBe(row.rows[0].role);

    /**
     * The replication consumer applies exactly that. A paired site is another
     * install, so the site gets its own row ids for the same logical role and
     * membership — the way replication materialises them — and the assertion
     * is that the membership lands wearing the custom role the event names.
     * Before the fix the payload hard-coded `customRoleId: null`, and this
     * insert would have produced a bare-preset member on the site.
     */
    const site = await seedBusiness("Site");
    const siteRoleId = randomUUID();
    const siteMembershipId = randomUUID();

    const roleEvent = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM iam_events
        WHERE event_type = 'tenant_role.created' AND entity_id = $1`,
      [roleId],
    );
    const rolePayload = JSON.parse(roleEvent.rows[0].payload) as {
      role: Record<string, unknown>;
    };

    const eventsToApply: import("../src/lib/iam/model").IamEvent[] = [
      {
        id: randomUUID(),
        businessId: site.businessId,
        sequence: 1,
        eventType: "tenant_role.created",
        entityType: "tenant_role",
        entityId: siteRoleId,
        schemaVersion: 1,
        payload: { ...rolePayload, role: { ...rolePayload.role, id: siteRoleId } },
        actorUserId: null,
        origin: "cloud",
        createdAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        businessId: site.businessId,
        sequence: 2,
        eventType: "membership.created",
        entityType: "membership",
        entityId: siteMembershipId,
        schemaVersion: 1,
        payload: {
          ...(JSON.parse(events.rows[0].payload) as Record<string, unknown>),
          membership: {
            ...payload.membership,
            id: siteMembershipId,
            businessId: site.businessId,
            customRoleId: siteRoleId,
          },
        },
        actorUserId: null,
        origin: "cloud",
        createdAt: new Date().toISOString(),
      },
    ];
    await dbLib.withTenant(site.businessId, () =>
      iamSync.applyIamEvents(site.businessId, randomUUID(), 0, eventsToApply),
    );

    const replica = await db.query<{ custom_role_id: string | null; role: string }>(
      `SELECT custom_role_id, role::text AS role FROM users WHERE id = $1`,
      [siteMembershipId],
    );
    expect(replica.rows).toHaveLength(1);
    expect(replica.rows[0].custom_role_id).toBe(siteRoleId);
    expect(replica.rows[0].role).toBe("accountant");
  });
});

// ---------------------------------------------------------------------------
// GAP 7 — one locking protocol for every door-changing transaction
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 7 — door changes serialise on one membership lock", () => {
  it("makes a role transition wait for whoever holds the membership lock", async () => {
    const seeded = await seedBusiness("Locked");
    const cashierId = await seedCashierWithPin(seeded, "3456");

    // Hold the lock the way another door-changing transaction would.
    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    await holder.query("BEGIN");
    await membershipLock.lockMembership(holder, seeded.businessId, cashierId);

    // The transition must block on it — measured, not assumed: it cannot
    // finish while the lock is held, and finishes once it is released.
    const transition = dbLib
      .withTenant(seeded.businessId, () =>
        team.updateMembership({
          businessId: seeded.businessId,
          userId: cashierId,
          actorId: seeded.ownerId,
          role: "waiter",
          reason: "تست قفل: انتقال نقش در صف انتظار",
        }),
      )
      .then(() => "resolved");
    const raced = await Promise.race([
      transition,
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 700)),
    ]);
    expect(raced).toBe("waiting");

    await holder.query("COMMIT");
    await holder.end();
    await expect(transition).resolves.toBe("resolved");

    const member = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [cashierId]);
    expect(member.rows[0].role).toBe("waiter");
  });

  it("makes a PIN write wait for the same lock", async () => {
    const seeded = await seedBusiness("PinLocked");
    const cashierId = await seedCashierWithPin(seeded, "4567");

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    await holder.query("BEGIN");
    await membershipLock.lockMembership(holder, seeded.businessId, cashierId);

    const pinWrite = dbLib
      .withTenant(seeded.businessId, () => team.setPin(seeded.businessId, cashierId, "5678", seeded.ownerId))
      .then(() => "resolved");
    const raced = await Promise.race([
      pinWrite,
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 700)),
    ]);
    expect(raced).toBe("waiting");

    await holder.query("COMMIT");
    await holder.end();
    await expect(pinWrite).resolves.toBe("resolved");
  });

  it("makes cloud PIN replication wait for the same lock", async () => {
    const seeded = await seedBusiness("ReplicationLocked");
    const cashierId = await seedCashierWithPin(seeded, "6789");

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    await holder.query("BEGIN");
    await membershipLock.lockMembership(holder, seeded.businessId, cashierId);

    // Authoritative replication that removes the PIN — the exact write the
    // login-path invariant must not interleave with.
    const replication = dbLib
      .withTenant(seeded.businessId, () =>
        loginCredentials.applyReplicatedPins(seeded.businessId, [], {
          staffPinMemberships: [cashierId],
          staffPinsAuthoritative: true,
        }),
      )
      .then(() => "resolved");
    const raced = await Promise.race([
      replication,
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 700)),
    ]);
    expect(raced).toBe("waiting");

    await holder.query("COMMIT");
    await holder.end();
    await expect(replication).resolves.toBe("resolved");
  });

  it("rolls a failed transition back without touching credentials or audit", async () => {
    const seeded = await seedBusiness("Rollback");
    // A manager with no PIN: moving them to a PIN role must fail the
    // login-path invariant.
    const manager = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name) VALUES ($1, 'manager', 'Manager') RETURNING id`,
      [seeded.businessId],
    );
    const managerId = manager.rows[0].id;

    const beforeAudit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log`,
    );
    const beforeEvents = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM iam_events`,
    );

    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        team.updateMembership({
          businessId: seeded.businessId,
          userId: managerId,
          actorId: seeded.ownerId,
          role: "cashier",
          reason: "تلاش برای انتقال بدون درب ورود",
        }),
      ),
    ).rejects.toThrow();

    const after = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [managerId]);
    expect(after.rows[0].role).toBe("manager");

    const afterAudit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log`,
    );
    const afterEvents = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM iam_events`,
    );
    expect(afterAudit.rows[0].count).toBe(beforeAudit.rows[0].count);
    expect(afterEvents.rows[0].count).toBe(beforeEvents.rows[0].count);
  });
});

// ---------------------------------------------------------------------------
// GAP 8 — deferred phone verification commits only on full success
// ---------------------------------------------------------------------------

describe("Issue #854 GAP 8 — the phone-OTP door commits its stamps only after MFA", () => {
  async function seedMfaReadyOwner(phone: string): Promise<Seed & { totpSecret: string }> {
    const seeded = await seedBusiness("Deferred", { ownerPhone: phone });

    // MFA required for managers → owner is in scope via the privileged baseline.
    await dbLib.withTenant(seeded.businessId, () =>
      mfaPolicy.setMfaPolicy(seeded.businessId, { requireForManagers: true, requireForAccountants: true }),
    );

    // A confirmed TOTP factor — the distinct second factor the door will ask for.
    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "totp",
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok || !enrolled.totpSecret) throw new Error("totp enrolment failed");
    const confirm = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "totp",
      code: await generateTotp({ secret: enrolled.totpSecret }),
    });
    expect(confirm.outcome).toBe("totp");

    return { ...seeded, totpSecret: enrolled.totpSecret };
  }

  async function startPhoneLogin(seeded: Seed & { totpSecret: string }, phone: string) {
    const requested = await phoneOtpRequest.POST(
      new NextRequest("http://localhost/api/auth/phone-otp/request", {
        method: "POST",
        body: JSON.stringify({ phone, businessId: seeded.businessId }),
        headers: { "content-type": "application/json" },
      }),
    );
    const requestText = await requested.text();
    expect(requested.status, requestText).toBe(200);
    const requestJson = JSON.parse(requestText) as { pendingToken?: string; token?: string };
    expect(requestJson.pendingToken ?? requestJson.token).toBeTruthy();
    requestJson.pendingToken = requestJson.pendingToken ?? requestJson.token;

    const code = sms.sent[sms.sent.length - 1].code;
    const verified = await phoneOtpVerify.POST(
      new NextRequest("http://localhost/api/auth/phone-otp/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${requestJson.pendingToken}`,
        },
      }),
    );
    const verifyJson = (await verified.json()) as {
      mfaRequired?: boolean;
      mfaToken?: string;
      primaryAuth?: string;
    };
    return { verified, verifyJson };
  }

  it("commits the stamps and the phone provenance after the MFA route finishes", async () => {
    const phone = "+989122000001";
    const seeded = await seedMfaReadyOwner(phone);

    const { verifyJson } = await startPhoneLogin(seeded, phone);
    expect(verifyJson.mfaRequired).toBe(true);
    expect(verifyJson.primaryAuth).toBe("phone_otp");
    expect(verifyJson.mfaToken).toBeTruthy();

    // Deferred: the OTP passed, but the ceremony is not over — no stamps yet.
    let stamps = await db.query<{ phone_verified_at: Date | null; otp_login_at: Date | null }>(
      `SELECT phone_verified_at, otp_login_at FROM users WHERE id = $1`,
      [seeded.ownerId],
    );
    expect(stamps.rows[0].otp_login_at).toBeNull();

    const completed = await mfaVerifyRoute.POST(
      new NextRequest("http://localhost/api/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code: await generateTotp({ secret: seeded.totpSecret }), method: "totp" }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${verifyJson.mfaToken}`,
        },
      }),
    );
    expect(completed.status).toBe(200);
    const session = completed.cookies.get("pos_session")?.value;
    expect(session).toBeTruthy();

    // Committed now — and the PIN window (`otp_login_at`) opens only because
    // the *whole* ceremony succeeded.
    stamps = await db.query<{ phone_verified_at: Date | null; otp_login_at: Date | null }>(
      `SELECT phone_verified_at, otp_login_at FROM users WHERE id = $1`,
      [seeded.ownerId],
    );
    expect(stamps.rows[0].phone_verified_at).not.toBeNull();
    expect(stamps.rows[0].otp_login_at).not.toBeNull();

    // The session keeps the true provenance of the door that opened it.
    const sessions = await db.query<{ login_method: string | null; revoked_at: Date | null }>(
      `SELECT login_method, revoked_at FROM employee_sessions WHERE employee_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [seeded.ownerId],
    );
    expect(sessions.rows[0].login_method).toBe("phone_otp");
    expect(sessions.rows[0].revoked_at).toBeNull();
  });

  it("leaves no verification or PIN window when the ceremony is abandoned", async () => {
    const phone = "+989122000002";
    const seeded = await seedMfaReadyOwner(phone);

    const { verifyJson } = await startPhoneLogin(seeded, phone);
    expect(verifyJson.mfaRequired).toBe(true);

    // The member walks away from the TOTP step. Nothing may be stamped — the
    // pending token simply expires with the ceremony unfinished.
    const stamps = await db.query<{ phone_verified_at: Date | null; otp_login_at: Date | null }>(
      `SELECT phone_verified_at, otp_login_at FROM users WHERE id = $1`,
      [seeded.ownerId],
    );
    // otp_login_at is the dangerous one: it opens the PIN-without-OTP window.
    expect(stamps.rows[0].otp_login_at).toBeNull();

    const sessions = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM employee_sessions WHERE employee_id = $1`,
      [seeded.ownerId],
    );
    expect(sessions.rows[0].count).toBe("0");
  });
});
