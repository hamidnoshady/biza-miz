/**
 * Issue #770 — the canonical retail/cosmetics batch inventory engine, against
 * a real database.
 *
 * The load-bearing claims this file proves:
 *
 *   - a batch sale allocates FEFO, refuses expired stock, posts the exact
 *     cost of the lots it consumed and keeps `item_stock` rolled up to the
 *     batches (migration 0078's invariant);
 *   - the exact allocation is persisted per order line, so a return/void can
 *     restore the SAME lot;
 *   - transfers carry batch identity across branches, and a multi-unit
 *     fungible transfer values the destination at value ÷ quantity (the
 *     total-value-as-unit-cost regression);
 *   - a supplier return keeps `item_batches` and `item_stock` synchronised;
 *   - a purchase receipt keeps the real manufacturer/supplier lot number;
 *   - two concurrent sales of the same last units cannot both succeed.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let cosmetics: typeof import("../src/lib/cosmetics-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let engine: typeof import("../src/lib/retail-batch-inventory");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "", otherLocationId: "" };

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
  databaseName = `pos_batch_engine_${randomUUID().replaceAll("-", "")}`;

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
  itemsService = await import("../src/lib/items-service");
  cosmetics = await import("../src/lib/cosmetics-service");
  stockService = await import("../src/lib/retail-stock-service");
  engine = await import("../src/lib/retail-batch-inventory");
  provisioning = await import("../src/lib/business-provisioning");

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
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    // Order matters: children before parents, and every tenant-scoped table
    // this file writes.
    for (const table of [
      "order_item_batch_restorations",
      "order_item_batch_allocations",
      "item_stock_transfer_line_batches",
      "item_stock_transfer_items",
      "item_stock_transfers",
      "item_supplier_return_items",
      "item_supplier_returns",
      "item_purchase_items",
      "item_purchases",
      "item_batches",
      "item_stock",
      "items",
      "domain_events",
      "journal_lines",
      "journal_entries",
      "order_items",
      "orders",
      "accounts",
      "locations",
      "businesses",
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Cosmetics Co', $1, 'cosmetics') RETURNING id",
    [`batch-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id`,
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  biz.otherLocationId = locRow.rows[1].id;

  const seedClient = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(seedClient, biz.id, "cosmetics");
  } finally {
    seedClient.release();
  }
});

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createBatchItem(name = "کرم ضدآفتاب"): Promise<string> {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name,
    kind: "simple",
    tracking: "batch",
  });
  return item.id;
}

async function receive(itemId: string, batchNumber: string, quantity: string, unitCost: number, expiryDate: string | null) {
  await withTransaction((client) =>
    cosmetics.receiveBatch(client, { itemId, batchNumber, quantity, unitCost, expiryDate }),
  );
}

async function batchQuantity(itemId: string, batchNumber: string): Promise<string> {
  const { rows } = await db.query<{ quantity: string }>(
    "SELECT quantity::text FROM item_batches WHERE item_id = $1 AND batch_number = $2",
    [itemId, batchNumber],
  );
  return rows[0]?.quantity ?? "0";
}

async function stockQuantity(itemId: string): Promise<string> {
  const { rows } = await db.query<{ quantity: string; unit_cost: string | null }>(
    "SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.quantity ?? "0";
}

async function stockUnitCost(itemId: string): Promise<string | null> {
  const { rows } = await db.query<{ unit_cost: string | null }>(
    "SELECT unit_cost::text FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.unit_cost ?? null;
}

function sellCosmetic(itemId: string, quantity: string, unitPrice = 100_000) {
  return withTransaction((client) =>
    cosmetics.sellCosmeticUnits(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      itemId,
      quantity,
      unitPrice,
      vatPercent: 9,
      paymentMethod: "cash",
    }),
  );
}

describe("canonical batch sale", () => {
  it("allocates FEFO across lots, posts exact batch COGS and rolls item_stock", async () => {
    const item = await createBatchItem();
    // Two lots; the sale of 4 must take 3 from the earlier-expiring lot and 1
    // from the later one, at each lot's own cost.
    await receive(item, "EARLY", "3", 10_000, "2030-01-01");
    await receive(item, "LATE", "10", 20_000, "2031-01-01");

    const sale = await sellCosmetic(item, "4");

    expect(sale.batchNumbers).toEqual(["EARLY", "LATE"]);
    // 3 × 10,000 + 1 × 20,000 — exact, not the 15,385 shelf average.
    expect(sale.cost).toBe("50000");
    expect(await batchQuantity(item, "EARLY")).toBe("0.000000000");
    expect(await batchQuantity(item, "LATE")).toBe("9.000000000");
    expect(await stockQuantity(item)).toBe("9.000000000");
    // Weighted average of what is left: 9 × 20,000 / 9.
    expect(Number(await stockUnitCost(item))).toBe(20_000);
  });

  it("refuses expired stock but still sells the unexpired lots", async () => {
    const item = await createBatchItem();
    await receive(item, "OLD", "5", 10_000, "2020-01-01");
    await receive(item, "FRESH", "5", 30_000, "2035-01-01");

    // 5 sellable units, of which 2 requested: FEFO must skip the expired lot.
    const sale = await sellCosmetic(item, "2");
    expect(sale.batchNumbers).toEqual(["FRESH"]);
    expect(sale.cost).toBe("60000");
    expect(await batchQuantity(item, "OLD")).toBe("5.000000000");
    expect(await batchQuantity(item, "FRESH")).toBe("3.000000000");

    // 6 more than the sellable stock: refused, with the expiry-specific message.
    await expect(sellCosmetic(item, "6")).rejects.toThrow(/منقضی/);
  });

  it("refuses a sale larger than the sellable stock when nothing is expired", async () => {
    const item = await createBatchItem();
    await receive(item, "ONLY", "2", 10_000, "2030-01-01");
    await expect(sellCosmetic(item, "3")).rejects.toThrow(/موجودی کافی نیست/);
    // Nothing moved.
    expect(await batchQuantity(item, "ONLY")).toBe("2.000000000");
    expect(await stockQuantity(item)).toBe("2.000000000");
  });

  it("opens a tester from the earliest-expiring sellable lot and rolls the stock", async () => {
    const item = await createBatchItem("ریمل");
    await receive(item, "SOON", "2", 50_000, "2030-06-01");
    await receive(item, "LATER", "2", 60_000, "2031-06-01");

    await withTransaction((client) =>
      cosmetics.openTester(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item,
      }),
    );

    expect(await batchQuantity(item, "SOON")).toBe("1.000000000");
    expect(await batchQuantity(item, "LATER")).toBe("2.000000000");
    expect(await stockQuantity(item)).toBe("3.000000000");
  });

  it("writes off expired lots and rolls item_stock down to the rest", async () => {
    const item = await createBatchItem("کرم پودر");
    await receive(item, "EXPIRED", "2", 10_000, "2020-01-01");
    await receive(item, "GOOD", "3", 10_000, "2035-01-01");

    const result = await withTransaction((client) =>
      cosmetics.writeOffExpiredBatches(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item,
      }),
    );

    expect(result.writtenOffQuantity).toBe("2");
    expect(await batchQuantity(item, "EXPIRED")).toBe("0");
    expect(await stockQuantity(item)).toBe("3.000000000");
  });
});

describe("exact allocation persistence", () => {
  it("records one allocation row per consumed batch, with cost value", async () => {
    const item = await createBatchItem();
    await receive(item, "A", "2", 10_000, "2030-01-01");
    await receive(item, "B", "5", 12_000, "2031-01-01");

    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status) VALUES ($1, 1, 'retail', 'open') RETURNING id`,
      [biz.locationId],
    );
    const line = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
       VALUES ($1, $2, 'کرم', 1000, 1, 'served') RETURNING id`,
      [biz.locationId, order.rows[0].id],
    );

    await withTransaction(async (client) => {
      const allocations = await engine.allocateBatchStock(client, { itemId: item, quantity: "3" });
      await engine.consumeBatchAllocations(client, item, allocations);
      await engine.recordOrderItemBatchAllocations(client, {
        orderItemId: line.rows[0].id,
        orderId: order.rows[0].id,
        locationId: biz.locationId,
        itemId: item,
        sourceType: "retail_invoice",
        sourceId: order.rows[0].id,
        allocations,
      });
    });

    const stored = await withTransaction((client) => engine.listOrderItemBatchAllocations(client, line.rows[0].id));
    expect(stored.map((a) => [a.batchNumber, a.quantity, a.costValue])).toEqual([
      ["A", "2.000000000", "20000"],
      ["B", "1.000000000", "12000"],
    ]);

    // Restoring 2 units takes them back from the first lot, and the rollup follows.
    const restored = await withTransaction((client) =>
      engine.restoreOrderItemBatchStock(client, {
        orderItemId: line.rows[0].id,
        itemId: item,
        locationId: biz.locationId,
        quantity: "2",
        disposition: "restockable",
        sourceType: "test_refund",
        sourceId: randomUUID(),
      }),
    );
    expect(restored?.restockedQuantity).toBe("2");
    expect(restored?.restockedValue).toBe("20000");
    expect(await batchQuantity(item, "A")).toBe("2.000000000");
    expect(await stockQuantity(item)).toBe("6.000000000");
  });

  it("does not restock a damaged/expired disposition, but records it", async () => {
    const item = await createBatchItem();
    await receive(item, "A", "5", 10_000, "2030-01-01");

    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status) VALUES ($1, 2, 'retail', 'open') RETURNING id`,
      [biz.locationId],
    );
    const line = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
       VALUES ($1, $2, 'کرم', 1000, 1, 'served') RETURNING id`,
      [biz.locationId, order.rows[0].id],
    );

    await withTransaction(async (client) => {
      const allocations = await engine.allocateBatchStock(client, { itemId: item, quantity: "3" });
      await engine.consumeBatchAllocations(client, item, allocations);
      await engine.recordOrderItemBatchAllocations(client, {
        orderItemId: line.rows[0].id,
        orderId: order.rows[0].id,
        locationId: biz.locationId,
        itemId: item,
        sourceType: "woocommerce_order",
        sourceId: order.rows[0].id,
        allocations,
      });
    });
    expect(await stockQuantity(item)).toBe("2.000000000");

    const restored = await withTransaction((client) =>
      engine.restoreOrderItemBatchStock(client, {
        orderItemId: line.rows[0].id,
        itemId: item,
        locationId: biz.locationId,
        quantity: "3",
        disposition: "damaged",
        sourceType: "woocommerce_refund",
        sourceId: "refund-1",
      }),
    );
    expect(restored?.restockedQuantity).toBe("0");
    expect(restored?.disposedQuantity).toBe("3");
    expect(restored?.restockedValue).toBe("0");
    // The lot stays where it was: damaged stock is not sellable stock.
    expect(await batchQuantity(item, "A")).toBe("2.000000000");

    const { rows } = await db.query<{ disposition: string; quantity: string }>(
      `SELECT disposition, quantity::text FROM order_item_batch_restorations
        WHERE order_item_id = $1`,
      [line.rows[0].id],
    );
    expect(rows).toEqual([{ disposition: "damaged", quantity: "3.000000000" }]);

    // A replayed refund for the same source is a no-op, not a double restore.
    const replay = await withTransaction((client) =>
      engine.restoreOrderItemBatchStock(client, {
        orderItemId: line.rows[0].id,
        itemId: item,
        locationId: biz.locationId,
        quantity: "3",
        disposition: "damaged",
        sourceType: "woocommerce_refund",
        sourceId: "refund-1",
      }),
    );
    expect(replay?.disposedQuantity).toBe("0");
    expect(replay?.alreadyRestored).toBe(true);
    expect(await batchQuantity(item, "A")).toBe("2.000000000");
  });
});

describe("transfers", () => {
  async function fungiblePair() {
    const source = await itemsService.createItem({ locationId: biz.locationId, name: "شامپو" });
    const destination = await itemsService.createItem({ locationId: biz.otherLocationId, name: "شامپو" });
    await withTransaction((client) =>
      cosmetics.receiveStock(source.id, { quantity: "10", unitCost: 100_000 }, client),
    );
    return { source, destination };
  }

  it("values a multi-unit fungible transfer at value ÷ quantity on the destination", async () => {
    const { source, destination } = await fungiblePair();

    const transfer = await withTransaction((client) =>
      stockService.createItemTransfer(client, {
        businessId: biz.id,
        sourceLocationId: biz.locationId,
        destinationLocationId: biz.otherLocationId,
        idempotencyKey: `t-${randomUUID()}`,
        lines: [{ sourceItemId: source.id, destinationItemId: destination.id, quantity: "3" }],
      }),
    );
    await withTransaction((client) =>
      stockService.shipItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }),
    );
    await withTransaction((client) =>
      stockService.receiveItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }),
    );

    expect(await stockQuantity(destination.id)).toBe("3.000000000");
    // Regression: this used to receive the whole line value (300,000) as the
    // *unit* cost, tripling the destination's stock valuation.
    expect(Number(await stockUnitCost(destination.id))).toBe(100_000);
  });

  it("moves batch stock across branches, preserving lot identity, expiry and cost", async () => {
    const source = await createBatchItem("کرم شب");
    const destination = await itemsService.createItem({
      locationId: biz.otherLocationId,
      name: "کرم شب",
      kind: "simple",
      tracking: "batch",
    });
    await receive(source, "EARLY", "2", 40_000, "2030-01-01");
    await receive(source, "LATE", "5", 55_000, "2031-01-01");

    const transfer = await withTransaction((client) =>
      stockService.createItemTransfer(client, {
        businessId: biz.id,
        sourceLocationId: biz.locationId,
        destinationLocationId: biz.otherLocationId,
        idempotencyKey: `tb-${randomUUID()}`,
        lines: [{ sourceItemId: source, destinationItemId: destination.id, quantity: "3" }],
      }),
    );
    await withTransaction((client) =>
      stockService.shipItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }),
    );

    // Shipped: the source lots are down by exactly the FEFO allocation.
    expect(await batchQuantity(source, "EARLY")).toBe("0.000000000");
    expect(await batchQuantity(source, "LATE")).toBe("4.000000000");
    expect(await stockQuantity(source)).toBe("4.000000000");
    // In transit: nothing is on the destination's shelf yet (it has no stock
    // row at all until the first receive).
    expect(await stockQuantity(destination.id)).toBe("0");

    await withTransaction((client) =>
      stockService.receiveItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }),
    );

    // Received: the SAME lots arrive, with their expiry and cost.
    expect(await batchQuantity(destination.id, "EARLY")).toBe("2.000000000");
    expect(await batchQuantity(destination.id, "LATE")).toBe("1.000000000");
    expect(await stockQuantity(destination.id)).toBe("3.000000000");
    const { rows } = await db.query<{ batch_number: string; unit_cost: string; expiry_date: string }>(
      `SELECT batch_number, unit_cost::text, expiry_date::text FROM item_batches
        WHERE item_id = $1 ORDER BY batch_number`,
      [destination.id],
    );
    expect(rows).toEqual([
      { batch_number: "EARLY", unit_cost: "40000", expiry_date: "2030-01-01" },
      { batch_number: "LATE", unit_cost: "55000", expiry_date: "2031-01-01" },
    ]);
  });

  it("cancels a shipped batch transfer and restores the exact source lots", async () => {
    const source = await createBatchItem("تونر");
    const destination = await itemsService.createItem({
      locationId: biz.otherLocationId,
      name: "تونر",
      kind: "simple",
      tracking: "batch",
    });
    await receive(source, "L1", "4", 30_000, "2030-01-01");

    const transfer = await withTransaction((client) =>
      stockService.createItemTransfer(client, {
        businessId: biz.id,
        sourceLocationId: biz.locationId,
        destinationLocationId: biz.otherLocationId,
        idempotencyKey: `tc-${randomUUID()}`,
        lines: [{ sourceItemId: source, destinationItemId: destination.id, quantity: "2" }],
      }),
    );
    await withTransaction((client) =>
      stockService.shipItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }),
    );
    expect(await batchQuantity(source, "L1")).toBe("2.000000000");

    await withTransaction((client) =>
      stockService.cancelItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }),
    );
    expect(await batchQuantity(source, "L1")).toBe("4.000000000");
    expect(await stockQuantity(source)).toBe("4.000000000");
    expect(await stockQuantity(destination.id)).toBe("0");
  });
});

describe("supplier returns and purchases", () => {
  it("keeps item_stock synchronised with the batches after a supplier return", async () => {
    const item = await createBatchItem();
    await receive(item, "A", "5", 10_000, "2030-01-01");
    await receive(item, "B", "5", 20_000, "2031-01-01");
    expect(await stockQuantity(item)).toBe("10.000000000");

    const { rows: batchRows } = await db.query<{ id: string }>(
      "SELECT id FROM item_batches WHERE item_id = $1 AND batch_number = 'B'",
      [item],
    );

    await withTransaction((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        settlementMethod: "accounts_payable",
        reason: "مرجوعی به تأمین‌کننده",
        idempotencyKey: `sr-${randomUUID()}`,
        lines: [{ itemId: item, quantity: "4", batchId: batchRows[0].id }],
      }),
    );

    expect(await batchQuantity(item, "B")).toBe("1.000000000");
    // Regression: the batch used to drop while item_stock.quantity stayed at 10.
    expect(await stockQuantity(item)).toBe("6.000000000");
    // Weighted average of 5 × 10,000 + 1 × 20,000 over 6 units.
    expect(Number(await stockUnitCost(item))).toBe(11_667);
  });

  it("receives a purchase under the real manufacturer lot number", async () => {
    const item = await createBatchItem("کرم مرطوب‌کننده");

    await withTransaction((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [
          {
            itemId: item,
            quantity: "6",
            unitCost: 25_000,
            batchNumber: "LOT-2026-A17",
            expiryDate: "2028-05-01",
            manufactureDate: "2025-11-01",
            supplierReference: "SUP-778",
          },
        ],
      }),
    );

    expect(await batchQuantity(item, "LOT-2026-A17")).toBe("6.000000000");
    const { rows } = await db.query<{
      batch_number: string;
      expiry_date: string;
      manufacture_date: string;
      supplier_reference: string;
      internal_batch_number: boolean;
    }>(
      `SELECT batch_number, expiry_date::text, manufacture_date::text, supplier_reference, internal_batch_number
         FROM item_purchase_items WHERE item_id = $1`,
      [item],
    );
    expect(rows).toEqual([
      {
        batch_number: "LOT-2026-A17",
        expiry_date: "2028-05-01",
        manufacture_date: "2025-11-01",
        supplier_reference: "SUP-778",
        internal_batch_number: false,
      },
    ]);
  });

  it("generates — and flags — an internal reference only when no lot number is given", async () => {
    const item = await createBatchItem("پد پاک‌کننده");

    await withTransaction((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId: item, quantity: "2", unitCost: 5_000 }],
      }),
    );

    const { rows } = await db.query<{ batch_number: string; internal_batch_number: boolean }>(
      "SELECT batch_number, internal_batch_number FROM item_purchase_items WHERE item_id = $1",
      [item],
    );
    expect(rows[0].internal_batch_number).toBe(true);
    expect(rows[0].batch_number).toMatch(/^P-/);
    // The generated number still reached a real batch row, so the stock is
    // traceable even when the delivery carried no lot.
    expect(await batchQuantity(item, rows[0].batch_number)).toBe("2.000000000");
  });
});

describe("concurrency", () => {
  it("lets exactly one of two concurrent sales take the last units", async () => {
    const item = await createBatchItem("کرم آخر");
    await receive(item, "LAST", "2", 10_000, "2030-01-01");

    // Two independent transactions, each asking for the whole lot. They both
    // touch the same batch row; the engine's FOR UPDATE plus the guarded
    // decrement (`WHERE quantity >= n`) is what serializes them, so exactly
    // one can win and the loser must fail with the honest shortage message —
    // never oversell, never leave the rollup disagreeing with the batches.
    const attempt = () =>
      withTransaction(async (client) => {
        const allocations = await engine.allocateBatchStock(client, { itemId: item, quantity: "2" });
        await engine.consumeBatchAllocations(client, item, allocations);
        return allocations;
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason?.message ?? rejected[0].reason)).toMatch(/موجودی کافی نیست/);

    expect(await batchQuantity(item, "LAST")).toBe("0.000000000");
    expect(await stockQuantity(item)).toBe("0.000000000");
  });
});
