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
let agencyService: typeof import("../src/lib/agency-service");
let workspaceLib: typeof import("../src/lib/workspace");

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
  agencyService = await import("../src/lib/agency-service");
  workspaceLib = await import("../src/lib/workspace");

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

  it("accepts the advertising-agency industry the check constraint was widened for (issue #1128)", async () => {
    // The same runtime-only failure the AEC test above pins down: migration
    // 0259 widens `businesses_industry_check`, and without it the first console
    // provision of an agency dies on a constraint violation long after
    // typecheck and the unit suite have both passed.
    const { businessId } = await provision("advertising_agency");
    const { rows } = await db.query<{ industry: string }>(
      "SELECT industry FROM businesses WHERE id = $1",
      [businessId],
    );
    expect(rows[0].industry).toBe("advertising_agency");
  });

  it("seeds the agency chart of accounts — its own lines, and none of the café's", async () => {
    const { businessId } = await provision("advertising_agency");
    const codes = await accountCodes(businessId);

    // The trade's own accounts (ADVERTISING_AGENCY_COA_TEMPLATE): four service
    // revenues, the four accounts its direct client cost is split across, the
    // reimbursable client-cost receivable, unbilled project work, and the
    // media/production payable.
    for (const code of [
      "4640", "4650", "4660", "4670",
      "5196", "5197", "5198", "5199",
      "1270", "1385", "2140",
    ]) {
      expect(codes, `agency account ${code}`).toContain(code);
    }
    // Neither the café nor a counter leaks in: no hospitality channels, no
    // recipe costing, no service charge, and no delivery-marketplace pair.
    for (const code of [
      "4100", "4200", "4310", "4320", "4330", "4360",
      "5100", "5150", "5160", "5180", "1310",
      "1230", "5650",
    ]) {
      expect(codes, `F&B account ${code} must not be seeded for an agency`).not.toContain(code);
    }
    // The shared controls stay, because the chart is built by subtracting from
    // F&B's: payroll and its withholdings, depreciation, cheques, VAT, the
    // agency's own marketing (5600, overhead — never client cost of sales), the
    // generic stock account its print material sits in, and the *one* customer
    // advance liability a retainer or a client media fund posts to.
    for (const code of ["5200", "5220", "2300", "5700", "1510", "1240", "2120", "2200", "5600", "1300", "2430"]) {
      expect(codes, `shared account ${code}`).toContain(code);
    }
    expect(codes.sort()).toEqual(
      [...coaTemplateForIndustry("advertising_agency")].map((a) => a.code).sort(),
    );
  });

  it("turns the restaurant-shaped features off when an agency is provisioned", async () => {
    const { businessId } = await provision("advertising_agency");
    const { rows } = await db.query<{ flag_key: string; enabled: boolean }>(
      "SELECT flag_key, enabled FROM business_features WHERE business_id = $1",
      [businessId],
    );
    const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.flag_key));
    for (const flag of ["inventory", "reservations", "delivery"]) {
      expect(off, flag).toContain(flag);
    }
  });

  it("treats a console-provisioned agency as a finished setup, because it walks no menu step", async () => {
    // `shouldCompleteSetupForPlatformProvision` reads the wizard rather than
    // restating a list: the agency walks the `service` shape (wizard-steps.ts),
    // so it has no `menu` step and provisioning it is a complete setup, not a
    // wizard waiting on a café menu the trade will never have.
    expect(provisioning.shouldCompleteSetupForPlatformProvision("advertising_agency")).toBe(true);
    const { businessId } = await provision("advertising_agency");
    expect(await completedAt(businessId)).not.toBeNull();
    expect(await setupState.isSetupComplete(businessId)).toBe(true);
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

  it("switches a shop into an agency by adding accounts, never by reinterpreting them (issue #1128)", async () => {
    // The issue's P0 line — "no destructive migration or existing-business
    // regression" — against real rows. A jewellery tenant turned into an agency
    // keeps every account it had, with its id and its name, and gains the
    // agency's own codes on top; nothing is renamed to mean something else and
    // nothing is dropped, which is what makes the console's switch safe to
    // offer at all.
    const { businessId } = await provision("jewelry");
    const before = await accountCodes(businessId);
    expect(before).toContain("1320"); // موجودی طلا و جواهر
    expect(before).not.toContain("4640");

    const result = await platformService.changeBusinessIndustry(businessId, "advertising_agency");
    expect(result!.business.industry).toBe("advertising_agency");

    const after = await accountCodes(businessId);
    for (const code of [
      "4640", "4650", "4660", "4670",
      "5196", "5197", "5198", "5199",
      "1270", "1385", "2140",
    ]) {
      expect(after, `agency account ${code}`).toContain(code);
    }
    // The old chart survives in full, including the codes the agency template
    // deliberately does not seed — that is the proof the change adds.
    for (const code of before) {
      expect(after, `pre-existing account ${code}`).toContain(code);
    }
    expect([...result!.seededAccountCodes].sort()).toEqual(
      after.filter((c) => !before.includes(c)).sort(),
    );
  });

  it("turns the restaurant-shaped features off, and the agency's own on, across a switch", async () => {
    // Both trades disable the same three flags, so a jewellery → agency switch
    // must leave them off rather than delete-then-reinsert them (which would
    // briefly flip a floor plan on for a business that has no floor).
    const { businessId } = await provision("jewelry");
    const result = await platformService.changeBusinessIndustry(businessId, "advertising_agency");
    expect(result!.business.industry).toBe("advertising_agency");

    const { rows } = await db.query<{ flag_key: string; enabled: boolean }>(
      "SELECT flag_key, enabled FROM business_features WHERE business_id = $1",
      [businessId],
    );
    const flags = Object.fromEntries(rows.map((r) => [r.flag_key, r.enabled]));
    expect(flags.inventory).toBe(false);
    expect(flags.reservations).toBe(false);
    expect(flags.delivery).toBe(false);
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

/**
 * Issue #1128 — an agency's operating profile: the eight presets inside the one
 * industry key, stored as a jsonb value in the shared `settings` table.
 *
 * Three things need a real database. The round trip has to survive RLS, because
 * `settings` is tenant-scoped and the service reads and writes it inside
 * `withTenant`. A business of another trade has to be *refused* rather than
 * handed the agency default, which is the same rule the AEC profile enforces and
 * the one a unit test cannot prove without the constraint and the row. And the
 * stored preset has to be what orders the blueprint list, which is the only
 * thing the choice actually does — a preset that reached the database and
 * changed nothing would be a settings form with no effect.
 */
describe("the agency operating profile (#1128)", () => {
  it("answers the default preset, and says that nothing is stored yet", async () => {
    const { businessId } = await provision("advertising_agency");
    const profile = await dbLib.withTenant(businessId, () =>
      agencyService.loadBusinessAgencyProfile(businessId),
    );
    expect(profile).toEqual({
      operatingProfile: "full_service",
      specialties: [],
      stored: false,
      updatedAt: null,
    });
    // The default is an answer, not a row: nothing is written until the business
    // chooses, so an upgrade cannot reinterpret a tenant that never picked one.
    const { rows } = await db.query<{ key: string }>(
      "SELECT key FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = $2",
      [businessId, SETTING_KEYS.agencyProfile],
    );
    expect(rows).toEqual([]);
  });

  it("saves a preset, reads it back, and writes the audit row", async () => {
    const { businessId, locationId, userId } = await provision("advertising_agency");
    const saved = await dbLib.withTenant(businessId, () =>
      agencyService.saveBusinessAgencyProfile(
        { businessId, locationId, userId },
        {
          operatingProfile: "media_buying",
          // The primary cannot also be a secondary, and a word from another
          // trade's vocabulary is dropped rather than stored.
          specialties: ["outdoor_print", "media_buying", "contractor"],
        },
      ),
    );
    expect(saved.operatingProfile).toBe("media_buying");
    expect(saved.specialties).toEqual(["outdoor_print"]);
    expect(saved.stored).toBe(true);
    expect(saved.updatedAt).not.toBeNull();

    const read = await dbLib.withTenant(businessId, () =>
      agencyService.loadBusinessAgencyProfile(businessId),
    );
    expect(read).toEqual(saved);

    const { rows } = await db.query<{ value: { operatingProfile: string } }>(
      "SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = $2",
      [businessId, SETTING_KEYS.agencyProfile],
    );
    expect(rows[0].value.operatingProfile).toBe("media_buying");

    const { rows: audit } = await db.query<{ user_id: string | null; payload: { before: unknown; after: { operatingProfile: string } } }>(
      `SELECT user_id, payload FROM audit_log
        WHERE business_id = $1 AND action = 'settings.agency_profile.update'
        ORDER BY id DESC LIMIT 1`,
      [businessId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(userId);
    expect(audit[0].payload.after.operatingProfile).toBe("media_buying");
    // The row says what changed, not only what it changed to.
    expect(audit[0].payload.before).toEqual({ operatingProfile: "full_service", specialties: [] });
  });

  it("refuses an unknown preset instead of quietly storing the default", async () => {
    const { businessId, locationId, userId } = await provision("advertising_agency");
    const error = await dbLib.withTenant(businessId, () =>
      agencyService
        .saveBusinessAgencyProfile({ businessId, locationId, userId }, { operatingProfile: "contractor" })
        .then(
          () => null,
          (caught: unknown) => caught as { code?: string },
        ),
    );
    expect(error?.code).toBe("invalid_profile");
    const { rows } = await db.query<{ key: string }>(
      "SELECT key FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = $2",
      [businessId, SETTING_KEYS.agencyProfile],
    );
    expect(rows).toEqual([]);
  });

  it("is refused for a business of another industry, and stores nothing for it", async () => {
    const { businessId, locationId, userId } = await provision("jewelry");
    const error = await dbLib.withTenant(businessId, () =>
      agencyService.loadBusinessAgencyProfile(businessId).then(
        () => null,
        (caught: unknown) => caught as { code?: string },
      ),
    );
    expect(error?.code).toBe("industry_mismatch");
    // The read the templates route uses answers null rather than throwing, so a
    // caller that does not know the trade can ask safely.
    expect(await dbLib.withTenant(businessId, () => agencyService.readAgencyOperatingProfile(businessId))).toBeNull();
    const writeError = await dbLib.withTenant(businessId, () =>
      agencyService
        .saveBusinessAgencyProfile({ businessId, locationId, userId }, { operatingProfile: "full_service" })
        .then(
          () => null,
          (caught: unknown) => caught as { code?: string },
        ),
    );
    expect(writeError?.code).toBe("industry_mismatch");
    const { rows } = await db.query<{ key: string }>(
      "SELECT key FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = $2",
      [businessId, SETTING_KEYS.agencyProfile],
    );
    expect(rows).toEqual([]);
  });

  it("orders the agency's blueprints by the stored preset, and offers all seven either way", async () => {
    const { businessId, locationId, userId } = await provision("advertising_agency");
    const seven = [
      "agency_brand_identity",
      "agency_website_landing",
      "agency_social_retainer",
      "agency_ad_campaign",
      "agency_outdoor_print",
      "agency_video_production",
      "agency_pr_event",
    ];

    // Before any choice: the default preset (full service) is what the route
    // resolves, and every blueprint is offered with the recommended ones first.
    const beforeChoice = await dbLib.withTenant(businessId, async () =>
      workspaceLib.listTemplates(businessId, {
        profile: await agencyService.readAgencyOperatingProfile(businessId),
      }),
    );
    expect(beforeChoice.map((t) => t.key)).toEqual(expect.arrayContaining(seven));
    expect(beforeChoice.some((t) => t.key.startsWith("aec_"))).toBe(false);
    expect(beforeChoice[0].recommended).toBe(true);
    // A full-service agency genuinely runs all seven, so the default preset
    // badges the whole set — and what that buys is the ordering: the trade's own
    // blueprints lead, ahead of the generic families every tenant also has.
    const recommendedBefore = beforeChoice.filter((t) => t.recommended).map((t) => t.key);
    expect(recommendedBefore).toEqual(seven);
    expect(beforeChoice.slice(0, seven.length).map((t) => t.key)).toEqual(seven);

    await dbLib.withTenant(businessId, () =>
      agencyService.saveBusinessAgencyProfile(
        { businessId, locationId, userId },
        { operatingProfile: "media_buying" },
      ),
    );

    const afterChoice = await dbLib.withTenant(businessId, async () =>
      workspaceLib.listTemplates(businessId, {
        profile: await agencyService.readAgencyOperatingProfile(businessId),
      }),
    );
    // Ordering and a badge, never a gate: the same seven are still offered, and
    // the ones a media buyer is recommended now lead the list.
    expect(afterChoice.map((t) => t.key)).toEqual(expect.arrayContaining(seven));
    expect(afterChoice.filter((t) => t.recommended).map((t) => t.key)).toEqual([
      "agency_ad_campaign",
      "agency_outdoor_print",
    ]);
    expect(afterChoice.slice(0, 2).every((t) => t.recommended)).toBe(true);
    expect(afterChoice.some((t) => t.key === "agency_brand_identity")).toBe(true);
  });
});
