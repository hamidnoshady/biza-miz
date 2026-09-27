/**
 * Retail split-payment support — see RETAIL_POS_ENGINEERING_REPORT.md's
 * split-payment section and src/lib/retail-tenders.ts's own header comment
 * for the design. The load-bearing claims this file checks:
 *
 *   1. Two or more tenders on one invoice produce one `payments` row per
 *      tender, exactly as the cashier entered it (not however the per-line
 *      ledger draw fragmented things), and every line's own revenue entry
 *      still balances with its debit side split across the accounts the
 *      tenders actually fund — for accessories, gold (two revenue-credit
 *      lines) and watch alike.
 *   2. A partial `credit` tender debits Accounts Receivable for exactly its
 *      own slice, not the whole invoice, and still requires a customer.
 *   3. A split that doesn't add up to the invoice (either direction) is
 *      refused before anything commits.
 *   4. Voiding a split-payment invoice reverses every tender it produced
 *      (retail-invoice-void-service.ts's `planPaymentRows` nets by method
 *      across however many rows there are — this is what actually exercises
 *      that with more than one method on the books).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { rialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let goldPricesService: typeof import("../src/lib/gold-prices-service");
let accessoriesService: typeof import("../src/lib/accessories-service");
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
  databaseName = `pos_retail_split_${randomUUID().replaceAll("-", "")}`;

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
  goldPricesService = await import("../src/lib/gold-prices-service");
  accessoriesService = await import("../src/lib/accessories-service");
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
  ["bankClearing", "1120", "Bank Clearing", "asset"],
  ["ar", "1200", "Accounts Receivable", "asset"],
  ["goldSalesRevenue", "4500", "Gold Sales Revenue", "revenue"],
  ["makingChargeRevenue", "4600", "Making Charge Revenue", "revenue"],
  ["vatPayable", "2200", "VAT Payable", "liability"],
  ["goldCogs", "5110", "Gold COGS", "expense"],
  ["goldInventory", "1320", "Gold Inventory", "asset"],
  ["watchSalesRevenue", "4550", "Watch Sales Revenue", "revenue"],
  ["watchCogs", "5120", "Watch COGS", "expense"],
  ["watchInventory", "1330", "Watch Inventory", "asset"],
  ["accessorySalesRevenue", "4560", "Accessory Sales Revenue", "revenue"],
  ["accessoryCogs", "5140", "Accessory COGS", "expense"],
  ["accessoryInventory", "1340", "Accessory Inventory", "asset"],
];

async function seedBusiness(industry: string) {
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM order_amendments");
  await db.query("DELETE FROM audit_log");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Retail Split Co', $1, $2) RETURNING id",
    [`retail-split-${randomUUID().slice(0, 8)}`, industry],
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

async function createCustomer(name = "مشتری"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name, roles) VALUES ($1, $2, ARRAY['customer']::text[]) RETURNING id",
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

interface DebitRow {
  accountId: string;
  debit: string;
}

/**
 * Every debit line posted by one specific domain-event type (revenue and
 * COGS share the same `source_type`/`source_id` in every one of these
 * services, so the event type is what actually isolates "the revenue
 * entry's own debit side" from a COGS entry that happens to debit the same
 * item).
 */
async function debitsFor(eventType: string, sourceType: string, sourceId: string): Promise<DebitRow[]> {
  const { rows } = await db.query<DebitRow>(
    `SELECT jl.account_id AS "accountId", jl.debit::text AS debit
       FROM domain_events de
       JOIN journal_entries je ON je.id = de.entry_id
       JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE de.business_id = $1 AND de.event_type = $2 AND de.source_type = $3 AND de.source_id = $4
        AND je.reversed_at IS NULL AND jl.debit::numeric > 0`,
    [biz.id, eventType, sourceType, sourceId],
  );
  return rows;
}

/** All live debit lines for a source, regardless of which event posted them (used by the void assertions). */
async function allDebitsFor(sourceType: string, sourceId: string): Promise<DebitRow[]> {
  const { rows } = await db.query<DebitRow>(
    `SELECT jl.account_id AS "accountId", jl.debit::text AS debit
       FROM domain_events de
       JOIN journal_entries je ON je.id = de.entry_id
       JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE de.business_id = $1 AND de.source_type = $2 AND de.source_id = $3
        AND je.reversed_at IS NULL AND jl.debit::numeric > 0`,
    [biz.id, sourceType, sourceId],
  );
  return rows;
}

async function paymentsFor(orderId: string): Promise<{ method: string; amount: number }[]> {
  const { rows } = await db.query<{ method: string; amount: string }>(
    "SELECT method::text AS method, amount::text AS amount FROM payments WHERE order_id = $1 ORDER BY settlement_seq",
    [orderId],
  );
  return rows.map((r) => ({ method: r.method, amount: Number(r.amount) }));
}

describe("split payment — accessories", () => {
  beforeEach(async () => {
    await seedBusiness("accessories");
  });

  it("records one payments row per tender and splits each line's own debit side across the funding accounts", async () => {
    const a = await makeAccessory("گردنبند بدلیجات", "10", 20_000, 100_000); // net incl. 9% vat = 109,000
    const b = await makeAccessory("دستبند بدلیجات", "10", 10_000, 50_000); // net incl. 9% vat = 54,500
    // Invoice total = 163,500. Cashier takes 100,000 cash + 63,500 card.
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      tenders: [
        { method: "cash", amount: rialText("100000") },
        { method: "bank", amount: rialText("63500") },
      ],
      lines: [
        { kind: "accessory", itemId: a.id, quantity: "1", vatPercent: 9 },
        { kind: "accessory", itemId: b.id, quantity: "1", vatPercent: 9 },
      ],
    });
    expect(created.total).toBe("163500");

    expect(await paymentsFor(created.orderId)).toEqual([
      { method: "cash", amount: 100_000 },
      { method: "card", amount: 63_500 },
    ]);

    // Line A (109,000) draws 100,000 cash + 9,000 bank; line B (54,500) is
    // entirely bank (the queue had 54,500 of bank left). Each line's own
    // debit side still sums to that line's own total.
    const debitsA = await debitsFor("accessory.sale_revenue", "accessory_sale", a.id);
    const debitsB = await debitsFor("accessory.sale_revenue", "accessory_sale", b.id);
    const sum = (rows: DebitRow[]) => rows.reduce((s, r) => s + Number(r.debit), 0);
    expect(sum(debitsA)).toBe(109_000);
    expect(sum(debitsB)).toBe(54_500);
    expect(debitsA.filter((r) => r.accountId === acct.cash).length).toBe(1);
    expect(debitsA.find((r) => r.accountId === acct.cash)?.debit).toBe("100000");
    expect(debitsA.find((r) => r.accountId === acct.bankClearing)?.debit).toBe("9000");
    expect(debitsB.find((r) => r.accountId === acct.bankClearing)?.debit).toBe("54500");
    expect(debitsB.some((r) => r.accountId === acct.cash)).toBe(false);

    // Across the whole invoice, total cash debited + total bank debited must
    // equal exactly what the till actually took, by method.
    const totalCash = sum([...debitsA, ...debitsB].filter((r) => r.accountId === acct.cash));
    const totalBank = sum([...debitsA, ...debitsB].filter((r) => r.accountId === acct.bankClearing));
    expect(totalCash).toBe(100_000);
    expect(totalBank).toBe(63_500);
  });

  it("posts a partial credit tender to Accounts Receivable for exactly its own slice, and requires a customer", async () => {
    const variant = await makeAccessory("انگشتر بدلیجات", "10", 20_000, 100_000); // total 109,000
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "accessories",
        tenders: [
          { method: "cash", amount: rialText("50000") },
          { method: "credit", amount: rialText("59000") },
        ],
        lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
      }),
    ).rejects.toThrow("برای فروش نسیه، انتخاب مشتری الزامی است.");

    const customerId = await createCustomer();
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      customerId,
      tenders: [
        { method: "cash", amount: rialText("50000") },
        { method: "credit", amount: rialText("59000") },
      ],
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
    });

    expect(await paymentsFor(created.orderId)).toEqual([
      { method: "cash", amount: 50_000 },
      { method: "credit", amount: 59_000 },
    ]);
    const debits = await debitsFor("accessory.sale_revenue", "accessory_sale", variant.id);
    expect(debits.find((r) => r.accountId === acct.cash)?.debit).toBe("50000");
    expect(debits.find((r) => r.accountId === acct.ar)?.debit).toBe("59000");
  });

  it("refuses a split that overshot the invoice, and commits nothing", async () => {
    const variant = await makeAccessory("گوشواره بدلیجات", "10", 20_000, 100_000); // total 109,000
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "accessories",
        tenders: [
          { method: "cash", amount: rialText("100000") },
          { method: "bank", amount: rialText("20000") }, // 120,000 > 109,000
        ],
        lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
      }),
    ).rejects.toThrow("مجموع پرداختی‌ها با مبلغ فاکتور مطابقت ندارد.");

    expect(await allDebitsFor("accessory_sale", variant.id)).toHaveLength(0);
    const stock = await accessoriesService.getStock(variant.id);
    expect(stock?.quantity).toBe("10.000000000"); // untouched
  });

  it("refuses a split that fell short of the invoice, and commits nothing", async () => {
    const variant = await makeAccessory("پابند بدلیجات", "10", 20_000, 100_000); // total 109,000
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "accessories",
        tenders: [
          { method: "cash", amount: rialText("50000") },
          { method: "bank", amount: rialText("20000") }, // 70,000 < 109,000
        ],
        lines: [{ kind: "accessory", itemId: variant.id, quantity: "1", vatPercent: 9 }],
      }),
    ).rejects.toThrow("مجموع پرداختی‌ها با مبلغ فاکتور مطابقت ندارد.");

    expect(await allDebitsFor("accessory_sale", variant.id)).toHaveLength(0);
    const stock = await accessoriesService.getStock(variant.id);
    expect(stock?.quantity).toBe("10.000000000"); // untouched
  });

  it("reverses every tender on void, netted by method across however many payments rows exist", async () => {
    const customerId = await createCustomer();
    const a = await makeAccessory("سنجاق بدلیجات", "10", 20_000, 100_000); // 109,000
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      customerId,
      tenders: [
        { method: "cash", amount: rialText("50000") },
        { method: "bank", amount: rialText("30000") },
        { method: "credit", amount: rialText("29000") },
      ],
      lines: [{ kind: "accessory", itemId: a.id, quantity: "1", vatPercent: 9 }],
    });

    await voidInvoice(created.orderId);

    const rows = await paymentsFor(created.orderId);
    // Three original slices plus their exact negatives (netByMethod nets per
    // method, so one reversal row per method actually used).
    expect(rows.filter((r) => r.amount > 0)).toEqual([
      { method: "cash", amount: 50_000 },
      { method: "card", amount: 30_000 },
      { method: "credit", amount: 29_000 },
    ]);
    expect(rows.filter((r) => r.amount < 0).map((r) => r.amount).sort((x, y) => x - y)).toEqual(
      [-50_000, -30_000, -29_000].sort((x, y) => x - y),
    );
    expect(await allDebitsFor("accessory_sale", a.id)).toHaveLength(0);
  });
});

describe("split payment — gold (two revenue-credit lines)", () => {
  beforeEach(async () => {
    await seedBusiness("jewelry");
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
  });

  it("splits the payment debit side across cash and bank while metal/making-charge/VAT credits stay whole", async () => {
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

    // metalValue 12,500,000; makingCharge 875,000; profit 1,337,500;
    // vat 199,125; total 14,911,625 (same fixture as retail-invoice.integration.test.ts).
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      tenders: [
        { method: "cash", amount: rialText("10000000") },
        { method: "bank" }, // open — takes the rest
      ],
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
    expect(created.total).toBe("14911625");

    expect(await paymentsFor(created.orderId)).toEqual([
      { method: "cash", amount: 10_000_000 },
      { method: "card", amount: 4_911_625 },
    ]);

    const debits = await debitsFor("gold.sale_revenue", "gold_sale", item.id);
    expect(debits.find((r) => r.accountId === acct.cash)?.debit).toBe("10000000");
    expect(debits.find((r) => r.accountId === acct.bankClearing)?.debit).toBe("4911625");
    expect(debits.reduce((s, r) => s + Number(r.debit), 0)).toBe(14_911_625);
  });
});

describe("split payment — watch", () => {
  beforeEach(async () => {
    await seedBusiness("watch");
  });

  it("splits the payment debit side across cash and bank", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "ساعت مچی", tracking: "serial" });
    const serial = await itemsService.addSerial(item.id, "SN-0001", { unitCost: 20_000_000 });

    // price 30,000,000, 9% vat -> total 32,700,000.
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "watch",
      tenders: [
        { method: "bank", amount: rialText("12700000") },
        { method: "cash", amount: rialText("20000000") },
      ],
      lines: [{ kind: "watch", serialId: serial.id, price: 30_000_000, vatPercent: 9 }],
    });
    expect(created.total).toBe("32700000");

    expect(await paymentsFor(created.orderId)).toEqual([
      { method: "card", amount: 12_700_000 },
      { method: "cash", amount: 20_000_000 },
    ]);

    const debits = await debitsFor("watch.sale_revenue", "watch_sale", serial.id);
    expect(debits.find((r) => r.accountId === acct.bankClearing)?.debit).toBe("12700000");
    expect(debits.find((r) => r.accountId === acct.cash)?.debit).toBe("20000000");
  });
});
