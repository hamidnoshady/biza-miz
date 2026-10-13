/**
 * Phase 22, food-cost variance report (issue #160 §4 — the last of Wave 4's
 * three deliberate deferrals). Proves getFoodCostVariance (reports-service.ts):
 * per-item theoretical cost is read from the frozen
 * order_item_inventory_snapshots (the same source deductForOrder itself
 * consumes from) priced at each ingredient's current avg_cost, while actual
 * COGS/waste come straight from the posted ledger — see buildFoodCostVariance's
 * doc comment in reports.ts for why there's no per-item *actual* figure.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { BUSINESS_WIDE_SCOPE, branchScope } from "../src/lib/report-scope";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let reportsService: typeof import("../src/lib/reports-service");

const biz = { id: "", locationId: "" };
const acct = { cogs: "", waste: "" };

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
  databaseName = `pos_food_cost_var_${randomUUID().replaceAll("-", "")}`;

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
  reportsService = await import("../src/lib/reports-service");

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

beforeEach(async () => {
  // order_item_inventory_snapshots is immutable (no UPDATE or DELETE, by
  // trigger — see migration 0013) and order_items' own financial-guard
  // trigger rejects deleting a non-open order's items, so tests that touch
  // either can't truncate between runs the way other integration tests do.
  // Each test gets its own fresh business/location instead, and every query
  // below is explicitly scoped to that location, so leftover rows from
  // earlier tests are simply a different location_id and never match.
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Food Cost Var Co', $1) RETURNING id",
    [`fcv-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5100', 'COGS', 'expense'), ($1, '5150', 'Waste', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "5100") acct.cogs = r.id;
    if (r.code === "5150") acct.waste = r.id;
  }
});

async function makeLocation(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id",
    [biz.id, name],
  );
  return rows[0].id;
}

async function makeInventoryItem(avgCost: number, unit = "g", locationId = biz.locationId): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit, avg_cost) VALUES ($1, 'Coffee', $2, $3) RETURNING id",
    [locationId, unit, avgCost],
  );
  return rows[0].id;
}

async function makeMenuItem(name: string, price: number, locationId = biz.locationId): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, name, price) VALUES ($1, $2, $3) RETURNING id",
    [locationId, name, price],
  );
  return rows[0].id;
}

/** A completed order with one non-voided order item, plus its frozen ingredient snapshot. */
async function makeSoldOrderItem(opts: {
  menuItemId: string | null;
  unitPrice: number;
  quantity: number;
  closedAt: string;
  itemStatus?: "served" | "voided";
  snapshot?: { inventoryItemId: string; requiredQuantity: number };
  locationId?: string;
}): Promise<string> {
  const locationId = opts.locationId ?? biz.locationId;
  const orderNumber = Math.floor(Math.random() * 1_000_000);
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status) VALUES ($1, $2, 'open') RETURNING id`,
    [locationId, orderNumber],
  );
  const orderItem = await db.query<{ id: string }>(
    `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
     VALUES ($1, $2, $3, 'item', $4, $5, $6) RETURNING id`,
    [locationId, order.rows[0].id, opts.menuItemId, opts.unitPrice, opts.quantity, opts.itemStatus ?? "served"],
  );
  if (opts.snapshot) {
    await db.query(
      `INSERT INTO order_item_inventory_snapshots
       (order_item_id, inventory_item_id, required_quantity, source_menu_item_id)
       VALUES ($1, $2, $3, $4)`,
      [orderItem.rows[0].id, opts.snapshot.inventoryItemId, opts.snapshot.requiredQuantity, opts.menuItemId],
    );
  }
  await db.query(`UPDATE orders SET status = 'completed', closed_at = $2 WHERE id = $1`, [
    order.rows[0].id,
    opts.closedAt,
  ]);
  return orderItem.rows[0].id;
}

async function postLedgerAmount(
  accountId: string,
  amountRial: number,
  entryDate: string,
  locationId = biz.locationId,
): Promise<void> {
  const entry = await db.query<{ id: string }>(
    "INSERT INTO journal_entries (business_id, location_id, entry_date, source_type) VALUES ($1, $2, $3, 'test') RETURNING id",
    [biz.id, locationId, entryDate],
  );
  await db.query("INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)", [
    entry.rows[0].id,
    accountId,
    amountRial,
  ]);
}

describe("getFoodCostVariance", () => {
  it("prices the frozen recipe snapshot at the ingredient's current avg_cost, and compares it against posted COGS + waste", async () => {
    const inventoryItemId = await makeInventoryItem(500); // 500 Rial/gram
    const menuItemId = await makeMenuItem("اسپرسو", 100_000);
    await makeSoldOrderItem({
      menuItemId,
      unitPrice: 100_000,
      quantity: 2,
      closedAt: "2025-06-15T10:00:00Z",
      snapshot: { inventoryItemId, requiredQuantity: 20 }, // 20g per unit
    });
    await postLedgerAmount(acct.cogs, 22_000, "2025-06-15");
    await postLedgerAmount(acct.waste, 3_000, "2025-06-15");

    const report = await reportsService.getFoodCostVariance(
      biz.id,
      { dateFrom: "2025-06-01", dateTo: "2025-06-30" },
      branchScope(biz.locationId),
    );

    expect(report.items).toHaveLength(1);
    const [item] = report.items;
    expect(item.menuItemId).toBe(menuItemId);
    expect(item.unitsSold).toBe(2);
    expect(item.revenue).toBe(200_000);
    // 20g * 2 units * 500 Rial/g = 20,000
    expect(item.theoreticalCost).toBe(20_000);
    expect(item.foodCostPct).toBeCloseTo(0.1);

    expect(report.theoreticalCost).toBe(20_000);
    expect(report.actualCogs).toBe(22_000);
    expect(report.wasteCost).toBe(3_000);
    expect(report.actualTotalCost).toBe(25_000);
    expect(report.variance).toBe(5_000);
    expect(report.unexplainedVariance).toBe(2_000);
  });

  it("aggregates all branches only for explicit business-wide scope", async () => {
    const otherLocationId = await makeLocation("Second branch");
    const mainMenuItemId = await makeMenuItem("Main espresso", 100_000);
    const otherMenuItemId = await makeMenuItem("Second-branch espresso", 100_000, otherLocationId);
    const mainInventoryItemId = await makeInventoryItem(500);
    const otherInventoryItemId = await makeInventoryItem(250, "g", otherLocationId);

    await makeSoldOrderItem({
      menuItemId: mainMenuItemId,
      unitPrice: 100_000,
      quantity: 1,
      closedAt: "2025-06-15T10:00:00Z",
      snapshot: { inventoryItemId: mainInventoryItemId, requiredQuantity: 10 },
    });
    await makeSoldOrderItem({
      menuItemId: otherMenuItemId,
      unitPrice: 100_000,
      quantity: 1,
      closedAt: "2025-06-15T10:00:00Z",
      snapshot: { inventoryItemId: otherInventoryItemId, requiredQuantity: 20 },
      locationId: otherLocationId,
    });

    // This broken cross-location reference is allowed by the legacy single-ID
    // foreign key, but must never attribute Branch B's closed order to Branch A.
    const foreignOrder = await db.query<{ id: string }>(
      "INSERT INTO orders (location_id, order_number, status) VALUES ($1, $2, 'open') RETURNING id",
      [otherLocationId, Math.floor(Math.random() * 1_000_000)],
    );
    const mismatchedItem = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
       VALUES ($1, $2, $3, 'mismatched branch item', 100000, 99, 'served') RETURNING id`,
      [biz.locationId, foreignOrder.rows[0].id, mainMenuItemId],
    );
    await db.query(
      `INSERT INTO order_item_inventory_snapshots
       (order_item_id, inventory_item_id, required_quantity, source_menu_item_id)
       VALUES ($1, $2, 10, $3)`,
      [mismatchedItem.rows[0].id, mainInventoryItemId, mainMenuItemId],
    );
    await db.query("UPDATE orders SET status = 'completed', closed_at = $2 WHERE id = $1", [
      foreignOrder.rows[0].id,
      "2025-06-15T10:00:00Z",
    ]);

    await postLedgerAmount(acct.cogs, 11_000, "2025-06-15");
    await postLedgerAmount(acct.cogs, 6_000, "2025-06-15", otherLocationId);
    await postLedgerAmount(acct.waste, 1_000, "2025-06-15");
    await postLedgerAmount(acct.waste, 500, "2025-06-15", otherLocationId);

    const filters = { dateFrom: "2025-06-01", dateTo: "2025-06-30" };
    const branchReport = await reportsService.getFoodCostVariance(biz.id, filters, branchScope(biz.locationId));
    expect(branchReport.items.map((item) => item.menuItemId)).toEqual([mainMenuItemId]);
    expect(branchReport.items[0].unitsSold).toBe(1);
    expect(branchReport.items[0].revenue).toBe(100_000);
    expect(branchReport.theoreticalCost).toBe(5_000);
    expect(branchReport.actualCogs).toBe(11_000);
    expect(branchReport.wasteCost).toBe(1_000);

    const businessReport = await reportsService.getFoodCostVariance(biz.id, filters, BUSINESS_WIDE_SCOPE);
    expect(businessReport.items.map((item) => item.menuItemId).sort()).toEqual(
      [mainMenuItemId, otherMenuItemId].sort(),
    );
    expect(businessReport.items.find((item) => item.menuItemId === mainMenuItemId)?.unitsSold).toBe(1);
    expect(businessReport.theoreticalCost).toBe(10_000);
    expect(businessReport.actualCogs).toBe(17_000);
    expect(businessReport.wasteCost).toBe(1_500);
  });

  it("excludes orders closed outside the requested date range", async () => {
    const inventoryItemId = await makeInventoryItem(500);
    const menuItemId = await makeMenuItem("اسپرسو", 100_000);
    await makeSoldOrderItem({
      menuItemId,
      unitPrice: 100_000,
      quantity: 1,
      closedAt: "2025-05-01T10:00:00Z",
      snapshot: { inventoryItemId, requiredQuantity: 20 },
    });

    const report = await reportsService.getFoodCostVariance(
      biz.id,
      { dateFrom: "2025-06-01", dateTo: "2025-06-30" },
      branchScope(biz.locationId),
    );
    expect(report.items).toHaveLength(0);
    expect(report.theoreticalCost).toBe(0);
  });

  it("excludes voided order items", async () => {
    const inventoryItemId = await makeInventoryItem(500);
    const menuItemId = await makeMenuItem("اسپرسو", 100_000);
    await makeSoldOrderItem({
      menuItemId,
      unitPrice: 100_000,
      quantity: 1,
      closedAt: "2025-06-15T10:00:00Z",
      itemStatus: "voided",
      snapshot: { inventoryItemId, requiredQuantity: 20 },
    });

    const report = await reportsService.getFoodCostVariance(
      biz.id,
      { dateFrom: "2025-06-01", dateTo: "2025-06-30" },
      branchScope(biz.locationId),
    );
    expect(report.items).toHaveLength(0);
  });

  it("still lists an item sold with no recipe snapshot — theoretical cost 0, a visible signal the recipe is missing", async () => {
    const menuItemId = await makeMenuItem("نوشیدنی بدون دستور پخت", 50_000);
    await makeSoldOrderItem({
      menuItemId,
      unitPrice: 50_000,
      quantity: 3,
      closedAt: "2025-06-15T10:00:00Z",
    });

    const report = await reportsService.getFoodCostVariance(
      biz.id,
      { dateFrom: "2025-06-01", dateTo: "2025-06-30" },
      branchScope(biz.locationId),
    );
    expect(report.items).toHaveLength(1);
    expect(report.items[0].theoreticalCost).toBe(0);
    expect(report.items[0].revenue).toBe(150_000);
    expect(report.items[0].foodCostPct).toBe(0);
  });

  it("sorts items worst (highest food-cost %) first", async () => {
    const inventoryItemId = await makeInventoryItem(500);
    const cheapItem = await makeMenuItem("قهوه ارزان", 100_000);
    const expensiveItem = await makeMenuItem("قهوه گران", 100_000);
    // cheapItem: 10g recipe -> 5,000 theoretical / 100,000 revenue = 5%
    await makeSoldOrderItem({
      menuItemId: cheapItem,
      unitPrice: 100_000,
      quantity: 1,
      closedAt: "2025-06-15T10:00:00Z",
      snapshot: { inventoryItemId, requiredQuantity: 10 },
    });
    // expensiveItem: 80g recipe -> 40,000 theoretical / 100,000 revenue = 40%
    await makeSoldOrderItem({
      menuItemId: expensiveItem,
      unitPrice: 100_000,
      quantity: 1,
      closedAt: "2025-06-15T10:00:00Z",
      snapshot: { inventoryItemId, requiredQuantity: 80 },
    });

    const report = await reportsService.getFoodCostVariance(
      biz.id,
      { dateFrom: "2025-06-01", dateTo: "2025-06-30" },
      branchScope(biz.locationId),
    );
    expect(report.items.map((i) => i.menuItemId)).toEqual([expensiveItem, cheapItem]);
  });

  it("returns zeroed totals with no data in range", async () => {
    const report = await reportsService.getFoodCostVariance(
      biz.id,
      { dateFrom: "2025-06-01", dateTo: "2025-06-30" },
      branchScope(biz.locationId),
    );
    expect(report.items).toEqual([]);
    expect(report.theoreticalCost).toBe(0);
    expect(report.actualCogs).toBe(0);
    expect(report.wasteCost).toBe(0);
    expect(report.variancePct).toBeNull();
  });
});
