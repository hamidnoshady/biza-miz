/**
 * `voidRetailInvoice` — see RETAIL_POS_ENGINEERING_REPORT.md §14 and
 * src/lib/retail-invoice-void-service.ts's own header comment for the full
 * design. The load-bearing claims this file checks:
 *
 *   1. Voiding an accessories/wholesale (trade-goods)/non-batch-cosmetic
 *      invoice actually reverses the ledger (revenue+COGS mirrored, not just
 *      `orders.status` flipped), restores `item_stock`, reverses any
 *      commission the line accrued and any loyalty points the sale earned,
 *      and cancels the payment/receivable footprint — for cash, credit and
 *      multi-line invoices alike (multi-line specifically exercises the
 *      fresh-id-per-reversal fix so two same-`posting_kind` lines don't
 *      collide on `uq_journal_business_source_posting`).
 *   2. Gold, watch, batch-tracked-cosmetic, and pre-fix-legacy lines are
 *      refused outright — nothing is written, `orders.status` stays
 *      `'completed'` — never half-voided.
 *   3. An invoice that already has a customer return, or is not a
 *      `completed` retail order, is refused the same way.
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
let itemsService: typeof import("../src/lib/items-service");
let accessoriesService: typeof import("../src/lib/accessories-service");
let cosmeticsService: typeof import("../src/lib/cosmetics-service");
let goldPricesService: typeof import("../src/lib/gold-prices-service");
let commissionService: typeof import("../src/lib/commission-service");
let loyaltyService: typeof import("../src/lib/loyalty-service");
let invoiceService: typeof import("../src/lib/retail-invoice-service");
let voidService: typeof import("../src/lib/retail-invoice-void-service");

const biz = { id: "", locationId: "" };
const acct: Record<string, string> = {};

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
  databaseName = `pos_retail_void_${randomUUID().replaceAll("-", "")}`;

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
  accessoriesService = await import("../src/lib/accessories-service");
  cosmeticsService = await import("../src/lib/cosmetics-service");
  goldPricesService = await import("../src/lib/gold-prices-service");
  commissionService = await import("../src/lib/commission-service");
  loyaltyService = await import("../src/lib/loyalty-service");
  invoiceService = await import("../src/lib/retail-invoice-service");
  voidService = await import("../src/lib/retail-invoice-void-service");

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

const ACCOUNT_SEED: [string, string, string, string][] = [
  ["cash", "1100", "Cash", "asset"],
  ["ar", "1200", "Accounts Receivable", "asset"],
  ["goldSalesRevenue", "4500", "Gold Sales Revenue", "revenue"],
  ["makingChargeRevenue", "4600", "Making Charge Revenue", "revenue"],
  ["vatPayable", "2200", "VAT Payable", "liability"],
  ["goldCogs", "5110", "Gold COGS", "expense"],
  ["goldInventory", "1320", "Gold Inventory", "asset"],
  ["accessorySalesRevenue", "4560", "Accessory Sales Revenue", "revenue"],
  ["accessoryCogs", "5140", "Accessory COGS", "expense"],
  ["accessoryInventory", "1340", "Accessory Inventory", "asset"],
  ["cosmeticSalesRevenue", "4570", "Cosmetic Sales Revenue", "revenue"],
  ["cosmeticCogs", "5150", "Cosmetic COGS", "expense"],
  ["cosmeticInventory", "1350", "Cosmetic Inventory", "asset"],
  ["wholesaleSalesRevenue", "4581", "Wholesale Sales Revenue", "revenue"],
  ["wholesaleCogs", "5181", "Wholesale COGS", "expense"],
  ["wholesaleInventory", "1371", "Wholesale Inventory", "asset"],
  ["watchSalesRevenue", "4550", "Watch Sales Revenue", "revenue"],
  ["watchCogs", "5120", "Watch COGS", "expense"],
  ["watchInventory", "1330", "Watch Inventory", "asset"],
  ["commissionExpense", "5210", "Commission expense", "expense"],
  ["salariesPayable", "2300", "Salaries payable", "liability"],
];

async function seedBusiness(industry: string) {
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM commission_accruals");
  await db.query("DELETE FROM commission_rules");
  await db.query("DELETE FROM customer_points");
  await db.query("DELETE FROM loyalty_programs");
  await db.query("DELETE FROM order_amendments");
  await db.query("DELETE FROM customer_return_inventory_allocations");
  await db.query("DELETE FROM customer_return_lines");
  await db.query("DELETE FROM customer_returns");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_batches");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Retail Void Co', $1, $2) RETURNING id",
    [`retail-void-${randomUUID().slice(0, 8)}`, industry],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  for (const [key, code, name, type] of ACCOUNT_SEED) {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4) RETURNING id",
      [biz.id, code, name, type],
    );
    acct[key] = rows[0].id;
  }
}

async function createEmployee(name = "فروشنده") {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', $2, 'x') RETURNING id`,
    [biz.id, name],
  );
  return rows[0].id;
}

async function createCustomer(name = "مشتری") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, $2) RETURNING id",
    [biz.id, name],
  );
  return rows[0].id;
}

async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

async function invoice(input: Parameters<typeof invoiceService.createRetailInvoice>[1]) {
  return withTransaction((client) => invoiceService.createRetailInvoice(client, input));
}

async function voidInvoice(orderId: string, reason = "اشتباه صندوقدار") {
  return withTransaction((client) =>
    voidService.voidRetailInvoice(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      orderId,
      actorId: null,
      reason,
    }),
  );
}

async function makeAccessory(name: string, quantity: string, unitCost: number, unitPrice: number) {
  const family = await itemsService.createItem({ locationId: biz.locationId, name, kind: "variant_parent" });
  const variant = await itemsService.createVariantChild(family.id, biz.locationId, "پیش‌فرض", null, [
    { name: "نوع", value: "پیش‌فرض" },
  ]);
  await accessoriesService.receiveStock(variant.id, { quantity, unitCost });
  await accessoriesService.setUnitPrice(variant.id, unitPrice);
  return variant;
}

async function stockOf(itemId: string): Promise<string> {
  const stock = await accessoriesService.getStock(itemId);
  return stock?.quantity ?? "0";
}

async function orderStatus(orderId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>("SELECT status::text AS status FROM orders WHERE id=$1", [
    orderId,
  ]);
  return rows[0]?.status ?? "";
}

/**
 * `journal_entries.source_id` is the fresh per-sale `postingSourceId`, not
 * the item id (see posting-engine.ts's own doc comment on that split) — so
 * this counts live entries by `domain_events.source_id`, which *does* still
 * carry the logical item id, joined to the journal entry each event posted.
 */
async function liveEntriesFor(sourceType: string, sourceId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text FROM domain_events de
       JOIN journal_entries je ON je.id = de.entry_id
      WHERE de.business_id = $1 AND de.source_type = $2 AND de.source_id = $3 AND je.reversed_at IS NULL`,
    [biz.id, sourceType, sourceId],
  );
  return Number(rows[0].count);
}

describe("voidRetailInvoice — accessories (fully automatic)", () => {
  beforeEach(async () => {
    await seedBusiness("accessories");
  });

  it("reverses revenue+COGS, restores stock, cancels the cash payment, and voids the order", async () => {
    const variant = await makeAccessory("دستبند بدلیجات", "10", 20_000, 50_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "3", vatPercent: 9 }],
    });

    expect(await stockOf(variant.id)).toBe("7.000000000");
    expect(await liveEntriesFor("accessory_sale", variant.id)).toBe(2); // revenue + COGS

    const result = await voidInvoice(created.orderId);
    expect(result.reversedEntryIds.length).toBe(2);

    expect(await stockOf(variant.id)).toBe("10.000000000");
    expect(await liveEntriesFor("accessory_sale", variant.id)).toBe(0);
    expect(await orderStatus(created.orderId)).toBe("voided");

    const { rows: items } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM order_items WHERE order_id=$1",
      [created.orderId],
    );
    expect(items.every((r) => r.status === "voided")).toBe(true);

    const { rows: payments } = await db.query<{ amount: string }>(
      "SELECT amount::text FROM payments WHERE order_id=$1 ORDER BY received_at",
      [created.orderId],
    );
    expect(payments.map((r) => Number(r.amount))).toEqual([163_500, -163_500]);

    const { rows: amendments } = await db.query<{ kind: string; previous_total: string; new_total: string }>(
      "SELECT kind::text AS kind, previous_total::text, new_total::text FROM order_amendments WHERE order_id=$1",
      [created.orderId],
    );
    expect(amendments).toHaveLength(1);
    expect(amendments[0].kind).toBe("void");
    expect(amendments[0].previous_total).toBe("163500");
    expect(amendments[0].new_total).toBe("0");
  });

  it("voids a multi-line invoice (two accessory lines) without a duplicate-posting-key collision", async () => {
    const bracelet = await makeAccessory("دستبند ۱", "10", 20_000, 50_000);
    const ring = await makeAccessory("انگشتر ۱", "10", 10_000, 30_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      lines: [
        { kind: "accessory", itemId: bracelet.id, quantity: "2", vatPercent: 9 },
        { kind: "accessory", itemId: ring.id, quantity: "1", vatPercent: 9 },
      ],
    });

    const result = await voidInvoice(created.orderId);
    expect(result.reversedEntryIds.length).toBe(4); // 2 lines × (revenue + COGS)
    expect(new Set(result.reversedEntryIds).size).toBe(4); // every id distinct — no collision

    expect(await stockOf(bracelet.id)).toBe("10.000000000");
    expect(await stockOf(ring.id)).toBe("10.000000000");

    // Every reversal must have actually posted as its own distinct
    // accessory_sale_revenue_reversal / accessory_sale_cogs_reversal entry —
    // this is exactly the uq_journal_business_source_posting collision class
    // §12/§13 of the report fixed elsewhere; the fresh randomUUID() per
    // reversal in reverseLiveEntry is what prevents it here too.
    const { rows: reversals } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE source_type = 'order_amendment' AND business_id = $1`,
      [biz.id],
    );
    expect(Number(reversals[0].count)).toBe(4);
  });

  it("reverses the accounts-receivable side of a credit sale (not just cash)", async () => {
    const customerId = await createCustomer();
    const variant = await makeAccessory("گردنبند", "5", 20_000, 50_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "credit" }],
      customerId,
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });

    const arBefore = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(debit) - SUM(credit), 0)::text AS balance
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.ar],
    );
    expect(Number(arBefore.rows[0].balance)).toBe(54_500); // 50,000 + 9% VAT

    await voidInvoice(created.orderId);

    const arAfter = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(debit) - SUM(credit), 0)::text AS balance
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.ar],
    );
    expect(Number(arAfter.rows[0].balance)).toBe(0);
  });

  it("reverses the commission the line accrued", async () => {
    const employeeId = await createEmployee();
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId,
      kind: "percent",
      basis: "net",
      value: 10,
    });
    const variant = await makeAccessory("سنجاق سینه", "10", 20_000, 100_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      createdBy: employeeId,
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });

    const before = await db.query<{ sum: string }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS sum FROM commission_accruals WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(before.rows[0].sum)).toBe(10_000); // 10% of 100,000 net

    await voidInvoice(created.orderId);

    const after = await db.query<{ sum: string }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS sum FROM commission_accruals WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(after.rows[0].sum)).toBe(0);

    const liability = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(credit) - SUM(debit), 0)::text AS balance
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.salariesPayable],
    );
    expect(Number(liability.rows[0].balance)).toBe(0);
  });

  it("reverses the loyalty points the sale earned", async () => {
    const customerId = await createCustomer();
    await loyaltyService.upsertProgram(biz.id, {
      name: "پیش‌فرض",
      earnPointsPer100000: 1,
      pointValueRial: 1000,
      isDefault: true,
    });
    const variant = await makeAccessory("دستبند طلایی‌رنگ", "10", 20_000, 500_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      customerId,
      businessDate: "2025-01-01",
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });

    const before = await db.query<{ sum: string }>(
      "SELECT COALESCE(SUM(points), 0)::text AS sum FROM customer_points WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(before.rows[0].sum)).toBeGreaterThan(0);

    await voidInvoice(created.orderId);

    const after = await db.query<{ sum: string }>(
      "SELECT COALESCE(SUM(points), 0)::text AS sum FROM customer_points WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(after.rows[0].sum)).toBe(0);
  });

  it("refuses a second void of the same invoice", async () => {
    const variant = await makeAccessory("گوشواره", "5", 20_000, 50_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });
    await voidInvoice(created.orderId);
    await expect(voidInvoice(created.orderId)).rejects.toThrow(voidService.RetailInvoiceVoidError);
  });

  it("refuses a line whose item was later deleted", async () => {
    const variant = await makeAccessory("پابند", "5", 20_000, 50_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });
    await db.query("UPDATE order_items SET item_id = NULL WHERE order_id = $1", [created.orderId]);
    await expect(voidInvoice(created.orderId)).rejects.toThrow(voidService.RetailInvoiceVoidError);
    expect(await orderStatus(created.orderId)).toBe("completed");
  });

  it("refuses a pre-fix legacy line with no recorded ledgerEntryIds, and mutates nothing", async () => {
    const variant = await makeAccessory("النگو", "5", 20_000, 50_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });
    // Simulate a line sold before this session's fix: strip ledgerEntryIds
    // the same way a pre-existing row in production would already lack it.
    await db.query(
      `UPDATE order_items SET retail_snapshot = retail_snapshot - 'ledgerEntryIds' WHERE order_id = $1`,
      [created.orderId],
    );
    await expect(voidInvoice(created.orderId)).rejects.toThrow(voidService.RetailInvoiceVoidError);
    expect(await orderStatus(created.orderId)).toBe("completed");
    expect(await stockOf(variant.id)).toBe("4.000000000"); // unchanged — never rolled back
  });

  it("refuses an invoice that already has a customer return on it", async () => {
    const variant = await makeAccessory("پلاک", "5", 20_000, 50_000);
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });
    await db.query(
      `INSERT INTO customer_returns
         (business_id, location_id, order_id, refund_method, refund_amount_rial, reason, idempotency_key)
       VALUES ($1, $2, $3, 'cash', 0, 'test', $4)`,
      [biz.id, biz.locationId, created.orderId, randomUUID()],
    );
    await expect(voidInvoice(created.orderId)).rejects.toThrow(voidService.RetailInvoiceVoidError);
  });
});

describe("voidRetailInvoice — trade-goods (fully automatic, shares the 'stocked' line kind)", () => {
  beforeEach(async () => {
    await seedBusiness("wholesale");
  });

  it("reverses revenue+COGS and restores stock for a wholesale line", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "پیچ و مهره", kind: "simple" });
    await accessoriesService.receiveStock(item.id, { quantity: "100", unitCost: 1_000 });
    await accessoriesService.setUnitPrice(item.id, 3_000);

    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "wholesale",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "stocked", itemId: item.id, quantity: "20", vatPercent: 9 }],
    });

    expect(await stockOf(item.id)).toBe("80.000000000");

    await voidInvoice(created.orderId);

    expect(await stockOf(item.id)).toBe("100.000000000");
    expect(await orderStatus(created.orderId)).toBe("voided");
  });
});

describe("voidRetailInvoice — cosmetics", () => {
  beforeEach(async () => {
    await seedBusiness("cosmetics");
  });

  it("voids a non-batch cosmetic line automatically", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "رژ لب", kind: "simple" });
    await accessoriesService.receiveStock(item.id, { quantity: "10", unitCost: 40_000 });
    await accessoriesService.setUnitPrice(item.id, 150_000);

    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "cosmetics",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "cosmetic", itemId: item.id, quantity: "2", vatPercent: 9 }],
    });

    expect(await stockOf(item.id)).toBe("8.000000000");
    await voidInvoice(created.orderId);
    expect(await stockOf(item.id)).toBe("10.000000000");
    expect(await orderStatus(created.orderId)).toBe("voided");
  });

  it("refuses a batch-tracked cosmetic line — FEFO allocation is not recoverable after the fact", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "کرم ضدآفتاب",
      kind: "simple",
      tracking: "batch",
    });
    await withTransaction((client) =>
      cosmeticsService.receiveBatch(client, {
        itemId: item.id,
        batchNumber: "B1",
        expiryDate: "2030-01-01",
        quantity: "10",
        unitCost: 20_000,
      }),
    );

    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "cosmetics",
      tenders: [{ method: "cash" }],
      // A batch-tracked item has no plain item_stock.unit_price to set —
      // the invoice line prices it directly, same as the till would.
      lines: [{ kind: "cosmetic", itemId: item.id, quantity: "2", unitPrice: 60_000, vatPercent: 9 }],
    });

    await expect(voidInvoice(created.orderId)).rejects.toThrow(voidService.RetailInvoiceVoidError);
    await expect(voidInvoice(created.orderId)).rejects.toThrow(/بچ‌محور/);
    expect(await orderStatus(created.orderId)).toBe("completed");
  });
});

describe("voidRetailInvoice — gold and watch are always refused", () => {
  beforeEach(async () => {
    await seedBusiness("jewelry");
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
  });

  it("refuses a gold line with the exact required Persian message, and mutates nothing", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند طلا",
      tracking: "weight",
    });
    await itemsService.setWeightAttributes(item.id, {
      purity: "18",
      grossWeight: "2.5",
      netWeight: "2.5",
      unitCostPerGram: "4000000",
    });

    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      tenders: [{ method: "cash" }],
      lines: [
        {
          kind: "gold",
          itemId: item.id,
          makingChargeType: "percent",
          makingChargeValue: 7,
          profitPercent: 10,
          vatPercent: 9,
        },
      ],
    });

    await expect(voidInvoice(created.orderId)).rejects.toThrow(
      "این فاکتور شامل کالای طلا/سریال‌دار است و به دلیل وضعیت نهایی فروش، ابطال خودکار امکان‌پذیر نیست.",
    );
    expect(await orderStatus(created.orderId)).toBe("completed");

    const { rows: weightRows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM item_weight_attributes WHERE item_id = $1",
      [item.id],
    );
    expect(weightRows[0].status).toBe("sold"); // untouched — still terminal
  });
});

describe("voidRetailInvoice — watch lines are always refused", () => {
  beforeEach(async () => {
    await seedBusiness("watch");
  });

  it("refuses a watch line with the exact required Persian message, and leaves the serial 'sold'", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت مچی",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(item.id, "SN-0001", { unitCost: 20_000_000 });

    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "watch",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "watch", serialId: serial.id, price: 30_000_000, vatPercent: 9 }],
    });

    await expect(voidInvoice(created.orderId)).rejects.toThrow(
      "این فاکتور شامل کالای طلا/سریال‌دار است و به دلیل وضعیت نهایی فروش، ابطال خودکار امکان‌پذیر نیست.",
    );
    expect(await orderStatus(created.orderId)).toBe("completed");

    const { rows: serialRows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM item_serials WHERE id = $1",
      [serial.id],
    );
    expect(serialRows[0].status).toBe("sold"); // untouched — still terminal
  });
});
