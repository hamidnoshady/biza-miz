/**
 * GH #1567 F3 — a selling-price markdown is not a write-down.
 *
 * A markdown changes the shelf price and nothing else. Inventory is written
 * down only through the reviewed NRV act, only when NRV < carrying value, and
 * never by touching quantity; later sales relieve the written-down value, so
 * the loss is expensed once. A reversal follows IAS 2 (attributable to units
 * still on hand, capped at the revised NRV, never above cost).
 */
import { randomUUID } from "node:crypto";
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
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let voids: typeof import("../src/lib/retail-invoice-void-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let counts: typeof import("../src/lib/item-stock-count-service");
let warehouse: typeof import("../src/lib/retail-warehouse-document-service");
let returns: typeof import("../src/lib/customer-return-service");
let accessories: typeof import("../src/lib/accessories-service");
let cosmetics: typeof import("../src/lib/cosmetics-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let reconciliation: typeof import("../src/lib/item-stock-valuation-reconciliation");
let nrv: typeof import("../src/lib/item-nrv-write-down-service");
let productCreation: typeof import("../src/lib/product-creation-service");
let productInput: typeof import("../src/lib/product-input");
let merch: typeof import("../src/lib/merchandising-service");

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
  databaseName = `pos_item_nrv_${randomUUID().replaceAll("-", "")}`;
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
  retailInvoice = await import("../src/lib/retail-invoice-service");
  voids = await import("../src/lib/retail-invoice-void-service");
  stockService = await import("../src/lib/retail-stock-service");
  counts = await import("../src/lib/item-stock-count-service");
  warehouse = await import("../src/lib/retail-warehouse-document-service");
  returns = await import("../src/lib/customer-return-service");
  accessories = await import("../src/lib/accessories-service");
  cosmetics = await import("../src/lib/cosmetics-service");
  provisioning = await import("../src/lib/business-provisioning");
  reconciliation = await import("../src/lib/item-stock-valuation-reconciliation");
  nrv = await import("../src/lib/item-nrv-write-down-service");
  productCreation = await import("../src/lib/product-creation-service");
  productInput = await import("../src/lib/product-input");
  merch = await import("../src/lib/merchandising-service");
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

type LineKind = "stocked" | "accessory" | "cosmetic";

async function sell(b: Biz, locationId: string, itemId: string, quantity: string, kind: LineKind = "stocked", clientRequestId?: string) {
  return tx((client) =>
    retailInvoice.createRetailInvoice(client, {
      businessId: b.id,
      locationId,
      industry: b.industry,
      lines: [{ kind, itemId, quantity, unitPrice: 100_000, discount: 0, vatPercent: 9 }],
      tenders: [{ method: "cash" }],
      clientRequestId: clientRequestId ?? null,
    }),
  );
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



async function expectTiedOut(b: Biz): Promise<void> {
  expect(await sumCarrying(b)).toBe(await glNet(b, b.inventoryCode));
  for (const locationId of [b.main, b.branch]) {
    const dry = await reconciliation.readItemStockValuationReconciliation(db as unknown as PoolClient, { businessId: b.id, locationId });
    expect(dry.rows).toEqual([]);
  }
}

async function journalCount(b: Biz): Promise<number> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1", [b.id]);
  return Number(rows[0].n);
}

async function markdown(b: Biz, itemId: string, newPrice: number) {
  return tx((client) => merch.applyMarkdown(client, { businessId: b.id, locationId: b.main, itemId, newPrice, createdBy: b.ownerId }));
}

async function preview(b: Biz, itemId: string, nrvUnitValue: number | string) {
  return nrv.previewItemWriteDown(db as unknown as PoolClient, { businessId: b.id, locationId: b.main, itemId, nrvUnitValue });
}

async function writeDown(b: Biz, itemId: string, nrvUnitValue: number | string, fingerprint: string, key = `wd-${randomUUID()}`, reason = "فروش فصل گذشته زیر بها") {
  return tx((client) =>
    nrv.createItemWriteDown(client, {
      businessId: b.id, locationId: b.main, itemId, nrvUnitValue, reason, idempotencyKey: key, reviewedFingerprint: fingerprint, createdBy: b.ownerId,
    }),
  );
}

async function reverse(b: Biz, writeDownId: string, revisedNrvUnitValue: number) {
  return tx((client) =>
    nrv.reverseItemWriteDown(client, { businessId: b.id, writeDownId, revisedNrvUnitValue, reason: "بهبود قیمت بازار", reversedBy: b.ownerId }),
  );
}

async function stocked(b: Biz, name: string, qty = "5", cost = 50_000, price = 100_000): Promise<string> {
  const id = await sku(b.main, name);
  await purchase(b, b.main, id, qty, cost);
  await accessories.setUnitPrice(id, price);
  return id;
}

describe("F3 — a markdown is a price change only", () => {
  it("owner repro: cost 50,000, price 100,000 → 70,000 on 5 units posts nothing", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await stocked(b, "پالتو");
    const before = await journalCount(b);
    const result = await markdown(b, a, 70_000);
    expect(result).toMatchObject({ oldPrice: 100_000, newPrice: 70_000, writeDownRial: 0, entryId: null, belowCost: false, nrvShortfallRial: "0", carryingUnitValue: "50000" });
    expect(await journalCount(b)).toBe(before);
    expect(await glNet(b, "5170")).toBe(0n);
    expect(await stock(a)).toMatchObject({ quantity: "5", total: "250000" });
    const price = await db.query<{ unit_price: string }>("SELECT unit_price::text FROM item_stock WHERE item_id = $1", [a]);
    expect(price.rows[0].unit_price).toBe("70000");
    // A later sale at the markdown price relieves cost, not a retail figure.
    await sell(b, b.main, a, "1");
    expect(await glNet(b, "5184")).toBe(50_000n);
    await expectTiedOut(b);
    // A price increase is a price change too: still nothing posted.
    const journals = await journalCount(b);
    await accessories.setUnitPrice(a, 120_000);
    expect(await journalCount(b)).toBe(journals);
    await expect(markdown(b, a, 130_000)).rejects.toThrow(/کمتر از قیمت فعلی/);
  });

  it("clearance below cost: the markdown flags the shortfall; the reviewed write-down posts it once", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await stocked(b, "کاپشن");
    const md = await markdown(b, a, 40_000);
    expect(md).toMatchObject({ belowCost: true, nrvShortfallRial: "50000", writeDownRial: 0 });
    expect(await glNet(b, "5170")).toBe(0n);

    const p = await preview(b, a, 40_000);
    expect(p).toMatchObject({ quantity: "5", carryingValue: "250000", carryingUnitValue: "50000", nrvValue: "200000", writeDownAmount: "50000", inventoryAccountCode: "1374", expenseAccountCode: "5170" });
    const done = await writeDown(b, a, 40_000, p.fingerprint);
    expect(done).toMatchObject({ amount: "50000", quantity: "5", carryingAfter: "200000", duplicate: false });
    expect(await stock(a)).toMatchObject({ quantity: "5", unitCost: "40000", total: "200000" });
    expect(await glNet(b, "5170")).toBe(50_000n);
    expect(await glNet(b, "1374")).toBe(200_000n);
    await expectTiedOut(b);

    // No double COGS: selling 2 relieves the written-down 80,000, not 100,000.
    await sell(b, b.main, a, "2");
    expect(await glNet(b, "5184")).toBe(80_000n);
    expect(await stock(a)).toMatchObject({ quantity: "3", total: "120000" });
    // Total expense over the life of the 2 units = 2 × 50,000 cost exactly.
    expect(80_000n + (50_000n * 2n) / 5n).toBe(100_000n);
    await expectTiedOut(b);
  });
});

describe("F3 — write-down guards", () => {
  it("refuses NRV at or above cost, stale reviews, missing reasons, tracked stock and drifted rows; replays are idempotent", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await stocked(b, "بارانی");
    await expect(preview(b, a, 50_000)).rejects.toMatchObject({ message: "nrv_not_below_cost" });
    await expect(preview(b, a, 60_000)).rejects.toMatchObject({ message: "nrv_not_below_cost" });
    await expect(preview(b, a, "4.5")).rejects.toMatchObject({ message: "invalid_nrv" });

    const p = await preview(b, a, 45_000);
    expect(p.writeDownAmount).toBe("25000");
    await expect(writeDown(b, a, 45_000, p.fingerprint, `wd-${randomUUID()}`, "")).rejects.toMatchObject({ message: "reason_required" });
    await expect(writeDown(b, a, 45_000, "")).rejects.toMatchObject({ message: "fingerprint_required" });
    // Stock moved after the review → the reviewed numbers no longer apply.
    await sell(b, b.main, a, "1");
    await expect(writeDown(b, a, 45_000, p.fingerprint)).rejects.toMatchObject({ message: "review_stale" });
    expect(await glNet(b, "5170")).toBe(0n);

    const fresh = await preview(b, a, 45_000);
    expect(fresh.writeDownAmount).toBe("20000");
    const key = `wd-${randomUUID()}`;
    const first = await writeDown(b, a, 45_000, fresh.fingerprint, key);
    const replay = await writeDown(b, a, 45_000, fresh.fingerprint, key);
    expect(replay).toMatchObject({ id: first.id, duplicate: true, amount: "20000" });
    await expect(writeDown(b, a, 44_000, fresh.fingerprint, key)).rejects.toMatchObject({ message: "idempotency_conflict" });
    expect(await glNet(b, "5170")).toBe(20_000n);
    await expectTiedOut(b);

    const serial = await itemsService.createItem({ locationId: b.main, name: "ساعت", tracking: "serial" });
    await expect(preview(b, serial.id, 1)).rejects.toMatchObject({ message: "tracking_unsupported" });
    const empty = await sku(b.main, "خالی");
    await expect(preview(b, empty, 1)).rejects.toMatchObject({ message: "no_stock" });

    // A legacy drifted row must be reconciled (F1) before it can be written down.
    const drifted = await stocked(b, "قدیمی");
    await db.query("UPDATE item_stock SET total_value_rial = 400000 WHERE item_id = $1", [drifted]);
    await expect(preview(b, drifted, 10_000)).rejects.toMatchObject({ message: "valuation_drift" });
  });

  it("is tenant- and branch-scoped", async () => {
    const b = await seed("fashion_apparel", "1374");
    const other = await seed("fashion_apparel", "1374");
    const a = await stocked(b, "جلیقه");
    await expect(nrv.previewItemWriteDown(db as unknown as PoolClient, { businessId: other.id, locationId: other.main, itemId: a, nrvUnitValue: 1 })).rejects.toMatchObject({ message: "item_not_found" });
    await expect(nrv.previewItemWriteDown(db as unknown as PoolClient, { businessId: b.id, locationId: b.branch, itemId: a, nrvUnitValue: 1 })).rejects.toMatchObject({ message: "item_not_found" });
    const p = await preview(b, a, 30_000);
    const done = await writeDown(b, a, 30_000, p.fingerprint);
    await expect(
      tx((client) => nrv.reverseItemWriteDown(client, { businessId: other.id, writeDownId: done.id, revisedNrvUnitValue: 50_000, reason: "x".repeat(5), reversedBy: other.ownerId })),
    ).rejects.toMatchObject({ message: "write_down_not_found" });
  });
});

describe("F3 — reversal follows IAS 2", () => {
  it("restores only what is attributable to units on hand, capped at revised NRV, never above cost, once", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await stocked(b, "کت چرم");
    const p = await preview(b, a, 40_000);
    const done = await writeDown(b, a, 40_000, p.fingerprint);
    await sell(b, b.main, a, "2");
    expect(await stock(a)).toMatchObject({ quantity: "3", total: "120000" });

    // NRV recovers to 60,000: attributable = 50,000 × 3/5 = 30,000; headroom
    // = 3 × 60,000 − 120,000 = 60,000 → restore 30,000 → back to cost 150,000.
    const r = await reverse(b, done.id, 60_000);
    expect(r).toMatchObject({ reversedAmount: "30000", carryingAfter: "150000" });
    expect(await stock(a)).toMatchObject({ quantity: "3", unitCost: "50000", total: "150000" });
    expect(await glNet(b, "5170")).toBe(20_000n);
    await expect(reverse(b, done.id, 60_000)).rejects.toMatchObject({ message: "already_reversed" });
    await expectTiedOut(b);

    // Partial recovery: capped at the revised NRV (3 × 45,000 − 120,000 = 15,000).
    const c = await stocked(b, "کت پشمی");
    const pc = await preview(b, c, 40_000);
    const wc = await writeDown(b, c, 40_000, pc.fingerprint);
    await sell(b, b.main, c, "2");
    const rc = await reverse(b, wc.id, 45_000);
    expect(rc).toMatchObject({ reversedAmount: "15000", carryingAfter: "135000" });
    // No recovery at all → nothing to reverse.
    const d = await stocked(b, "کت کتان");
    const pd = await preview(b, d, 40_000);
    const wd = await writeDown(b, d, 40_000, pd.fingerprint);
    await expect(reverse(b, wd.id, 40_000)).rejects.toMatchObject({ message: "nothing_to_reverse" });
    await expectTiedOut(b);
  });
});

describe("F3 — other items-model trades", () => {
  it("writes accessories and cosmetics stock down into their own inventory accounts", async () => {
    for (const [industry, code] of [["accessories", "1340"], ["cosmetics", "1350"]] as const) {
      const b = await seed(industry, code);
      const a = await stocked(b, `کالا ${industry}`, "4", 30_000, 60_000);
      const md = await markdown(b, a, 20_000);
      expect(md).toMatchObject({ belowCost: true, nrvShortfallRial: "40000", writeDownRial: 0 });
      const p = await preview(b, a, 20_000);
      expect(p.inventoryAccountCode).toBe(code);
      await writeDown(b, a, 20_000, p.fingerprint);
      expect(await glNet(b, code)).toBe(80_000n);
      expect(await glNet(b, "5170")).toBe(40_000n);
      await expectTiedOut(b);
    }
  });
});
