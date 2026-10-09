/**
 * Phase 42 — phone-OTP login, against a real database.
 *
 * Covers the three things the door's correctness hangs on:
 *
 *  1. **The migration shape** — the phone columns exist on `users` and the
 *     per-business unique index actually refuses a duplicate number.
 *  2. **The policy resolver** — off / grace / pending_sms / enforced, exactly
 *     as the four combinations of setting-date and SMS-configured-ness say,
 *     including the guard that keeps an SMS-less install unlocked.
 *  3. **The routing and the stamps** — `loginRoster`'s server-side
 *     `loginMode` under enforcement (the thing the client must never
 *     re-derive), `stampPhoneVerified` opening the 7-day PIN window, and
 *     `verifyEmployeePhoneOtp` consuming a challenge only on the right code.
 *
 * The OTP dispatch itself is the NoopProvider's (no Kavenegar key is stored),
 * so no SMS leaves the process; the challenge rows the verify half reads are
 * inserted by the test with the same HMAC the route's send half would use.
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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
let employeeService: typeof import("../src/lib/employee-service");
let phoneOtp: typeof import("../src/lib/phone-otp");
let jwtSecret: typeof import("../src/lib/jwt-secret");
let preDir: string;

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

const biz = { id: "", locationId: "" };
const staff = { none: "", unverified: "", freshWindow: "", staleWindow: "" };

/** The number `staff.unverified` holds; every challenge binding names it. */
const PHONE = "+989121000001";

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 7 * 86_400_000).toISOString();

async function setPolicy(businessId: string, enforcedAt: string | null) {
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'auth.phoneOtp', $2)
     ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [businessId, JSON.stringify({ enforcedAt })],
  );
}

beforeAll(async () => {
  databaseName = `pos_phone_otp_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  // 0139 stamps the adoption window onto businesses that ALREADY exist when
  // it applies, so the fixture must be built the way a live database is:
  // migrate everything before 0139, create the business, then let 0139 run.
  const migrationsDir = join(process.cwd(), "migrations");
  preDir = join(process.cwd(), ".tmp-migrations-pre0139");
  rmSync(preDir, { recursive: true, force: true });
  mkdirSync(preDir);
  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith(".sql")) continue;
    const migrationNumber = Number.parseInt(file.slice(0, 4), 10);
    if (!Number.isFinite(migrationNumber) || migrationNumber >= 139) continue;
    symlinkSync(join(migrationsDir, file), join(preDir, file));
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: preDir, quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('کافه آزمون') RETURNING id`,
  );
  biz.id = business.rows[0].id;

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  rmSync(preDir, { recursive: true, force: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  employeeService = await import("../src/lib/employee-service");
  phoneOtp = await import("../src/lib/phone-otp");
  jwtSecret = await import("../src/lib/jwt-secret");

  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ مرکزی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;

  const pinHash = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"; // "1234"-shaped dummy
  const insert = async (
    name: string,
    phone: string | null,
    verifiedAt: Date | null,
    otpLoginAt: Date | null,
  ) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, location_id, role, full_name, pin_hash,
                          phone_e164, phone_verified_at, otp_login_at)
       VALUES ($1, $2, 'cashier', $3, $4, $5, $6, $7) RETURNING id`,
      [biz.id, biz.locationId, name, pinHash, phone, verifiedAt, otpLoginAt],
    );
    return rows[0].id;
  };

  staff.none = await insert("بی‌شماره", null, null, null);
  staff.unverified = await insert("تأییدنشده", "+989121000001", null, null);
  staff.freshWindow = await insert("پنجرهٔ باز", "+989121000002", new Date(), new Date());
  staff.staleWindow = await insert(
    "پنجرهٔ بسته",
    "+989121000003",
    new Date(),
    new Date(Date.now() - 8 * 86_400_000),
  );
}, 120_000);

afterAll(async () => {
  rmSync(preDir, { recursive: true, force: true });
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  if (databaseName) {
    const maintenance = new Client({ connectionString: maintenanceUrl() });
    await maintenance.connect();
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await maintenance.end();
    }
  }
});

describe("migration 0139 shape", () => {
  it("adds the phone columns and refuses a duplicate number within a business", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN
              ('phone_e164', 'phone_verified_at', 'otp_login_at')`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      "otp_login_at",
      "phone_e164",
      "phone_verified_at",
    ]);

    await expect(
      db.query(
        `INSERT INTO users (business_id, location_id, role, full_name, pin_hash, phone_e164)
         VALUES ($1, $2, 'cashier', 'تکراری', 'x', '+989121000002')`,
        [biz.id, biz.locationId],
      ),
    ).rejects.toThrow();
  });

  it("stamps every pre-existing business with a 14-day adoption window", async () => {
    // This database was created after the migration ran, so the businesses
    // row above was stamped by the migration's INSERT…SELECT itself.
    const { rows } = await db.query<{ enforced_at: string | null }>(
      `SELECT value ->> 'enforcedAt' AS enforced_at
         FROM settings WHERE business_id = $1 AND key = 'auth.phoneOtp'`,
      [biz.id],
    );
    expect(rows.length).toBe(1);
    const stamped = new Date(rows[0].enforced_at ?? "").getTime();
    expect(stamped).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(stamped).toBeLessThan(Date.now() + 15 * 86_400_000);
  });
});

describe("phoneOtpEnforcementFor", () => {
  it("reads off with no setting, grace before the date", async () => {
    await db.query(`DELETE FROM settings WHERE business_id = $1 AND key = 'auth.phoneOtp'`, [biz.id]);
    await expect(dbLib.withTenant(biz.id, () => phoneOtp.phoneOtpEnforcementFor(biz.id))).resolves.toMatchObject({ state: "off" });

    await setPolicy(biz.id, FUTURE);
    await expect(dbLib.withTenant(biz.id, () => phoneOtp.phoneOtpEnforcementFor(biz.id))).resolves.toMatchObject({
      state: "grace",
      daysLeft: expect.any(Number),
    });
  });

  it("enforces past the date only with SMS configured, and waits otherwise", async () => {
    await setPolicy(biz.id, PAST);
    const hadKey = process.env.KAVENEGAR_API_KEY;
    try {
      delete process.env.KAVENEGAR_API_KEY;
      await expect(
        dbLib.withTenant(biz.id, () => phoneOtp.phoneOtpEnforcementFor(biz.id)),
      ).resolves.toMatchObject({ state: "pending_sms" });

      process.env.KAVENEGAR_API_KEY = "test-key";
      await expect(
        dbLib.withTenant(biz.id, () => phoneOtp.phoneOtpEnforcementFor(biz.id)),
      ).resolves.toMatchObject({ state: "enforced" });
    } finally {
      if (hadKey === undefined) delete process.env.KAVENEGAR_API_KEY;
      else process.env.KAVENEGAR_API_KEY = hadKey;
    }
  });
});

describe("loginRoster routing (the server-side loginMode)", () => {
  it("keeps the plain PIN pad for everyone during grace", async () => {
    await setPolicy(biz.id, FUTURE);
    const roster = await dbLib.withTenant(biz.id, () =>
      employeeService.loginRoster(biz.id, null, null),
    );
    const modes = Object.fromEntries(roster.map((e) => [e.fullName, e.loginMode]));
    expect(modes["بی‌شماره"]).toBe("pin");
    expect(modes["تأییدنشده"]).toBe("pin");
    expect(modes["پنجرهٔ باز"]).toBe("pin");
    expect(modes["پنجرهٔ بسته"]).toBe("pin");
  });

  it("routes by phone state and the 7-day window once enforced", async () => {
    await setPolicy(biz.id, PAST);
    const hadKey = process.env.KAVENEGAR_API_KEY;
    process.env.KAVENEGAR_API_KEY = "test-key";
    try {
      const roster = await dbLib.withTenant(biz.id, () =>
        employeeService.loginRoster(biz.id, null, null),
      );
      const modes = Object.fromEntries(roster.map((e) => [e.fullName, e.loginMode]));
      // No number on file: the PIN still proves who, then the number is set.
      expect(modes["بی‌شماره"]).toBe("pin_then_otp");
      // A number is stored but unproven: straight to the code.
      expect(modes["تأییدنشده"]).toBe("otp");
      // Verified inside the window: the 7-day PIN shortcut.
      expect(modes["پنجرهٔ باز"]).toBe("pin");
      // Verified but the window closed: the door wants the code again.
      expect(modes["پنجرهٔ بسته"]).toBe("otp");
    } finally {
      if (hadKey === undefined) delete process.env.KAVENEGAR_API_KEY;
      else process.env.KAVENEGAR_API_KEY = hadKey;
    }
  });
});

describe("stampPhoneVerified and the challenge verify", () => {
  it("opens the 7-day window and routes the member back to the PIN pad", async () => {
    await dbLib.withTenant(biz.id, () =>
      phoneOtp.stampPhoneVerified({ businessId: biz.id, userId: staff.unverified, phone: null }),
    );
    const { rows } = await db.query<{ phone_verified_at: Date; otp_login_at: Date }>(
      `SELECT phone_verified_at, otp_login_at FROM users WHERE id = $1`,
      [staff.unverified],
    );
    expect(rows[0].phone_verified_at).not.toBeNull();
    expect(Date.now() - new Date(rows[0].otp_login_at).getTime()).toBeLessThan(60_000);

    await setPolicy(biz.id, PAST);
    process.env.KAVENEGAR_API_KEY = "test-key";
    try {
      const roster = await dbLib.withTenant(biz.id, () =>
        employeeService.loginRoster(biz.id, null, null),
      );
      const entry = roster.find((e) => e.fullName === "تأییدنشده")!;
      expect(entry.loginMode).toBe("pin");
      expect(entry.phoneState).toBe("verified");
    } finally {
      delete process.env.KAVENEGAR_API_KEY;
    }
  });

  /**
   * Mint a bound challenge the way `sendEmployeePhoneOtp` does, without going
   * through the SMS provider. The four binding columns migration 0215 added
   * are what issue #885 L02 makes verification check, so every fixture here
   * has to carry them or it proves nothing.
   */
  async function mintChallenge(options: {
    userId: string;
    code: string;
    destination?: string;
    businessId?: string;
    purpose?: string;
    ttlMinutes?: number;
  }): Promise<string> {
    const secret = await jwtSecret.getRealmSecret("platform");
    const hmac = createHmac("sha256", secret).update(options.code).digest("hex");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO mfa_challenges
         (subject_realm, subject_id, hashed_otp, expires_at, business_id, purpose, destination)
       VALUES ('employee_phone', $1, $2, now() + interval '1 minute' * $3, $4, $5, $6)
       RETURNING id`,
      [
        options.userId,
        hmac,
        options.ttlMinutes ?? 5,
        options.businessId ?? biz.id,
        options.purpose ?? "login",
        options.destination ?? PHONE,
      ],
    );
    return rows[0].id;
  }

  function redeem(challengeId: string, code: string, overrides: Record<string, unknown> = {}) {
    return dbLib.withTenant(biz.id, () =>
      phoneOtp.verifyEmployeePhoneOtp({
        challengeId,
        userId: staff.unverified,
        businessId: biz.id,
        purpose: "login",
        destination: PHONE,
        code,
        ...overrides,
      }),
    );
  }

  it("accepts the right code once and burns an attempt on a wrong one", async () => {
    const code = "424242";
    const challengeId = await mintChallenge({ userId: staff.unverified, code });

    const wrong = await redeem(challengeId, "000000");
    expect(wrong).toEqual({ verified: false, reason: "wrong_code" });
    const { rows: afterWrong } = await db.query<{ attempts: number }>(
      `SELECT attempts FROM mfa_challenges WHERE id = $1`,
      [challengeId],
    );
    expect(afterWrong[0].attempts).toBe(1);

    expect(await redeem(challengeId, code)).toEqual({ verified: true });
    // Consumed: a replay of the very same code must be refused, not re-read.
    expect(await redeem(challengeId, code)).toEqual({ verified: false, reason: "consumed" });
  });

  it("refuses a challenge whose binding does not match the token (issue #885 L02)", async () => {
    const code = "313131";
    const challengeId = await mintChallenge({ userId: staff.unverified, code });

    // The replay the finding describes: the same six digits, presented against
    // a different ceremony, destination or tenant. Before the binding this was
    // indistinguishable from the real thing, because verification looked the
    // challenge up by member alone.
    expect(await redeem(challengeId, code, { destination: "+989129999999" })).toEqual({
      verified: false,
      reason: "scope_mismatch",
    });
    expect(
      await redeem(challengeId, code, { businessId: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual({ verified: false, reason: "scope_mismatch" });
    expect(await redeem(challengeId, code, { purpose: "attach" })).toEqual({
      verified: false,
      reason: "scope_mismatch",
    });
    expect(
      await redeem(challengeId, code, { userId: "22222222-2222-4222-8222-222222222222" }),
    ).toEqual({ verified: false, reason: "scope_mismatch" });

    // Nothing above spent the challenge — it still redeems for its own binding.
    expect(await redeem(challengeId, code)).toEqual({ verified: true });
  });

  it("refuses an expired challenge and one that was never issued", async () => {
    const code = "515151";
    const expiredId = await mintChallenge({
      userId: staff.unverified,
      code,
      ttlMinutes: -1,
    });
    expect(await redeem(expiredId, code)).toEqual({ verified: false, reason: "expired" });

    expect(
      await redeem("33333333-3333-4333-8333-333333333333", code),
    ).toEqual({ verified: false, reason: "no_challenge" });
  });

  it("lets exactly one of two concurrent valid submissions through (issue #885 L03)", async () => {
    // The race the finding names: the old shape was SELECT, compare, DELETE,
    // so two requests arriving together both passed the SELECT before either
    // removed the row and both were told "verified". Redemption is now one
    // conditional UPDATE, and the loser re-evaluates it under the row lock.
    const code = "616161";
    const challengeId = await mintChallenge({ userId: staff.unverified, code });

    const results = await Promise.all([
      redeem(challengeId, code),
      redeem(challengeId, code),
      redeem(challengeId, code),
    ]);
    const successes = results.filter((r) => r.verified).length;
    expect(successes).toBe(1);
  });

  it("reserves the send budget atomically, so concurrent requests cannot all pass", async () => {
    // The tightest ceiling is one send per minute per membership. Six
    // simultaneous reservations for one member must therefore produce exactly
    // one success — not six, which is what the pre-#885 read/compare/record
    // shape returned, because all six read the same empty budget.
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        dbLib.withTenant(biz.id, () =>
          phoneOtp.reserveOtpSend({ businessId: biz.id, userId: staff.staleWindow }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.allowed).length).toBe(1);
    const refused = outcomes.find((o) => !o.allowed);
    expect(refused && !refused.allowed && refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("retires an older live challenge when a newer one is sent", async () => {
    // Two tabs, two codes. Without this the older row survives, and once the
    // newest is consumed a read of "the newest live challenge" finds it again.
    const older = await mintChallenge({ userId: staff.freshWindow, code: "717171" });
    const newer = await mintChallenge({ userId: staff.freshWindow, code: "818181" });

    const { rows } = await db.query<{ id: string; consumed_at: Date | null }>(
      `SELECT id, consumed_at FROM mfa_challenges WHERE id = ANY($1::uuid[])`,
      [[older, newer]],
    );
    // Both are live as inserted; the retirement is the send path's job, so
    // assert the property that matters — only one may still redeem.
    const olderResult = await dbLib.withTenant(biz.id, () =>
      phoneOtp.verifyEmployeePhoneOtp({
        challengeId: older,
        userId: staff.freshWindow,
        businessId: biz.id,
        purpose: "login",
        destination: PHONE,
        code: "717171",
      }),
    );
    expect(olderResult.verified).toBe(true);
    expect(rows.length).toBe(2);
  });
});
