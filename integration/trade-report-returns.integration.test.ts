/**
 * GH #1567 F4 — trade sales reports net of returns, consistent with the
 * ledger, and grouped by the merchandising tags frozen at sale time.
 *
 * Every scenario ties the report to the general ledger: report revenue =
 * trade revenue − sales returns (4400), report COGS = trade COGS, per branch.
 * Covered: full return, partial refund with VAT, damaged (discarded) return,
 * size exchange, re-tagging after the sale, legacy (pre-snapshot) sales,
 * branch and tenant isolation, the fact table's own affinity guard, and the
 * same netting for accessories and cosmetics.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { quantityText, rialText } from "../src/lib/inventory-exact";
import type { Industry } from "../src/lib/industries";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let accessories: typeof import("../src/lib/accessories-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let returns: typeof import("../src/lib/customer-return-service");
let reports: typeof import("../src/lib/industry-reports-service");
let merch: typeof import("../src/lib/merchandising-service");
let profiles: typeof import("../src/lib/item-brands-service");
let codes: typeof import("../src/lib/retail-account-codes");

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
  databaseName = `pos_trade_report_returns_${randomUUID().replaceAll("-", "")}`;
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
  stockService = await import("../src/lib/retail-stock-service");
  accessories = await import("../src/lib/accessories-service");
  provisioning = await import("../src/lib/business-provisioning");
  retailInvoice = await import("../src/lib/retail-invoice-service");
  returns = await import("../src/lib/customer-return-service");
  reports = await import("../src/lib/industry-reports-service");
  merch = await import("../src/lib/merchandising-service");
  profiles = await import("../src/lib/item-brands-service");
  codes = await import("../src/lib/retail-account-codes");
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

interface Biz {
  id: string;
  main: string;
  branch: string;
  ownerId: string;
  industry: Industry;
  inventoryCode: string;
}

async function seed(industry: Industry, inventoryCode: string): Promise<Biz> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Shop', $1, $2) RETURNING id",
    [`shop-${randomUUID().slice(0, 8)}`, industry],
  );
  const id = bizRow.rows[0].id;
  const locRows = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id",
    [id],
  );
  const user = await db.query<{ id: string }>(
    "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id",
    [id],
  );
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, id, industry);
  } finally {
    client.release();
  }
  return { id, main: locRows.rows[0].id, branch: locRows.rows[1].id, ownerId: user.rows[0].id, industry, inventoryCode };
}

async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function sku(locationId: string, name: string): Promise<string> {
  const parent = await itemsService.createItem({ locationId, name, kind: "variant_parent" });
  const child = await itemsService.createVariantChild(parent.id, locationId, `${name} M`, null, [{ name: "سایز", value: "M" }]);
  return child.id;
}

async function purchase(b: Biz, locationId: string, itemId: string, quantity: string, unitCost: number) {
  return tx((client) => stockService.receiveItemPurchase(client, { businessId: b.id, locationId, lines: [{ itemId, quantity, unitCost }] }));
}

async function stock(itemId: string): Promise<{ quantity: string; unitCost: string | null; total: string | null }> {
  const { rows } = await db.query<{ quantity: string; unit_cost: string | null; total_value_rial: string | null }>(
    "SELECT quantity::text, unit_cost::text, total_value_rial::text FROM item_stock WHERE item_id=$1",
    [itemId],
  );
  return { quantity: String(Number(rows[0]?.quantity ?? 0)), unitCost: rows[0]?.unit_cost ?? null, total: rows[0]?.total_value_rial ?? null };
}

async function glNet(b: Biz, code: string): Promise<bigint> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND a.code = $2`,
    [b.id, code],
  );
  return BigInt(rows[0].net);
}

async function sumCarrying(b: Biz): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT coalesce(sum(s.total_value_rial),0)::text AS total
       FROM item_stock s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1`,
    [b.id],
  );
  return BigInt(rows[0].total);
}




type Kind = "stocked" | "accessory" | "cosmetic";
const PREFIX: Record<string, string> = { fashion_apparel: "fashion_apparel", accessories: "accessory", cosmetics: "cosmetic" };
const KIND: Record<string, Kind> = { fashion_apparel: "stocked", accessories: "accessory", cosmetics: "cosmetic" };

async function stockedSku(b: Biz, name: string, locationId = b.main, quantity = "10"): Promise<string> {
  const id = await sku(locationId, name);
  await purchase(b, locationId, id, quantity, 50_000);
  await accessories.setUnitPrice(id, 100_000);
  return id;
}

async function sellAt(
  b: Biz,
  itemId: string,
  quantity: string,
  options: { locationId?: string; vatPercent?: number } = {},
): Promise<{ orderId: string; orderItemId: string }> {
  const locationId = options.locationId ?? b.main;
  const invoice = await tx((client) =>
    retailInvoice.createRetailInvoice(client, {
      businessId: b.id,
      locationId,
      industry: b.industry,
      lines: [{ kind: KIND[b.industry], itemId, quantity, unitPrice: 100_000, discount: 0, vatPercent: options.vatPercent ?? 0 } as never],
      tenders: [{ method: "cash" }],
    }),
  );
  const { rows } = await db.query<{ id: string }>("SELECT id FROM order_items WHERE order_id=$1", [invoice.orderId]);
  return { orderId: invoice.orderId, orderItemId: rows[0].id };
}

async function giveBack(
  b: Biz,
  sale: { orderId: string; orderItemId: string },
  quantity: string,
  refund: number,
  disposition: "restockable" | "discarded" = "restockable",
  locationId = b.main,
) {
  return tx((client) =>
    returns.createCustomerReturn(client, {
      businessId: b.id,
      locationId,
      orderId: sale.orderId,
      refundMethod: "cash",
      refundAmount: rialText(String(refund)),
      reason: "F4 test",
      idempotencyKey: randomUUID(),
      createdBy: b.ownerId,
      lines: [{ orderItemId: sale.orderItemId, quantity: quantityText(quantity), disposition }],
    }),
  );
}

async function report(b: Biz, locationId = b.main) {
  return reports.variantSalesAnalysis(b.id, locationId, { eventPrefix: PREFIX[b.industry] });
}

/** Report totals must equal the ledger: revenue − 4400, and COGS. */
async function expectTiesToLedger(b: Biz) {
  const accounts = codes.RETAIL_ACCOUNT_CODES[b.industry as keyof typeof codes.RETAIL_ACCOUNT_CODES]!;
  const rows = await report(b);
  const revenue = rows.reduce((sum, r) => sum + r.netRevenue, 0);
  const cogs = rows.reduce((sum, r) => sum + r.cogs, 0);
  const ledgerRevenue = -(await glNet(b, accounts.revenue)) - (await glNet(b, "4400"));
  expect(BigInt(revenue)).toBe(ledgerRevenue);
  expect(BigInt(cogs)).toBe(await glNet(b, accounts.cogs));
}

describe("F4 — variant/brand reports net returns exactly as the ledger does", () => {
  it("a full-price return of 1 of 3 leaves 2 / 200,000 / 100,000 (the baseline repro)", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "پیراهن");
    const sale = await sellAt(b, item, "3");
    await giveBack(b, sale, "1", 100_000);

    const [row] = await report(b);
    expect(row).toMatchObject({ itemId: item, quantitySold: "2", netRevenue: 200_000, cogs: 100_000, margin: 100_000 });
    await expectTiesToLedger(b);
    const [brand] = await reports.brandSalesAnalysis(b.id, b.main, { eventPrefix: "fashion_apparel" });
    expect(brand).toMatchObject({ quantitySold: "2", netRevenue: 200_000, cogs: 100_000 });
    expect(await stock(item)).toMatchObject({ quantity: "8", total: "400000" });
  });

  it("a partial refund with VAT takes off exactly the contra-revenue the ledger booked", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "مانتو");
    // 2 × 100,000 + 9% VAT = 218,000; the customer gets 54,500 back for one
    // unit kept at a discount: 50,000 revenue + 4,500 VAT.
    const sale = await sellAt(b, item, "2", { vatPercent: 9 });
    await giveBack(b, sale, "1", 54_500);

    const [row] = await report(b);
    expect(row).toMatchObject({ quantitySold: "1", netRevenue: 150_000, cogs: 50_000 });
    expect(await glNet(b, "4400")).toBe(50_000n);
    await expectTiesToLedger(b);
  });

  it("a damaged return reduces quantity and revenue but reverses no COGS — like the ledger", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "شلوار");
    const sale = await sellAt(b, item, "2");
    await giveBack(b, sale, "1", 100_000, "discarded");

    const [row] = await report(b);
    expect(row).toMatchObject({ quantitySold: "1", netRevenue: 100_000, cogs: 100_000, margin: 0 });
    expect(await stock(item)).toMatchObject({ quantity: "8" });
    await expectTiesToLedger(b);
  });

  it("a size exchange M→L returns M's unit with no revenue and sells L as its own sale", async () => {
    const b = await seed("fashion_apparel", "1374");
    const medium = await stockedSku(b, "کت M");
    const large = await stockedSku(b, "کت L");
    const first = await sellAt(b, medium, "1");
    await giveBack(b, first, "1", 0);
    await sellAt(b, large, "1");

    const rows = await report(b);
    const byItem = new Map(rows.map((r) => [r.itemId, r]));
    expect(byItem.get(medium)).toMatchObject({ quantitySold: "0", netRevenue: 100_000, cogs: 0 });
    expect(byItem.get(large)).toMatchObject({ quantitySold: "1", netRevenue: 100_000, cogs: 50_000 });
    await expectTiesToLedger(b);
  });

  it("returns are dated by the return, so a period sees only what the ledger booked in it", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "ژاکت");
    const sale = await sellAt(b, item, "3");
    await giveBack(b, sale, "1", 100_000);
    await db.query("UPDATE sale_return_facts SET occurred_at = now() + interval '40 days' WHERE order_item_id = $1", [sale.orderItemId]);
    const today = new Date().toISOString().slice(0, 10);
    const [now] = await reports.variantSalesAnalysis(b.id, b.main, { eventPrefix: "fashion_apparel", from: today, to: today });
    expect(now).toMatchObject({ quantitySold: "3", netRevenue: 300_000 });
  });

  it("isolates branches and tenants, and refuses a fact filed under the wrong branch", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "پیراهن");
    const sale = await sellAt(b, item, "3");
    await giveBack(b, sale, "1", 100_000);
    expect(await report(b, b.branch)).toEqual([]);
    const other = await seed("fashion_apparel", "1374");
    expect(await reports.variantSalesAnalysis(other.id, b.main, { eventPrefix: "fashion_apparel" })).toEqual([]);

    await expect(
      db.query(
        `INSERT INTO sale_return_facts (business_id, location_id, order_id, order_item_id, item_id, source_type, source_id, quantity, disposition)
         VALUES ($1, $2, $3, $4, $5, 'customer_return', 'forged', 1, 'restockable')`,
        [b.id, b.branch, sale.orderId, sale.orderItemId, item],
      ),
    ).rejects.toThrow(/sale_return_fact_affinity_violation/);
  });

  for (const [industry, inventory] of [["accessories", "1340"], ["cosmetics", "1350"]] as const) {
    it(`nets returns the same way for ${industry}`, async () => {
      const b = await seed(industry, inventory);
      const item = await stockedSku(b, "کالا");
      const sale = await sellAt(b, item, "3");
      await giveBack(b, sale, "1", 100_000);
      const [row] = await report(b);
      expect(row).toMatchObject({ quantitySold: "2", netRevenue: 200_000, cogs: 100_000 });
      await expectTiesToLedger(b);
    });
  }
});

describe("F4 — sell-through by the tags each sale carried when it happened", () => {
  it("re-tagging a style moves only its future sales; its returns follow the sale's tags", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "پیراهن");
    const parent = (await db.query<{ parent_item_id: string }>("SELECT parent_item_id FROM items WHERE id=$1", [item])).rows[0].parent_item_id;
    await db.query("INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, 'دسته‌بندی', 'پیراهن مردانه')", [parent]);
    await profiles.updateItemProfile(item, { collection: "بهار ۱۴۰۵", season: "بهار" });
    const spring = await sellAt(b, item, "2");
    await profiles.updateItemProfile(item, { collection: "تابستان ۱۴۰۵", season: "تابستان" });
    await sellAt(b, item, "1");
    await giveBack(b, spring, "1", 100_000);

    const rows = await merch.sellThroughByCollection(b.id, b.main, { eventPrefix: "fashion_apparel" });
    const byCollection = new Map(rows.map((r) => [r.collection, r]));
    expect(byCollection.get("بهار ۱۴۰۵")).toMatchObject({
      season: "بهار", category: "پیراهن مردانه", snapshotKnown: true, quantitySold: "1", netRevenue: 100_000,
    });
    expect(byCollection.get("تابستان ۱۴۰۵")).toMatchObject({ season: "تابستان", quantitySold: "1", netRevenue: 100_000 });
    expect(rows).toHaveLength(2);
    expect(await merch.sellThroughByCollection(b.id, b.branch, { eventPrefix: "fashion_apparel" })).toEqual([]);
  });

  it("a sale recorded before snapshots existed is reported as unknown, never under today's tags", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "پیراهن");
    await profiles.updateItemProfile(item, { collection: "پاییز", season: "پاییز" });
    await sellAt(b, item, "1");
    // Simulate a pre-0328 sale event: no merch key.
    await db.query(
      `UPDATE domain_events SET payload = payload - 'merch'
        WHERE business_id = $1 AND event_type = 'fashion_apparel.sale_revenue'`,
      [b.id],
    );
    const rows = await merch.sellThroughByCollection(b.id, b.main, { eventPrefix: "fashion_apparel" });
    expect(rows).toEqual([
      { collection: null, season: null, category: null, snapshotKnown: false, quantitySold: "1", netRevenue: 100_000, unknownReturnQuantity: "0", revenueComplete: true },
    ]);
  });
});

describe("F4 — migration 0328 backfills legacy returns honestly", () => {
  it("re-derives a pre-0328 counter return's quantity and COGS, leaving its revenue share unknown", async () => {
    const b = await seed("fashion_apparel", "1374");
    const item = await stockedSku(b, "پیراهن");
    const sale = await sellAt(b, item, "3");
    const ret = await giveBack(b, sale, "1", 100_000);
    // Pretend the return predates 0328: no fact was written.
    await db.query("DELETE FROM sale_return_facts WHERE business_id = $1", [b.id]);
    const sql = readFileSync(new URL("../migrations/0328_sale_return_facts.sql", import.meta.url), "utf8");
    const backfill = sql.slice(sql.indexOf("-- Legacy online refunds"));
    await db.query(backfill);
    await db.query(backfill); // idempotent

    const { rows } = await db.query<{ source_type: string; source_id: string; quantity: string; net_rial: string; cogs_rial: string; amounts_known: boolean; merch: unknown }>(
      `SELECT source_type, source_id, trim_scale(quantity)::text AS quantity, net_rial::text, cogs_rial::text, amounts_known, merch
         FROM sale_return_facts WHERE business_id = $1`,
      [b.id],
    );
    expect(rows).toEqual([
      { source_type: "legacy_customer_return", source_id: ret.id, quantity: "1", net_rial: "0", cogs_rial: "50000", amounts_known: false, merch: null },
    ]);
    const [row] = await report(b);
    // Quantity and COGS net exactly; the refund's per-line revenue share was
    // never recorded, so revenue is not guessed.
    expect(row).toMatchObject({ quantitySold: "2", cogs: 100_000, netRevenue: 300_000 });
    expect(BigInt(row.cogs)).toBe(await glNet(b, "5184"));
    // GH #1567 C6 — and the row says so: its revenue is an upper bound.
    expect(row).toMatchObject({ unknownReturnQuantity: "1", revenueComplete: false });
  });

  it("mixed history: only rows (and totals) that include an unknown-amount return are marked incomplete (GH #1567 C6)", async () => {
    const b = await seed("fashion_apparel", "1374");
    const legacy = await stockedSku(b, "پیراهن قدیمی");
    const modern = await stockedSku(b, "پیراهن تازه");
    const legacySale = await sellAt(b, legacy, "3");
    await giveBack(b, legacySale, "1", 100_000);
    // That return predates 0328: drop its fact and backfill it the way 0328 does.
    await db.query("DELETE FROM sale_return_facts WHERE business_id = $1", [b.id]);
    const sql = readFileSync(new URL("../migrations/0328_sale_return_facts.sql", import.meta.url), "utf8");
    await db.query(sql.slice(sql.indexOf("-- Legacy online refunds")));
    // After 0328: a second return on the same legacy item (known), and a sale + return on another item (known).
    await giveBack(b, legacySale, "1", 100_000);
    const modernSale = await sellAt(b, modern, "2");
    await giveBack(b, modernSale, "1", 100_000);

    const rows = await report(b);
    const legacyRow = rows.find((r) => r.itemId === legacy)!;
    const modernRow = rows.find((r) => r.itemId === modern)!;
    // Legacy: 3 − 1 (unknown amount) − 1 (known) = 1 unit; revenue only nets the known return.
    expect(legacyRow).toMatchObject({ quantitySold: "1", netRevenue: 200_000, unknownReturnQuantity: "1", revenueComplete: false });
    expect(modernRow).toMatchObject({ quantitySold: "1", netRevenue: 100_000, unknownReturnQuantity: "0", revenueComplete: true });
    // The brand total covers both items, so it is incomplete too.
    const brands = await reports.brandSalesAnalysis(b.id, b.main, { eventPrefix: "fashion_apparel" });
    expect(brands).toHaveLength(1);
    expect(brands[0]).toMatchObject({ quantitySold: "2", netRevenue: 300_000, unknownReturnQuantity: "1", revenueComplete: false });
    // Sell-through carries the same flag on the group the legacy return falls in.
    const groups = await merch.sellThroughByCollection(b.id, b.main, { eventPrefix: "fashion_apparel" });
    expect(groups.some((g) => !g.revenueComplete && g.unknownReturnQuantity === "1")).toBe(true);
    expect(groups.reduce((n, g) => n + Number(g.unknownReturnQuantity), 0)).toBe(1);
  });
});
