/**
 * Issue #885 L10 — forgotten-password initiation, against a real database.
 *
 * The route's non-enumeration contract is asserted against the handler in
 * `src/app/api/auth/password-reset/request/route.test.ts`. What only a
 * database can prove is the other half:
 *
 *  1. A request for a real address actually mints a row in
 *     `auth_password_resets`, and mints it for that user and no one else.
 *  2. Issuing revokes the address's previous pending token, so two requests
 *     do not leave two live links in the wild.
 *  3. The rate limit bites against real rows, at the boundary the policy
 *     names — not one request early or one late.
 *  4. A deactivated account is refused without minting anything.
 *
 * No mail leaves the process: nothing is listening on the SMTP port the
 * fixture points at, and the send is fire-and-forget by design (see the
 * service), so a refused connection is caught and logged, not surfaced.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let resetRequest: typeof import("../src/lib/password-reset-request");
let dbLib: typeof import("../src/lib/db");

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

const users = { active: "", inactive: "", rateLimit: "" };

/** Insert a platform user directly; the login flow is not what is under test. */
async function seedUser(email: string, isActive: boolean): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    // A bcrypt-shaped dummy: this flow never compares a password.
    [email, "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", "مدیر آزمون", isActive],
  );
  return rows[0].id;
}

/**
 * Every row ever created for a user, spent or not.
 *
 * Distinct from `pendingResetCount` on purpose: `issuePasswordResetToken`
 * revokes the previous pending token when it issues a new one, so the
 * *pending* count is pinned at one no matter how many requests were made.
 * The rate limit is charged against history, so that is what this reads.
 */
async function totalResetCount(userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_password_resets
      WHERE subject_realm = 'platform_user' AND subject_id = $1`,
    [userId],
  );
  return Number.parseInt(rows[0].n, 10);
}

async function pendingResetCount(userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_password_resets
      WHERE subject_realm = 'platform_user' AND subject_id = $1
        AND used_at IS NULL AND revoked_at IS NULL`,
    [userId],
  );
  return Number.parseInt(rows[0].n, 10);
}

beforeAll(async () => {
  databaseName = `pos_pwd_reset_req_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Must be set before the first import of the module under test: it reads
  // the base URL at call time, but the db pool binds on first import.
  process.env.DATABASE_URL = urlFor(databaseName);
  // Both imported after DATABASE_URL is repointed: the pool resolves its
  // connection string on first import, so importing earlier would bind the
  // module under test to the maintenance database.
  dbLib = await import("../src/lib/db");
  resetRequest = await import("../src/lib/password-reset-request");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  users.active = await seedUser("manager@example.com", true);
  users.inactive = await seedUser("departed@example.com", false);
  users.rateLimit = await seedUser("ratelimit@example.com", true);

  // Point the platform's message config at an address nothing listens on, so
  // `resolveMessageConfig()` reports SMTP as usable and the flow proceeds to
  // mint. The send itself fails harmlessly into the service's catch.
  await db.query(
    `INSERT INTO platform_message_config
       (id, enabled, email_provider, smtp_host, smtp_port, smtp_from)
     VALUES (true, true, 'smtp', '127.0.0.1', 1, 'noreply@example.com')`,
  );
}, 180_000);

beforeEach(() => {
  vi.stubEnv("PLATFORM_BASE_URL", "https://pos.example.com");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.end();
  // The service queries through the app pool, not the test client, so that
  // pool is still holding the database open here. DROP refuses while any
  // session is attached, so it has to be closed first — otherwise every test
  // passes and the *file* still fails on teardown.
  await dbLib?.closeDatabasePool().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  if (!rootDatabaseUrl) return;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
});

describe("forgotten-password initiation", () => {
  it("mints a reset for an address that exists", async () => {
    const result = await resetRequest.requestPlatformUserPasswordReset("manager@example.com");

    expect(result.outcome).toBe("sent");
    if (result.outcome !== "sent") return;
    expect(result.subjectId).toBe(users.active);
    expect(await pendingResetCount(users.active)).toBe(1);
  });

  it("mints nothing for an address that does not exist", async () => {
    const result = await resetRequest.requestPlatformUserPasswordReset("nobody@example.com");

    expect(result.outcome).toBe("unknown_email");
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_password_resets WHERE email = 'nobody@example.com'`,
    );
    expect(Number.parseInt(rows[0].n, 10)).toBe(0);
  });

  it("mints nothing for a deactivated account", async () => {
    const result = await resetRequest.requestPlatformUserPasswordReset("departed@example.com");

    expect(result.outcome).toBe("inactive");
    expect(await pendingResetCount(users.inactive)).toBe(0);
  });

  it("is case- and whitespace-insensitive about the address", async () => {
    // citext on the column and a normalised lookup have to agree, or the rate
    // limit could be evaded by respelling the address.
    const result = await resetRequest.requestPlatformUserPasswordReset(
      "  MANAGER@Example.COM ",
    );

    expect(result.outcome).toBe("sent");
    if (result.outcome !== "sent") return;
    expect(result.subjectId).toBe(users.active);
  });

  it("leaves only one live link after repeated requests", async () => {
    await resetRequest.requestPlatformUserPasswordReset("manager@example.com");
    await resetRequest.requestPlatformUserPasswordReset("manager@example.com");

    // A second request must not leave the first link usable.
    expect(await pendingResetCount(users.active)).toBe(1);
  });

  it("refuses once the hourly cap is spent, at exactly the boundary", async () => {
    const hourly = resetRequest.PASSWORD_RESET_REQUEST_LIMITS[0];
    const EMAIL = "ratelimit@example.com";

    // A user nothing else in this file has touched, so the count starts at
    // zero and the boundary is the policy's own rather than whatever earlier
    // cases happened to leave behind.
    expect(await totalResetCount(users.rateLimit)).toBe(0);

    // The decision runs before the row is written, so exactly `max` requests
    // are served and the next one is refused.
    for (let i = 0; i < hourly.max; i += 1) {
      const allowed = await resetRequest.requestPlatformUserPasswordReset(EMAIL);
      expect(allowed.outcome, `request ${i + 1} of ${hourly.max}`).toBe("sent");
    }
    expect(await totalResetCount(users.rateLimit)).toBe(hourly.max);

    const refused = await resetRequest.requestPlatformUserPasswordReset(EMAIL);
    expect(refused.outcome).toBe("rate_limited");
    if (refused.outcome !== "rate_limited") return;
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(hourly.windowMs);

    // And refusing minted nothing — the cap cannot be spent twice.
    expect(await totalResetCount(users.rateLimit)).toBe(hourly.max);
  });

  it("records requests against the right user only", async () => {
    // The deactivated user must have no rows at all, whatever the active one
    // has accumulated.
    expect(await pendingResetCount(users.inactive)).toBe(0);
  });
});
