/**
 * Issue #808 — the setup lifecycle, against a real database under row-level
 * security.
 *
 * Three contracts are pinned here, all of which the old implementation got
 * wrong:
 *
 *   1. **Formal completion is `setup.progress.completedAt` alone.** A business
 *      whose required markers are all present but which never reached Finish
 *      is *not* complete (it used to be), and a stamped business is complete
 *      whatever its markers say.
 *   2. **Readiness is derived from persisted data, and the markers heal to
 *      match it.** A menu with a category and no active item is not ready and
 *      clears a stale marker; a business whose data exists but whose marker was
 *      lost gets the marker back on the next state read.
 *   3. **Concurrent progress writes cannot erase one another**, and the
 *      completion stamp is written exactly once.
 *
 * It connects as an unprivileged role — the same paranoia as
 * tenant-isolation.integration.test.ts, because run as a superuser the reads
 * would succeed unscoped and the assertions would be vacuous — and calls the
 * functions with no ambient scope at all, reproducing the server-component
 * case (see the `withTenantScope` doc comment in src/lib/auth.ts: a background
 * tick's `.run()` can clobber `enterWith()` scope mid-request).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { withTenant } from "../src/lib/db";
import {
  getWizardProgress,
  markSetupComplete,
  markStepDone,
  SETTING_KEYS,
} from "../src/lib/settings";
import { computeSetupState, isSetupComplete } from "../src/lib/setup-state";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_setup_complete_test_role";
const APP_PASSWORD = "setup-complete-test-password";

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
  databaseName = `pos_setup_complete_${randomUUID().replaceAll("-", "")}`;

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

/**
 * A business (and its first branch) with an optional `setup.progress` row.
 * Everything else — accounts, settings, menu — is added by the individual
 * test, so "ready" is never an accident of the fixture.
 */
async function seedBusiness(options: {
  industry?: string;
  steps?: string[];
  completedAt?: string | null;
} = {}): Promise<SeededBusiness> {
  const slug = `wizard-${randomUUID().slice(0, 8)}`;
  const { rows } = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [`Wizard Cafe ${slug}`, slug, options.industry ?? "food_service"],
  );
  const businessId = rows[0].id;

  const { rows: locationRows } = await ownerClient.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id",
    [businessId],
  );

  if (options.steps || options.completedAt !== undefined) {
    const stepMap: Record<string, string> = {};
    for (const step of options.steps ?? []) stepMap[step] = "2026-01-01T00:00:00.000Z";
    await ownerClient.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'setup.progress', $2)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [businessId, JSON.stringify({ steps: stepMap, completedAt: options.completedAt ?? null })],
    );
  }

  return { businessId, locationId: locationRows[0].id };
}

/** Everything a first-run wizard's business/accounts/tax/costing steps write, plus a sellable F&B menu. */
async function makeBusinessReady(seeded: SeededBusiness, options: { menuItems?: number } = {}) {
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

  const { rows: categoryRows } = await ownerClient.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی گرم') RETURNING id`,
    [locationId],
  );
  for (let i = 0; i < (options.menuItems ?? 1); i++) {
    await ownerClient.query(
      `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
       VALUES ($1, $2, $3, 500000, true)`,
      [locationId, categoryRows[0].id, `آیتم ${i + 1}`],
    );
  }
  if ((options.menuItems ?? 1) === 0) {
    // An inactive item is still "a menu exists" but not a sellable one: the
    // category-with-inactive-item shape must not satisfy readiness either.
    await ownerClient.query(
      `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
       VALUES ($1, $2, 'غیرفعال', 500000, false)`,
      [locationId, categoryRows[0].id],
    );
  }
}

describe("setup completeness under row-level security", () => {
  it("runs as a role that row-level security applies to", async () => {
    // If this fails, the assertions below are vacuous.
    const { rows } = await ownerClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0].privileged).toBe(false);
  });

  it("is incomplete when every required marker is present but Finish was never reached", async () => {
    // The exact state the old fallback called "complete": the owner had
    // satisfied business -> accounts -> costing -> tax -> menu and would have
    // been ejected before Hardware / Backup / Opening / Finish (issue #808 §1).
    const { businessId } = await seedBusiness({
      steps: ["business", "accounts", "costing", "tax", "menu"],
    });

    // No ambient scope on purpose — this is the server-component case.
    expect(await isSetupComplete(businessId)).toBe(false);
  });

  it("is complete once completedAt is stamped, even with steps missing", async () => {
    const { businessId } = await seedBusiness({
      steps: ["business"],
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(await isSetupComplete(businessId)).toBe(true);
  });

  it("derives readiness from data and heals the markers to match it", async () => {
    const seeded = await seedBusiness({ steps: ["business", "accounts", "costing", "tax"] });
    await makeBusinessReady(seeded, { menuItems: 0 });

    // The menu marker is absent and there is no sellable item: the wizard
    // still has work to do, and the stale `menu` idea of "a category is a
    // menu" is not accepted even if a marker said so.
    const before = await computeSetupState(seeded.businessId);
    expect(before.readiness.ready).toBe(false);
    expect(before.missingForCompletion.join(" ")).toContain("آیتم فعال");
    expect(before.progress.steps.menu).toBeFalsy();

    // Selling data arrives. Readiness follows it, and the marker is repaired
    // without any endpoint calling markStepDone.
    await ownerClient.query(
      `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
       SELECT $1, id, 'اسپرسو', 500000, true FROM menu_categories WHERE location_id = $1 LIMIT 1`,
      [seeded.locationId],
    );
    const after = await computeSetupState(seeded.businessId);
    expect(after.missingForCompletion).toEqual([]);
    expect(after.readiness.ready).toBe(true);
    expect(after.progress.steps.business).toBeTruthy();
    expect(after.progress.steps.accounts).toBeTruthy();
    expect(after.progress.steps.menu).toBeTruthy();

    // And the repair is persisted, not just returned.
    const stored = await withTenant(seeded.businessId, () => getWizardProgress(seeded.businessId));
    expect(stored.steps.menu).toBeTruthy();
  });

  it("clears a marker the data does not support", async () => {
    const seeded = await seedBusiness({ steps: ["menu"] });
    await makeBusinessReady(seeded, { menuItems: 0 });

    const state = await computeSetupState(seeded.businessId);
    expect(state.progress.steps.menu).toBeFalsy();
    expect(state.missingForCompletion).toContain("منو باید حداقل یک آیتم فعال و قابل فروش داشته باشد.");
  });

  it("walks the industry matrix: the same data is ready for retail and not for F&B", async () => {
    const retail = await seedBusiness({ industry: "jewelry" });
    const cafe = await seedBusiness({ industry: "food_service" });
    for (const seeded of [retail, cafe]) {
      await ownerClient.query(
        `INSERT INTO settings (business_id, location_id, key, value) VALUES
           ($1, NULL, 'business.prefs', '{"currencyDisplay":"toman","language":"fa","calendar":"jalali"}'),
           ($1, NULL, 'tax.config', '{"defaultRate":9}')`,
        [seeded.businessId],
      );
      await ownerClient.query(
        `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'موجودی نقد', 'asset')`,
        [seeded.businessId],
      );
    }

    // Retail has no costing/menu prerequisite (its catalogue lives in the
    // products workspace); F&B still needs both.
    const retailState = await computeSetupState(retail.businessId);
    expect(retailState.readiness.ready).toBe(true);
    expect(retailState.progress.steps.menu).toBeUndefined();

    const cafeState = await computeSetupState(cafe.businessId);
    expect(cafeState.readiness.ready).toBe(false);
    expect(cafeState.missingForCompletion.length).toBe(2); // costing + menu
  });

  it("backfills established tenants exactly once and leaves a genuine first run alone", async () => {
    // Migration 0197's rules, re-run against this database's fixtures. The
    // migration itself already ran (before these rows existed), so applying
    // its file again is exactly the idempotent normalisation a deployed
    // instance performs.
    const legacy = await seedBusiness({
      steps: ["business", "accounts", "costing", "tax", "menu"],
    });
    const operationalNoRow = await seedBusiness();
    await ownerClient.query(
      `INSERT INTO orders (location_id, order_number, type, status)
       VALUES ($1, 1, 'takeaway', 'open')`,
      [operationalNoRow.locationId],
    );
    const freshSignup = await seedBusiness(); // no progress row, no accounts, no trading

    const migration = readFileSync(
      join(process.cwd(), "migrations", "0197_setup_completion_backfill.sql"),
      "utf8",
    );
    await ownerClient.query(migration);

    expect(await isSetupComplete(legacy.businessId)).toBe(true);
    expect(await isSetupComplete(operationalNoRow.businessId)).toBe(true);
    // A signup whose wizard was never started must still go through it.
    expect(await isSetupComplete(freshSignup.businessId)).toBe(false);
  });

  it("does not lose either of two concurrent step writes (issue #808 §7)", async () => {
    const { businessId } = await seedBusiness();

    await withTenant(businessId, () =>
      Promise.all([
        markStepDone(businessId, "users"),
        markStepDone(businessId, "hardware"),
        markStepDone(businessId, "backup"),
      ]),
    );

    const progress = await withTenant(businessId, () => getWizardProgress(businessId));
    expect(Object.keys(progress.steps).sort()).toEqual(["backup", "hardware", "users"]);
  });

  it("stamps completion exactly once, even raced with a step write", async () => {
    const { businessId } = await seedBusiness();

    const [first, second] = await withTenant(businessId, () =>
      Promise.all([markSetupComplete(businessId), markSetupComplete(businessId)]),
    );
    const stampedCalls = [first, second].filter((r) => r.stamped);
    expect(stampedCalls).toHaveLength(1);

    const stampedAt = stampedCalls[0].progress.completedAt;
    expect(stampedAt).toBeTruthy();

    // A late step write (another tab, a retried Skip) neither duplicates the
    // stamp nor erases it.
    await withTenant(businessId, () => markStepDone(businessId, "opening"));
    const stored = await withTenant(businessId, () => getWizardProgress(businessId));
    expect(stored.completedAt).toBe(stampedAt);
    expect(stored.steps.opening).toBeTruthy();

    // A retry after the fact reports "not stamped" — the audit event is
    // written by the caller only in that first case.
    const retry = await withTenant(businessId, () => markSetupComplete(businessId));
    expect(retry.stamped).toBe(false);
    expect(retry.progress.completedAt).toBe(stampedAt);
    expect(SETTING_KEYS.wizardProgress).toBe("setup.progress");
  });
});
