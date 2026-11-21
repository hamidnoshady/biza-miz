/**
 * ESH-200/202 (#1385/#1387) — the phone-first journey against a real database.
 *
 * The acceptance properties this file exists to prove:
 *
 *  - a valid signup code creates exactly one personal identity and **no**
 *    business, membership, branch or setup completion;
 *  - concurrent redemptions of one code converge on one identity;
 *  - a second signup for an already-verified number links that identity instead
 *    of creating a duplicate;
 *  - a code minted for another purpose cannot be redeemed as a signup;
 *  - onboarding persists across reads, provisions only on submit, and two
 *    submits (including concurrent ones) produce one business.
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
let db: typeof import("../src/lib/db");
let signup: typeof import("../src/lib/iam/public-signup");
let onboarding: typeof import("../src/lib/iam/onboarding");
let otp: typeof import("../src/lib/otp-challenge");
let industries: typeof import("../src/lib/industries");

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

/** A unique mobile per test, in the canonical shape the service stores. */
function uniquePhone(): string {
  const tail = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  return `+98912${tail}`;
}

async function setPublicSignup(enabled: boolean): Promise<void> {
  await db.withoutTenantScope("platform", () =>
    db.query(
      `UPDATE platform_auth_settings
          SET configured = true, public_signup_enabled = $1, updated_at = now()
        WHERE id = 1`,
      [enabled],
    ),
  );
}

/** Stage a live signup request + challenge with a known code, without sending SMS. */
async function stageSignup(
  phone: string,
  options: { purpose?: "signup" | "login"; code?: string } = {},
): Promise<string> {
  const { rows } = await db.withoutTenantScope("signup", () =>
    db.query<{ id: string }>(
      `INSERT INTO platform_signup_requests (phone_e164, first_name, last_name)
       VALUES ($1, 'نگار', 'احمدی')
       RETURNING id`,
      [phone],
    ),
  );
  const requestId = rows[0].id;
  await otp.issueOtpChallenge({
    subjectRealm: signup.SIGNUP_SUBJECT_REALM,
    subjectId: requestId,
    purpose: options.purpose ?? "signup",
    candidatePhoneE164: phone,
    code: options.code ?? "424242",
  });
  return requestId;
}

async function countIdentities(phone: string): Promise<number> {
  const { rows } = await db.withoutTenantScope("signup", () =>
    db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM platform_users WHERE phone_e164 = $1",
      [phone],
    ),
  );
  return Number(rows[0].count);
}

beforeAll(async () => {
  databaseName = `pos_signup_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.JWT_SECRET = "signup-integration-secret-".padEnd(64, "x");
  process.env.POS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  delete (globalThis as { pgPool?: unknown }).pgPool;

  db = await import("../src/lib/db");
  signup = await import("../src/lib/iam/public-signup");
  onboarding = await import("../src/lib/iam/onboarding");
  otp = await import("../src/lib/otp-challenge");
  industries = await import("../src/lib/industries");
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
  delete process.env.POS_MASTER_KEY;
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("the public registration switch", () => {
  it("refuses both halves server-side while it is off", async () => {
    await setPublicSignup(false);
    expect(
      await signup.requestSignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone: "09121234567",
      }),
    ).toEqual({ ok: false, error: "signup_disabled" });

    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone: "09121234567",
        code: "424242",
      }),
    ).toEqual({ ok: false, error: "signup_disabled" });

    await setPublicSignup(true);
  });
});

describe("signup request", () => {
  it("sends the code and records the send without a constraint violation", async () => {
    const phone = uniquePhone();
    const result = await signup.requestSignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("sent");
    expect(result.maskedPhone).toContain("***");

    // The proof row and its code exist, and the send was counted in the same
    // limiter realm the other OTP doors use — a signup send must not fail after
    // the SMS has already gone out.
    const { rows: requests } = await db.withoutTenantScope("signup", () =>
      db.query<{ id: string }>(
        `SELECT id FROM platform_signup_requests
          WHERE phone_e164 = $1 AND consumed_at IS NULL`,
        [phone],
      ),
    );
    expect(requests).toHaveLength(1);

    const { rows: attempts } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM auth_login_attempts
          WHERE realm = 'signup' AND identity_key = $1`,
        [`signup:${phone}`],
      ),
    );
    expect(attempts[0].count).toBe("1");

    // A resend supersedes the first request rather than leaving two live codes.
    // The send limiter's 60s cooldown is real, so age the first attempt instead
    // of sleeping through it.
    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE auth_login_attempts SET created_at = now() - interval '2 minutes'
          WHERE realm = 'signup' AND identity_key = $1`,
        [`signup:${phone}`],
      ),
    );
    const resent = await signup.requestSignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
    });
    expect(resent.ok).toBe(true);
    const { rows: live } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform_signup_requests
          WHERE phone_e164 = $1 AND consumed_at IS NULL`,
        [phone],
      ),
    );
    expect(live[0].count).toBe("1");
  });
});

describe("signup verification", () => {
  it("creates one personal identity and no tenant", async () => {
    const phone = uniquePhone();
    await stageSignup(phone);

    const first = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: "424242",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);

    expect(await countIdentities(phone)).toBe(1);

    const { rows: identity } = await db.withoutTenantScope("signup", () =>
      db.query<{ email: string | null; password_hash: string | null; full_name: string; phone_verified_at: Date | null }>(
        `SELECT email::text AS email, password_hash, full_name, phone_verified_at
           FROM platform_users WHERE id = $1`,
        [first.platformUserId],
      ),
    );
    expect(identity[0].email).toBeNull();
    expect(identity[0].password_hash).toBeNull();
    expect(identity[0].full_name).toBe("نگار احمدی");
    expect(identity[0].phone_verified_at).not.toBeNull();

    const { rows: tenant } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE platform_user_id = $1",
        [first.platformUserId],
      ),
    );
    expect(tenant[0].count).toBe("0");

    const { rows: setup } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM settings WHERE key = 'setup.progress'`,
      ),
    );
    expect(setup[0].count).toBe("0");
  });

  it("links an already-verified number instead of creating a second identity", async () => {
    const phone = uniquePhone();
    await stageSignup(phone);
    const first = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: "424242",
    });
    expect(first.ok).toBe(true);

    await stageSignup(phone, { code: "515151" });
    const second = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: "515151",
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.created).toBe(false);
    expect(second.platformUserId).toBe(first.platformUserId);
    expect(await countIdentities(phone)).toBe(1);
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    const phone = uniquePhone();
    await stageSignup(phone);

    const [a, b] = await Promise.all([
      signup.verifySignupOtp({ firstName: "الف", lastName: "ب", phone, code: "424242" }),
      signup.verifySignupOtp({ firstName: "الف", lastName: "ب", phone, code: "424242" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await countIdentities(phone)).toBe(1);
  });

  it("refuses a code minted for another purpose", async () => {
    const phone = uniquePhone();
    await stageSignup(phone, { purpose: "login", code: "616161" });
    const result = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: "616161",
    });
    expect(result).toEqual({ ok: false, error: "invalid_code" });
    expect(await countIdentities(phone)).toBe(0);
  });

  it("refuses a wrong code without consuming the identity slot", async () => {
    const phone = uniquePhone();
    await stageSignup(phone);
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code: "999999",
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await countIdentities(phone)).toBe(0);
  });
});

describe("short onboarding", () => {
  async function verifiedIdentity(): Promise<string> {
    const phone = uniquePhone();
    await stageSignup(phone);
    const result = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: "424242",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("signup failed");
    return result.platformUserId;
  }

  it("resumes a saved draft and keeps every captured field", async () => {
    const platformUserId = await verifiedIdentity();
    const industry = industries.ENABLED_INDUSTRIES[0];

    const saved = await onboarding.saveOnboarding(platformUserId, {
      industry,
      businessName: "فروشگاه نمونه",
      locationName: "شعبه اصلی",
      address: "تهران، خیابان ولیعصر",
      phone: "02112345678",
      logoDataUrl: ONE_PIXEL_PNG,
      step: "logo",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const resumed = await onboarding.readOnboarding(platformUserId);
    expect(resumed).toMatchObject({
      industry,
      businessName: "فروشگاه نمونه",
      locationName: "شعبه اصلی",
      address: "تهران، خیابان ولیعصر",
      phoneE164: "+982112345678",
      step: "logo",
      status: "in_progress",
      provisionedBusinessId: null,
    });
    expect(resumed?.logo?.mimeType).toBe("image/png");

    // A second device saving a later step does not erase the logo.
    const stepped = await onboarding.saveOnboarding(platformUserId, { step: "profile" });
    expect(stepped.ok).toBe(true);
    expect((await onboarding.readOnboarding(platformUserId))?.logo).not.toBeNull();
  });

  it("refuses an industry that is not enabled", async () => {
    const platformUserId = await verifiedIdentity();
    expect(
      await onboarding.saveOnboarding(platformUserId, { industry: "not_a_trade" }),
    ).toEqual({ ok: false, error: "invalid_industry" });
  });

  it("refuses to submit without the required business details", async () => {
    const platformUserId = await verifiedIdentity();
    expect(await onboarding.submitOnboarding(platformUserId)).toEqual({
      ok: false,
      error: "onboarding_incomplete",
    });
  });

  it("provisions one business on submit and is idempotent under concurrency", async () => {
    const platformUserId = await verifiedIdentity();
    const industry = industries.ENABLED_INDUSTRIES[0];
    const saved = await onboarding.saveOnboarding(platformUserId, {
      industry,
      businessName: `کسب‌وکار ${randomUUID().slice(0, 8)}`,
      locationName: "شعبه مرکزی",
      address: "تهران",
      phone: "02188776655",
      logoDataUrl: ONE_PIXEL_PNG,
      step: "profile",
    });
    expect(saved.ok).toBe(true);

    const [a, b] = await Promise.all([
      onboarding.submitOnboarding(platformUserId),
      onboarding.submitOnboarding(platformUserId),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.business.businessId).toBe(b.business.businessId);

    const { rows: businesses } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE platform_user_id = $1",
        [platformUserId],
      ),
    );
    expect(businesses[0].count).toBe("1");

    const state = await onboarding.readOnboarding(platformUserId);
    expect(state?.status).toBe("provisioned");
    expect(state?.provisionedBusinessId).toBe(a.business.businessId);

    const { rows: business } = await db.withoutTenantScope("signup", () =>
      db.query<{ industry: string; name: string; setup_complete: boolean }>(
        `SELECT b.industry, b.name::text AS name,
                EXISTS (
                  SELECT 1 FROM settings s
                   WHERE s.business_id = b.id AND s.key = 'setup.progress'
                     AND s.value ->> 'completedAt' IS NOT NULL
                ) AS setup_complete
           FROM businesses b WHERE b.id = $1`,
        [a.business.businessId],
      ),
    );
    expect(business[0].industry).toBe(industry);
    expect(business[0].setup_complete).toBe(false);

    // The branch contact reads as the local number people type into `/setup`'s
    // phone field, while the person's canonical identity number stays the
    // verified mobile the signup code proved.
    const { rows: contact } = await db.withoutTenantScope("signup", () =>
      db.query<{ phone: string | null; identity_phone: string | null }>(
        `SELECT l.phone, p.phone_e164 AS identity_phone
           FROM locations l
           JOIN users u ON u.business_id = l.business_id AND u.platform_user_id = $2
           JOIN platform_users p ON p.id = u.platform_user_id
          WHERE l.business_id = $1
          ORDER BY l.created_at ASC
          LIMIT 1`,
        [a.business.businessId, platformUserId],
      ),
    );
    expect(contact[0].phone).toBe("02188776655");
    expect(contact[0].identity_phone).toMatch(/^\+98912/);

    // The staged logo became the canonical business setting, once.
    const { rows: logo } = await db.withoutTenantScope("signup", () =>
      db.query<{ value: { dataUrl: string; mimeType: string } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'business.logo'`,
        [a.business.businessId],
      ),
    );
    expect(logo).toHaveLength(1);
    expect(logo[0].value.mimeType).toBe("image/png");

    // A repeat submit after completion answers with the same business.
    const again = await onboarding.submitOnboarding(platformUserId);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.business.businessId).toBe(a.business.businessId);
  });
});
