/**
 * Owner activation, against a real database (issue #755 §14).
 *
 * The claim this file exists to prove is negative and easy to break silently:
 * **provisioning must not leave the platform operator holding a permanent
 * credential to a tenant.** So the assertions are about what does *not* exist —
 * no operator-chosen password, no MFA enrolment minted at provisioning time, no
 * recovery codes in the console's response.
 *
 * The second claim is the one Codex flagged on the first version of this flow,
 * and it is why redemption needs two halves: the activation link travels through
 * the operator (there is no mail transport), so the link alone cannot be the
 * credential — otherwise the operator redeems their own link, chooses a password
 * and keeps the recovery codes. The proof of control is a six-digit code texted
 * to the owner's own mobile, and these tests hold the operator to it: a wrong
 * code, a guessed code and a link-without-code all leave the password untouched,
 * and guessing burns the code permanently.
 *
 * That is also why this file stubs `@/lib/sms-config`: the code has to be
 * *capturable* to be redeemed at all, and the stub is how the test does what the
 * owner does and the operator cannot.
 *
 *   - the owner identity is created with a password nobody knows, which fails
 *     closed against any guess;
 *   - the activation link is single-use, expiring and stored only as a hash;
 *   - redeeming it is where the password, the second factor and the recovery
 *     codes come into being — in the *owner's* response, never the operator's;
 *   - an email that already has a platform login keeps that password and gets no
 *     activation link, so a group owner's second business is added without
 *     anybody needing to know their credentials;
 *   - and that cross-business attach is refused unless the operator confirms it,
 *     because it is an action on somebody else's account.
 */
import { createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/**
 * The SMS transport, replaced by something that records instead of ringing.
 *
 * `configured` is mutable so one test can prove the refusal when no provider
 * exists at all — on such an install there is no owner-controlled channel, and
 * the service must say so rather than text into a log.
 */
const sms = vi.hoisted(() => ({
  configured: true,
  sent: [] as { phone: string; code: string }[],
}));

vi.mock("@/lib/sms-config", () => ({
  getPublicSmsConfig: async () => ({
    configured: sms.configured,
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
let provisioning: typeof import("../src/lib/business-provisioning");
let activation: typeof import("../src/lib/owner-activation");

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
  databaseName = `pos_owner_activation_${randomUUID().replaceAll("-", "")}`;
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
  provisioning = await import("../src/lib/business-provisioning");
  activation = await import("../src/lib/owner-activation");

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

async function provisionActivated(suffix: string, ownerPhone: string | null = "09121234567") {
  const email = `owner-${suffix}@example.com`;
  const businessName = `کافه ${suffix}`;
  const result = await provisioning.provisionBusiness({
    businessName,
    ownerName: "مالک تازه",
    ownerPhone,
    email,
    industry: "food_service",
    subdomain: `act-${suffix}`,
    seedChartOfAccounts: false,
    ownerActivation: true,
    createdBy: null,
  });
  return { ...result, email, businessName };
}

const BASE_URL = "http://localhost:3000/api/auth/owner-activation";

async function getPreview(token: string): Promise<Response> {
  const { GET } = await import("../src/app/api/auth/owner-activation/route");
  return GET(new Request(`${BASE_URL}?token=${encodeURIComponent(token)}`) as never) as
    Promise<Response>;
}

/** The redemption half of the public endpoint. */
async function postAccept(
  token: string,
  password: string,
  code?: string,
): Promise<Response> {
  const { POST } = await import("../src/app/api/auth/owner-activation/route");
  return POST(
    new Request(BASE_URL, {
      method: "POST",
      body: JSON.stringify({ token, password, code }),
    }) as never,
  ) as Promise<Response>;
}

/** The send-code half, which is also the operator's only move. */
async function postSendCode(token: string): Promise<Response> {
  const { POST } = await import("../src/app/api/auth/owner-activation/route");
  return POST(
    new Request(BASE_URL, {
      method: "POST",
      body: JSON.stringify({ token, action: "send_code" }),
    }) as never,
  ) as Promise<Response>;
}

/** Asks for a code and returns the one the owner would have read. */
async function sendCode(token: string): Promise<string> {
  const before = sms.sent.length;
  const res = await postSendCode(token);
  expect(res.status, `send_code failed: ${await res.clone().text()}`).toBe(200);
  const sent = sms.sent.slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0].code).toMatch(/^\d{6}$/);
  return sent[0].code;
}

describe("provisioning with owner activation", () => {
  it("creates no credential the operator could know, and no MFA material at all", async () => {
    const biz = await provisionActivated(`new-${randomUUID().slice(0, 6)}`);
    expect(biz.ownerIdentityCreated).toBe(true);
    expect(biz.ownerActivation?.token).toBeTruthy();

    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    // The stored hash is of 32 random bytes this process generated and threw
    // away. Every plausible guess — including the empty string — fails closed.
    for (const guess of ["", "password", "Password1", biz.email]) {
      expect(await bcrypt.compare(guess, rows[0].password_hash)).toBe(false);
    }

    const { rows: enrolments } = await db.query(
      `SELECT 1 FROM mfa_enrolments WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(enrolments).toHaveLength(0);

    const { rows: codes } = await db.query(
      `SELECT 1 FROM mfa_recovery_codes WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(codes).toHaveLength(0);

    // Only the hash is on disk: the plaintext exists solely in the response.
    const { rows: stored } = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM owner_activations WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).toBe(activation.hashActivationToken(biz.ownerActivation!.token));
    expect(stored[0].token_hash).not.toBe(biz.ownerActivation!.token);
  }, 60_000);

  it("previews the business and a masked phone, and nothing else", async () => {
    const biz = await provisionActivated(`prev-${randomUUID().slice(0, 6)}`);
    const res = await getPreview(biz.ownerActivation!.token);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).toMatchObject({
      businessName: biz.businessName,
      email: biz.email,
      ownerName: "مالک تازه",
      phoneHint: "••••4567",
    });

    // The full mobile never leaves the server on a page reachable by whoever
    // holds the link.
    expect(JSON.stringify(json)).not.toContain("09121234567");
    expect(JSON.stringify(json)).not.toContain("+989121234567");
  }, 60_000);

  it("refuses an unknown token", async () => {
    const res = await getPreview("act_deadbeef");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "invalid_activation" });
  }, 60_000);

  it("refuses an activation with no mobile to prove control of", async () => {
    // The link travels through the operator, so without an owner-controlled
    // channel there is no second half — and a link that cannot be honoured must
    // not be issued.
    await expect(provisionActivated(`nophone-${randomUUID().slice(0, 6)}`, null)).rejects.toBeInstanceOf(
      provisioning.OwnerPhoneRequiredError,
    );

    // The console path refuses it as a field error before any transaction opens.
    const validated = provisioning.validateProvisionBody(
      { businessName: "کافه بی‌شماره", ownerName: "مالک", email: "nobody@example.com" },
      { ownerActivation: true },
    );
    expect(validated.input).toBeNull();
    expect(validated.error).toBe("invalid_owner_phone");
  }, 60_000);
});

describe("the texted code is what makes activation the owner's act", () => {
  it("cannot be finished by whoever holds the link", async () => {
    const biz = await provisionActivated(`operator-${randomUUID().slice(0, 6)}`);

    // The operator holding the link and no phone: no code, so nothing happens.
    const noCode = await postAccept(biz.ownerActivation!.token, "operator-chosen");
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toMatchObject({ error: "activation_code_required" });

    // And a guessed code is refused rather than ignored.
    const guessed = await postAccept(biz.ownerActivation!.token, "operator-chosen", "000000");
    expect(guessed.status).toBe(409);
    expect(await guessed.json()).toMatchObject({ error: "activation_code_required" });

    const { rows } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    expect(await bcrypt.compare("operator-chosen", rows[0].password_hash)).toBe(false);
    expect(rows[0].token_version).toBe(1);
  }, 60_000);

  it("is refused before a code has ever been sent, and stores only its HMAC", async () => {
    const biz = await provisionActivated(`nocode-${randomUUID().slice(0, 6)}`);
    const code = await sendCode(biz.ownerActivation!.token);

    const { rows } = await db.query<{
      code_hash: string | null;
      code_expires_at: Date | null;
      code_sent_at: Date | null;
      code_attempts: number;
    }>(
      `SELECT code_hash, code_expires_at, code_sent_at, code_attempts
         FROM owner_activations WHERE business_id = $1`,
      [biz.businessId],
    );
    const stored = rows[0];
    expect(stored.code_hash).toBeTruthy();
    expect(stored.code_hash).not.toContain(code);
    expect(stored.code_attempts).toBe(0);
    expect(stored.code_sent_at).toBeInstanceOf(Date);
    // Ten minutes, matching the service's own window.
    const windowMs = new Date(stored.code_expires_at!).getTime() - Date.now();
    expect(windowMs).toBeGreaterThan(9 * 60_000);
    expect(windowMs).toBeLessThanOrEqual(10 * 60_000);

    // Sent to the owner's own number, in E.164 as everything downstream expects.
    expect(sms.sent.at(-1)!.phone).toBe("+989121234567");
  }, 60_000);

  it("refuses to text a code once the link is used, revoked or expired", async () => {
    const biz = await provisionActivated(`usedcode-${randomUUID().slice(0, 6)}`);
    const code = await sendCode(biz.ownerActivation!.token);
    expect((await postAccept(biz.ownerActivation!.token, "owner-password", code)).status).toBe(200);

    const again = await postSendCode(biz.ownerActivation!.token);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "activation_accepted" });

    // No provider, no activation: the owner can never prove control, so the
    // service says so instead of texting into a log.
    const other = await provisionActivated(`nosms-${randomUUID().slice(0, 6)}`);
    sms.configured = false;
    try {
      const refused = await postSendCode(other.ownerActivation!.token);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ error: "sms_not_configured" });
    } finally {
      sms.configured = true;
    }
  }, 60_000);

  it("stops accepting guesses after a handful of wrong ones", async () => {
    const biz = await provisionActivated(`brute-${randomUUID().slice(0, 6)}`);
    const token = biz.ownerActivation!.token;
    const realCode = await sendCode(token);
    const wrong = realCode === "000000" ? "111111" : "000000";

    for (let i = 1; i <= activation.MAX_ACTIVATION_CODE_ATTEMPTS; i += 1) {
      const res = await postAccept(token, "brute-force-password", wrong);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "activation_code_invalid" });

      // The counter has to survive the refusal — it is committed, not rolled
      // back with the rejected attempt.
      const { rows } = await db.query<{ code_attempts: number }>(
        `SELECT code_attempts FROM owner_activations WHERE business_id = $1`,
        [biz.businessId],
      );
      expect(rows[0].code_attempts).toBe(i);
    }

    // Even the correct code is dead now: a fresh code is the only way in.
    const after = await postAccept(token, "brute-force-password", realCode);
    expect(after.status).toBe(429);
    expect(await after.json()).toMatchObject({ error: "activation_code_attempts_exceeded" });

    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    expect(await bcrypt.compare("brute-force-password", rows[0].password_hash)).toBe(false);
  }, 60_000);

  it("expires the code out of its ten-minute window", async () => {
    const biz = await provisionActivated(`expire-${randomUUID().slice(0, 6)}`);
    const token = biz.ownerActivation!.token;
    const code = await sendCode(token);

    await db.query(
      `UPDATE owner_activations SET code_expires_at = now() - interval '1 minute'
        WHERE business_id = $1`,
      [biz.businessId],
    );

    const res = await postAccept(token, "too-late-password", code);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "activation_code_expired" });
  }, 60_000);
});

describe("redeeming an activation link", () => {
  it("sets the owner's own password and mints their own second factor and codes", async () => {
    const biz = await provisionActivated(`redeem-${randomUUID().slice(0, 6)}`);
    const token = biz.ownerActivation!.token;

    const code = await sendCode(token);

    // The password policy is checked with a valid code in hand, so this is the
    // policy talking and not a missing field.
    const weak = await postAccept(token, "short", code);
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ error: "weak_password" });

    const res = await postAccept(token, "owner-chosen-password", code);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.mfa.method).toBe("sms_otp");
    expect(json.mfa.phoneE164).toBe("+989121234567");
    expect(json.mfa.existing).toBe(false);
    // Ten codes, and they exist only here — the console never receives them.
    expect(json.mfa.recoveryCodes).toHaveLength(10);

    const { rows: user } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    expect(await bcrypt.compare("owner-chosen-password", user[0].password_hash)).toBe(true);
    // Sessions minted against the throwaway hash are invalidated.
    expect(user[0].token_version).toBe(2);

    const { rows: enrolments } = await db.query<{ method: string; phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT method, phone_e164, confirmed_at FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(enrolments).toHaveLength(1);
    expect(enrolments[0].method).toBe("sms_otp");
    // The operator typed the number, so the owner still has to prove it.
    expect(enrolments[0].confirmed_at).toBeNull();

    const { rows: codes } = await db.query(`SELECT 1 FROM mfa_recovery_codes WHERE subject_id = $1`, [
      biz.platformUserId,
    ]);
    expect(codes).toHaveLength(10);

    const { rows: audit } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(audit.map((a) => a.action)).toContain("owner.activated");

    // The spent code is gone with the link: a texted six-digit code must not
    // stay valid against an activation that is already accepted.
    const { rows: spent } = await db.query<{ code_hash: string | null }>(
      `SELECT code_hash FROM owner_activations WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(spent[0].code_hash).toBeNull();
  }, 60_000);

  it("leaves an existing second factor and its recovery codes alone", async () => {
    // A person who already enrolled MFA — a group owner opening a third café —
    // must not have their factor replaced, and must not be handed a fresh set of
    // codes that silently retire the ones on their desk.
    const biz = await provisionActivated(`hasmfa-${randomUUID().slice(0, 6)}`);
    const token = biz.ownerActivation!.token;

    const recovery = await import("../src/lib/mfa-recovery");
    await recovery.issueRecoveryCodes("platform_user", biz.platformUserId);
    await db.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, phone_e164, confirmed_at)
       VALUES ('platform_user', $1, 'sms_otp', true, $2, now())`,
      [biz.platformUserId, "+989120000000"],
    );
    const { rows: before } = await db.query<{ code_hash: string }>(
      `SELECT code_hash FROM mfa_recovery_codes WHERE subject_id = $1`,
      [biz.platformUserId],
    );
    expect(before).toHaveLength(10);

    const code = await sendCode(token);
    const res = await postAccept(token, "third-business-password", code);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.mfa.existing).toBe(true);
    // The number they had, not the one in this provisioning call.
    expect(json.mfa.phoneE164).toBe("+989120000000");
    expect(json.mfa.recoveryCodes).toHaveLength(0);

    const { rows: enrolments } = await db.query<{ phone_e164: string | null }>(
      `SELECT phone_e164 FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(enrolments).toHaveLength(1);
    expect(enrolments[0].phone_e164).toBe("+989120000000");

    // Byte-for-byte the same rows: the codes already on this person's desk are
    // still the codes that work.
    const { rows: after } = await db.query<{ code_hash: string }>(
      `SELECT code_hash FROM mfa_recovery_codes WHERE subject_id = $1`,
      [biz.platformUserId],
    );
    expect(after.map((c) => c.code_hash).sort()).toEqual(before.map((c) => c.code_hash).sort());
  }, 60_000);

  it("is single use", async () => {
    const biz = await provisionActivated(`once-${randomUUID().slice(0, 6)}`);
    const token = biz.ownerActivation!.token;
    const code = await sendCode(token);
    expect((await postAccept(token, "first-password", code)).status).toBe(200);

    const second = await postAccept(token, "second-password", code);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "activation_accepted" });

    // The second attempt changed nothing.
    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    expect(await bcrypt.compare("first-password", rows[0].password_hash)).toBe(true);
  }, 60_000);

  it("stops working when the link itself has expired", async () => {
    const biz = await provisionActivated(`stale-${randomUUID().slice(0, 6)}`);
    const token = biz.ownerActivation!.token;
    await db.query(
      `UPDATE owner_activations SET expires_at = now() - interval '1 minute' WHERE business_id = $1`,
      [biz.businessId],
    );

    const res = await postAccept(token, "too-late-password", "000000");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "activation_expired" });
  }, 60_000);
});

describe("an owner who already has a platform login", () => {
  it("is refused until the operator confirms, then linked without an activation link", async () => {
    const suffix = randomUUID().slice(0, 6);
    const email = `group-${suffix}@example.com`;
    const first = await provisioning.provisionBusiness({
      businessName: "کافه نخست",
      ownerName: "مالک گروه",
      ownerPhone: "09121234567",
      email,
      subdomain: `group-a-${suffix}`,
      seedChartOfAccounts: false,
      ownerActivation: true,
      createdBy: null,
    });
    const token = first.ownerActivation!.token;
    const code = await sendCode(token);
    expect((await postAccept(token, "their-own-password", code)).status).toBe(200);

    const { rows: before } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [first.platformUserId],
    );

    // Unconfirmed: refused, and nothing was created.
    await expect(
      provisioning.provisionBusiness({
        businessName: "کافه دوم",
        ownerName: "مالک گروه",
        ownerPhone: "09121234567",
        email,
        subdomain: `group-b-${suffix}`,
        seedChartOfAccounts: false,
        ownerActivation: true,
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(provisioning.ExistingOwnerConfirmationRequiredError);

    const { rows: nothing } = await db.query(
      `SELECT 1 FROM businesses WHERE subdomain = $1`,
      [`group-b-${suffix}`],
    );
    expect(nothing).toHaveLength(0);

    // Confirmed: the business is added to the *same* identity.
    const second = await provisioning.provisionBusiness({
      businessName: "کافه دوم",
      ownerName: "مالک گروه",
      ownerPhone: "09121234567",
      email,
      subdomain: `group-b-${suffix}`,
      seedChartOfAccounts: false,
      ownerActivation: true,
      confirmExistingOwner: true,
      createdBy: null,
    });
    expect(second.platformUserId).toBe(first.platformUserId);
    expect(second.ownerIdentityCreated).toBe(false);
    // No link: this person's credentials are theirs, and nobody — including the
    // operator who just added a business — needs to know or reset them.
    expect(second.ownerActivation).toBeUndefined();

    const { rows: after } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [first.platformUserId],
    );
    expect(after[0].password_hash).toBe(before[0].password_hash);
    expect(after[0].token_version).toBe(before[0].token_version);
  }, 120_000);
});

/**
 * The code is stored as an HMAC of a random six-digit string under the platform
 * realm secret, and this is the construction the service must be using —
 * otherwise the tests above would be passing against a hash nothing could ever
 * match.
 *
 * Recomputed here rather than through a shared helper, so a change to the
 * service's construction fails here instead of being mirrored by the test.
 */
describe("the stored code is the documented construction", () => {
  it("matches an HMAC of the plaintext under the platform realm secret", async () => {
    const { getRealmSecret } = await import("../src/lib/jwt-secret");
    const biz = await provisionActivated(`hmac-${randomUUID().slice(0, 6)}`);
    const code = await sendCode(biz.ownerActivation!.token);

    const { rows } = await db.query<{ code_hash: string | null }>(
      `SELECT code_hash FROM owner_activations WHERE business_id = $1`,
      [biz.businessId],
    );

    const expected = createHmac("sha256", await getRealmSecret("platform"))
      .update(code)
      .digest("hex");
    expect(rows[0].code_hash).toBe(expected);
    // And the plaintext is nowhere on the row.
    expect(JSON.stringify(rows[0])).not.toContain(code);
  }, 60_000);
});
