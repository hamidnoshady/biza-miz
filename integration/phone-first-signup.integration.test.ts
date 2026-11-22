/**
 * ESH-200 / #1385 — phone-first public signup against a real database.
 *
 * The acceptance properties this file exists to prove:
 *
 *  - no identity exists until a valid, unexpired, signup-purpose code is
 *    redeemed;
 *  - a successful redemption creates exactly one personal identity and **no**
 *    business, membership, branch, wallet or subscription;
 *  - wrong, expired, replayed, wrong-purpose, wrong-phone and concurrent
 *    redemptions are refused or converge on one identity;
 *  - an already-verified number is linked, never duplicated;
 *  - an SMS failure consumes the proof and leaves nothing verifiable;
 *  - the send cooldown is real and a resend leaves one live request.
 *
 * Codes are captured by an injected transport and never printed. The database
 * is disposable and dropped afterwards.
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
let retention: typeof import("../src/lib/iam/signup-retention");
let otp: typeof import("../src/lib/otp-challenge");

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

function signupEnabled(enabled: boolean): void {
  process.env.ALLOW_PUBLIC_SIGNUP = enabled ? "true" : "false";
}

/** Ask for a code through the real service, recording it instead of sending it. */
async function requestWithCode(phone: string): Promise<{
  code: string;
  requestToken: string;
}> {
  let code = "";
  const result = await signup.requestSignupOtp(
    { firstName: "نگار", lastName: "احمدی", phone },
    {
      sendOtp: async (deliveredTo, deliveredCode) => {
        expect(deliveredTo).toBe(phone);
        code = deliveredCode;
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`signup request failed: ${result.error}`);
  expect(code).toMatch(/^\d{6}$/);
  return { code, requestToken: result.requestToken };
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.withoutTenantScope("signup", () =>
    db.query<{ count: string }>(sql, params),
  );
  return Number(rows[0].count);
}

async function identityCount(phone: string): Promise<number> {
  return count("SELECT count(*)::text AS count FROM platform_users WHERE phone_e164 = $1", [phone]);
}

async function businessRecordCount(): Promise<number> {
  return count(
    `SELECT (
       (SELECT count(*) FROM businesses) +
       (SELECT count(*) FROM users) +
       (SELECT count(*) FROM locations) +
       (SELECT count(*) FROM business_wallets) +
       (SELECT count(*) FROM business_subscriptions) +
       (SELECT count(*) FROM employee_sessions)
     )::text AS count`,
  );
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
  signupEnabled(true);
  delete (globalThis as { pgPool?: unknown }).pgPool;

  db = await import("../src/lib/db");
  signup = await import("../src/lib/iam/public-signup");
  retention = await import("../src/lib/iam/signup-retention");
  otp = await import("../src/lib/otp-challenge");
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
    signupEnabled(false);
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
        requestToken: "a".repeat(43),
      }),
    ).toEqual({ ok: false, error: "signup_disabled" });
    signupEnabled(true);
  });
});

describe("requesting a signup code", () => {
  it("records one live request and enforces the resend cooldown", async () => {
    const phone = uniquePhone();
    const first = await requestWithCode(phone);

    const limited = await signup.requestSignupOtp(
      { firstName: "نگار", lastName: "احمدی", phone },
      { sendOtp: async () => undefined },
    );
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.error).toBe("rate_limited");
    if (limited.error !== "rate_limited") return;
    expect(limited.retryAfterMs).toBeGreaterThan(0);

    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE auth_login_attempts SET created_at = now() - interval '2 minutes'
          WHERE realm = 'signup' AND identity_key = $1`,
        [signup.signupRateLimitKey(phone)],
      ),
    );

    const second = await requestWithCode(phone);
    expect(second.requestToken).not.toBe(first.requestToken);

    const { rows } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform_signup_requests
          WHERE phone_e164 = $1 AND consumed_at IS NULL`,
        [phone],
      ),
    );
    expect(rows[0].count).toBe("1");

    // The old token no longer names a live request.
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code: first.code,
        requestToken: first.requestToken,
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
  });

  it("serialises two simultaneous requests for one number into one send", async () => {
    const phone = uniquePhone();
    const send = async () => undefined;
    const results = await Promise.all([
      signup.requestSignupOtp({ firstName: "نگار", lastName: "احمدی", phone }, { sendOtp: send }),
      signup.requestSignupOtp({ firstName: "نگار", lastName: "احمدی", phone }, { sendOtp: send }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && "error" in refused ? refused.error : null).toBe("rate_limited");

    const { rows } = await db.withoutTenantScope("signup", () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform_signup_requests
          WHERE phone_e164 = $1 AND consumed_at IS NULL`,
        [phone],
      ),
    );
    expect(rows[0].count).toBe("1");
  });

  it("does not leave a verifiable request when the SMS provider fails", async () => {
    const phone = uniquePhone();
    let deliveredCode = "";
    const failed = await signup.requestSignupOtp(
      { firstName: "نگار", lastName: "احمدی", phone },
      {
        sendOtp: async (_phone, code) => {
          deliveredCode = code;
          throw new Error("provider unavailable");
        },
      },
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toBe("sms_dispatch_failed");

    const { rows } = await db.withoutTenantScope("signup", () =>
      db.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM platform_signup_requests WHERE phone_e164 = $1`,
        [phone],
      ),
    );
    expect(rows[0].consumed_at).not.toBeNull();
    expect(await identityCount(phone)).toBe(0);

    // The code was never delivered to a person, and even if it leaked it is not
    // redeemable: the request was consumed with the failed send.
    expect(deliveredCode).toMatch(/^\d{6}$/);
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code: deliveredCode,
        requestToken: "a".repeat(43),
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await identityCount(phone)).toBe(0);
  });
});

describe("verifying a signup code", () => {
  it("creates exactly one personal identity and no business or billing record", async () => {
    const phone = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);
    const beforeBusinessRecords = await businessRecordCount();

    const result = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code,
      requestToken,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.resumed).toBe(false);
    expect(result.hasBusinessMemberships).toBe(false);
    expect(await identityCount(phone)).toBe(1);
    expect(await businessRecordCount()).toBe(beforeBusinessRecords);

    const { rows } = await db.withoutTenantScope("signup", () =>
      db.query<{
        email: string | null;
        password_hash: string | null;
        full_name: string;
        phone_verified_at: Date | null;
      }>(
        `SELECT email::text AS email, password_hash, full_name, phone_verified_at
           FROM platform_users WHERE id = $1`,
        [result.platformUserId],
      ),
    );
    expect(rows[0].email).toBeNull();
    expect(rows[0].password_hash).toBeNull();
    expect(rows[0].full_name).toBe("نگار احمدی");
    expect(rows[0].phone_verified_at).not.toBeNull();

    const { rows: requests } = await db.withoutTenantScope("signup", () =>
      db.query<{
        consumed_at: Date | null;
        verified_at: Date | null;
        platform_user_id: string | null;
        identity_created: boolean;
      }>(
        `SELECT consumed_at, verified_at, platform_user_id, identity_created
           FROM platform_signup_requests WHERE phone_e164 = $1`,
        [phone],
      ),
    );
    expect(requests[0].consumed_at).not.toBeNull();
    expect(requests[0].verified_at).not.toBeNull();
    expect(requests[0].platform_user_id).toBe(result.platformUserId);
    expect(requests[0].identity_created).toBe(true);

    const { rows: audits } = await db.withoutTenantScope("platform", () =>
      db.query<{ action: string; payload: Record<string, unknown> }>(
        `SELECT action, payload FROM platform_audit_log
          WHERE action LIKE 'auth.signup.%'
          ORDER BY id`,
      ),
    );
    const actions = audits.map((row) => row.action);
    expect(actions).toContain("auth.signup.requested");
    expect(actions).toContain("auth.signup.sent");
    expect(actions).toContain("auth.signup.verified");
    expect(actions).toContain("auth.signup.identity_created");
    for (const audit of audits) {
      const serialized = JSON.stringify(audit.payload);
      expect(serialized, `${audit.action} leaked the code`).not.toContain(code);
      expect(serialized, `${audit.action} leaked the full number`).not.toContain(phone);
    }
  });

  it("refuses a wrong code until the attempt budget is exhausted, then the right code is too", async () => {
    const phone = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);

    for (let i = 0; i < otp.OTP_MAX_ATTEMPTS; i += 1) {
      expect(
        await signup.verifySignupOtp({
          firstName: "نگار",
          lastName: "احمدی",
          phone,
          code: "000000",
          requestToken,
        }),
      ).toEqual({ ok: false, error: "invalid_code" });
    }
    expect(await identityCount(phone)).toBe(0);

    // The challenge is burned; the correct code cannot resurrect it.
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code,
        requestToken,
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await identityCount(phone)).toBe(0);
  });

  it("refuses an expired code and creates nothing", async () => {
    const phone = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);
    await db.withoutTenantScope("signup", () =>
      db.query(`UPDATE mfa_challenges SET expires_at = now() - interval '1 second'`),
    );

    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code,
        requestToken,
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await identityCount(phone)).toBe(0);
  });

  it("refuses a code minted for another purpose", async () => {
    const phone = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);
    await db.withoutTenantScope("signup", () =>
      db.query(`UPDATE mfa_challenges SET purpose = 'login' WHERE candidate_phone_e164 = $1`, [
        phone,
      ]),
    );

    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code,
        requestToken,
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await identityCount(phone)).toBe(0);
  });

  it("refuses a valid code when the challenge is bound to a different phone", async () => {
    const phone = uniquePhone();
    const other = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);
    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE mfa_challenges SET candidate_phone_e164 = $2
          WHERE candidate_phone_e164 = $1`,
        [phone, other],
      ),
    );

    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code,
        requestToken,
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await identityCount(phone)).toBe(0);
  });

  it("is idempotent for the same client, then refuses a replay after the grace period", async () => {
    const phone = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);
    const first = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code,
      requestToken,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code,
      requestToken,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.resumed).toBe(true);
    expect(replay.platformUserId).toBe(first.platformUserId);
    expect(await identityCount(phone)).toBe(1);

    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE platform_signup_requests
            SET verified_at = now() - interval '${signup.SIGNUP_IDEMPOTENCY_MINUTES + 1} minutes'
          WHERE phone_e164 = $1`,
        [phone],
      ),
    );
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code,
        requestToken,
      }),
    ).toEqual({ ok: false, error: "invalid_code" });
    expect(await identityCount(phone)).toBe(1);
  });

  it("links an already-verified number instead of creating a duplicate", async () => {
    const phone = uniquePhone();
    const first = await requestWithCode(phone);
    const created = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: first.code,
      requestToken: first.requestToken,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Age the send attempt so the limiter allows the second request.
    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE auth_login_attempts SET created_at = now() - interval '2 minutes'
          WHERE realm = 'signup' AND identity_key = $1`,
        [signup.signupRateLimitKey(phone)],
      ),
    );
    const second = await requestWithCode(phone);
    const linked = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: second.code,
      requestToken: second.requestToken,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.created).toBe(false);
    expect(linked.platformUserId).toBe(created.platformUserId);
    expect(await identityCount(phone)).toBe(1);
  });

  it("converges concurrent redemptions on exactly one identity", async () => {
    const phone = uniquePhone();
    const { code, requestToken } = await requestWithCode(phone);

    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        signup.verifySignupOtp({
          firstName: "نگار",
          lastName: "احمدی",
          phone,
          code,
          requestToken,
        }),
      ),
    );

    const successes = attempts.filter((result) => result.ok);
    expect(successes.length).toBeGreaterThan(0);
    const ids = new Set(
      successes.map((result) => (result.ok ? result.platformUserId : "")),
    );
    expect(ids.size).toBe(1);
    expect(successes.filter((result) => result.ok && result.created).length).toBe(1);
    expect(await identityCount(phone)).toBe(1);
  });

  it("rolls the code back when the number resolves to more than one identity", async () => {
    const phone = uniquePhone();
    const first = await requestWithCode(phone);
    const created = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: first.code,
      requestToken: first.requestToken,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A second global identity that verified the same number on one of its
    // memberships. The global unique index cannot stop a legacy membership row,
    // which is exactly the ambiguous state #1384 says must be refused, never
    // merged or guessed.
    const secondIdentityId = randomUUID();
    const businessId = randomUUID();
    const membershipId = randomUUID();
    await db.withoutTenantScope("signup", async () => {
      await db.query(
        `INSERT INTO platform_users (id, email, full_name, is_active)
         VALUES ($1, $2, 'شخص دوم', true)`,
        [secondIdentityId, `second-${secondIdentityId.slice(0, 8)}@example.test`],
      );
      await db.query(
        `INSERT INTO businesses (id, name, slug, subdomain, industry)
         VALUES ($1, 'کافه دوم', $2, $3, 'food_service')`,
        [businessId, `signup-amb-${businessId.slice(0, 8)}`, `signup-amb-${businessId.slice(0, 8)}`],
      );
      await db.query(
        `INSERT INTO users (id, business_id, platform_user_id, role, full_name, email, phone_e164, phone_verified_at)
         VALUES ($1, $2, $3, 'owner', 'شخص دوم', NULL, $4, now())`,
        [membershipId, businessId, secondIdentityId, phone],
      );
    });

    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE auth_login_attempts SET created_at = now() - interval '2 minutes'
          WHERE realm = 'signup' AND identity_key = $1`,
        [signup.signupRateLimitKey(phone)],
      ),
    );
    const second = await requestWithCode(phone);
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code: second.code,
        requestToken: second.requestToken,
      }),
    ).toEqual({ ok: false, error: "account_ambiguous" });

    // The failure rolled the OTP consumption back: the same code and request
    // token still reach the same refusal instead of "invalid_code".
    expect(
      await signup.verifySignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone,
        code: second.code,
        requestToken: second.requestToken,
      }),
    ).toEqual({ ok: false, error: "account_ambiguous" });

    const { rows } = await db.withoutTenantScope("signup", () =>
      db.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM mfa_challenges
          WHERE purpose = 'signup' AND candidate_phone_e164 = $1
          ORDER BY created_at DESC LIMIT 1`,
        [phone],
      ),
    );
    expect(rows[0].consumed_at).toBeNull();
  });

  it("sweeps only expired live proofs and old consumed proofs", async () => {
    const now = new Date();
    const oldConsumedPhone = uniquePhone();
    const staleLivePhone = uniquePhone();
    const freshLivePhone = uniquePhone();
    const oldCreated = new Date(now.getTime() - 60 * 86_400_000);
    const oldConsumedAt = new Date(now.getTime() - 40 * 86_400_000);
    const staleCreated = new Date(now.getTime() - 2 * 86_400_000);
    const staleExpires = new Date(now.getTime() - 36 * 3_600_000);
    const freshExpires = new Date(now.getTime() + 5 * 60_000);

    await db.withoutTenantScope("signup", async () => {
      await db.query(
        `INSERT INTO platform_signup_requests
           (phone_e164, first_name, last_name, request_token_hash, created_at, expires_at, consumed_at)
         VALUES ($1, 'کهنه', 'مصرف‌شده', $2, $3, $4, $5)`,
        [
          oldConsumedPhone,
          signup.hashSignupRequestToken(randomUUID()),
          oldCreated.toISOString(),
          new Date(oldCreated.getTime() + 5 * 60_000).toISOString(),
          oldConsumedAt.toISOString(),
        ],
      );
      await db.query(
        `INSERT INTO platform_signup_requests
           (phone_e164, first_name, last_name, request_token_hash, created_at, expires_at)
         VALUES ($1, 'منقضی', 'زنده', $2, $3, $4)`,
        [
          staleLivePhone,
          signup.hashSignupRequestToken(randomUUID()),
          staleCreated.toISOString(),
          staleExpires.toISOString(),
        ],
      );
      await db.query(
        `INSERT INTO platform_signup_requests
           (phone_e164, first_name, last_name, request_token_hash, created_at, expires_at)
         VALUES ($1, 'تازه', 'زنده', $2, $3, $4)`,
        [
          freshLivePhone,
          signup.hashSignupRequestToken(randomUUID()),
          now.toISOString(),
          freshExpires.toISOString(),
        ],
      );
    });

    const swept = await retention.sweepSignupRequests(now);
    expect(swept.expiredMarked).toBeGreaterThanOrEqual(1);
    expect(swept.deleted).toBeGreaterThanOrEqual(1);

    const { rows } = await db.withoutTenantScope("signup", () =>
      db.query<{ phone_e164: string; consumed_at: Date | null }>(
        `SELECT phone_e164, consumed_at FROM platform_signup_requests
          WHERE phone_e164 IN ($1, $2, $3)
          ORDER BY phone_e164`,
        [oldConsumedPhone, staleLivePhone, freshLivePhone],
      ),
    );
    expect(rows.some((row) => row.phone_e164 === oldConsumedPhone)).toBe(false);
    expect(rows.find((row) => row.phone_e164 === staleLivePhone)?.consumed_at).not.toBeNull();
    expect(rows.find((row) => row.phone_e164 === freshLivePhone)?.consumed_at).toBeNull();

    const { rows: audits } = await db.withoutTenantScope("platform", () =>
      db.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM platform_audit_log
          WHERE action = 'auth.signup.retention_sweep'
          ORDER BY id DESC LIMIT 1`,
      ),
    );
    expect(audits[0]?.payload).toMatchObject({
      expiredMarked: expect.any(Number),
      deleted: expect.any(Number),
    });
    expect(JSON.stringify(audits[0]?.payload)).not.toContain(oldConsumedPhone);
    expect(JSON.stringify(audits[0]?.payload)).not.toContain(staleLivePhone);
  });

  it("guides an existing identity with a business to sign in", async () => {
    const phone = uniquePhone();
    const first = await requestWithCode(phone);
    const created = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: first.code,
      requestToken: first.requestToken,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A membership for this identity is enough for the signup result to say
    // "this person already belongs to a business"; it creates no new business.
    const businessId = randomUUID();
    const membershipId = randomUUID();
    await db.withoutTenantScope("signup", async () => {
      await db.query(
        `INSERT INTO businesses (id, name, slug, subdomain, industry)
         VALUES ($1, 'کافه آزمون', $2, $3, 'food_service')`,
        [businessId, `signup-test-${businessId.slice(0, 8)}`, `signup-test-${businessId.slice(0, 8)}`],
      );
      await db.query(
        `INSERT INTO users (id, business_id, platform_user_id, role, full_name, email, phone_e164, phone_verified_at)
         VALUES ($1, $2, $3, 'owner', 'نگار احمدی', NULL, $4, now())`,
        [membershipId, businessId, created.platformUserId, phone],
      );
    });

    await db.withoutTenantScope("signup", () =>
      db.query(
        `UPDATE auth_login_attempts SET created_at = now() - interval '2 minutes'
          WHERE realm = 'signup' AND identity_key = $1`,
        [signup.signupRateLimitKey(phone)],
      ),
    );
    const second = await requestWithCode(phone);
    const existing = await signup.verifySignupOtp({
      firstName: "نگار",
      lastName: "احمدی",
      phone,
      code: second.code,
      requestToken: second.requestToken,
    });
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;
    expect(existing.created).toBe(false);
    expect(existing.platformUserId).toBe(created.platformUserId);
    expect(existing.hasBusinessMemberships).toBe(true);
    expect(await identityCount(phone)).toBe(1);
  });
});
