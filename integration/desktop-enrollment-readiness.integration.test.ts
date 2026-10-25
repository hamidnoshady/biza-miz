/**
 * Issue #1115 §A.2 — desktop enrolment readiness, against a real database under
 * row-level security.
 *
 * The decision itself is unit-tested (`desktop-enrollment-readiness.test.ts`);
 * this pins what the service *reads*: that readiness follows persisted setup
 * data and the wizard's completion marker (not a request), that an account's
 * suspension, a deactivated owner, a missing entitlement, an inactive branch
 * and a branch with no menu each block it, and that nothing leaks across
 * tenants.
 *
 * It connects as an unprivileged role so row-level security applies; run as a
 * superuser the scoped reads would succeed unscoped and the assertions would be
 * vacuous.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { readEnrollmentReadiness } from "../src/lib/desktop-enrollment-readiness-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_enroll_ready_test_role";
const APP_PASSWORD = "enroll-ready-test-password";

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
  databaseName = `pos_enroll_ready_${randomUUID().replaceAll("-", "")}`;

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

  // Point db.ts's pool at this database as the UNPRIVILEGED role, so the
  // setup-state reads run under real row-level security.
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
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

interface SeededBusiness {
  businessId: string;
  locationId: string;
}

async function seedBusiness(options: { industry?: string } = {}): Promise<SeededBusiness> {
  const slug = `enroll-${randomUUID().slice(0, 8)}`;
  const { rows } = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [`Enroll Cafe ${slug}`, slug, options.industry ?? "food_service"],
  );
  const businessId = rows[0].id;
  const { rows: locationRows } = await ownerClient.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id",
    [businessId],
  );
  return { businessId, locationId: locationRows[0].id };
}

/** Everything the wizard's required steps write for F&B, plus an owner, a payment way and a sellable menu. */
async function makeBusinessReady(seeded: SeededBusiness, options: { completed?: boolean; menuItems?: number } = {}) {
  const { businessId, locationId } = seeded;
  await ownerClient.query(
    `INSERT INTO settings (business_id, location_id, key, value) VALUES
       ($1, NULL, 'business.prefs', '{"currencyDisplay":"toman","language":"fa","calendar":"jalali"}'),
       ($1, NULL, 'inventory.costing', '{"method":"fifo","system":"perpetual","lockedAt":null}'),
       ($1, NULL, 'tax.config', '{"defaultRate":9}')
     ON CONFLICT (business_id, location_id, key) DO NOTHING`,
    [businessId],
  );
  await ownerClient.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'موجودی نقد', 'asset'), ($1, '3900', 'تراز افتتاحیه', 'equity')`,
    [businessId],
  );
  await ownerClient.query(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x')`,
    [businessId],
  );
  const { rows: methods } = await ownerClient.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_methods WHERE business_id = $1",
    [businessId],
  );
  if (Number(methods[0].n) === 0) {
    await ownerClient.query(
      `INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
       VALUES ($1, 'cash', 'نقد', 'cash', 0, true, true)`,
      [businessId],
    );
  }
  await addMenu(locationId, options.menuItems ?? 1);
  if (options.completed !== false) {
    await ownerClient.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'setup.progress', $2)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [businessId, JSON.stringify({ steps: {}, completedAt: "2026-10-01T08:00:00.000Z" })],
    );
  }
}

async function addMenu(locationId: string, items: number) {
  const { rows } = await ownerClient.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی گرم') RETURNING id`,
    [locationId],
  );
  for (let i = 0; i < items; i++) {
    await ownerClient.query(
      `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
       VALUES ($1, $2, $3, 500000, true)`,
      [locationId, rows[0].id, `آیتم ${i + 1}`],
    );
  }
}

describe("desktop enrolment readiness under row-level security", () => {
  it("runs as a role that row-level security applies to", async () => {
    const { rows } = await ownerClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0].privileged).toBe(false);
  });

  it("is ready for a finished business, at its only branch", async () => {
    const seeded = await seedBusiness();
    await makeBusinessReady(seeded);
    const result = await readEnrollmentReadiness({ businessId: seeded.businessId });
    expect(result.blockerCodes).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.locationId).toBe(seeded.locationId);
  });

  it("names the missing required steps of a half-configured business and points at the wizard", async () => {
    const seeded = await seedBusiness();
    await ownerClient.query(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x')`,
      [seeded.businessId],
    );
    await ownerClient.query(
      `INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
       VALUES ($1, 'cash', 'نقد', 'cash', 0, true, true) ON CONFLICT DO NOTHING`,
      [seeded.businessId],
    );
    const result = await readEnrollmentReadiness({ businessId: seeded.businessId });
    expect(result.ready).toBe(false);
    const incomplete = result.blockers.find((blocker) => blocker.code === "setup_incomplete");
    expect(incomplete?.missingSteps).toEqual(expect.arrayContaining(["business", "accounts", "costing", "tax", "menu"]));
    expect(incomplete?.action).toEqual({ kind: "open_cloud_setup", href: "/setup/business" });
  });

  it("derives readiness from data: ready data without the Finish stamp asks to finish, not to redo", async () => {
    const seeded = await seedBusiness();
    await makeBusinessReady(seeded, { completed: false });
    const result = await readEnrollmentReadiness({ businessId: seeded.businessId });
    expect(result.blockerCodes).toEqual(["setup_not_completed"]);
  });

  it("follows the data when the owner finishes the missing step (safe resume)", async () => {
    const seeded = await seedBusiness();
    await makeBusinessReady(seeded, { completed: false, menuItems: 0 });
    const before = await readEnrollmentReadiness({ businessId: seeded.businessId });
    expect(before.blockerCodes).toEqual(expect.arrayContaining(["setup_incomplete"]));

    await ownerClient.query(
      `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
       SELECT $1, id, 'اسپرسو', 500000, true FROM menu_categories WHERE location_id = $1 LIMIT 1`,
      [seeded.locationId],
    );
    await ownerClient.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'setup.progress', $2)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [seeded.businessId, JSON.stringify({ steps: {}, completedAt: "2026-10-02T08:00:00.000Z" })],
    );
    const after = await readEnrollmentReadiness({ businessId: seeded.businessId });
    expect(after.ready).toBe(true);
  });

  it("refuses a suspended account and a deactivated owner", async () => {
    const seeded = await seedBusiness();
    await makeBusinessReady(seeded);
    await ownerClient.query("UPDATE businesses SET status = 'suspended' WHERE id = $1", [seeded.businessId]);
    expect((await readEnrollmentReadiness({ businessId: seeded.businessId })).blockerCodes).toEqual([
      "business_suspended",
    ]);
    await ownerClient.query("UPDATE businesses SET status = 'active' WHERE id = $1", [seeded.businessId]);
    await ownerClient.query("UPDATE users SET is_active = false WHERE business_id = $1 AND role = 'owner'", [
      seeded.businessId,
    ]);
    expect((await readEnrollmentReadiness({ businessId: seeded.businessId })).blockerCodes).toEqual([
      "no_active_owner",
    ]);
  });

  it("refuses a business whose desktop-sync entitlement is switched off", async () => {
    const seeded = await seedBusiness();
    await makeBusinessReady(seeded);
    await ownerClient.query(
      `INSERT INTO feature_flags (key, name, description, default_enabled)
       VALUES ('site_cloud_sync', 'x', 'x', true) ON CONFLICT (key) DO NOTHING`,
    );
    await ownerClient.query(
      `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'site_cloud_sync', false)
       ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = false`,
      [seeded.businessId],
    );
    expect((await readEnrollmentReadiness({ businessId: seeded.businessId })).blockerCodes).toEqual(["not_entitled"]);
  });

  describe("several branches", () => {
    async function twoBranches() {
      const seeded = await seedBusiness();
      await makeBusinessReady(seeded);
      const { rows } = await ownerClient.query<{ id: string }>(
        "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ دو') RETURNING id",
        [seeded.businessId],
      );
      return { ...seeded, secondId: rows[0].id };
    }

    it("asks which branch when none was named", async () => {
      const { businessId } = await twoBranches();
      const result = await readEnrollmentReadiness({ businessId });
      expect(result.blockerCodes).toEqual(["location_required"]);
    });

    it("judges the chosen branch's own menu, not the business's", async () => {
      const { businessId, locationId, secondId } = await twoBranches();
      expect((await readEnrollmentReadiness({ businessId, locationId })).ready).toBe(true);
      const empty = await readEnrollmentReadiness({ businessId, locationId: secondId });
      expect(empty.blockerCodes).toEqual(["branch_menu_empty"]);
    });

    it("does not offer an inactive branch", async () => {
      const { businessId, locationId, secondId } = await twoBranches();
      await ownerClient.query("UPDATE locations SET is_active = false WHERE id = $1", [secondId]);
      const result = await readEnrollmentReadiness({ businessId, locationId: secondId });
      expect(result.blockerCodes).toEqual(["location_unavailable"]);
      // With the second branch retired, the remaining one is simply the branch.
      expect((await readEnrollmentReadiness({ businessId })).locationId).toBe(locationId);
    });
  });

  it("never reads another tenant's branch", async () => {
    const mine = await seedBusiness();
    await makeBusinessReady(mine);
    const theirs = await seedBusiness();
    await makeBusinessReady(theirs);
    const result = await readEnrollmentReadiness({ businessId: mine.businessId, locationId: theirs.locationId });
    expect(result.blockerCodes).toEqual(["location_unavailable"]);
    expect(result.locationId).toBeNull();
  });

  it("skips the menu check for an industry whose wizard has no menu step", async () => {
    const seeded = await seedBusiness({ industry: "service_saas" });
    await ownerClient.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES
         ($1, NULL, 'business.prefs', '{"currencyDisplay":"toman","language":"fa","calendar":"jalali"}'),
         ($1, NULL, 'tax.config', '{"defaultRate":9}'),
         ($1, NULL, 'setup.progress', $2)`,
      [seeded.businessId, JSON.stringify({ steps: {}, completedAt: "2026-10-01T08:00:00.000Z" })],
    );
    await ownerClient.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'نقد', 'asset')`,
      [seeded.businessId],
    );
    await ownerClient.query(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x')`,
      [seeded.businessId],
    );
    await ownerClient.query(
      `INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
       VALUES ($1, 'cash', 'نقد', 'cash', 0, true, true) ON CONFLICT DO NOTHING`,
      [seeded.businessId],
    );
    const result = await readEnrollmentReadiness({ businessId: seeded.businessId });
    expect(result.blockerCodes).toEqual([]);
  });
});
