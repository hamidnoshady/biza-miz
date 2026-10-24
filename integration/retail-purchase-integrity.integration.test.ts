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

/** The receipt's journal lines, joined to account codes, debit-first. */
async function purchaseJournal(purchaseId: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.source_type = 'item_purchase' AND je.source_id = $1
      ORDER BY jl.debit::numeric DESC, a.code`,
    [purchaseId],
  );
  return rows;
}

describe("settlement and the supplier invoice on the retail receive (issue #915)", () => {
  it("credit (and the historical default) posts Debit inventory / Credit accounts payable", async () => {
    const explicit = await receive({ settlementMethod: "credit" });
    const defaulted = await receive();
    for (const purchase of [explicit, defaulted]) {
      expect(await purchaseJournal(purchase.id)).toEqual([
        { code: "1350", debit: "500000", credit: "0" },
        { code: "2100", debit: "0", credit: "500000" },
      ]);
    }
    const { rows } = await db.query<{ settlement_method: string }>(
      "SELECT settlement_method FROM item_purchases ORDER BY created_at",
    );
    expect(rows.map((r) => r.settlement_method)).toEqual(["credit", "credit"]);
  });

  it("cash credits the till (1100), bank credits bank clearing (1120)", async () => {
    const cash = await receive({ settlementMethod: "cash" });
    expect(await purchaseJournal(cash.id)).toEqual([
      { code: "1350", debit: "500000", credit: "0" },
      { code: "1100", debit: "0", credit: "500000" },
    ]);

    const bank = await receive({ settlementMethod: "bank" });
    expect(await purchaseJournal(bank.id)).toEqual([
      { code: "1350", debit: "500000", credit: "0" },
      { code: "1120", debit: "0", credit: "500000" },
    ]);
  });

  it("the invoice's VAT debits 1220 and the settlement side carries goods + VAT", async () => {
    const purchase = await receive({
      settlementMethod: "credit",
      invoice: {
        invoiceNumber: "F-915-1",
        invoiceDate: "2026-02-01",
        vatAmount: 45_000,
        paymentTermsDays: null,
        dueDate: null,
      },
    });
    expect(await purchaseJournal(purchase.id)).toEqual([
      { code: "1350", debit: "500000", credit: "0" },
      { code: "1220", debit: "45000", credit: "0" },
      { code: "2100", debit: "0", credit: "545000" },
    ]);
    const { rows } = await db.query<{ vat_amount: string }>(
      "SELECT vat_amount::text FROM item_purchases WHERE id = $1",
      [purchase.id],
    );
    expect(rows[0].vat_amount).toBe("45000");
  });

  it("persists the supplier invoice and derives the due date from terms over the invoice date", async () => {
    const purchase = await receive({
      invoice: {
        invoiceNumber: "F-915-2",
        invoiceDate: "2026-02-01",
        vatAmount: 0,
        paymentTermsDays: 30,
        dueDate: null,
      },
    });
    const { rows } = await db.query<{
      supplier_invoice_number: string | null;
      supplier_invoice_date: string | null;
      payment_terms_days: number | null;
      payment_due_date: string | null;
    }>(
      `SELECT supplier_invoice_number, supplier_invoice_date::text, payment_terms_days, payment_due_date::text
         FROM item_purchases WHERE id = $1`,
      [purchase.id],
    );
    expect(rows[0]).toEqual({
      supplier_invoice_number: "F-915-2",
      supplier_invoice_date: "2026-02-01",
      payment_terms_days: 30,
      payment_due_date: "2026-03-03",
    });

    // An explicit due date wins over derived terms.
    const explicit = await receive({
      invoice: { invoiceNumber: null, invoiceDate: null, vatAmount: 0, paymentTermsDays: 30, dueDate: "2026-04-01" },
    });
    const { rows: explicitRows } = await db.query<{ payment_due_date: string | null }>(
      "SELECT payment_due_date::text FROM item_purchases WHERE id = $1",
      [explicit.id],
    );
    expect(explicitRows[0].payment_due_date).toBe("2026-04-01");
  });
});

describe("exact money on the retail purchase (issue #915 — bigint Rial past 2^53)", () => {
  // 2^53 + 1 — a value Number() can no longer represent exactly.
  const HUGE = "9007199254740993";

  it("a unit cost given as decimal text flows exactly into the document, stock, total and posting", async () => {
    const purchase = await receive({
      settlementMethod: "cash",
      lines: [{ itemId: item.id, quantity: "1", unitCost: HUGE }],
    });
    expect(purchase.total).toBe(HUGE);

    const doc = await db.query<{ total: string; unit_cost: string }>(
      `SELECT p.total::text, i.unit_cost::text
         FROM item_purchases p JOIN item_purchase_items i ON i.purchase_id = p.id
        WHERE p.id = $1`,
      [purchase.id],
    );
    expect(doc.rows[0].total).toBe(HUGE);
    expect(doc.rows[0].unit_cost).toBe(HUGE);

    const stock = await db.query<{ unit_cost: string }>(
      "SELECT unit_cost::text FROM item_stock WHERE item_id = $1",
      [item.id],
    );
    expect(stock.rows[0].unit_cost).toBe(HUGE);

    expect(await purchaseJournal(purchase.id)).toEqual([
      { code: "1350", debit: HUGE, credit: "0" },
      { code: "1100", debit: "0", credit: HUGE },
    ]);
  });

  it("the running average over a huge receipt stays exact (no float on the read-back)", async () => {
    await receive({ lines: [{ itemId: item.id, quantity: "1", unitCost: HUGE }] });
    await receive({ lines: [{ itemId: item.id, quantity: "1", unitCost: HUGE }] });
    const stock = await db.query<{ quantity: string; unit_cost: string }>(
      "SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1",
      [item.id],
    );
    expect(Number(stock.rows[0].quantity)).toBe(2);
    // Averaging two identical bigint costs through a float would drift to
    // ...992; the exact path keeps ...993.
    expect(stock.rows[0].unit_cost).toBe(HUGE);
  });

  it("refuses a malformed or unsafe cost as a validation error, never a cast surprise", async () => {
    for (const bad of ["12.5", "1e20", "-5", "", "99999999999999999999999999", Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        receive({ lines: [{ itemId: item.id, quantity: "1", unitCost: bad as never }] }),
      ).rejects.toBeInstanceOf(stockService.RetailStockError);
    }
    expect((await db.query("SELECT id FROM item_purchases")).rows).toHaveLength(0);
  });
});

describe("concurrent linked returns against one purchase (issue #915 phase 3)", () => {
  const sendBack = (quantity: string) =>
    withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: lastPurchaseId,
        settlementMethod: "accounts_payable",
        reason: "کالای معیوب",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.id, quantity }],
      }),
    );
  let lastPurchaseId = "";

  it("two simultaneous returns can never pass the ceiling together — the purchase row lock serialises them", async () => {
    const purchase = await receive(); // 10 units
    lastPurchaseId = purchase.id;

    // 6 + 6 > 10: whichever transaction commits second must see the first
    // one's rows (FOR UPDATE on the purchase) and fail the cumulative check.
    const results = await Promise.allSettled([sendBack("6"), sendBack("6")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/بیشتر/);

    const { rows } = await db.query<{ quantity: string }>(
      `SELECT COALESCE(sum(l.quantity), 0)::text AS quantity
         FROM item_supplier_return_items l
         JOIN item_supplier_returns r ON r.id = l.return_id
        WHERE r.purchase_id = $1`,
      [purchase.id],
    );
    expect(Number(rows[0].quantity)).toBe(6);
    // And the stock relief matches the single accepted return: 10 − 6 = 4.
    const stock = await db.query<{ quantity: string }>(
      "SELECT quantity::text FROM item_stock WHERE item_id = $1",
      [item.id],
    );
    expect(Number(stock.rows[0].quantity)).toBe(4);
  });
});

describe("posted-receipt correction guard (issue #915 phase 3, migration 0234)", () => {
  it("the only UPDATE the engine performs — finalising total on the in-flight row — still works (receive proves it)", async () => {
    const purchase = await receive();
    const { rows } = await db.query<{ total: string }>(
      "SELECT total::text FROM item_purchases WHERE id = $1",
      [purchase.id],
    );
    expect(rows[0].total).toBe("500000");
  });

  it("every other UPDATE of a posted receipt is rejected by the database itself", async () => {
    const purchase = await receive();
    // Rewriting the settlement after posting would silently detach the
    // document from its ledger entry.
    await expect(
      db.query("UPDATE item_purchases SET settlement_method = 'cash' WHERE id = $1", [purchase.id]),
    ).rejects.toThrow(/item_purchase_correction_forbidden/);
    // Re-finalising a finalised total (total is no longer 0) is rejected too.
    await expect(
      db.query("UPDATE item_purchases SET total = total + 1 WHERE id = $1", [purchase.id]),
    ).rejects.toThrow(/item_purchase_correction_forbidden/);
    // Even a "harmless" note edit: corrections are new documents, not edits.
    await expect(
      db.query("UPDATE item_purchases SET note = 'edited' WHERE id = $1", [purchase.id]),
    ).rejects.toThrow(/item_purchase_correction_forbidden/);
  });

  it("a tenant-scoped session can never DELETE a posted receipt; maintenance and cascades still can", async () => {
    const purchase = await receive();

    // The application's tenant pool always carries app.business_id — that
    // session is refused.
    await expect(
      withClient(async (client) => {
        await client.query("SELECT set_config('app.business_id', $1, true)", [biz.id]);
        await client.query("DELETE FROM item_purchases WHERE id = $1", [purchase.id]);
      }),
    ).rejects.toThrow(/item_purchase_delete_forbidden/);
    const survived = await db.query("SELECT id FROM item_purchases WHERE id = $1", [purchase.id]);
    expect(survived.rows).toHaveLength(1);

    // A maintenance session (no tenant GUC — platform scripts, this suite's
    // own beforeEach) can still clean up directly …
    await db.query("DELETE FROM item_purchases WHERE id = $1", [purchase.id]);
    const gone = await db.query("SELECT id FROM item_purchases WHERE id = $1", [purchase.id]);
    expect(gone.rows).toHaveLength(0);

    // … and an FK cascade (platform offboarding removing a branch/business)
    // fires the trigger at depth > 1 and passes through.
    const { rows: cascaded } = await db.query<{ id: string }>(
      "INSERT INTO item_purchases (business_id, location_id, total) VALUES ($1, $2, 0) RETURNING id",
      [biz.otherBusinessId, biz.otherBusinessLocationId],
    );
    await db.query("DELETE FROM locations WHERE id = $1", [biz.otherBusinessLocationId]);
    const sweptAway = await db.query("SELECT id FROM item_purchases WHERE id = $1", [cascaded[0].id]);
    expect(sweptAway.rows).toHaveLength(0);
  });
});
