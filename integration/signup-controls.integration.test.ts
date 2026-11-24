/**
 * Issue #1388 — the runtime public-registration control and the funnel ledger,
 * against a real database.
 *
 * Proves:
 *  - a stored control governs both signup doors, and the environment gate is
 *    only the fallback when no control was ever saved;
 *  - maintenance is a distinct refusal;
 *  - an enabled control can open registration on a deployment whose env gate
 *    was never set;
 *  - the funnel records the requested/sent/verified/created facts with ids
 *    only — no phone, code or token anywhere in the ledger row;
 *  - the account inspector masks by default and only the explicit reveal
 *    returns the full contact details;
 *  - authentication SMS never touches a business wallet.
 *
 * Codes are captured by an injected transport and never printed.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://pos:pos@localhost:5432/pos";

let databaseName: string;
let db: typeof import("../src/lib/db");
let signup: typeof import("../src/lib/iam/public-signup");
let controls: typeof import("../src/lib/iam/signup-controls");
let events: typeof import("../src/lib/iam/signup-events");
let maskPhoneE164: typeof import("../src/lib/phone-otp").maskPhoneE164;
let adminId: string;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function uniquePhone(): string {
  const tail = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  return `+98912${tail}`;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.withoutTenantScope("platform", () =>
    db.query<{ count: string }>(sql, params),
  );
  return Number(rows[0].count);
}

async function save(input: {
  enabled: boolean;
  maintenance: boolean;
  message?: string | null;
}): Promise<void> {
  await controls.saveSignupControls(
    {
      publicSignupEnabled: input.enabled,
      maintenanceMode: input.maintenance,
      maintenanceMessage: input.message ?? null,
    },
    adminId,
  );
}

async function requestAndVerify(phone: string): Promise<{
  code: string;
  requestToken: string;
  platformUserId: string;
}> {
  let code = "";
  const requested = await signup.requestSignupOtp(
    { firstName: "نگار", lastName: "احمدی", phone },
    {
      sendOtp: async (deliveredTo, deliveredCode) => {
        expect(deliveredTo).toBe(phone);
        code = deliveredCode;
      },
    },
  );
  expect(requested.ok).toBe(true);
  if (!requested.ok) throw new Error(`request failed: ${requested.error}`);

  const verified = await signup.verifySignupOtp({
    firstName: "نگار",
    lastName: "احمدی",
    phone,
    code,
    requestToken: requested.requestToken,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(`verify failed: ${verified.error}`);
  return { code, requestToken: requested.requestToken, platformUserId: verified.platformUserId };
}

beforeAll(async () => {
  databaseName = `pos_signup_controls_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.JWT_SECRET = "signup-controls-integration-secret-".padEnd(64, "x");
  process.env.POS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.ALLOW_PUBLIC_SIGNUP = "true";
  delete (globalThis as { pgPool?: unknown }).pgPool;

  db = await import("../src/lib/db");
  signup = await import("../src/lib/iam/public-signup");
  controls = await import("../src/lib/iam/signup-controls");
  events = await import("../src/lib/iam/signup-events");
  ({ maskPhoneE164 } = await import("../src/lib/phone-otp"));

  const { rows } = await db.withoutTenantScope("platform", () =>
    db.query<{ id: string }>(
      `INSERT INTO platform_admins (email, password_hash, full_name)
       VALUES ('signup-controls@example.invalid', 'x', 'مدیر آزمون')
       RETURNING id`,
    ),
  );
  adminId = rows[0].id;
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

describe("the stored registration control", () => {
  it("closes both doors when disabled and opens them when enabled, regardless of the env gate", async () => {
    // No row yet: the environment gate is the fallback.
    process.env.ALLOW_PUBLIC_SIGNUP = "false";
    const fallback = await controls.loadSignupGate();
    expect(fallback).toMatchObject({ enabled: false, source: "environment", readable: true });

    // A saved control opens the door even though the deployment gate is off.
    await save({ enabled: true, maintenance: false });
    expect(await controls.loadSignupGate()).toMatchObject({ enabled: true, source: "runtime" });

    const opened = await requestAndVerify(uniquePhone());
    expect(opened.platformUserId).toMatch(/^[0-9a-f-]{36}$/);

    // A saved control closes the door even though the deployment gate is on.
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    await save({ enabled: false, maintenance: false });
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
  });

  it("reports maintenance as its own refusal, even with registration enabled", async () => {
    await save({ enabled: true, maintenance: true, message: "تعمیرات شبکه" });
    expect(await controls.loadSignupGate()).toMatchObject({
      enabled: false,
      reason: "maintenance",
      source: "runtime",
    });

    expect(
      await signup.requestSignupOtp({
        firstName: "نگار",
        lastName: "احمدی",
        phone: "09121234568",
      }),
    ).toEqual({ ok: false, error: "signup_maintenance" });

    await save({ enabled: true, maintenance: false });
  });

  it("records who changed the control and the before/after values", async () => {
    await save({ enabled: false, maintenance: true, message: "توقف کوتاه" });
    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{
        public_signup_enabled: boolean;
        maintenance_mode: boolean;
        maintenance_message: string | null;
        updated_by: string | null;
        updated_by_name: string;
      }>(
        `SELECT s.public_signup_enabled, s.maintenance_mode, s.maintenance_message,
                s.updated_by, pa.full_name AS updated_by_name
           FROM platform_signup_settings s
           LEFT JOIN platform_admins pa ON pa.id = s.updated_by
          WHERE s.id = 1`,
      ),
    );
    expect(rows[0]).toMatchObject({
      public_signup_enabled: false,
      maintenance_mode: true,
      maintenance_message: "توقف کوتاه",
      updated_by: adminId,
      updated_by_name: "مدیر آزمون",
    });
    await save({ enabled: true, maintenance: false });
  });
});

describe("the signup funnel and account inspection", () => {
  it("records facts-only events and never debits a tenant wallet", async () => {
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
    await save({ enabled: true, maintenance: false });

    const phone = uniquePhone();
    const { code, platformUserId } = await requestAndVerify(phone);

    const funnel = await events.getSignupFunnel(30);
    const countOf = (event: string) =>
      funnel.totals.find((row) => row.event === event)?.count ?? 0;
    expect(countOf("otp_requested")).toBeGreaterThanOrEqual(1);
    expect(countOf("otp_sent")).toBeGreaterThanOrEqual(1);
    expect(countOf("otp_verified")).toBeGreaterThanOrEqual(1);
    expect(countOf("account_created")).toBeGreaterThanOrEqual(1);

    // No ledger row may contain the number, the code or a token.
    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{ row: string }>(
        `SELECT to_jsonb(e)::text AS row FROM platform_signup_events e`,
      ),
    );
    for (const entry of rows) {
      expect(entry.row).not.toContain(phone);
      expect(entry.row).not.toContain(code);
      expect(entry.row).not.toContain("requestToken");
    }

    // A phone-first signup creates a person, not a business or a wallet.
    expect(await count(`SELECT count(*)::text AS count FROM business_wallets`)).toBe(0);

    const masked = await events.findSignupAccount(platformUserId);
    expect(masked).not.toBeNull();
    expect(masked!.maskedPhone).toBe(maskPhoneE164(phone));
    expect(JSON.stringify(masked)).not.toContain(phone);

    const revealed = await events.revealSignupAccountContact(platformUserId);
    expect(revealed).toMatchObject({ phone, accountId: platformUserId });
    expect(JSON.stringify(revealed)).not.toMatch(/national|password|hash|otp/i);
  });
});
