/**
 * Locked-account enumeration regression (issue #843, item 12).
 *
 * The login doors used to check the lockout *before* comparing the password,
 * so a caller who never had the password could send one wrong guess at an
 * address and read the status code: 423 told them the account exists and is
 * locked, 401 that it does not (or is not). The lockout verdict is only
 * actionable to someone who has proven the password, so it must be disclosed
 * after that proof and never before.
 *
 * These tests drive the real route handlers:
 *  - wrong password + unlocked  → 401 invalid_credentials
 *  - wrong password + locked    → 401 invalid_credentials (identical body)
 *  - correct password + locked  → 423 account_locked
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
const globalForPg = globalThis as unknown as { pgPool?: Pool };
type DbLib = typeof import("../src/lib/db");
type LockoutService = typeof import("../src/lib/login-lockout-service");
let dbLib: DbLib;
let lockout: LockoutService;
let loginRoute: typeof import("../src/app/api/auth/login/route");
let directoryRoute: typeof import("../src/app/api/auth/directory/route");
let platformLoginRoute: typeof import("../src/app/api/platform/auth/login/route");

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
  databaseName = `pos_lockout_enum_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  lockout = await import("../src/lib/login-lockout-service");
  loginRoute = await import("../src/app/api/auth/login/route");
  directoryRoute = await import("../src/app/api/auth/directory/route");
  platformLoginRoute = await import("../src/app/api/platform/auth/login/route");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
});

async function lockAccount(realm: "tenant_password" | "directory" | "platform_admin", email: string, times: number) {
  for (let i = 0; i < times; i += 1) await lockout.recordAuthFailure(realm, email);
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("locked password accounts are not enumerable before the password is proven", () => {
  it("answers a wrong password identically whether or not the tenant account is locked", async () => {
    const email = `tenant-${randomUUID()}@example.com`;
    await db.query(
      `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, $2, 'مالک')`,
      [email, await bcrypt.hash("correct-horse", 4)],
    );

    const unlocked = await loginRoute.POST(post("http://localhost/api/auth/login", { email, password: "wrong" }));
    expect(unlocked.status).toBe(401);
    expect(await unlocked.json()).toEqual({ error: "invalid_credentials" });

    // Five failures lock the account (PASSWORD_LOCKOUT_POLICY).
    await lockAccount("tenant_password", email, 5);
    const lockedWrong = await loginRoute.POST(post("http://localhost/api/auth/login", { email, password: "wrong" }));
    expect(lockedWrong.status).toBe(401);
    expect(await lockedWrong.json()).toEqual({ error: "invalid_credentials" });

    // Unknown email: the same answer, via the dummy-hash comparison.
    const unknown = await loginRoute.POST(post("http://localhost/api/auth/login", { email: `nobody-${randomUUID()}@example.com`, password: "wrong" }));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "invalid_credentials" });

    // The owner who actually knows the password still gets the actionable
    // locked response.
    const correct = await loginRoute.POST(post("http://localhost/api/auth/login", { email, password: "correct-horse" }));
    expect(correct.status).toBe(423);
    const body = (await correct.json()) as { error?: string; lockedUntil?: string };
    expect(body.error).toBe("account_locked");
    expect(body.lockedUntil).toBeTruthy();
  }, 120_000);

  it("applies the same ordering to the apex directory door", async () => {
    const email = `directory-${randomUUID()}@example.com`;
    await db.query(
      `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, $2, 'مالک')`,
      [email, await bcrypt.hash("correct-horse", 4)],
    );
    await lockAccount("directory", email, 5);

    const wrong = await directoryRoute.POST(post("http://localhost/api/auth/directory", { email, password: "wrong" }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });

    const correct = await directoryRoute.POST(post("http://localhost/api/auth/directory", { email, password: "correct-horse" }));
    expect(correct.status).toBe(423);
    expect(((await correct.json()) as { error?: string }).error).toBe("account_locked");
  }, 120_000);

  it("applies the same ordering to the platform-admin door", async () => {
    const email = `admin-${randomUUID()}@example.com`;
    await db.query(
      `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, $2, 'اپراتور')`,
      [email, await bcrypt.hash("correct-horse", 4)],
    );
    // PLATFORM_LOCKOUT_POLICY locks after three failures.
    await lockAccount("platform_admin", email, 3);

    const wrong = await platformLoginRoute.POST(post("http://localhost/api/platform/auth/login", { email, password: "wrong" }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });

    const correct = await platformLoginRoute.POST(post("http://localhost/api/platform/auth/login", { email, password: "correct-horse" }));
    expect(correct.status).toBe(423);
    expect(((await correct.json()) as { error?: string }).error).toBe("account_locked");
  }, 120_000);
});
