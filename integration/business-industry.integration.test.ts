/**
 * Phase 25 Wave 1 — the business type as something a super-admin owns.
 *
 * Two things need real-database proof, because both are about SQL the unit
 * tests deliberately do not reach:
 *
 * 1. **Provisioning honours the industry the console sends.** The validation
 *    was always there (`validateProvisionBody`, unit-tested); what was missing
 *    was any caller passing it, so every console-provisioned business silently
 *    became `food_service` *with the F&B chart of accounts*. The account codes
 *    are the assertion that matters — a business can carry the right `industry`
 *    string and still be unusable if its ledger was seeded for another trade.
 *
 * 2. **Changing the industry is additive.** `changeBusinessIndustry` re-seeds
 *    through the same idempotent `seedChartOfAccounts`, so it must add the new
 *    industry's missing codes while leaving every existing account — its id,
 *    its name, and anything posted against it — exactly as it was. That
 *    "leaves nothing behind" property is the whole basis on which the change is
 *    safe to expose at all, so it is asserted directly rather than assumed.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { coaTemplateForIndustry } from "../src/lib/coa-template";
import { SETTING_KEYS } from "../src/lib/settings";
import type { Industry } from "../src/lib/industries";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let setupState: typeof import("../src/lib/setup-state");
let platformService: typeof import("../src/lib/platform-service");
let paymentMethods: typeof import("../src/lib/payment-methods-service");

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
  databaseName = `pos_business_industry_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  setupState = await import("../src/lib/setup-state");
  platformService = await import("../src/lib/platform-service");
  paymentMethods = await import("../src/lib/payment-methods-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

let seq = 0;

/** Provision the way the console does: a named industry and a seeded chart of accounts. */
async function provision(industry: Industry) {
  seq += 1;
  return provisioning.provisionBusiness({
    businessName: `کسب‌وکار ${industry} ${seq}`,
    ownerName: "مالک",
    email: `owner-${industry}-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `biz${industry.replace("_", "")}${seq}`,
    industry,
    seedChartOfAccounts: true,
    completeSetup: provisioning.shouldCompleteSetupForPlatformProvision(industry),
  });
}

async function accountCodes(businessId: string): Promise<string[]> {
  const { rows } = await db.query<{ code: string }>(
    "SELECT code FROM accounts WHERE business_id = $1 ORDER BY code",
    [businessId],
  );
  return rows.map((r) => r.code);
}

async function writeSetupProgress(businessId: string, completed: boolean): Promise<void> {
  const value = completed
    ? JSON.stringify({ steps: {}, completedAt: new Date().toISOString() })
    : JSON.stringify({ steps: {}, completedAt: null });
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, $2, $3::jsonb)
     ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [businessId, SETTING_KEYS.wizardProgress, value],
  );
}

async function completedAt(businessId: string): Promise<string | null> {
  const { rows } = await db.query<{ completed_at: string | null }>(
    "SELECT value ->> 'completedAt' AS completed_at FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = $2",
    [businessId, SETTING_KEYS.wizardProgress],
  );
  return rows[0]?.completed_at ?? null;
}

describe("provisioning with an industry", () => {
  it("stores the industry the caller asked for", async () => {
    const { businessId } = await provision("jewelry");
    const { rows } = await db.query<{ industry: string }>(
      "SELECT industry FROM businesses WHERE id = $1",
      [businessId],
    );
    expect(rows[0].industry).toBe("jewelry");
  });

  it("seeds that industry's chart of accounts, not the F&B one", async () => {
    const { businessId } = await provision("jewelry");
    const codes = await accountCodes(businessId);

    // The jewelry-specific codes Phase 21 posts against (coa-template.ts's
    // WELL_KNOWN_CODES): gold inventory, gold sales revenue, making-charge
    // revenue, gold COGS. None of these exist in the F&B template, so their
    // presence is proof the right template ran.
    for (const code of ["1320", "4500", "4600", "5110"]) {
      expect(codes, `jewelry account ${code}`).toContain(code);
    }
    expect(codes.sort()).toEqual(
      [...coaTemplateForIndustry("jewelry")].map((a) => a.code).sort(),
    );
  });

  it("seeds the cosmetics chart of accounts for a cosmetics business", async () => {
    const { businessId } = await provision("cosmetics");
    const codes = await accountCodes(businessId);
    for (const code of ["1350", "4570", "5150", "5160"]) {
      expect(codes, `cosmetics account ${code}`).toContain(code);
    }
    expect(codes.sort()).toEqual(
      [...coaTemplateForIndustry("cosmetics")].map((a) => a.code).sort(),
    );
  });

  it("accepts the AEC industry the check constraint was widened for (issue #799)", async () => {
    // The failure this pins down is the one that only appears at runtime: a
    // new industry whose migration did not widen
    // `businesses_industry_check` typechecks, unit-tests green, and then fails
    // with a constraint violation the first time an operator provisions one.
    const { businessId } = await provision("architecture_construction");
    const { rows } = await db.query<{ industry: string }>(
      "SELECT industry FROM businesses WHERE id = $1",
      [businessId],
    );
    expect(rows[0].industry).toBe("architecture_construction");
  });

  it("seeds the AEC chart of accounts — its own lines, and none of the café's", async () => {
    const { businessId } = await provision("architecture_construction");
    const codes = await accountCodes(businessId);

    // The trade's own accounts: contract work in progress, retention on both
    // sides, the three revenues, the subcontractor payable and direct project
    // cost (coa-template.ts's ARCHITECTURE_CONSTRUCTION_COA_TEMPLATE).
    for (const code of ["1380", "1250", "2440", "2130", "4610", "4620", "4630", "5191", "5192", "5193"]) {
      expect(codes, `AEC account ${code}`).toContain(code);
    }
    // And the café does not leak in: no food/beverage channels, no recipe
    // costing, no service charge, no delivery-marketplace commission.
    for (const code of ["4100", "4200", "4310", "4320", "4330", "4360", "5100", "5150", "5160", "5180", "1310", "5650"]) {
      expect(codes, `F&B account ${code} must not be seeded for AEC`).not.toContain(code);
    }
    expect(codes.sort()).toEqual(
      [...coaTemplateForIndustry("architecture_construction")].map((a) => a.code).sort(),
    );
  });

  it("turns the restaurant-shaped features off when the AEC industry is provisioned", async () => {
    // The industry's `defaultDisabledFeatures` are seeded as per-business
    // overrides (business-provisioning.ts), which is how "no café module
    // leaks into an AEC tenant" is enforced beyond the module set itself.
    const { businessId } = await provision("architecture_construction");
    const { rows } = await db.query<{ flag_key: string; enabled: boolean }>(
      "SELECT flag_key, enabled FROM business_features WHERE business_id = $1",
      [businessId],
    );
    const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.flag_key));
    for (const flag of ["inventory", "reservations", "delivery"]) {
      expect(off, flag).toContain(flag);
    }
  });

  it("still defaults to food_service when no industry is named", async () => {
    seq += 1;
    const { businessId } = await provisioning.provisionBusiness({
      businessName: `کافه ${seq}`,
      ownerName: "مالک",
      email: `owner-default-${seq}@example.com`,
      password: "correct-horse",
      subdomain: `bizdefault${seq}`,
      seedChartOfAccounts: true,
    });
    const { rows } = await db.query<{ industry: string }>(
      "SELECT industry FROM businesses WHERE id = $1",
      [businessId],
    );
    expect(rows[0].industry).toBe("food_service");
  });

  it("keeps a bare console-provisioned F&B business in setup while preserving the other-trade shortcut", async () => {
    const foodBusiness = await provision("food_service");
    expect(await completedAt(foodBusiness.businessId)).toBeNull();
    expect(await setupState.isSetupComplete(foodBusiness.businessId)).toBe(false);

    const retailBusiness = await provision("jewelry");
    expect(await completedAt(retailBusiness.businessId)).not.toBeNull();
    expect(await setupState.isSetupComplete(retailBusiness.businessId)).toBe(true);
  });
});

describe("changeBusinessIndustry", () => {
  it("switches the type and tops the chart of accounts up", async () => {
    const { businessId } = await provision("food_service");
    const before = await accountCodes(businessId);
    expect(before).not.toContain("1320");

    const result = await platformService.changeBusinessIndustry(businessId, "jewelry");
    expect(result).not.toBeNull();
    expect(result!.business.industry).toBe("jewelry");

    const after = await accountCodes(businessId);
    for (const code of ["1320", "4500", "4600", "5110"]) {
      expect(after, `jewelry account ${code}`).toContain(code);
    }
    // Everything the new template needed and the business lacked, and nothing else.
    expect([...result!.seededAccountCodes].sort()).toEqual(
      after.filter((c) => !before.includes(c)).sort(),
    );
  });

  it("leaves every pre-existing account untouched, ids and names included", async () => {
    const { businessId } = await provision("food_service");
    const { rows: before } = await db.query<{ id: string; code: string; name: string }>(
      "SELECT id, code, name FROM accounts WHERE business_id = $1 ORDER BY code",
      [businessId],
    );
    // Rename one so a blind re-seed that overwrote names would be caught.
    await db.query("UPDATE accounts SET name = 'نام دستیِ حسابدار' WHERE business_id = $1 AND code = $2", [
      businessId,
      before[0].code,
    ]);

    await platformService.changeBusinessIndustry(businessId, "jewelry");

    const { rows: after } = await db.query<{ id: string; code: string; name: string }>(
      "SELECT id, code, name FROM accounts WHERE business_id = $1 AND code = ANY($2) ORDER BY code",
      [businessId, before.map((a) => a.code)],
    );
    expect(after).toHaveLength(before.length);
    for (const [i, row] of after.entries()) {
      expect(row.id, `account ${row.code} kept its id`).toBe(before[i].id);
    }
    expect(after[0].name).toBe("نام دستیِ حسابدار");
  });

  it("is idempotent — changing to the same industry seeds nothing new", async () => {
    const { businessId } = await provision("watch");
    const before = await accountCodes(businessId);

    const result = await platformService.changeBusinessIndustry(businessId, "watch");
    expect(result!.seededAccountCodes).toEqual([]);
    expect(await accountCodes(businessId)).toEqual(before);
  });

  it("deletes no tenant data when the type changes", async () => {
    const { businessId, locationId } = await provision("food_service");
    const category = await db.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id`,
      [locationId],
    );
    await db.query(
      `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'اسپرسو', 100000)`,
      [locationId, category.rows[0].id],
    );

    await platformService.changeBusinessIndustry(businessId, "accessories");

    // The café's menu is now unreachable from the dashboard, but it is still
    // there — the console warned about exactly this rather than dropping it.
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) FROM menu_items WHERE location_id = $1",
      [locationId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("returns null for a business that does not exist", async () => {
    expect(await platformService.changeBusinessIndustry(randomUUID(), "jewelry")).toBeNull();
  });
});

describe("industryDataCounts", () => {
  it("counts what a type change would leave behind", async () => {
    const { businessId, locationId } = await provision("food_service");
    expect(await platformService.industryDataCounts(businessId)).toEqual({
      menuItems: 0,
      industryItems: 0,
      orders: 0,
      journalEntries: 0,
    });

    const category = await db.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id`,
      [locationId],
    );
    await db.query(
      `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'چای', 50000)`,
      [locationId, category.rows[0].id],
    );
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'completed', 50000)`,
      [locationId],
    );

    const counts = await platformService.industryDataCounts(businessId);
    expect(counts.menuItems).toBe(1);
    expect(counts.orders).toBe(1);
  });

  it("counts only the business asked about", async () => {
    const a = await provision("food_service");
    const b = await provision("food_service");
    const category = await db.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id`,
      [a.locationId],
    );
    await db.query(
      `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'قهوه', 90000)`,
      [a.locationId, category.rows[0].id],
    );

    expect((await platformService.industryDataCounts(a.businessId)).menuItems).toBe(1);
    expect((await platformService.industryDataCounts(b.businessId)).menuItems).toBe(0);
  });
});

describe("industry feature defaults", () => {
  async function overrides(businessId: string): Promise<Record<string, boolean>> {
    const { rows } = await db.query<{ flag_key: string; enabled: boolean }>(
      "SELECT flag_key, enabled FROM business_features WHERE business_id = $1",
      [businessId],
    );
    return Object.fromEntries(rows.map((r) => [r.flag_key, r.enabled]));
  }

  it("turns off the F&B-shaped features for a retail business at provision", async () => {
    const { businessId } = await provision("jewelry");
    const flags = await overrides(businessId);
    // `inventory` is F&B's recipe-costed raw-material store and `reservations`
    // gates tables and the floor plan; a jewellery shop has neither.
    expect(flags.inventory).toBe(false);
    expect(flags.reservations).toBe(false);
    expect(flags.delivery).toBe(false);
  });

  it("turns nothing off for a café", async () => {
    const { businessId } = await provision("food_service");
    expect(await overrides(businessId)).toEqual({});
  });

  it("applies the new industry's defaults on a change", async () => {
    const { businessId } = await provision("food_service");
    expect(await overrides(businessId)).toEqual({});

    await platformService.changeBusinessIndustry(businessId, "watch");
    const flags = await overrides(businessId);
    expect(flags.inventory).toBe(false);
    expect(flags.reservations).toBe(false);
  });

  it("clears the old industry's defaults when switching back to a café", async () => {
    // Otherwise a business switched to food_service would come up with no
    // tables and no floor plan, because the overrides its previous trade
    // seeded would still be sitting there switched off.
    const { businessId } = await provision("jewelry");
    expect((await overrides(businessId)).reservations).toBe(false);

    await platformService.changeBusinessIndustry(businessId, "food_service");
    const flags = await overrides(businessId);
    expect(flags.reservations).toBeUndefined();
    expect(flags.inventory).toBeUndefined();
  });

  it("leaves an override the new industry also disables in place", async () => {
    const { businessId } = await provision("jewelry");
    await platformService.changeBusinessIndustry(businessId, "watch");
    // Both trades disable these, so the change is a no-op for them rather than
    // a delete-then-reinsert that would briefly flip the flag on.
    const flags = await overrides(businessId);
    expect(flags.inventory).toBe(false);
    expect(flags.reservations).toBe(false);
  });
});

describe("industry-transition readiness lifecycle", () => {
  it("re-opens a completed retail tenant when F&B prerequisites are missing", async () => {
    const { businessId } = await provision("jewelry");
    await writeSetupProgress(businessId, true);
    expect(await completedAt(businessId)).not.toBeNull();

    await platformService.changeBusinessIndustry(businessId, "food_service");

    expect(await completedAt(businessId)).toBeNull();
  });

  it("preserves completed setup when F&B readiness is already satisfied", async () => {
    const { businessId, locationId } = await provision("jewelry");
    await db.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES
         ($1, NULL, $2, '{"currencyDisplay":"toman"}'::jsonb),
         ($1, NULL, $3, '{"method":"fifo","system":"perpetual","lockedAt":null}'::jsonb),
         ($1, NULL, $4, '{"defaultRate":0}'::jsonb)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [businessId, SETTING_KEYS.businessPrefs, SETTING_KEYS.costing, SETTING_KEYS.tax],
    );
    await db.query(
      `INSERT INTO menu_items (location_id, name, price, is_active) VALUES ($1, 'چای', 50000, true)`,
      [locationId],
    );
    await writeSetupProgress(businessId, true);

    await platformService.changeBusinessIndustry(businessId, "food_service");

    expect(await completedAt(businessId)).not.toBeNull();
  });
});

describe("industry-transition payment methods", () => {
  it("adds SnapFood once when entering F&B and preserves existing custom methods", async () => {
    const { businessId } = await provision("jewelry");
    await db.query(
      `INSERT INTO payment_methods
         (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer, requires_reference)
       VALUES ($1, 'wallet_custom', 'کیف پول فروشگاه', 'online', 70, false, false, true)`,
      [businessId],
    );

    await platformService.changeBusinessIndustry(businessId, "food_service");
    await platformService.changeBusinessIndustry(businessId, "food_service");

    const { rows: snapRows } = await db.query<{ id: string; is_active: boolean; is_builtin: boolean }>(
      "SELECT id, is_active, is_builtin FROM payment_methods WHERE business_id = $1 AND code = 'snappfood'",
      [businessId],
    );
    expect(snapRows).toHaveLength(1);
    expect(snapRows[0]).toMatchObject({ is_active: true, is_builtin: true });

    const { rows: custom } = await db.query<{ name: string; settlement: string; requires_reference: boolean }>(
      "SELECT name, settlement::text AS settlement, requires_reference FROM payment_methods WHERE business_id = $1 AND code = 'wallet_custom'",
      [businessId],
    );
    expect(custom).toEqual([{ name: "کیف پول فروشگاه", settlement: "online", requires_reference: true }]);
  });

  it("retires SnapFood outside F&B without exposing, deleting, or severing historical payments", async () => {
    const { businessId, locationId } = await provision("food_service");
    const { rows: snapRows } = await db.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE business_id = $1 AND code = 'snappfood'",
      [businessId],
    );
    const snapId = snapRows[0].id;
    await db.query(
      "UPDATE payment_methods SET name = $2, requires_reference = true, sort_order = 77 WHERE id = $1",
      [snapId, "اسنپ‌فود قراردادی"],
    );
    await db.query(
      `INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin)
       VALUES ($1, 'wallet_custom', 'کیف پول سفارشی', 'online', 70, false)`,
      [businessId],
    );
    const { rows: orderRows } = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, total)
       VALUES ($1, 900001, 'delivery', 100000) RETURNING id`,
      [locationId],
    );
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, payment_method_id)
       VALUES ($1, $2, 'snappfood', 100000, $3)`,
      [locationId, orderRows[0].id, snapId],
    );

    await platformService.changeBusinessIndustry(businessId, "jewelry");

    const { rows: retired } = await db.query<{
      id: string;
      name: string;
      is_active: boolean;
      sort_order: number;
      requires_reference: boolean;
    }>(
      "SELECT id, name, is_active, sort_order, requires_reference FROM payment_methods WHERE business_id = $1 AND code = 'snappfood'",
      [businessId],
    );
    expect(retired).toEqual([
      { id: snapId, name: "اسنپ‌فود قراردادی", is_active: false, sort_order: 77, requires_reference: true },
    ]);
    const { rows: history } = await db.query<{ payment_method_id: string | null }>(
      "SELECT payment_method_id FROM payments WHERE order_id = $1",
      [orderRows[0].id],
    );
    expect(history).toEqual([{ payment_method_id: snapId }]);

    const outsideMethods = await dbLib.withTenant(businessId, () =>
      paymentMethods.listPaymentMethods(businessId, { includeInactive: true }),
    );
    expect(outsideMethods.some((method) => method.code === "snappfood")).toBe(false);
    expect(outsideMethods.some((method) => method.code === "wallet_custom")).toBe(true);

    await platformService.changeBusinessIndustry(businessId, "food_service");
    const { rows: restored } = await db.query<{ id: string; name: string; is_active: boolean; sort_order: number; requires_reference: boolean }>(
      "SELECT id, name, is_active, sort_order, requires_reference FROM payment_methods WHERE business_id = $1 AND code = 'snappfood'",
      [businessId],
    );
    expect(restored).toEqual([
      { id: snapId, name: "اسنپ‌فود قراردادی", is_active: true, sort_order: 77, requires_reference: true },
    ]);
    const { rows: historyAfterReturn } = await db.query<{ payment_method_id: string | null }>(
      "SELECT payment_method_id FROM payments WHERE order_id = $1",
      [orderRows[0].id],
    );
    expect(historyAfterReturn).toEqual([{ payment_method_id: snapId }]);
  });
});
