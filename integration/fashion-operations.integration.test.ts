/**
 * #1567 Phase 3 — inventory, POS and safety checks for a fashion tenant on the
 * canonical items model. Every scenario runs on the shared engines (no fashion
 * fork) and asserts the *fashion* accounts (1374 inventory / 4584 revenue /
 * 5184 COGS) from the real `fashion_apparel` chart of accounts.
 *
 *   3.1 per-variant stock across two branches: purchase, transfer, stock
 *       count, damaged write-off (warehouse issue)
 *   3.2 POS: mixed cart, line discount, split tenders, parent-not-sellable,
 *       oversell refused
 *   3.4 bad barcode, cross-branch / cross-tenant isolation, offline replay
 *       (clientRequestId), concurrent sale of the last unit
 *   3.5 a later rename / collection-season retag never rewrites the sold
 *       invoice, its ledger, or what a return restores
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
let stockService: typeof import("../src/lib/retail-stock-service");
let counts: typeof import("../src/lib/item-stock-count-service");
let warehouse: typeof import("../src/lib/retail-warehouse-document-service");
let barcodes: typeof import("../src/lib/item-barcodes-service");
let brands: typeof import("../src/lib/item-brands-service");
let returns: typeof import("../src/lib/customer-return-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", main: "", branch: "", ownerId: "" };

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
  databaseName = `pos_fashion_ops_${randomUUID().replaceAll("-", "")}`;
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
  stockService = await import("../src/lib/retail-stock-service");
  counts = await import("../src/lib/item-stock-count-service");
  warehouse = await import("../src/lib/retail-warehouse-document-service");
  barcodes = await import("../src/lib/item-barcodes-service");
  brands = await import("../src/lib/item-brands-service");
  returns = await import("../src/lib/customer-return-service");
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

/** A fashion business with two branches and the real fashion chart of accounts. */
async function seedFashionBusiness(): Promise<{ id: string; main: string; branch: string; ownerId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'fashion_apparel') RETURNING id",
    [`boutique-${randomUUID().slice(0, 8)}`],
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
    await provisioning.seedChartOfAccounts(client, id, "fashion_apparel");
  } finally {
    client.release();
  }
  return { id, main: locRows.rows[0].id, branch: locRows.rows[1].id, ownerId: user.rows[0].id };
}

beforeEach(async () => {
  Object.assign(biz, await seedFashionBusiness());
});

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

/** One style (variant parent) with one child per size at a branch. */
async function style(locationId: string, sizes: string[], name = "تی‌شرت TS-100"): Promise<Record<string, string>> {
  const parent = await itemsService.createItem({ locationId, name, kind: "variant_parent" });
  const out: Record<string, string> = { parent: parent.id };
  for (const size of sizes) {
    const child = await itemsService.createVariantChild(parent.id, locationId, `${name} ${size}`, null, [
      { name: "سایز", value: size },
    ]);
    out[size] = child.id;
  }
  return out;
}

async function stockOf(itemId: string): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id=$1", [itemId]);
  return rows[0] ? Number(rows[0].quantity) : 0;
}

/** Debit/credit of one journal entry, by account code. */
async function entryLines(entryId: string): Promise<Array<{ code: string; debit: string; credit: string }>> {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1 ORDER BY jl.debit DESC, a.code`,
    [entryId],
  );
  return rows;
}

/** Net debit−credit by account code for the business, optionally one event type's entries. */
async function net(businessId = biz.id): Promise<Map<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code`,
    [businessId],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.net)]));
}

async function expectBalanced(businessId = biz.id): Promise<void> {
  const totals = [...(await net(businessId)).values()].reduce((a, b) => a + b, 0n);
  expect(totals).toBe(0n);
}

async function eventEntry(eventType: string): Promise<string> {
  const { rows } = await db.query<{ entry_id: string }>(
    "SELECT entry_id FROM domain_events WHERE business_id=$1 AND event_type=$2 ORDER BY created_at DESC LIMIT 1",
    [biz.id, eventType],
  );
  expect(rows[0]?.entry_id, eventType).toBeTruthy();
  return rows[0].entry_id;
}

async function purchase(locationId: string, lines: Array<{ itemId: string; quantity: string; unitCost: number }>) {
  return tx((client) => stockService.receiveItemPurchase(client, { businessId: biz.id, locationId, lines }));
}

type CartLine = { itemId: string; quantity: string; unitPrice: number; discount?: number };

async function sell(
  locationId: string,
  lines: CartLine[],
  options: { tenders?: Array<{ method: "cash" | "bank" | "credit"; amount?: string }>; clientRequestId?: string } = {},
) {
  return tx((client) =>
    retailInvoice.createRetailInvoice(client, {
      businessId: biz.id,
      locationId,
      industry: "fashion_apparel",
      lines: lines.map((l) => ({
        kind: "stocked" as const,
        itemId: l.itemId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount ?? 0,
        vatPercent: 9,
      })),
      tenders: (options.tenders ?? [{ method: "cash" }]).map((t) =>
        t.amount ? { method: t.method, amount: rialText(t.amount) } : { method: t.method },
      ),
      clientRequestId: options.clientRequestId ?? null,
    }),
  );
}

describe("3.1 per-variant stock across branches", () => {
  it("purchase, transfer, count and damaged write-off all post to fashion inventory 1374", async () => {
    const main = await style(biz.main, ["M", "L"]);
    const branch = await style(biz.branch, ["M", "L"]);

    await purchase(biz.main, [
      { itemId: main.M, quantity: "10", unitCost: 50_000 },
      { itemId: main.L, quantity: "6", unitCost: 50_000 },
    ]);
    // Per SKU, never the parent.
    expect(await stockOf(main.M)).toBe(10);
    expect(await stockOf(main.L)).toBe(6);
    expect(await stockOf(main.parent)).toBe(0);
    expect(await entryLines(await eventEntry("retail.purchase_received"))).toEqual([
      { code: "1374", debit: "800000", credit: "0" },
      { code: "2100", debit: "0", credit: "800000" },
    ]);

    // Damaged stock written off through a warehouse issue (حواله). Done right
    // after the receipt on purpose: the issue values non-batch stock from
    // `item_stock.total_value_rial`, which the sale/transfer/return writers do
    // not maintain (pre-existing on main, all retail trades — reported on PR
    // #1575, not fixed here per AGENTS.md rule 6), so after a transfer it would
    // over-relieve.
    const parsed = warehouse.parseRetailWarehouseDocumentLines("issue", [{ itemId: main.M, quantity: "1" }]);
    const issue = await tx((client) =>
      warehouse.createRetailWarehouseDocumentInTransaction(client, {
        businessId: biz.id,
        locationId: biz.main,
        kind: parsed.kind,
        recipient: "ضایعات — آسیب‌دیده",
        lines: parsed.lines,
        createdBy: null,
      }),
    );
    expect(issue.creditCode).toBe("1374");
    expect(issue.totalValue).toBe("50000");
    expect(await stockOf(main.M)).toBe(9);

    // Branch transfer of size M: in-transit, then the destination's own SKU row.
    const transfer = await tx((client) =>
      stockService.createItemTransfer(client, {
        businessId: biz.id,
        sourceLocationId: biz.main,
        destinationLocationId: biz.branch,
        idempotencyKey: randomUUID(),
        lines: [{ sourceItemId: main.M, destinationItemId: branch.M, quantity: "4" }],
      }),
    );
    await tx((client) => stockService.shipItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }));
    expect(await entryLines(await eventEntry("retail.transfer_ship"))).toEqual([
      { code: "1360", debit: "200000", credit: "0" },
      { code: "1374", debit: "0", credit: "200000" },
    ]);
    await tx((client) => stockService.receiveItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }));
    expect(await stockOf(main.M)).toBe(5);
    expect(await stockOf(branch.M)).toBe(4);
    expect(await stockOf(branch.L)).toBe(0);
    expect((await net()).get("1360") ?? 0n).toBe(0n);

    // Stocktake at main: L counted 5 of 6 → one unit short, relieved from 1374.
    const count = await tx((client) =>
      counts.createItemStockCount(client, {
        businessId: biz.id,
        locationId: biz.main,
        lines: [{ itemId: main.L, countedQty: "5" }],
        createdBy: null,
      }),
    );
    expect(count.shortage).toBe("50000");
    expect(await stockOf(main.L)).toBe(5);
    const countLines = await entryLines(count.entryId!);
    expect(countLines.find((l) => l.code === "1374")).toEqual({ code: "1374", debit: "0", credit: "50000" });

    // Inventory GL equals the valued stock still on hand across both branches.
    const onHandUnits = (await stockOf(main.M)) + (await stockOf(main.L)) + (await stockOf(branch.M));
    expect((await net()).get("1374")).toBe(BigInt(onHandUnits * 50_000));
    await expectBalanced();
  });
});

describe("3.2 POS", () => {
  it("mixed cart with a line discount and split tenders posts per-SKU stock and balanced GL", async () => {
    const tee = await style(biz.main, ["M", "L"]);
    const jeans = await style(biz.main, ["32"], "جین JN-200");
    await purchase(biz.main, [
      { itemId: tee.M, quantity: "5", unitCost: 50_000 },
      { itemId: tee.L, quantity: "5", unitCost: 50_000 },
      { itemId: jeans["32"], quantity: "3", unitCost: 200_000 },
    ]);

    // gross 100k + 2×100k + 400k = 700k; discount 50k on jeans → net 650k; VAT 9% = 58,500.
    const invoice = await sell(
      biz.main,
      [
        { itemId: tee.M, quantity: "1", unitPrice: 100_000 },
        { itemId: tee.L, quantity: "2", unitPrice: 100_000 },
        { itemId: jeans["32"], quantity: "1", unitPrice: 400_000, discount: 50_000 },
      ],
      { tenders: [{ method: "cash", amount: "300000" }, { method: "bank" }] },
    );
    expect(invoice.total).toBe("708500");
    expect(await stockOf(tee.M)).toBe(4);
    expect(await stockOf(tee.L)).toBe(3);
    expect(await stockOf(jeans["32"])).toBe(2);

    const gl = await net();
    expect(gl.get("1100")).toBe(300_000n);
    expect(gl.get("1120")).toBe(408_500n);
    expect(gl.get("4584")).toBe(-650_000n);
    expect(gl.get("2200")).toBe(-58_500n);
    // COGS: 3 tees × 50k + 1 jeans × 200k.
    expect(gl.get("5184")).toBe(350_000n);
    await expectBalanced();
  });

  it("refuses the style parent and an oversell, leaving stock untouched", async () => {
    const tee = await style(biz.main, ["M"]);
    await purchase(biz.main, [{ itemId: tee.M, quantity: "2", unitCost: 50_000 }]);
    await expect(sell(biz.main, [{ itemId: tee.parent, quantity: "1", unitPrice: 100_000 }])).rejects.toThrow();
    await expect(sell(biz.main, [{ itemId: tee.M, quantity: "3", unitPrice: 100_000 }])).rejects.toThrow(/موجودی کافی نیست/);
    expect(await stockOf(tee.M)).toBe(2);
    expect(await net()).toEqual(new Map([["1374", 100_000n], ["2100", -100_000n]]));
  });
});

describe("3.4 safety", () => {
  it("bad barcodes are refused and a scan resolves only the exact SKU at its own branch", async () => {
    const tee = await style(biz.main, ["M", "L"]);
    const branchTee = await style(biz.branch, ["M"]);

    // EAN-13 with a wrong check digit (valid: 4006381333931).
    await expect(barcodes.assignBarcode(tee.M, { code: "4006381333932" })).rejects.toThrow(/رقم کنترل/);
    await barcodes.assignBarcode(tee.M, { code: "4006381333931" });
    // Size L can never share size M's code at the same branch.
    await expect(barcodes.assignBarcode(tee.L, { code: "4006381333931" })).rejects.toBeInstanceOf(
      barcodes.BarcodeConflictError,
    );

    const hit = await barcodes.lookupBarcode(biz.main, " 4006381333931 ");
    expect(hit.map((m) => m.itemId)).toEqual([tee.M]);
    expect(await barcodes.lookupBarcode(biz.main, "9999999999994")).toEqual([]);
    // Another branch does not resolve main's label.
    expect(await barcodes.lookupBarcode(biz.branch, "4006381333931")).toEqual([]);
    expect(branchTee.M).not.toBe(tee.M);
  });

  it("isolates branches and tenants on sale and on return", async () => {
    const tee = await style(biz.main, ["M"]);
    const branchTee = await style(biz.branch, ["M"]);
    await purchase(biz.main, [{ itemId: tee.M, quantity: "3", unitCost: 50_000 }]);
    await purchase(biz.branch, [{ itemId: branchTee.M, quantity: "3", unitCost: 50_000 }]);

    // Selling the branch's SKU at main is refused.
    await expect(sell(biz.main, [{ itemId: branchTee.M, quantity: "1", unitPrice: 100_000 }])).rejects.toThrow(
      /کالا یافت نشد/,
    );

    const sale = await sell(biz.main, [{ itemId: tee.M, quantity: "1", unitPrice: 100_000 }]);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM order_items WHERE order_id=$1", [sale.orderId]);

    // Another tenant cannot return this invoice, even naming its ids directly.
    const other = await seedFashionBusiness();
    await expect(
      tx((client) =>
        returns.createCustomerReturn(client, {
          businessId: other.id,
          locationId: other.main,
          orderId: sale.orderId,
          refundMethod: "cash",
          refundAmount: rialText("109000"),
          reason: "cross-tenant",
          idempotencyKey: "x-tenant",
          createdBy: other.ownerId,
          lines: [{ orderItemId: rows[0].id, quantity: quantityText("1"), disposition: "restockable" }],
        }),
      ),
    ).rejects.toThrow(/completed_order_not_found/);
    // Nor can the same tenant's other branch.
    await expect(
      tx((client) =>
        returns.createCustomerReturn(client, {
          businessId: biz.id,
          locationId: biz.branch,
          orderId: sale.orderId,
          refundMethod: "cash",
          refundAmount: rialText("109000"),
          reason: "cross-branch",
          idempotencyKey: "x-branch",
          createdBy: biz.ownerId,
          lines: [{ orderItemId: rows[0].id, quantity: quantityText("1"), disposition: "restockable" }],
        }),
      ),
    ).rejects.toThrow(/completed_order_not_found/);
    expect(await stockOf(tee.M)).toBe(2);
    expect(await stockOf(branchTee.M)).toBe(3);
    expect((await net(other.id)).size).toBe(0);
  });

  it("an offline replay with the same clientRequestId is one sale; a different payload under it is refused", async () => {
    const tee = await style(biz.main, ["M"]);
    await purchase(biz.main, [{ itemId: tee.M, quantity: "5", unitCost: 50_000 }]);
    const key = `offline-${randomUUID()}`;
    const line = { itemId: tee.M, quantity: "2", unitPrice: 100_000 };

    const first = await sell(biz.main, [line], { clientRequestId: key });
    const replay = await sell(biz.main, [line], { clientRequestId: key });
    expect(replay.orderId).toBe(first.orderId);
    expect(await stockOf(tee.M)).toBe(3);
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM orders WHERE location_id=$1 AND type='retail'",
      [biz.main],
    );
    expect(rows[0].n).toBe("1");

    await expect(sell(biz.main, [{ ...line, quantity: "1" }], { clientRequestId: key })).rejects.toBeInstanceOf(
      retailInvoice.RetailRequestConflictError,
    );
    expect(await stockOf(tee.M)).toBe(3);
    expect((await net()).get("5184")).toBe(100_000n);
  });

  it("two tills racing for the last unit sell it once and never go negative", async () => {
    const tee = await style(biz.main, ["M"]);
    await purchase(biz.main, [{ itemId: tee.M, quantity: "1", unitCost: 50_000 }]);
    const results = await Promise.allSettled([
      sell(biz.main, [{ itemId: tee.M, quantity: "1", unitPrice: 100_000 }]),
      sell(biz.main, [{ itemId: tee.M, quantity: "1", unitPrice: 100_000 }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await stockOf(tee.M)).toBe(0);
    expect((await net()).get("5184")).toBe(50_000n);
    await expectBalanced();
  });
});

describe("3.5 a category/style change never reassigns sold history", () => {
  it("renaming and re-tagging a sold SKU leaves the invoice, its ledger and the return untouched", async () => {
    const tee = await style(biz.main, ["M"]);
    await purchase(biz.main, [{ itemId: tee.M, quantity: "4", unitCost: 50_000 }]);
    await brands.updateItemProfile(tee.M, { collection: "تابستان ۱۴۰۵", season: "summer" });
    const sale = await sell(biz.main, [{ itemId: tee.M, quantity: "2", unitPrice: 100_000 }]);

    const before = await db.query<{ id: string; name_snapshot: string; retail_snapshot: unknown; unit_price: string }>(
      "SELECT id, name_snapshot, retail_snapshot, unit_price::text FROM order_items WHERE order_id=$1",
      [sale.orderId],
    );
    const glBefore = await net();

    // The style is renamed, re-categorised to another collection/season and repriced.
    await itemsService.updateItemMeta(tee.M, { name: "تی‌شرت بازطراحی‌شده" });
    await brands.updateItemProfile(tee.M, { collection: "حراج زمستان", season: "winter" });
    await tradeGoods.setTradeGoodsUnitPrice(tee.M, 80_000);

    const after = await db.query<{ id: string; name_snapshot: string; retail_snapshot: unknown; unit_price: string }>(
      "SELECT id, name_snapshot, retail_snapshot, unit_price::text FROM order_items WHERE order_id=$1",
      [sale.orderId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await net()).toEqual(glBefore);

    // A later return still credits the originally sold value and restocks the same SKU.
    const result = await tx((client) =>
      returns.createCustomerReturn(client, {
        businessId: biz.id,
        locationId: biz.main,
        orderId: sale.orderId,
        refundMethod: "cash",
        refundAmount: rialText("109000"),
        reason: "after retag",
        idempotencyKey: "after-retag",
        createdBy: biz.ownerId,
        lines: [{ orderItemId: before.rows[0].id, quantity: quantityText("1"), disposition: "restockable" }],
      }),
    );
    expect(result.recoveredValue).toBe("50000");
    expect(await stockOf(tee.M)).toBe(3);
    await expectBalanced();
  });
});
