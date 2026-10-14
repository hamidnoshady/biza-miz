/**
 * The catalog-driven sweep's future-schema guarantee, proven on a real
 * database (issue #822): reset defines the operational scope as "every live
 * foreign key into `businesses(id)`, minus the preserved commercial
 * allowlist". A migration that adds a NEW operational tenant table therefore
 * becomes part of the reset automatically — no reset code change, no second
 * static list to remember — while the preserved scope and the first-run state
 * behave exactly as contracted.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { runMigrations } from "../scripts/migrate";
import { afterAll, beforeAll, expect, it } from "vitest";

const rootDatabaseUrl = process.env.DATABASE_URL;
let databaseName = "";
let db: Client;

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
  databaseName = `pos_reset_future_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  const { getPool } = await import("../src/lib/db");
  await getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

it("sweeps a tenant table that does not exist in any reset list yet, and keeps the root and first-run state", async () => {
  // The exact shape a new tenant table takes in this schema: a single-column
  // FK into businesses(id). Nothing about it is known to the reset code.
  await db.query(`
    CREATE TABLE zz_future_widget_registry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      widget_key text NOT NULL
    )`);

  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, 'hash', 'Future Owner') RETURNING id`,
    [`future-${randomUUID().slice(0, 8)}@example.com`],
  );
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, plan) VALUES ('Future Co', $1, 'business') RETURNING id`,
    [`future-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;
  const oldBranch = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Pre-reset branch') RETURNING id`,
    [businessId],
  );
  await db.query(
    `INSERT INTO users (business_id, platform_user_id, role, full_name)
     VALUES ($1, $2, 'owner', 'Future Owner')`,
    [businessId, identity.rows[0].id],
  );
  await db.query(
    `INSERT INTO zz_future_widget_registry (business_id, widget_key) VALUES ($1, 'w-1'), ($1, 'w-2')`,
    [businessId],
  );

  const { resetBusiness } = await import("../src/lib/platform-service");
  await resetBusiness(businessId);

  // Discovered from the live catalog and swept — nobody added this table to
  // any reset list.
  const { rows: widgets } = await db.query(
    `SELECT count(*)::text AS n FROM zz_future_widget_registry WHERE business_id = $1`,
    [businessId],
  );
  expect(widgets[0].n).toBe("0");

  // The root row survives (same id — the whole point of the #822 refactor)…
  expect((await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [businessId])).rowCount).toBe(1);

  // …the pre-reset branch is gone, replaced by exactly one blank default
  // branch, and the owner's global login identity is untouched.
  const { rows: locations } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE business_id = $1`,
    [businessId],
  );
  expect(locations).toHaveLength(1);
  expect(locations[0]).toMatchObject({ name: "شعبه مرکزی" });
  expect(locations[0].id).not.toBe(oldBranch.rows[0].id);
  expect(
    (await db.query(`SELECT 1 FROM platform_users WHERE id = $1`, [identity.rows[0].id])).rowCount,
  ).toBe(1);
});
