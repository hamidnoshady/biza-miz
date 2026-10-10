/**
 * Issue #854 — the hardening pass, against a real database.
 *
 * One file for the findings whose *fix* is a data-flow guarantee rather than a
 * pure rule, because those are the ones a unit test cannot honestly prove:
 *
 *   - **P0.3** the tenant administrator who triggers a member's password reset
 *     must not receive the credential that completes it — the link goes to the
 *     holder's *verified* phone and nowhere else, and the recovery is refused
 *     outright when there is no verified number to send it to;
 *   - **P0.5** branch ids on an invitation are tenant-validated at creation
 *     *and* re-validated at acceptance;
 *   - **P0.9** the last second factor may not be removed by standing in the one
 *     business whose policy does not require it, when another membership does;
 *   - **P1.7** a self-service PIN rotation needs the current PIN; an
 *     administrator reset does not;
 *   - **P1.13** a Hybrid site cannot originate a membership or an invitation;
 *   - **P2.13** PIN uniqueness is a database constraint, not a bcrypt scan.
 */
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { generate as generateTotp } from "otplib";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/**
 * The SMS transport, recorded rather than rung. The P0.3 guarantee is about
 * *where a credential goes*, so the test has to be able to see the sent message
 * — that is what makes the negative assertion (the caller's return value has no
 * token) mean something.
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

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let team: typeof import("../src/lib/team-service");
let mfaService: typeof import("../src/lib/mfa-service");
let passwordReset: typeof import("../src/lib/password-reset");
let deployment: typeof import("../src/lib/deployment-mode");
let settings: typeof import("../src/lib/settings");
let mfaPolicy: typeof import("../src/lib/mfa-policy");
let mfaEnrol: typeof import("../src/lib/mfa-enrol");
let mfaVerify: typeof import("../src/lib/mfa-verify");
let otpChallenge: typeof import("../src/lib/otp-challenge");

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
  databaseName = `pos_auth_hardening_${randomUUID().replaceAll("-", "")}`;
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
  passwordReset = await import("../src/lib/password-reset");
  deployment = await import("../src/lib/deployment-mode");
  settings = await import("../src/lib/settings");
  mfaPolicy = await import("../src/lib/mfa-policy");
  mfaEnrol = await import("../src/lib/mfa-enrol");
  mfaVerify = await import("../src/lib/mfa-verify");
  otpChallenge = await import("../src/lib/otp-challenge");

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
  // Challenges are minted pre-auth and carry no tenant column, so they are
  // cleared per test rather than per business.
  await db.query("DELETE FROM mfa_challenges");
  await db.query("DELETE FROM mfa_enrolments");
  await db.query("DELETE FROM employee_credentials");
  await db.query("DELETE FROM invitations");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
});

interface Seed {
  businessId: string;
  businessSlug: string;
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
    businessSlug: slug,
    locationId: location.rows[0].id,
    ownerId: owner.rows[0].id,
    ownerPlatformUserId: identity.rows[0].id,
    ownerEmail,
    ownerPassword,
  };
}

describe("Issue #854 — P0.3 no tenant administrator ever receives a usable reset credential", () => {
  it("sends the link to the holder's verified phone and returns only a masked target", async () => {
    const seeded = await seedBusiness("Alpha", { ownerPhone: "+989121110001" });

    const issued = await dbLib.withTenant(seeded.businessId, () =>
      team.requestMemberPasswordReset(seeded.businessId, seeded.ownerId, seeded.ownerId, {
        origin: "https://app.example.com",
      }),
    );

    // Nothing spendable in the response — no token, no URL, no code.
    expect(issued).not.toHaveProperty("token");
    expect(issued).not.toHaveProperty("url");
    expect(issued.deliveredTo).toBe("+989***0001");
    expect(issued.channel).toBe("sms");

    // The link went to the holder, and it is a real reset token.
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].phone).toBe("+989121110001");
    const token = decodeURIComponent(
      sms.sent[0].code.slice(sms.sent[0].code.indexOf("token=") + "token=".length),
    );
    const preview = await passwordReset.previewPasswordResetToken(token);
    expect(preview).toMatchObject({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      status: "pending",
    });

    // The tenant administrator's copy of the row records only the masked target.
    const { rows } = await db.query<{ delivery_target_masked: string | null; delivery_channel: string | null }>(
      `SELECT delivery_target_masked, delivery_channel FROM auth_password_resets`,
    );
    expect(rows[0].delivery_channel).toBe("sms");
    expect(rows[0].delivery_target_masked).toBe("+989***0001");
  });

  it("refuses the recovery outright when the identity has no verified number anywhere", async () => {
    const seeded = await seedBusiness("Unverified", { ownerPhone: null });

    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        team.requestMemberPasswordReset(seeded.businessId, seeded.ownerId, seeded.ownerId, {
          origin: "https://app.example.com",
        }),
      ),
    ).rejects.toThrow("no_verified_channel");

    // And no token was minted in the attempt, so nothing can be retried later.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_password_resets`,
    );
    expect(rows[0].count).toBe("0");
    expect(sms.sent).toHaveLength(0);
  });

  it("accepts a verified number held on one of the identity's other memberships", async () => {
    /**
     * The person may be a cashier here and the accountant there. The channel
     * belongs to the *identity*, so it is searched across active memberships —
     * still only ever a number whose possession was proven.
     */
    const alpha = await seedBusiness("Alpha", { ownerPhone: null });
    const beta = await seedBusiness("Beta", { ownerPhone: null });

    await db.query(
      `INSERT INTO users (business_id, platform_user_id, role, full_name, email, phone_e164, phone_verified_at)
       VALUES ($1, $2, 'accountant', 'Owner', $3, '+989121110002', now())`,
      [beta.businessId, alpha.ownerPlatformUserId, alpha.ownerEmail],
    );

    const issued = await dbLib.withTenant(alpha.businessId, () =>
      team.requestMemberPasswordReset(alpha.businessId, alpha.ownerId, alpha.ownerId, {
        origin: "https://app.example.com",
      }),
    );
    expect(issued.deliveredTo).toBe("+989***0002");
    expect(sms.sent[0].phone).toBe("+989121110002");
  });
});

describe("Issue #854 — P0.5 invitation branches belong to the inviting business", () => {
  it("refuses a foreign branch at creation", async () => {
    const alpha = await seedBusiness("Alpha");
    const beta = await seedBusiness("Beta");

    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        team.createInvitation({
          businessId: alpha.businessId,
          email: `newcomer-${randomUUID().slice(0, 8)}@example.com`,
          role: "manager",
          fullName: "Newcomer",
          locationIds: [beta.locationId],
          locationScope: "selected",
          actorId: alpha.ownerId,
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
        }),
      ),
    ).rejects.toThrow("unknown_location");
  });

  it("refuses an invitation row that names a foreign branch, at acceptance", async () => {
    /**
     * Defence in depth: the row can be written by more than one path over the
     * life of the schema (a pairing apply, a restore, an older release), so the
     * check runs again on the way out, under the privileged acceptance window.
     */
    const alpha = await seedBusiness("Alpha");
    const beta = await seedBusiness("Beta");
    const token = `legacy-${randomUUID()}`;
    const email = `legacy-${randomUUID().slice(0, 8)}@example.com`;

    await db.query(
      `INSERT INTO invitations
         (business_id, email, role, full_name, token_hash, expires_at, location_ids, location_scope)
       VALUES ($1, $2, 'manager', 'Legacy', $3, now() + interval '1 day', ARRAY[$4]::uuid[], 'selected')`,
      [
        alpha.businessId,
        email,
        createHash("sha256").update(token).digest("hex"),
        beta.locationId,
      ],
    );

    await expect(team.acceptInvitation(token, "new-pass-854")).rejects.toThrow(
      "unknown_location",
    );
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE email = $1`,
      [email],
    );
    expect(rows[0].count).toBe("0");
  });
});

describe("Issue #854 — P0.9 the last factor is a global question", () => {
  it("refuses removal from a business that does not require it, when another membership does", async () => {
    const alpha = await seedBusiness("Alpha"); // owner here ⇒ MFA mandatory
    const beta = await seedBusiness("Beta"); // accountant here ⇒ policy-dependent

    await db.query(
      `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
       VALUES ($1, $2, 'accountant', 'Owner', $3)`,
      [beta.businessId, alpha.ownerPlatformUserId, alpha.ownerEmail],
    );
    await db.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, confirmed_at, is_primary)
       VALUES ('platform_user', $1, 'totp', now(), true)`,
      [alpha.ownerPlatformUserId],
    );

    const requirement = await mfaService.globalMfaRequirementForPlatformUser(
      alpha.ownerPlatformUserId,
    );
    expect(requirement.required).toBe(true);
    expect(requirement.bindingMembershipId).toBe(alpha.ownerId);
    expect(requirement.reason).toContain("Alpha");

    const removal = await mfaService.mayRemoveGlobalMfaFactor(alpha.ownerPlatformUserId, {
      isLastConfirmedFactor: true,
    });
    expect(removal.allowed).toBe(false);

    // A *secondary* factor is still removable: only the last one is protected.
    const secondary = await mfaService.mayRemoveGlobalMfaFactor(alpha.ownerPlatformUserId, {
      isLastConfirmedFactor: false,
    });
    expect(secondary.allowed).toBe(true);
  });

  it("allows removal once no active membership requires it", async () => {
    const alpha = await seedBusiness("Alpha");
    await db.query(
      `UPDATE users SET role = 'accountant' WHERE id = $1`,
      [alpha.ownerId],
    );
    await db.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, confirmed_at, is_primary)
       VALUES ('platform_user', $1, 'totp', now(), true)`,
      [alpha.ownerPlatformUserId],
    );

    const removal = await mfaService.mayRemoveGlobalMfaFactor(alpha.ownerPlatformUserId, {
      isLastConfirmedFactor: true,
    });
    expect(removal.allowed).toBe(true);
  });
});

describe("Issue #854 — P1.7 self-service PIN rotation needs the current PIN", () => {
  it("refuses a self-service rotation without proof and accepts an admin reset", async () => {
    const seeded = await seedBusiness("Alpha");
    await dbLib.withTenant(seeded.businessId, () =>
      team.setPin(seeded.businessId, seeded.ownerId, "4821", seeded.ownerId),
    );

    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        team.setPin(seeded.businessId, seeded.ownerId, "9153", seeded.ownerId, {
          selfService: true,
          currentPinVerified: false,
        }),
      ),
    ).rejects.toThrow("current_pin_required");

    // The credential is untouched by the refusal.
    const { rows } = await db.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM employee_credentials
        WHERE employee_id = $1 AND credential_type = 'pin' AND status = 'active'`,
      [seeded.ownerId],
    );
    expect(await bcrypt.compare("4821", rows[0].secret_hash)).toBe(true);

    // An administrator reset is the path for a forgotten PIN: no proof needed.
    await dbLib.withTenant(seeded.businessId, () =>
      team.setPin(seeded.businessId, seeded.ownerId, "7734", seeded.ownerId),
    );
    const after = await db.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM employee_credentials
        WHERE employee_id = $1 AND credential_type = 'pin' AND status = 'active'`,
      [seeded.ownerId],
    );
    expect(await bcrypt.compare("7734", after.rows[0].secret_hash)).toBe(true);
  });
});

describe("Issue #854 — P2.13 PIN uniqueness is a constraint, and it is per business", () => {
  it("refuses a duplicate PIN inside one business and allows the same digits in another", async () => {
    const alpha = await seedBusiness("Alpha");
    const beta = await seedBusiness("Beta");

    const cashierA = await dbLib.withTenant(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Cashier A",
        pin: "2468",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    expect(cashierA.userId).toBeTruthy();

    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        team.createMembership({
          businessId: alpha.businessId,
          role: "waiter",
          fullName: "Waiter A",
          pin: "2468",
          defaultLocationId: alpha.locationId,
          actorId: alpha.ownerId,
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
        }),
      ),
    ).rejects.toThrow("pin_taken");

    // Same digits in the other business are fine: the index is (business, pin).
    const waiterB = await dbLib.withTenant(beta.businessId, () =>
      team.createMembership({
        businessId: beta.businessId,
        role: "waiter",
        fullName: "Waiter B",
        pin: "2468",
        defaultLocationId: beta.locationId,
        actorId: beta.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    expect(waiterB.userId).toBeTruthy();
  });
});

describe("Issue #854 — P1.13 a Hybrid site does not originate memberships", () => {
  it("refuses an invitation from a Hybrid deployment and states which side owns it", async () => {
    const seeded = await seedBusiness("Paired");
    await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query(
        `INSERT INTO settings (business_id, location_id, key, value)
         VALUES ($1, NULL, $2, $3)
         ON CONFLICT (business_id, location_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [
          seeded.businessId,
          settings.SETTING_KEYS.deploymentProfile,
          /**
           * `resolveDeploymentProfile` reads a *record*, not a bare string:
           * `{ profile, pairedAt }`. Writing the string made the resolver fall
           * through to its inferred value, which is how this assertion caught
           * the difference.
           */
          JSON.stringify({ profile: "hybrid", pairedAt: new Date().toISOString() }),
        ],
      ),
    );
    expect((await deployment.readDeploymentProfile(seeded.businessId)).profile).toBe("hybrid");

    await expect(
      dbLib.withTenant(seeded.businessId, () =>
        team.createInvitation({
          businessId: seeded.businessId,
          email: `hybrid-${randomUUID().slice(0, 8)}@example.com`,
          role: "manager",
          fullName: "Invited",
          actorId: seeded.ownerId,
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
        }),
      ),
    ).rejects.toThrow("cloud_confirmation_required");
  });
});

describe("Issue #854 — P1.1 / P2.11 / P2.12: what the admin screens write", () => {
  it("keeps both MFA policy knobs independent", async () => {
    /**
     * The trap the policy card had to stop falling into: the route normalises a
     * partial body, so a `PUT` naming only `requireForManagers` stores
     * `requireForAccountants: false`. The screen now sends both; this pins the
     * storage half — each knob survives the other's write.
     */
    const seeded = await seedBusiness("Policy");

    await dbLib.withTenant(seeded.businessId, () =>
      mfaPolicy.setMfaPolicy(seeded.businessId, {
        requireForManagers: true,
        requireForAccountants: true,
      }),
    );
    let policy = await dbLib.withTenant(seeded.businessId, () =>
      mfaPolicy.getMfaPolicy(seeded.businessId),
    );
    expect(policy).toEqual({ requireForManagers: true, requireForAccountants: true });

    // Turning managers off leaves the accountant requirement standing.
    await dbLib.withTenant(seeded.businessId, () =>
      mfaPolicy.setMfaPolicy(seeded.businessId, {
        requireForManagers: false,
        requireForAccountants: true,
      }),
    );
    policy = await dbLib.withTenant(seeded.businessId, () =>
      mfaPolicy.getMfaPolicy(seeded.businessId),
    );
    expect(policy).toEqual({ requireForManagers: false, requireForAccountants: true });
  });

  it("stores an invitation's branch policy and custom role, and lists them back", async () => {
    const seeded = await seedBusiness("Scoped");
    const second = await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query<{ id: string }>(
        "INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id",
        [seeded.businessId],
      ),
    );
    const branchId = second.rows[0].id;

    const role = await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query<{ id: string }>(
        `INSERT INTO tenant_roles (business_id, name, permissions)
         VALUES ($1, 'Scoped role', $2) RETURNING id`,
        [seeded.businessId, JSON.stringify(["orders.view"])],
      ),
    );
    const customRoleId = role.rows[0].id;

    await dbLib.withTenant(seeded.businessId, () =>
      team.createInvitation({
        businessId: seeded.businessId,
        email: `scoped-${randomUUID().slice(0, 8)}@example.com`,
        role: "manager",
        fullName: "Scoped invitee",
        locationScope: "selected",
        locationIds: [branchId],
        customRoleId,
        actorId: seeded.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    const [invitation] = await dbLib.withTenant(seeded.businessId, () =>
      team.listInvitations(seeded.businessId),
    );
    /**
     * P2.11/P2.12: what the invitation will grant is readable *before* it is
     * accepted. Without this the admin screen could only say "invited", and the
     * invitee's access was decided by defaults nobody had seen.
     */
    expect(invitation.locationScope).toBe("selected");
    /**
     * The first assigned branch becomes the invitation's default when the form
     * names none — `createInvitation` passes `locationIds[0]` rather than a
     * null, because a membership with branches but no home branch has no
     * default location to open. Asserting the *branch* (not just non-null) is
     * what makes this catch a scope that stops being stored with its ids.
     */
    expect(invitation.defaultLocationId).toBe(branchId);
    expect(invitation.customRoleId).toBe(customRoleId);
    expect(invitation.customRoleName).toBe("Scoped role");
  });
});

/**
 * Issue #854 (P1.11, invariant 4) — the two MFA ceremonies, and the fact that a
 * challenge is only good for the transaction it was minted for.
 *
 * Both halves of P1.11 were wrong in the same direction and cancelled each
 * other out, which is why neither was caught by a test:
 *
 *  - step-up accepted *any* live second-factor SMS challenge, including one the
 *    member had asked for in order to sign in, and
 *  - the login interstitial and the enrolment screen shared one verifier whose
 *    boolean flag decided whether a half-finished enrolment counted as a factor.
 *
 * The fix splits the ceremonies by name (`verifyExistingConfirmedMfaFactor` /
 * `verifyAndConfirmPendingMfaEnrolment`) and makes every caller state which
 * challenge purposes it will spend. These assertions run against the real
 * tables, because "which row may be spent" is a database question.
 */
describe("Issue #854 — P1.11 the two ceremonies stay separate", () => {
  it("refuses a pending TOTP enrolment at step-up, and lets the enrolment ceremony activate it", async () => {
    const seeded = await seedBusiness("Ceremony");
    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      email: seeded.ownerEmail,
      method: "totp",
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok || !enrolled.totpSecret) throw new Error("enrolment failed");
    const code = await generateTotp({ secret: enrolled.totpSecret });

    // Step-up (the strict path): the code is correct, but the factor is not a
    // factor yet. A pending enrolment must not become one as a side effect.
    const atStepUp = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "totp",
      code,
    });
    expect(atStepUp.outcome).toBe("rejected");

    const stillPending = await mfaService.getAccountMfaEnrolments(
      "platform_user",
      seeded.ownerPlatformUserId,
    );
    expect(stillPending[0].confirmed_at).toBeNull();

    // The enrolment ceremony: same code, same subject — and this one *is*
    // allowed to activate the row, which is the whole point of the screen.
    const atEnrolment = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "totp",
      code,
    });
    expect(atEnrolment.outcome).toBe("totp");
    expect(atEnrolment.wasUnconfirmed).toBe(true);

    const confirmed = await mfaService.getAccountMfaEnrolments(
      "platform_user",
      seeded.ownerPlatformUserId,
    );
    expect(confirmed[0].confirmed_at).not.toBeNull();

    // And now the strict path accepts the same factor.
    const afterConfirm = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "totp",
      code,
    });
    expect(afterConfirm.outcome).toBe("totp");
  });

  it("refuses an SMS challenge minted for login when the caller spends step-up purposes", async () => {
    const seeded = await seedBusiness("Purposes", { ownerPhone: "+989121234567" });
    const loginChallenge = await otpChallenge.issueOtpChallenge({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      purpose: "mfa_login",
      candidatePhoneE164: "+989121234567",
    });
    await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query(
        `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, phone_e164, is_primary, confirmed_at)
         VALUES ('platform_user', $1, 'sms_otp', '+989121234567', true, now())`,
        [seeded.ownerPlatformUserId],
      ),
    );

    // The step-up ceremony will not spend a login code...
    const atStepUp = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: loginChallenge.code,
      smsPurposes: ["step_up_sms"],
    });
    expect(atStepUp.outcome).toBe("rejected");

    // ...and the login ceremony will, which proves the refusal above is about
    // the purpose rather than about the code being unusable.
    const atLogin = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: loginChallenge.code,
      smsPurposes: ["mfa_login"],
    });
    expect(atLogin.outcome).toBe("sms_otp");
  });

  it("fails closed when a caller states no SMS purpose at all", async () => {
    const seeded = await seedBusiness("FailClosed", { ownerPhone: "+989121234568" });
    const challenge = await otpChallenge.issueOtpChallenge({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      purpose: "step_up_sms",
      candidatePhoneE164: "+989121234568",
    });
    await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query(
        `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, phone_e164, is_primary, confirmed_at)
         VALUES ('platform_user', $1, 'sms_otp', '+989121234568', true, now())`,
        [seeded.ownerPlatformUserId],
      ),
    );

    // A new call site that forgets `smsPurposes` gets nothing, rather than the
    // union of everything a second factor could be.
    const silent = await mfaVerify.verifyExistingConfirmedMfaFactor({
      subjectRealm: "platform_user",
      subjectId: seeded.ownerPlatformUserId,
      method: "sms_otp",
      code: challenge.code,
    });
    expect(silent.outcome).toBe("rejected");
  });
});

/**
 * Issue #854 (P0.4, ordering) — the membership is the last thing an invitation
 * acceptance writes, not the first.
 *
 * The ceremony is: invitation → primary authentication → required MFA → accept
 * membership → session. The old shape accepted first and evaluated MFA after, so
 * a member who abandoned the second factor kept a membership nobody had finished
 * accepting, and a first-time invitee ended up with an account whose password was
 * typed into a form that was never completed. Phase 1 now validates and
 * authenticates (creating the *identity*, since MFA enrolments hang off it), and
 * phase 2 writes the membership only once every factor is proven.
 */
describe("Issue #854 — P0.4 the acceptance ceremony, in order", () => {
  async function inviteeFixture(seeded: Seed, email: string) {
    const invitation = await dbLib.withTenant(seeded.businessId, () =>
      team.createInvitation({
        businessId: seeded.businessId,
        email,
        role: "manager",
        fullName: "Invited Person",
        actorId: seeded.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    return invitation;
  }

  /** The raw token is only in the sent link; the fixture reads it from the row. */
  async function invitationIdFor(email: string): Promise<string> {
    const { rows } = await db.query<{ id: string; token_hash: string }>(
      "SELECT id, token_hash FROM invitations WHERE email = $1",
      [email],
    );
    return rows[0].id;
  }

  it("writes no membership before the second factor is proven", async () => {
    const seeded = await seedBusiness("Ordered");
    const invitation = await inviteeFixture(seeded, "ordered@example.com");
    const invitationId = await invitationIdFor("ordered@example.com");

    const staged = await team.beginInvitationAcceptance(invitation.token, "invitee-password-854");

    // The identity exists — it is the subject the second factor is enrolled on.
    const identity = await db.query("SELECT 1 FROM platform_users WHERE email = 'ordered@example.com'");
    expect(identity.rowCount).toBe(1);

    // The membership does not, and the invitation is still pending.
    const members = await db.query(
      "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
      [seeded.businessId, staged.platformUserId],
    );
    expect(members.rowCount, "membership written before the factor was proven").toBe(0);
    const pending = await db.query<{ accepted_at: Date | null }>(
      "SELECT accepted_at FROM invitations WHERE id = $1",
      [invitationId],
    );
    expect(pending.rows[0].accepted_at).toBeNull();

    // Phase 2 lands it, and is idempotent for the same identity: a retry — or a
    // second in-flight verify — must not read as "already accepted" and fail.
    const completed = await team.completeInvitationAcceptance({
      invitationId,
      platformUserId: staged.platformUserId,
    });
    expect(completed.role).toBe("manager");
    const again = await team.completeInvitationAcceptance({
      invitationId,
      platformUserId: staged.platformUserId,
    });
    expect(again.userId).toBe(completed.userId);

    const membersAfter = await db.query(
      "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
      [seeded.businessId, staged.platformUserId],
    );
    expect(membersAfter.rowCount).toBe(1);
  });

  it("still refuses the password of an existing identity in phase 1", async () => {
    const seeded = await seedBusiness("Refuse");
    const email = `known-${randomUUID().slice(0, 8)}@example.com`;
    const identity = await db.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ($1, $2, 'Known') RETURNING id`,
      [email, await bcrypt.hash("their-real-password", 10)],
    );

    const invitation = await dbLib.withTenant(seeded.businessId, () =>
      team.createInvitation({
        businessId: seeded.businessId,
        email,
        role: "manager",
        fullName: "Known",
        actorId: seeded.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    await expect(team.beginInvitationAcceptance(invitation.token, null)).rejects.toMatchObject({
      message: "authentication_required",
    });
    await expect(
      team.beginInvitationAcceptance(invitation.token, "not-their-password"),
    ).rejects.toMatchObject({ message: "invalid_credentials" });

    // A matching password gets as far as the second factor, and only then is
    // the membership the invitee's.
    const staged = await team.beginInvitationAcceptance(invitation.token, "their-real-password");
    expect(staged.platformUserId).toBe(identity.rows[0].id);
    const before = await db.query("SELECT 1 FROM users WHERE business_id = $1", [seeded.businessId]);
    expect(before.rowCount).toBe(1); // the owner only
  });

  it("re-locks the invitation in phase 2, so one revoked mid-ceremony cannot land", async () => {
    const seeded = await seedBusiness("Revoked");
    const invitation = await inviteeFixture(seeded, "revoked@example.com");
    const invitationId = await invitationIdFor("revoked@example.com");

    const staged = await team.beginInvitationAcceptance(invitation.token, "invitee-password-854");
    await db.query("UPDATE invitations SET revoked_at = now() WHERE id = $1", [invitationId]);

    await expect(
      team.completeInvitationAcceptance({
        invitationId,
        platformUserId: staged.platformUserId,
      }),
    ).rejects.toMatchObject({ message: "invitation_revoked", status: 409 });
  });
});

/**
 * Issue #854 (P1.1) — the console's own MFA report reads the canonical key, and
 * it covers every role the policy can gate.
 *
 * Two defects met in `listMfaAccountStatus`. Its business-policy subquery spelled
 * the settings key `security.mfaPolicy`, which **nothing in the repository
 * writes** — so `requireForManagers` / `requireForAccountants` always read as
 * absent and only owner/admin rows could ever appear — and `admin` was missing
 * from the role list even though it is mandatory. A console that under-reports
 * who is protected is worse than no report: it is the screen an operator would
 * use to decide nothing needs doing.
 */
describe("Issue #854 — P1.1 the console MFA roster reads the real policy", () => {
  it("lists an admin, and an accountant only when the policy asks for one", async () => {
    const seeded = await seedBusiness("Roster");

    const adminIdentity = await db.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ('roster-admin@example.com', 'hash', 'Admin') RETURNING id`,
    );
    await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
         VALUES ($1, $2, 'admin', 'Admin', 'roster-admin@example.com')`,
        [seeded.businessId, adminIdentity.rows[0].id],
      ),
    );

    const accountantIdentity = await db.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ('roster-accountant@example.com', 'hash', 'Accountant') RETURNING id`,
    );
    await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
         VALUES ($1, $2, 'accountant', 'Accountant', 'roster-accountant@example.com')`,
        [seeded.businessId, accountantIdentity.rows[0].id],
      ),
    );

    const before = await mfaService.listMfaAccountStatus();
    const emailsOf = (rows: { email: string }[]) => rows.map((r) => r.email);
    expect(emailsOf(before)).toContain("roster-admin@example.com");
    // An accountant is optional: no setting, no row.
    expect(emailsOf(before)).not.toContain("roster-accountant@example.com");

    // Written under the *canonical* key, which is the whole point: the old
    // `security.mfaPolicy` spelling would leave this assertion failing.
    await dbLib.withTenant(seeded.businessId, () =>
      dbLib.query(
        `INSERT INTO settings (business_id, key, value)
         VALUES ($1, $2, $3::jsonb)`,
        [seeded.businessId, settings.SETTING_KEYS.mfaPolicy, JSON.stringify({ requireForAccountants: true })],
      ),
    );

    const after = await mfaService.listMfaAccountStatus();
    const accountant = after.find((r) => r.email === "roster-accountant@example.com");
    expect(accountant, "an accountant the policy gates must be in the roster").toBeTruthy();
    /**
     * Gated, not "not_required": an account with no factor that a policy now
     * covers sits in its grace window first (`requirement === "grace"`), and is
     * `"required"` once that window closes. Both mean the console must show it.
     */
    expect(accountant!.requirement).not.toBe("not_required");
    expect(accountant!.methods).toEqual([]);
  });
});
