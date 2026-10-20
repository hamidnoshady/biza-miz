/**
 * Issue #924 — the parts of the price-matrix hardening that only Postgres can
 * prove: optimistic stock versions, purchase-cost locking, audit history for
 * bulk updates, full-scope preview counts, list-deletion history and the
 * supported-currency constraint.
 *
 * Every case here failed (or silently did nothing) before the fixes:
 *  - the stock version pattern was double-escaped, so `saveStockPrices` filtered
 *    out every cell and returned `{ touched: 0 }` without saving;
 *  - bulk quick updates wrote prices but produced no `product_price_history`;
 *  - preview counted only the five sampled rows;
 *  - purchase updates could revalue stock that already had a quantity.
 *
 * `npm run test:db` (needs Postgres; not part of `npm test`).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let service: typeof import("../src/lib/price-lists-service");

let businessId = "";
let locationId = "";
let listId = "";
let itemA = ""; // quantity 0, no cost — purchase price may be set
let itemB = ""; // quantity 5, cost 1000 — purchase price is locked
let itemC = ""; // quantity 0, no cost, no sale price

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function addItem(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO items (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, name],
  );
  return rows[0].id;
}

async function stockVersion(itemId: string): Promise<string> {
  const { rows } = await db.query<{ version: string }>(
    "SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS version FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0].version;
}

async function salePrice(itemId: string): Promise<number | null> {
  const { rows } = await db.query<{ unit_price: string | null }>(
    "SELECT unit_price::text AS unit_price FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.unit_price == null ? null : Number(rows[0].unit_price);
}

async function purchaseCost(itemId: string): Promise<number | null> {
  const { rows } = await db.query<{ unit_cost: string | null }>(
    "SELECT unit_cost::text AS unit_cost FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.unit_cost == null ? null : Number(rows[0].unit_cost);
}

async function history(kind?: string) {
  const { rows } = await db.query<{
    item_id: string;
    price_kind: string;
    price_list_id: string | null;
    old_price: string | null;
    new_price: string | null;
    source: string;
    reason: string | null;
  }>(
    kind
      ? "SELECT item_id, price_kind, price_list_id, old_price::text, new_price::text, source, reason FROM product_price_history WHERE price_kind = $1 ORDER BY created_at, item_id"
      : "SELECT item_id, price_kind, price_list_id, old_price::text, new_price::text, source, reason FROM product_price_history ORDER BY created_at, item_id",
    kind ? [kind] : [],
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    priceKind: row.price_kind,
    priceListId: row.price_list_id,
    oldPrice: row.old_price == null ? null : Number(row.old_price),
    newPrice: row.new_price == null ? null : Number(row.new_price),
    source: row.source,
    reason: row.reason,
  }));
}

beforeAll(async () => {
  databaseName = `pos_price_hardening_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  service = await import("../src/lib/price-lists-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  const dbLib = await import("../src/lib/db");
  await dbLib.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Shop', $1) RETURNING id",
    [`shop-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  locationId = location.rows[0].id;

  itemA = await addItem("کرم");
  itemB = await addItem("شامپو");
  itemC = await addItem("صابون");

  await db.query(
    "INSERT INTO item_stock (item_id, quantity, unit_cost, unit_price) VALUES ($1, 0, NULL, 10000), ($2, 5, 1000, 10000), ($3, 0, NULL, NULL)",
    [itemA, itemB, itemC],
  );

  const list = await db.query<{ id: string }>(
    "INSERT INTO price_lists (location_id, name) VALUES ($1, 'عمده') RETURNING id",
    [locationId],
  );
  listId = list.rows[0].id;
  await db.query(
    "INSERT INTO price_list_entries (price_list_id, item_id, price) VALUES ($1, $2, 50000), ($1, $3, 50000)",
    [listId, itemA, itemB],
  );
});

describe("saveStockPrices — versioned stock cells (F04)", () => {
  it("accepts the numeric version the matrix loads and saves the sale price", async () => {
    const version = await stockVersion(itemA);
    expect(version).toMatch(/^\d+$/);

    const result = await service.saveStockPrices(
      [{ itemId: itemA, kind: "sale", price: 12_000, expectedVersion: version }],
      { locationId, businessId },
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.touched).toBe(1);
    expect(await salePrice(itemA)).toBe(12_000);
  });

  it("reports a stale stock version as a conflict and leaves the price", async () => {
    const version = await stockVersion(itemA);
    await service.saveStockPrices(
      [{ itemId: itemA, kind: "sale", price: 12_000, expectedVersion: version }],
      { locationId, businessId },
    );

    const stale = await service.saveStockPrices(
      [{ itemId: itemA, kind: "sale", price: 13_000, expectedVersion: version }],
      { locationId, businessId },
    );

    expect(stale.touched).toBe(0);
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.conflicts[0]).toMatchObject({
      itemId: itemA,
      kind: "sale",
      requestedPrice: 13_000,
      currentPrice: 12_000,
    });
    expect(await salePrice(itemA)).toBe(12_000);
  });
});

describe("purchase cost safety (F01)", () => {
  it("refuses a purchase price while stock is on hand, even from a null cost", async () => {
    const version = await stockVersion(itemB);
    const result = await service.saveStockPrices(
      [{ itemId: itemB, kind: "purchase", price: 2_000, expectedVersion: version }],
      { locationId, businessId },
    );
    expect(result.touched).toBe(0);
    expect(result.skipped).toContainEqual({
      itemId: itemB,
      kind: "purchase",
      reason: "purchase_cost_locked_with_stock",
    });
    expect(await purchaseCost(itemB)).toBe(1_000);
  });

  it("allows a purchase price for a zero-quantity item", async () => {
    const version = await stockVersion(itemC);
    const result = await service.saveStockPrices(
      [{ itemId: itemC, kind: "purchase", price: 3_000, expectedVersion: version }],
      { locationId, businessId },
    );
    expect(result.touched).toBe(1);
    expect(await purchaseCost(itemC)).toBe(3_000);
  });

  it("bulk purchase updates skip items that hold stock", async () => {
    const outcome = await service.quickUpdatePrices({
      target: { kind: "purchase" },
      mode: "percent",
      value: 10,
      round: false,
      itemIds: [],
      // Explicit branch-wide scope: an empty id list alone no longer means all.
      scope: { kind: "all" },
      locationId,
      businessId,
      source: "bulk",
    });
    // itemA and itemC have quantity 0; itemB has 5 and must not be revalued.
    // Both zero-quantity items still have no purchase price to move, so the
    // statement changes nothing — and the lock on itemB is reported, not silent.
    expect(outcome.changed).toBe(0);
    expect(outcome.skipped).toBe(1); // itemB, refused by the quantity guard
    expect(await purchaseCost(itemB)).toBe(1_000);
  });
});

describe("quick update — audit history is written (F07)", () => {
  it("records one immutable row per actually changed list cell", async () => {
    const outcome = await service.quickUpdatePrices({
      target: { kind: "list", priceListId: listId },
      mode: "percent",
      value: 10,
      round: false,
      itemIds: [],
      // Explicit branch-wide scope: an empty id list alone no longer means all.
      scope: { kind: "all" },
      locationId,
      businessId,
      source: "bulk",
    });
    expect(outcome).toEqual({ changed: 2, skipped: 0 });

    const rows = await history("list");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: itemA,
          priceKind: "list",
          priceListId: listId,
          oldPrice: 50_000,
          newPrice: 55_000,
          source: "bulk",
          reason: "quick_update",
        }),
        expect.objectContaining({ itemId: itemB, oldPrice: 50_000, newPrice: 55_000 }),
      ]),
    );
  });

  it("does not log no-op bulk changes", async () => {
    const outcome = await service.quickUpdatePrices({
      target: { kind: "list", priceListId: listId },
      mode: "percent",
      value: 0,
      round: false,
      itemIds: [],
      // Explicit branch-wide scope: an empty id list alone no longer means all.
      scope: { kind: "all" },
      locationId,
      businessId,
      source: "bulk",
    });
    expect(outcome).toEqual({ changed: 0, skipped: 2 }); // both cells already at 0%
    expect(await history("list")).toHaveLength(0);
  });

  it("records the deleted list's entries before the cascade", async () => {
    const deleted = await service.deletePriceList(listId, locationId, {
      businessId,
      actorId: null,
    });
    expect(deleted).toBe(true);

    const rows = await history("list");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.newPrice).toBeNull();
      expect(row.oldPrice).toBe(50_000);
      expect(row.reason).toBe("price_list_deleted");
      expect(row.priceListId).toBeNull(); // ON DELETE SET NULL, history survives
    }
  });
});

describe("quick-update preview (F11)", () => {
  it("counts and totals the whole scope, not just the sampled five rows", async () => {
    for (const name of ["الف", "ب", "پ", "ت", "ث", "ج", "چ"]) {
      const item = await addItem(name);
      await db.query(
        "INSERT INTO price_list_entries (price_list_id, item_id, price) VALUES ($1, $2, 10000)",
        [listId, item],
      );
    }

    const preview = await service.previewQuickUpdate({
      target: { kind: "list", priceListId: listId },
      mode: "percent",
      value: 10,
      round: false,
      itemIds: [],
      // Explicit branch-wide scope: an empty id list alone no longer means all.
      scope: { kind: "all" },
      locationId,
      businessId,
    });

    expect(preview.affectedCount).toBe(9);
    expect(preview.skippedCount).toBe(0);
    expect(preview.totalBefore).toBe(2 * 50_000 + 7 * 10_000);
    expect(preview.totalAfter).toBe(2 * 55_000 + 7 * 11_000);
    expect(preview.sample).toHaveLength(5);
  });

  it("excludes purchase-locked items from the purchase preview totals", async () => {
    const preview = await service.previewQuickUpdate({
      target: { kind: "purchase" },
      mode: "amount",
      value: 1_000,
      round: false,
      itemIds: [],
      // Explicit branch-wide scope: an empty id list alone no longer means all.
      scope: { kind: "all" },
      locationId,
      businessId,
    });
    // Only itemB has a purchase cost today, and it is locked by quantity 5.
    expect(preview.affectedCount).toBe(0);
    expect(preview.skippedCount).toBe(0);
    expect(preview.totalBefore).toBe(0);
  });
});

describe("price history is transactional (F07)", () => {
  it("writes a row inside the caller's transaction", async () => {
    const dbLib = await import("../src/lib/db");
    const { recordPriceHistory } = await import("../src/lib/price-history");
    await dbLib.withTenantTransaction(
      businessId,
      async () => {
        await recordPriceHistory([
          {
            businessId,
            locationId,
            itemId: itemA,
            priceKind: "sale",
            oldPrice: 10_000,
            newPrice: 12_000,
            source: "sync",
            reason: "woocommerce_product_sync",
          },
        ]);
      },
      { locationId },
    );

    const rows = await history("sale");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: itemA,
      oldPrice: 10_000,
      newPrice: 12_000,
      source: "sync",
      reason: "woocommerce_product_sync",
    });
  });

  it("disappears with a rolled-back price write", async () => {
    const dbLib = await import("../src/lib/db");
    const { recordPriceHistory } = await import("../src/lib/price-history");
    await expect(
      dbLib.withTenantTransaction(
        businessId,
        async () => {
          await recordPriceHistory([
            {
              businessId,
              locationId,
              itemId: itemA,
              priceKind: "sale",
              oldPrice: 10_000,
              newPrice: 13_000,
              source: "manual",
            },
          ]);
          throw new Error("price write failed");
        },
        { locationId },
      ),
    ).rejects.toThrow("price write failed");

    expect(await history("sale")).toHaveLength(0);
  });

  it("skips the no-op case", async () => {
    const { recordOnePriceChange } = await import("../src/lib/price-history");
    const dbLib = await import("../src/lib/db");
    await dbLib.withTenantTransaction(
      businessId,
      async () => {
        await recordOnePriceChange({
          businessId,
          locationId,
          itemId: itemA,
          priceKind: "sale",
          oldPrice: 10_000,
          newPrice: 10_000,
          source: "manual",
        });
      },
      { locationId },
    );
    expect(await history("sale")).toHaveLength(0);
  });
});

describe("currency constraint (F10)", () => {
  it("rejects an unsupported currency at the service boundary", async () => {
    const result = await service.createPriceList({
      locationId,
      name: "دلاری",
      currency: "GBP",
    });
    expect(result.error).toBe("unsupported_currency");
  });

  it("enforces the supported set in the database as well", async () => {
    await expect(
      db.query("INSERT INTO price_lists (location_id, name, currency) VALUES ($1, 'دلاری', 'GBP')", [
        locationId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
