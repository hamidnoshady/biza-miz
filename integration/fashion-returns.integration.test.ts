/**
 * #1567 Phase 3 — customer returns / exchanges on an items-model (fashion)
 * retail invoice. Acceptance: "scan a sale, exchange M→L, issue partial refund
 * and process an unsellable damaged return; correct per-SKU stock and GL, no
 * double posting on repeat, race or retry."
 *
 * Retail lines store `order_items.quantity = 1` and keep the real quantity in
 * `retail_snapshot.quantity`; their sale relieves `item_stock` and posts COGS
 * to the trade's own accounts (fashion: 5184 / 1374) — so a return must
 * restore `item_stock` and reverse *that* COGS entry proportionally, never the
 * generic 5100/1300 pair the warehouse (F&B) path uses.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { quantityText, rialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let tradeGoods: typeof import("../src/lib/trade-goods-service");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let returns: typeof import("../src/lib/customer-return-service");
let orderRead: typeof import("../src/lib/order-read-service");

const biz = { id: "", locationId: "", ownerId: "" };

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
  databaseName = `pos_fashion_returns_${randomUUID().replaceAll("-", "")}`;
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
  tradeGoods = await import("../src/lib/trade-goods-service");
  retailInvoice = await import("../src/lib/retail-invoice-service");
  returns = await import("../src/lib/customer-return-service");
  orderRead = await import("../src/lib/order-read-service");

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

// A fresh business per test: every test reads its own ledger and stock, so no
// cross-test cleanup is needed and none can leak.
beforeEach(async () => {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Fashion Co', $1, 'fashion_apparel') RETURNING id",
    [`fashion-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  biz.ownerId = userRow.rows[0].id;
  // The refund posting resolves cash/bank-clearing/AR/sales-returns/VAT
  // together (accountIdsByCode throws on any missing code); the sale posts to
  // the fashion trade's own revenue/COGS/inventory.
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1120', 'Bank clearing', 'asset'),
            ($1, '1200', 'Accounts receivable', 'asset'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '4400', 'Sales returns', 'revenue'),
            ($1, '4584', 'Fashion revenue', 'revenue'),
            ($1, '5184', 'Fashion COGS', 'expense'),
            ($1, '1374', 'Fashion inventory', 'asset')`,
    [biz.id],
  );
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

async function variant(name: string, quantity = "10"): Promise<string> {
  const parent = await itemsService.createItem({
    locationId: biz.locationId,
    name: `پیراهن ${name}`,
    kind: "variant_parent",
  });
  const child = await itemsService.createVariantChild(parent.id, biz.locationId, `سایز ${name}`, null, [
    { name: "سایز", value: name },
  ]);
  await tradeGoods.receiveTradeGoodsStock(child.id, { quantity, unitCost: 50_000 });
  await tradeGoods.setTradeGoodsUnitPrice(child.id, 100_000);
  return child.id;
}

async function sell(itemId: string, quantity: string): Promise<{ orderId: string; orderItemId: string }> {
  const invoice = await withTransaction((client) =>
    retailInvoice.createRetailInvoice(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "fashion_apparel",
      lines: [{ kind: "stocked", itemId, quantity, unitPrice: 100_000, discount: 0, vatPercent: 9 }],
      tenders: [{ method: "cash" }],
    }),
  );
  const { rows } = await db.query<{ id: string }>("SELECT id FROM order_items WHERE order_id=$1", [invoice.orderId]);
  expect(rows).toHaveLength(1);
  return { orderId: invoice.orderId, orderItemId: rows[0].id };
}

type ReturnInput = {
  orderId: string;
  orderItemId: string;
  quantity: string;
  disposition: "restockable" | "discarded";
  refund: string;
  key: string;
};

async function returnLine(input: ReturnInput, client?: PoolClient) {
  const run = (c: PoolClient) =>
    returns.createCustomerReturn(c, {
      businessId: biz.id,
      locationId: biz.locationId,
      orderId: input.orderId,
      refundMethod: "cash",
      refundAmount: rialText(input.refund),
      reason: "integration test",
      idempotencyKey: input.key,
      createdBy: biz.ownerId,
      lines: [{ orderItemId: input.orderItemId, quantity: quantityText(input.quantity), disposition: input.disposition }],
    });
  return client ? run(client) : withTransaction(run);
}

async function stockOf(itemId: string): Promise<number> {
  return Number((await tradeGoods.getStock(itemId))?.quantity);
}

/** Net debit−credit per account code, optionally limited to one posting kind. */
async function net(postingKind?: string): Promise<Map<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND ($2::text IS NULL OR je.posting_kind = $2)
      GROUP BY a.code`,
    [biz.id, postingKind ?? null],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.net)]));
}

async function countEntries(postingKind: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE business_id=$1 AND posting_kind=$2",
    [biz.id, postingKind],
  );
  return Number(rows[0].n);
}

async function expectBalancedLedger(): Promise<void> {
  const { rows } = await db.query<{ d: string; c: string }>(
    `SELECT coalesce(sum(jl.debit),0)::text AS d, coalesce(sum(jl.credit),0)::text AS c
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1`,
    [biz.id],
  );
  expect(rows[0].d).toBe(rows[0].c);
}

describe("fashion (items-model) customer returns", () => {
  it("partial restockable return restores the real quantity and reverses COGS proportionally to 1374/5184", async () => {
    const itemId = await variant("M");
    const sale = await sell(itemId, "3");
    expect(await stockOf(itemId)).toBe(7);
    // The order read the return panel uses exposes the real sold count.
    const detail = await orderRead.getOrderDetail(biz.locationId, sale.orderId);
    const detailLine = detail?.items.find((row) => row.id === sale.orderItemId);
    expect(Number(detailLine?.quantity)).toBe(1);
    expect(Number(detailLine?.returnable_quantity)).toBe(3);

    const first = await returnLine({ ...sale, quantity: "2", disposition: "restockable", refund: "218000", key: "r1" });
    expect(first.duplicate).toBe(false);
    // 150,000 COGS × 2/3
    expect(first.recoveredValue).toBe("100000");
    expect(await stockOf(itemId)).toBe(9);

    const reversal = await net("cogs_reversal");
    expect(reversal.get("1374")).toBe(100_000n);
    expect(reversal.get("5184")).toBe(-100_000n);
    // The warehouse path's generic accounts are never touched.
    expect(reversal.has("1300")).toBe(false);
    expect(reversal.has("5100")).toBe(false);

    const refund = await net("customer_refund");
    expect(refund.get("4400")).toBe(200_000n);
    expect(refund.get("2200")).toBe(18_000n);
    expect(refund.get("1100")).toBe(-218_000n);

    // Capacity reads the snapshot quantity (3), not order_items.quantity (1):
    // 2 already returned, so 2 more exceeds; the last 1 fits.
    await expect(
      returnLine({ ...sale, quantity: "2", disposition: "restockable", refund: "0", key: "r-over" }),
    ).rejects.toThrow(/return_quantity_exceeds_sold/);
    const last = await returnLine({ ...sale, quantity: "1", disposition: "restockable", refund: "109000", key: "r2" });
    expect(last.recoveredValue).toBe("50000");
    expect(await stockOf(itemId)).toBe(10);

    // Fully returned: the sale's COGS is exactly undone.
    const all = await net();
    expect(all.get("5184")).toBe(0n);
    await expectBalancedLedger();
  });

  it("a damaged/unsellable (discarded) return refunds without restocking or reversing COGS", async () => {
    const itemId = await variant("S");
    const sale = await sell(itemId, "2");
    const result = await returnLine({ ...sale, quantity: "1", disposition: "discarded", refund: "109000", key: "dmg" });
    expect(result.recoveredValue).toBe("0");
    expect(await stockOf(itemId)).toBe(8);
    expect(await countEntries("cogs_reversal")).toBe(0);
    const refund = await net("customer_refund");
    expect(refund.get("4400")).toBe(100_000n);
    expect(refund.get("1100")).toBe(-109_000n);
    // The written-off unit stays expensed.
    expect((await net()).get("5184")).toBe(100_000n);
    await expectBalancedLedger();
  });

  it("exchange M→L: return M to stock, sell L — per-SKU stock and GL reconcile", async () => {
    const m = await variant("M");
    const l = await variant("L");
    const sale = await sell(m, "1");
    await returnLine({ ...sale, quantity: "1", disposition: "restockable", refund: "109000", key: "exch-m" });
    await sell(l, "1");

    expect(await stockOf(m)).toBe(10);
    expect(await stockOf(l)).toBe(9);
    const all = await net();
    // Only the L unit remains sold: one unit of revenue, one unit of COGS.
    expect(all.get("5184")).toBe(50_000n);
    expect(all.get("4584")! + all.get("4400")!).toBe(-100_000n);
    expect(all.get("1100")).toBe(109_000n);
    await expectBalancedLedger();
  });

  it("is idempotent on retry and under a concurrent race — no double restock or double posting", async () => {
    const itemId = await variant("XL");
    const sale = await sell(itemId, "2");
    const input: ReturnInput = { ...sale, quantity: "1", disposition: "restockable", refund: "109000", key: "same-key" };

    const first = await returnLine(input);
    const retry = await returnLine(input);
    expect(retry.duplicate).toBe(true);
    expect(retry.id).toBe(first.id);
    expect(retry.recoveredValue).toBe(first.recoveredValue);
    expect(await stockOf(itemId)).toBe(9);

    // Race: two connections submit a fresh key at the same time.
    const raceInput: ReturnInput = { ...input, key: "race-key" };
    const [a, b] = await Promise.all([returnLine(raceInput), returnLine(raceInput)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    expect(await stockOf(itemId)).toBe(10);

    expect(await countEntries("cogs_reversal")).toBe(2);
    expect(await countEntries("customer_refund")).toBe(2);
    expect((await net()).get("5184")).toBe(0n);
    await expectBalancedLedger();
  });

  it("rejects a quantity above what the line sold", async () => {
    const itemId = await variant("XS");
    const sale = await sell(itemId, "2");
    await expect(
      returnLine({ ...sale, quantity: "3", disposition: "restockable", refund: "0", key: "too-many" }),
    ).rejects.toThrow(/return_quantity_exceeds_sold/);
    expect(await stockOf(itemId)).toBe(8);
  });
});
