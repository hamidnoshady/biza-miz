/**
 * Re-importing product prices and stock for products that already exist
 * (issue #1376), against a real database.
 *
 * The properties this suite exists to keep true:
 *
 *  1. A matched existing product's sale price is written through
 *     `saveStockPrices`, so the shelf price moves with a price-history row —
 *     and a purchase cost that holds stock is never rewritten from a file.
 *  2. A target quantity moves through `createItemStockCount`: an absolute count
 *     with its variance line and one ledger effect, not a direct
 *     `item_stock` write.
 *  3. `fill_missing` preserves everything a product already has, including a
 *     stock row that a re-import must not treat as empty.
 *  4. A serial-tracked item never accepts a numeric quantity — the row is held
 *     with the serial reason while its price still applies.
 *  5. Uploading the same file again creates no product, no second count and no
 *     second price-history row.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { CatalogueMapping, CatalogueSheet, CatalogueTarget } from "../src/lib/data-transfer/catalogue-profile";
import type { CatalogueValueMode } from "../src/lib/data-transfer/catalogue-values";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let catalogue: typeof import("../src/lib/data-transfer/catalogue-service");
let stockCounts: typeof import("../src/lib/item-stock-count-service");

const biz = { id: "", locationId: "" };
const actor = { userId: null as string | null, name: "مدیر آزمون" };
const items = { lipstick: "", cream: "", fresh: "", serial: "" };

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
  databaseName = `pos_catalogue_reimport_${randomUUID().replaceAll("-", "")}`;
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
  catalogue = await import("../src/lib/data-transfer/catalogue-service");
  stockCounts = await import("../src/lib/item-stock-count-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('فروشگاه آزمون', $1, 'accessories') RETURNING id`,
    [`catalogue-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;

  // The three accounts the retail count rule resolves for a variance.
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1340', 'Accessory Inventory', 'asset'),
            ($1, '5190', 'Count Shortage', 'expense'),
            ($1, '4910', 'Count Surplus', 'revenue')`,
    [biz.id],
  );

  items.lipstick = await addItem("LIP-1", "رژ لب", { quantity: "5", unitPrice: 100_000, unitCost: 50_000 });
  items.cream = await addItem("CREAM-2", "کرم");
  items.fresh = await addItem("FRESH-4", "کرم جدید");
  items.serial = await addItem("SER-3", "ساعت سریال‌دار", undefined, { tracking: "serial" });
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool();
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** An item in the branch, optionally with its stock row already present. */
async function addItem(
  sku: string,
  name: string,
  stock?: { quantity: string; unitPrice: number | null; unitCost: number | null },
  options: { tracking?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO items (location_id, name, sku, tracking) VALUES ($1, $2, $3, $4) RETURNING id`,
    [biz.locationId, name, sku, options.tracking ?? "none"],
  );
  const id = rows[0].id;
  if (stock) {
    await db.query(
      `INSERT INTO item_stock (item_id, quantity, unit_price, unit_cost) VALUES ($1, $2, $3, $4)`,
      [id, stock.quantity, stock.unitPrice, stock.unitCost],
    );
  }
  return id;
}

function asBusiness<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(biz.id, fn);
}

function owner(target: CatalogueTarget) {
  return { businessId: biz.id, locationId: biz.locationId, target, actor };
}

const COLUMNS = ["کد کالا", "نام کالا", "قیمت", "بهای خرید", "موجودی"];
const MAPPING: CatalogueMapping = { sku: 0, title: 1, price: 2, cost: 3, quantity: 4 };

/** One row per line: sku, title, sale price, purchase cost, target quantity. */
function sheetOf(rows: Array<[string, string, string, string, string]>): CatalogueSheet {
  return {
    name: "Sheet1",
    columns: COLUMNS,
    rows: rows.map((cells, index) => ({
      number: index + 2,
      cells: cells.map((text) => ({ text })),
    })),
  };
}

async function stageCatalogue(input: {
  target: CatalogueTarget;
  sheet: CatalogueSheet;
  valueMode: CatalogueValueMode;
  sourceName: string;
  fingerprint: string;
}): Promise<string> {
  return asBusiness(() =>
    catalogue.stageCatalogue(owner(input.target), {
      sheet: input.sheet,
      mapping: MAPPING,
      fileName: input.sourceName,
      sourceName: input.sourceName,
      fingerprint: input.fingerprint,
      fallbackBrand: "برند آزمون",
      duplicateRows: [],
      axis: "",
      valueMode: input.valueMode,
      currency: "rial",
    }),
  );
}

async function stockOf(itemId: string) {
  const { rows } = await db.query<{ quantity: string; unit_price: string | null; unit_cost: string | null }>(
    `SELECT quantity::text AS quantity, unit_price::text AS unit_price, unit_cost::text AS unit_cost
       FROM item_stock WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ?? null;
}

async function historyOf(itemId: string) {
  const { rows } = await db.query<{ price_kind: string; old_price: string | null; new_price: string | null }>(
    `SELECT price_kind, old_price::text AS old_price, new_price::text AS new_price
       FROM product_price_history WHERE item_id = $1 ORDER BY price_kind`,
    [itemId],
  );
  return rows;
}

async function countLinesOf(itemId: string) {
  const { rows } = await db.query<{
    count_id: string;
    system_qty: string;
    counted_qty: string;
    variance: string;
    entry_id: string | null;
  }>(
    `SELECT c.id AS count_id, l.system_qty::text AS system_qty, l.counted_qty::text AS counted_qty,
            l.variance::text AS variance, c.entry_id
       FROM item_stock_count_lines l JOIN item_stock_counts c ON c.id = l.stock_count_id
      WHERE l.item_id = $1 ORDER BY c.counted_at`,
    [itemId],
  );
  return rows;
}

async function countRows(table: "items" | "item_stock_counts" | "product_price_history"): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0].n);
}

async function stagedPlans(runId: string, target: CatalogueTarget) {
  const items = await asBusiness(() => catalogue.catalogueItems(owner(target), runId));
  return Object.fromEntries(
    items.map((item) => [
      item.externalKey,
      (item.snapshot as { valuePlan?: Record<string, Record<string, unknown>> }).valuePlan,
    ]),
  );
}

describe("re-importing prices and stock for existing products", () => {
  let updateRun = "";

  it("stages current → proposed values without writing anything canonical", async () => {
    const before = { items: await countRows("items"), counts: await countRows("item_stock_counts") };
    updateRun = await stageCatalogue({
      target: "retail",
      valueMode: "update_existing",
      sourceName: "catalogue.xlsx",
      fingerprint: "fp-1",
      sheet: sheetOf([
        ["LIP-1", "رژ لب", "250000", "90000", "8"],
        ["CREAM-2", "کرم", "300000", "150000", "3"],
      ]),
    });

    // A preview writes no product, no price and no stock movement.
    expect(await countRows("items")).toBe(before.items);
    expect(await countRows("item_stock_counts")).toBe(before.counts);
    expect(await stockOf(items.lipstick)).toMatchObject({ quantity: "5.000000000", unit_price: "100000" });

    const plans = await stagedPlans(updateRun, "retail");
    expect(plans["sku:LIP-1"]).toMatchObject({
      price: { action: "set", current: 100_000, proposed: 250_000 },
      // Receipts own the carrying cost of a product that holds stock.
      cost: { action: "held", reason: "catalogue_cost_locked_with_stock" },
      quantity: { action: "set", current: "5.000000000", proposed: "8", delta: 3 },
    });
    expect(plans["sku:CREAM-2"]).toMatchObject({
      price: { action: "set", current: null, proposed: 300_000 },
      cost: { action: "set", current: null, proposed: 150_000 },
      quantity: { action: "set", current: "0", proposed: "3", delta: 3 },
    });
  });

  it("refuses the financial write without its own confirmation", async () => {
    await expect(asBusiness(() => catalogue.applyCatalogue(owner("retail"), updateRun, true, {}))).rejects.toMatchObject({
      code: "catalogue_price_confirmation_required",
    });
    expect(await countRows("item_stock_counts")).toBe(0);
  });

  it("writes the sale price with history and the quantity through the count service", async () => {
    const summary = await asBusiness(() =>
      catalogue.applyCatalogue(owner("retail"), updateRun, true, { prices: true, stock: true }),
    );
    expect(summary.run.status).toBe("applied");
    expect(summary.counts.failed).toBe(0);

    // Price: the shelf price moved and the change is in the immutable history.
    expect(await stockOf(items.lipstick)).toMatchObject({
      unit_price: "250000",
      unit_cost: "50000",
      quantity: "8.000000000",
    });
    expect(await historyOf(items.lipstick)).toEqual([
      { price_kind: "sale", old_price: "100000", new_price: "250000" },
    ]);

    // Stock: a reviewed count, not a direct balance write — one ledger effect each.
    const lipstickCounts = await countLinesOf(items.lipstick);
    expect(lipstickCounts).toHaveLength(1);
    expect(lipstickCounts[0]).toMatchObject({ system_qty: "5.000000000", counted_qty: "8.000000000", variance: "3.000000000" });
    expect(lipstickCounts[0].entry_id).not.toBeNull();

    // A product with no stock row yet gets price, cost and quantity in one apply.
    expect(await stockOf(items.cream)).toMatchObject({
      unit_price: "300000",
      unit_cost: "150000",
      quantity: "3.000000000",
    });
    expect(await historyOf(items.cream)).toEqual([
      { price_kind: "purchase", old_price: null, new_price: "150000" },
      { price_kind: "sale", old_price: null, new_price: "300000" },
    ]);
    const creamCounts = await countLinesOf(items.cream);
    expect(creamCounts).toHaveLength(1);
    expect(creamCounts[0]).toMatchObject({ system_qty: "0.000000000", counted_qty: "3.000000000" });
    expect(creamCounts[0].entry_id).not.toBeNull();

    // No product was created by an update-only catalogue.
    expect(await countRows("items")).toBe(4);
  });

  it("fill_missing leaves every existing value alone and only fills what is empty", async () => {
    const fillRun = await stageCatalogue({
      target: "retail",
      valueMode: "fill_missing",
      sourceName: "catalogue.xlsx",
      fingerprint: "fp-2",
      sheet: sheetOf([
        ["LIP-1", "رژ لب", "999999", "1", "12"],
        ["FRESH-4", "کرم جدید", "500000", "200000", "4"],
      ]),
    });

    const plans = await stagedPlans(fillRun, "retail");
    expect(plans["sku:LIP-1"]).toMatchObject({
      price: { action: "unchanged", current: 250_000, proposed: 999_999 },
      cost: { action: "unchanged", current: 50_000, proposed: 1 },
      quantity: { action: "unchanged", current: "8.000000000", proposed: "12", reason: "catalogue_existing_stock_preserved" },
    });
    expect(plans["sku:FRESH-4"]).toMatchObject({
      price: { action: "set", proposed: 500_000 },
      quantity: { action: "set", proposed: "4" },
    });

    const historyBefore = await historyOf(items.lipstick);
    const countsBefore = await countLinesOf(items.lipstick);
    await asBusiness(() => catalogue.applyCatalogue(owner("retail"), fillRun, true, { prices: true, stock: true }));

    // The populated product is exactly as it was.
    expect(await stockOf(items.lipstick)).toMatchObject({
      unit_price: "250000",
      unit_cost: "50000",
      quantity: "8.000000000",
    });
    expect(await historyOf(items.lipstick)).toEqual(historyBefore);
    expect(await countLinesOf(items.lipstick)).toEqual(countsBefore);

    // The empty one is filled through the same services.
    expect(await stockOf(items.fresh)).toMatchObject({
      unit_price: "500000",
      unit_cost: "200000",
      quantity: "4.000000000",
    });
    expect(await historyOf(items.fresh)).toEqual([
      { price_kind: "purchase", old_price: null, new_price: "200000" },
      { price_kind: "sale", old_price: null, new_price: "500000" },
    ]);
    const freshCounts = await countLinesOf(items.fresh);
    expect(freshCounts).toHaveLength(1);
    expect(freshCounts[0]).toMatchObject({ system_qty: "0.000000000", counted_qty: "4.000000000" });
  });

  it("a repeated import converges: no duplicate product, count or price change", async () => {
    const before = {
      items: await countRows("items"),
      counts: await countRows("item_stock_counts"),
      history: await countRows("product_price_history"),
      lipstick: await stockOf(items.lipstick),
      fresh: await stockOf(items.fresh),
    };

    const repeatRun = await stageCatalogue({
      target: "retail",
      valueMode: "fill_missing",
      sourceName: "catalogue.xlsx",
      fingerprint: "fp-2",
      sheet: sheetOf([
        ["LIP-1", "رژ لب", "999999", "1", "12"],
        ["FRESH-4", "کرم جدید", "500000", "200000", "4"],
      ]),
    });
    const summary = await asBusiness(() =>
      catalogue.applyCatalogue(owner("retail"), repeatRun, true, { prices: true, stock: true }),
    );
    expect(summary.run.status).toBe("applied");

    expect(await countRows("items")).toBe(before.items);
    expect(await countRows("item_stock_counts")).toBe(before.counts);
    expect(await countRows("product_price_history")).toBe(before.history);
    expect(await stockOf(items.lipstick)).toEqual(before.lipstick);
    expect(await stockOf(items.fresh)).toEqual(before.fresh);
  });

  it("refuses a preview whose stock moved before the apply", async () => {
    const itemId = await addItem("MOVE-5", "کالای متحرک", { quantity: "2", unitPrice: 100_000, unitCost: 60_000 });
    const runId = await stageCatalogue({
      target: "retail",
      valueMode: "update_existing",
      sourceName: "catalogue.xlsx",
      fingerprint: "fp-moved",
      sheet: sheetOf([["MOVE-5", "کالای متحرک", "150000", "", "4"]]),
    });
    const plans = await stagedPlans(runId, "retail");
    expect(plans["sku:MOVE-5"]).toMatchObject({
      quantity: { action: "set", current: "2.000000000", proposed: "4" },
    });

    // Stock moves between the review and the apply — a sale, a receipt or a count.
    await db.query(`UPDATE item_stock SET quantity = 3, updated_at = now() WHERE item_id = $1`, [itemId]);
    const countsBefore = await countRows("item_stock_counts");

    await expect(
      asBusiness(() => catalogue.applyCatalogue(owner("retail"), runId, true, { prices: true, stock: true })),
    ).rejects.toMatchObject({ code: "preview_stale" });

    // Nothing was written: no price, no count, and the shelf keeps its new balance.
    expect(await countRows("item_stock_counts")).toBe(countsBefore);
    expect(await stockOf(itemId)).toMatchObject({ quantity: "3.000000000", unit_price: "100000" });
    expect(await historyOf(itemId)).toEqual([]);

    // The guard the catalogue hands to the count is live, not decorative: the
    // balance the reviewer saw is passed as the baseline, so a count against a
    // shelf that moved refuses rather than posting an unreviewed variance.
    const reviewed = (plans["sku:MOVE-5"] as { quantity: { current: string } }).quantity.current;
    await expect(
      asBusiness(() =>
        dbLib.withTenantTransaction(biz.id, (client) =>
          stockCounts.createItemStockCount(client, {
            businessId: biz.id,
            locationId: biz.locationId,
            lines: [{ itemId, countedQty: "4" }],
            createdBy: null,
            baselineSnapshot: { [itemId]: reviewed },
          }),
        ),
      ),
    ).rejects.toThrow("snapshot_conflict");
    expect(await countRows("item_stock_counts")).toBe(countsBefore);
  });

  it("holds a serial item's quantity while still applying its price", async () => {
    const serialRun = await stageCatalogue({
      target: "watch",
      valueMode: "update_existing",
      sourceName: "watch-list.xlsx",
      fingerprint: "fp-serial",
      sheet: sheetOf([["SER-3", "ساعت سریال‌دار", "900000", "", "2"]]),
    });

    const plans = await stagedPlans(serialRun, "watch");
    expect(plans["sku:SER-3"]).toMatchObject({
      price: { action: "set", current: null, proposed: 900_000 },
      quantity: { action: "held", proposed: "2", reason: "catalogue_tracking_serial_unsupported" },
    });

    const summary = await asBusiness(() =>
      catalogue.applyCatalogue(owner("watch"), serialRun, true, { prices: true, stock: true }),
    );
    expect(summary.run.status).toBe("applied");

    // The price is real; the quantity never became a balance or a count.
    expect(await stockOf(items.serial)).toMatchObject({ unit_price: "900000", quantity: "0.000000000" });
    expect(await historyOf(items.serial)).toEqual([{ price_kind: "sale", old_price: null, new_price: "900000" }]);
    expect(await countLinesOf(items.serial)).toEqual([]);
  });
});
