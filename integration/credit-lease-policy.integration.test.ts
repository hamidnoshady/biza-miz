/**
 * Migration 0257 (issue #998, Phase 0): the credit lease settings and the
 * offline meter registry are seeded to exactly what the pure policy module
 * assumes, and their constraints refuse the values that would grant unbounded
 * debt or an unknown lock policy.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { CREDIT_LEASE_SETTINGS_DEFAULT, validateCreditLeaseSettings } from "../src/lib/billing/credit-lease/policy";
import { OFFLINE_METER_SEEDS } from "../src/lib/billing/credit-lease/offline-meters";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `credit_lease_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Client({ connectionString: rootDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  const admin = new Client({ connectionString: rootDatabaseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("credit lease defaults", () => {
  it("seed one row equal to the policy module's defaults", async () => {
    const { rows } = await db.query(
      `SELECT offline_window_days, debt_ceiling_rial::bigint AS debt_ceiling_rial, over_lease_price_bps, lock_policy
         FROM credit_lease_defaults`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const fromDb = {
      offlineWindowDays: row.offline_window_days,
      debtCeilingRial: Number(row.debt_ceiling_rial),
      overLeasePriceBps: row.over_lease_price_bps,
      lockPolicy: row.lock_policy,
    };
    expect(fromDb).toEqual(CREDIT_LEASE_SETTINGS_DEFAULT);
    expect(validateCreditLeaseSettings(fromDb)).toBeNull();
  });

  it("refuse a second row and out-of-range values", async () => {
    await expect(db.query(`INSERT INTO credit_lease_defaults (id) VALUES (false)`)).rejects.toThrow();
    await expect(db.query(`UPDATE credit_lease_defaults SET debt_ceiling_rial = -1`)).rejects.toThrow();
    await expect(db.query(`UPDATE credit_lease_defaults SET offline_window_days = 31`)).rejects.toThrow();
    await expect(db.query(`UPDATE credit_lease_defaults SET over_lease_price_bps = 0`)).rejects.toThrow();
    await expect(db.query(`UPDATE credit_lease_defaults SET lock_policy = 'wipe'`)).rejects.toThrow();
  });
});

describe("credit lease plan overrides", () => {
  it("accept NULL fields, validate set fields, and follow the plan on delete", async () => {
    const key = `plan_${randomUUID().slice(0, 8)}`;
    await db.query(`INSERT INTO billing_plans (key, name) VALUES ($1, 'Test plan')`, [key]);
    await db.query(`INSERT INTO credit_lease_plan_overrides (plan_key, debt_ceiling_rial) VALUES ($1, 5000000)`, [key]);
    const { rows } = await db.query(`SELECT offline_window_days, lock_policy FROM credit_lease_plan_overrides WHERE plan_key = $1`, [key]);
    expect(rows[0]).toEqual({ offline_window_days: null, lock_policy: null });
    await expect(db.query(`UPDATE credit_lease_plan_overrides SET lock_policy = 'wipe' WHERE plan_key = $1`, [key])).rejects.toThrow();
    await db.query(`DELETE FROM billing_plans WHERE key = $1`, [key]);
    const after = await db.query(`SELECT 1 FROM credit_lease_plan_overrides WHERE plan_key = $1`, [key]);
    expect(after.rowCount).toBe(0);
  });
});

describe("credit offline meter registry", () => {
  it("is seeded with the agreed three meters, all in shadow", async () => {
    const { rows } = await db.query<{ meter_key: string; unit: string; installs: string[]; mode: string }>(
      `SELECT meter_key, unit, installs, mode FROM credit_offline_meters ORDER BY sort_order`,
    );
    expect(rows.map((r) => ({ key: r.meter_key, unit: r.unit, installs: r.installs, mode: r.mode }))).toEqual(
      OFFLINE_METER_SEEDS.map((m) => ({ key: m.key, unit: m.unit, installs: [...m.installs], mode: m.mode })),
    );
  });

  it("lets the superadmin add a meter by data, and refuses a malformed one", async () => {
    await db.query(
      `INSERT INTO credit_offline_meters (meter_key, name, unit, installs) VALUES ('reports.export_run', 'Test', 'run', ARRAY['local'])`,
    );
    const { rows } = await db.query(`SELECT mode FROM credit_offline_meters WHERE meter_key = 'reports.export_run'`);
    expect(rows[0].mode).toBe("shadow");
    await expect(
      db.query(`INSERT INTO credit_offline_meters (meter_key, name, unit, installs) VALUES ('NoDot', 'x', 'u', ARRAY['local'])`),
    ).rejects.toThrow();
    await expect(
      db.query(`INSERT INTO credit_offline_meters (meter_key, name, unit, installs) VALUES ('a.b', 'x', 'u', ARRAY['cloud'])`),
    ).rejects.toThrow();
    await expect(
      db.query(`INSERT INTO credit_offline_meters (meter_key, name, unit, installs) VALUES ('a.c', 'x', 'u', ARRAY[]::text[])`),
    ).rejects.toThrow();
    await expect(db.query(`UPDATE credit_offline_meters SET mode = 'sometimes' WHERE meter_key = 'reports.export_run'`)).rejects.toThrow();
  });
});
