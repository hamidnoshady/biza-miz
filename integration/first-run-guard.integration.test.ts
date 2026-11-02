/**
 * `hasAnyUser()` is the guard on every first-run path — the root page's
 * login-or-wizard choice, and the two routes (`/api/setup/bootstrap`,
 * `/api/setup/pair`) that refuse to run twice. All four ask it with no tenant
 * scope, because at that point there is no tenant to scope to.
 *
 * That makes it exactly the question row-level security is designed to refuse
 * to answer: an unscoped `SELECT count(*) FROM users` under an unprivileged
 * role matches no policy and returns 0 no matter how many users exist. This
 * test connects as such a role — the same paranoia as
 * tenant-isolation.integration.test.ts, and for the same reason: run as a
 * superuser, it would pass vacuously.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";
import { hasAnyUser } from "../src/lib/setup-state";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_first_run_test_role";
const APP_PASSWORD = "first-run-test-password";

let databaseName: string;
let ownerClient: Client;

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

/** See pairing.integration.test.ts: db.ts caches its pool on globalThis. */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

beforeAll(async () => {
  databaseName = `pos_first_run_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({
    databaseUrl: ownerUrl,
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();

  // Point db.ts's pool at this database as the UNPRIVILEGED role, so
  // hasAnyUser() runs under real row-level security.
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
}, 120_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await ownerClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

describe("hasAnyUser", () => {
  it("runs as a role that row-level security applies to", async () => {
    // If this fails, the assertion below is vacuous.
    const { rows } = await ownerClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0].privileged).toBe(false);
  });

  it("is false on an empty install", async () => {
    expect(await hasAnyUser()).toBe(false);
  });

  it("is true once a user exists, even with no tenant scope to see it through", async () => {
    const biz = await ownerClient.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('First Run Cafe', 'first-run-cafe') RETURNING id",
    );
    const businessId = biz.rows[0].id;
    const loc = await ownerClient.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [businessId],
    );
    await ownerClient.query(
      `INSERT INTO users (business_id, location_id, full_name, role, password_hash)
       VALUES ($1, $2, 'Owner', 'owner', 'x')`,
      [businessId, loc.rows[0].id],
    );

    expect(await hasAnyUser()).toBe(true);
  });
});
