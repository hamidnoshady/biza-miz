/**
 * Issue #915 — purchase integrity on the retail `items` model.
 *
 * The load-bearing claims: POST-retry idempotency on purchases (a stable
 * client key means a retry after a committed-but-lost response returns the
 * ORIGINAL receipt — zero duplicate stock, AP or events; the same key with a
 * different payload is a deterministic conflict; a concurrent race has
 * exactly one winner); supplier identity is validated against the branch
 * (active, same location) rather than trusted as an arbitrary FK; and a
 * linked supplier return carries exact provenance — the purchase must belong
 * to the tenant/branch, every returned line must have been acquired under
 * it, cumulative returns never exceed what it received, and batch/serial
 * returns name lots/units that purchase actually delivered.
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
let dbLib: typeof import("../src/lib/db");
let stockService: typeof import("../src/lib/retail-stock-service");
let itemsService: typeof import("../src/lib/items-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "", otherLocationId: "", otherBusinessId: "", otherBusinessLocationId: "" };
const sup = { id: "", inactiveId: "", otherLocationId: "" };
const item = { id: "" };

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
  databaseName = `pos_pint_${randomUUID().replaceAll("-", "")}`;

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
  stockService = await import("../src/lib/retail-stock-service");
  itemsService = await import("../src/lib/items-service");
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
  await db.query("DELETE FROM item_supplier_return_items");
  await db.query("DELETE FROM item_supplier_returns");
  await db.query("DELETE FROM item_purchase_items");
  await db.query("DELETE FROM item_purchases");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM item_batches");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Integrity Co', $1, 'cosmetics'), ('Other Co', $2, 'cosmetics') RETURNING id",
    [`pint-${randomUUID().slice(0, 8)}`, `pint-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  biz.otherBusinessId = bizRow.rows[1].id;

  const locRow = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch'), ($2, 'Elsewhere') RETURNING id`,
    [biz.id, biz.otherBusinessId],
  );
  biz.locationId = locRow.rows[0].id;
  biz.otherLocationId = locRow.rows[1].id;
  biz.otherBusinessLocationId = locRow.rows[2].id;

  const supRow = await db.query<{ id: string }>(
    `INSERT INTO suppliers (location_id, name, is_active) VALUES
       ($1, 'Active supplier', true),
       ($1, 'Retired supplier', false),
       ($2, 'Branch supplier', true)
     RETURNING id`,
    [biz.locationId, biz.otherLocationId],
  );
  sup.id = supRow.rows[0].id;
  sup.inactiveId = supRow.rows[1].id;
  sup.otherLocationId = supRow.rows[2].id;

  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.id, "cosmetics");
  } finally {
    client.release();
  }

  const created = await itemsService.createItem({ locationId: biz.locationId, name: "کرم مرطوب‌کننده", tracking: "none" });
  item.id = created.id;
});

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

const receive = (overrides: Partial<Parameters<typeof stockService.receiveItemPurchase>[1]> = {}) =>
  withClient((client) =>
    stockService.receiveItemPurchase(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      ...overrides,
    }),
  );

describe("purchase idempotency (issue #915 P0)", () => {
  it("returns the original receipt for an identical retry — one purchase, one posting, one event", async () => {
    const key = randomUUID();
    const hash = stockService.retailRequestHash({ supplier: null, lines: [["a", "10", 50_000]] });

    const first = await receive({ idempotencyKey: key, requestHash: hash });
    expect(first.duplicate).toBe(false);

    const retry = await receive({ idempotencyKey: key, requestHash: hash });
    expect(retry.duplicate).toBe(true);
    expect(retry.id).toBe(first.id);
    expect(retry.total).toBe(first.total);

    const purchases = await db.query("SELECT id FROM item_purchases");
    expect(purchases.rows).toHaveLength(1);
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.id]);
    expect(Number(stock.rows[0].quantity)).toBe(10);
    const events = await db.query("SELECT id FROM domain_events WHERE event_type = 'retail.purchase_received'");
    expect(events.rows).toHaveLength(1);
    const entries = await db.query("SELECT id FROM journal_entries");
    expect(entries.rows).toHaveLength(1);
  });

  it("refuses the same key with a different payload as a deterministic conflict", async () => {
    const key = randomUUID();
    await receive({ idempotencyKey: key, requestHash: "hash-of-first-payload" });

    await expect(receive({ idempotencyKey: key, requestHash: "hash-of-second-payload" })).rejects.toBeInstanceOf(
      stockService.RetailIdempotencyConflictError,
    );

    const purchases = await db.query("SELECT id FROM item_purchases");
    expect(purchases.rows).toHaveLength(1);
  });

  it("concurrent submissions with the same key have exactly one winner and zero duplicates", async () => {
    const key = randomUUID();
    const hash = "same-payload-hash";

    const results = await Promise.allSettled([
      receive({ idempotencyKey: key, requestHash: hash }),
      receive({ idempotencyKey: key, requestHash: hash }),
    ]);

    // Either both resolved (the loser read the winner's committed row as a
    // duplicate) or the loser lost the unique-index race mid-transaction —
    // which the route resolves by re-reading the winner.
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<import("../src/lib/retail-stock-service").ReceivePurchaseResult> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.filter((r) => !r.value.duplicate)).toHaveLength(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(stockService.RetailIdempotencyRaceError);
    }

    const purchases = await db.query("SELECT id FROM item_purchases");
    expect(purchases.rows).toHaveLength(1);
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.id]);
    expect(Number(stock.rows[0].quantity)).toBe(10);
    const events = await db.query("SELECT id FROM domain_events WHERE event_type = 'retail.purchase_received'");
    expect(events.rows).toHaveLength(1);

    // The committed winner is readable by key — the route's race-recovery path.
    const winner = await stockService.readItemPurchaseByIdempotencyKey(biz.id, key);
    expect(winner?.id).toBe(fulfilled[0].value.id);
    expect(winner?.requestHash).toBe(hash);
  });

  it("a failed receipt rolls back whole — no purchase row survives for the key", async () => {
    const key = randomUUID();
    await expect(
      withClient((client) =>
        stockService.receiveItemPurchase(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          idempotencyKey: key,
          requestHash: "h",
          lines: [
            { itemId: item.id, quantity: "5", unitCost: 10_000 },
            { itemId: randomUUID(), quantity: "1", unitCost: 10_000 }, // unknown item fails the second line
          ],
        }),
      ),
    ).rejects.toThrow(/کالا یافت نشد/);

    const purchases = await db.query("SELECT id FROM item_purchases");
    expect(purchases.rows).toHaveLength(0);
    const stock = await db.query("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.id]);
    expect(stock.rows).toHaveLength(0);

    // The key is free again — the client may retry after fixing the payload.
    const retry = await receive({ idempotencyKey: key, requestHash: "h2" });
    expect(retry.duplicate).toBe(false);
  });
});

describe("supplier identity (issue #915 P1)", () => {
  it("accepts the branch's own active supplier", async () => {
    const purchase = await receive({ supplierId: sup.id });
    const stored = await db.query<{ supplier_id: string }>("SELECT supplier_id FROM item_purchases WHERE id = $1", [purchase.id]);
    expect(stored.rows[0].supplier_id).toBe(sup.id);
  });

  it("refuses an inactive supplier", async () => {
    await expect(receive({ supplierId: sup.inactiveId })).rejects.toThrow(/تأمین‌کننده/);
  });

  it("refuses another branch's supplier", async () => {
    await expect(receive({ supplierId: sup.otherLocationId })).rejects.toThrow(/تأمین‌کننده/);
  });
});

describe("linked supplier-return provenance (issue #915 P1)", () => {
  const sendBack = (overrides: Partial<Parameters<typeof stockService.createItemSupplierReturn>[1]> = {}) =>
    withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        settlementMethod: "accounts_payable",
        reason: "کالای معیوب",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.id, quantity: "1" }],
        ...overrides,
      }),
    );

  it("refuses a purchase id from another tenant or branch", async () => {
    await receive();
    // A purchase that exists but belongs to the OTHER business/location.
    const foreign = await db.query<{ id: string }>(
      `INSERT INTO item_purchases (business_id, location_id, total) VALUES ($1, $2, 0) RETURNING id`,
      [biz.otherBusinessId, biz.otherBusinessLocationId],
    );
    await expect(sendBack({ purchaseId: foreign.rows[0].id })).rejects.toThrow(/خرید مرتبط/);
    await expect(sendBack({ purchaseId: randomUUID() })).rejects.toThrow(/خرید مرتبط/);
  });

  it("refuses returning an item the named purchase never received", async () => {
    await receive();
    const other = await itemsService.createItem({ locationId: biz.locationId, name: "ریمل", tracking: "none" });
    const otherPurchase = await receive({ lines: [{ itemId: other.id, quantity: "3", unitCost: 20_000 }] });

    await expect(sendBack({ purchaseId: otherPurchase.id })).rejects.toThrow(/در خرید انتخاب‌شده دریافت نشده/);
  });

  it("enforces the cumulative return ceiling across multiple returns", async () => {
    const purchase = await receive(); // 10 units
    // A second, unrelated purchase of the same item — its quantity must NOT
    // widen the first purchase's ceiling.
    await receive({ lines: [{ itemId: item.id, quantity: "100", unitCost: 50_000 }] });

    await sendBack({ purchaseId: purchase.id, lines: [{ itemId: item.id, quantity: "6" }] });
    await sendBack({ purchaseId: purchase.id, lines: [{ itemId: item.id, quantity: "4" }] });
    await expect(
      sendBack({ purchaseId: purchase.id, lines: [{ itemId: item.id, quantity: "1" }] }),
    ).rejects.toThrow(/بیشتر/);
  });

  it("caps multiple lines of the same item within one request", async () => {
    const purchase = await receive(); // 10 units
    await receive({ lines: [{ itemId: item.id, quantity: "100", unitCost: 50_000 }] });
    await expect(
      sendBack({
        purchaseId: purchase.id,
        lines: [
          { itemId: item.id, quantity: "7" },
          { itemId: item.id, quantity: "7" },
        ],
      }),
    ).rejects.toThrow(/بیشتر/);
  });

  it("unlinked returns stay supported at current cost basis", async () => {
    await receive();
    const result = await sendBack({ lines: [{ itemId: item.id, quantity: "2" }] });
    expect(result.value).toBe("100000");
  });

  it("a batch return linked to a purchase must name a lot that purchase delivered", async () => {
    const batchItem = await itemsService.createItem({ locationId: biz.locationId, name: "سرم ویتامین", tracking: "batch" });
    const purchaseA = await receive({
      lines: [{ itemId: batchItem.id, quantity: "5", unitCost: 30_000, batchNumber: "LOT-A" }],
    });
    await receive({
      lines: [{ itemId: batchItem.id, quantity: "5", unitCost: 40_000, batchNumber: "LOT-B" }],
    });

    const lots = await db.query<{ id: string; batch_number: string }>(
      "SELECT id, batch_number FROM item_batches WHERE item_id = $1",
      [batchItem.id],
    );
    const lotA = lots.rows.find((l) => l.batch_number === "LOT-A")!;
    const lotB = lots.rows.find((l) => l.batch_number === "LOT-B")!;

    await expect(
      sendBack({ purchaseId: purchaseA.id, lines: [{ itemId: batchItem.id, quantity: "1", batchId: lotB.id }] }),
    ).rejects.toThrow(/بچ انتخاب‌شده/);

    const ok = await sendBack({
      purchaseId: purchaseA.id,
      lines: [{ itemId: batchItem.id, quantity: "1", batchId: lotA.id }],
    });
    expect(ok.value).toBe("30000");
  });

  it("a serial return linked to a purchase must name a unit that purchase delivered", async () => {
    const watch = await itemsService.createItem({ locationId: biz.locationId, name: "ساعت", tracking: "serial" });
    const purchaseA = await receive({
      lines: [{ itemId: watch.id, quantity: "1", unitCost: 9_000_000, serials: [{ serialNumber: "SN-A" }] }],
    });
    await receive({
      lines: [{ itemId: watch.id, quantity: "1", unitCost: 9_500_000, serials: [{ serialNumber: "SN-B" }] }],
    });

    await expect(
      sendBack({ purchaseId: purchaseA.id, lines: [{ itemId: watch.id, quantity: "1", serialNumber: "SN-B" }] }),
    ).rejects.toThrow(/این دستگاه در خرید انتخاب‌شده/);

    const ok = await sendBack({
      purchaseId: purchaseA.id,
      lines: [{ itemId: watch.id, quantity: "1", serialNumber: "SN-A" }],
    });
    expect(ok.value).toBe("9000000");
  });

  it("same return key with a different payload hash is a conflict; identical hash replays", async () => {
    await receive();
    const key = randomUUID();
    const first = await sendBack({ idempotencyKey: key, requestHash: "return-hash-1" });
    expect(first.duplicate).toBe(false);

    const replay = await sendBack({ idempotencyKey: key, requestHash: "return-hash-1" });
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(first.id);

    await expect(sendBack({ idempotencyKey: key, requestHash: "return-hash-2" })).rejects.toBeInstanceOf(
      stockService.RetailIdempotencyConflictError,
    );

    const returns = await db.query("SELECT id FROM item_supplier_returns");
    expect(returns.rows).toHaveLength(1);
  });
});
