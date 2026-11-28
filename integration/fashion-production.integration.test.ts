/**
 * GH #1567 Phase 6B — fashion production orders against a real database.
 *
 * The invariants under test, for every path (full, partial, scrap, rework,
 * shortage, cancellation, retry, concurrency, isolation):
 *   * stock moves only through F1's WAC primitives, so the trade inventory
 *     account (1374) always equals the sum of `item_stock.total_value_rial`;
 *   * the order's WIP subledger equals GL 1310, and closes at exactly 0;
 *   * a retried request moves nothing twice; a stale screen gets a conflict;
 *   * nothing crosses a branch or a tenant.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let production: typeof import("../src/lib/fashion-production-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_fashion_production_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
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
  provisioning = await import("../src/lib/business-provisioning");
  production = await import("../src/lib/fashion-production-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

interface Shop {
  id: string;
  main: string;
  branch: string;
  ownerId: string;
  fabric: string;
  zip: string;
  dress: string;
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

async function seed(): Promise<Shop> {
  const { rows: [biz] } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Atelier', $1, 'fashion_apparel') RETURNING id",
    [`atelier-${randomUUID().slice(0, 8)}`],
  );
  const { rows: locs } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id", [biz.id]);
  const { rows: [user] } = await db.query<{ id: string }>(
    "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id", [biz.id]);
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.id, "fashion_apparel");
  } finally {
    client.release();
  }
  const main = locs[0].id;
  const fabric = (await itemsService.createItem({ locationId: main, name: "پارچه کرپ" })).id;
  const zip = (await itemsService.createItem({ locationId: main, name: "زیپ" })).id;
  const parent = await itemsService.createItem({ locationId: main, name: "پیراهن مجلسی", kind: "variant_parent" });
  const dress = (await itemsService.createVariantChild(parent.id, main, "پیراهن مجلسی M", null, [{ name: "سایز", value: "M" }])).id;
  await tx((c) => stockService.receiveItemPurchase(c, {
    businessId: biz.id, locationId: main,
    lines: [{ itemId: fabric, quantity: "100", unitCost: 50_000 }, { itemId: zip, quantity: "50", unitCost: 10_000 }],
  }));
  return { id: biz.id, main, branch: locs[1].id, ownerId: user.id, fabric, zip, dress };
}

function actor(shop: Shop, canWriteOff = true) {
  return { businessId: shop.id, userId: shop.ownerId, canWriteOff };
}

async function glNet(businessId: string, code: string): Promise<bigint> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE a.business_id = $1 AND a.code = $2`,
    [businessId, code],
  );
  return BigInt(rows[0].net);
}

async function carrying(businessId: string): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT coalesce(sum(s.total_value_rial),0)::text AS total
       FROM item_stock s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1`,
    [businessId],
  );
  return BigInt(rows[0].total);
}

async function stockOf(itemId: string) {
  const { rows } = await db.query<{ quantity: string; total: string | null }>(
    "SELECT trim_scale(quantity)::text AS quantity, total_value_rial::text AS total FROM item_stock WHERE item_id = $1", [itemId]);
  return { quantity: rows[0]?.quantity ?? "0", total: rows[0]?.total ?? null };
}

/** Stock subledger = GL 1374; WIP subledger = GL 1310. */
async function expectReconciled(shop: Shop) {
  expect(await carrying(shop.id)).toBe(await glNet(shop.id, "1374"));
  const report = await production.productionReport(actor(shop), shop.main);
  expect(report.reconciliation.reconciled).toBe(true);
  expect(BigInt(report.reconciliation.glWipRial)).toBe(await glNet(shop.id, "1310"));
}

async function newOrder(shop: Shop, planned: string, extra: Record<string, unknown> = {}) {
  const bom = await production.saveBom(actor(shop), shop.main, {
    name: `پیراهن ${randomUUID().slice(0, 6)}`, outputItemId: shop.dress, conversionCostPerUnitRial: 0,
    lines: [{ materialItemId: shop.fabric, quantityPerUnit: "2" }, { materialItemId: shop.zip, quantityPerUnit: "1" }],
  });
  return production.createProductionOrder(actor(shop), shop.main, {
    bomId: bom.id, plannedQuantity: planned, idempotencyKey: `create-${randomUUID()}`, ...extra,
  });
}

type Detail = Awaited<ReturnType<typeof newOrder>>;

async function act(shop: Shop, detail: Pick<Detail, "order">, body: Record<string, unknown>, opts: { key?: string; canWriteOff?: boolean } = {}) {
  return production.applyProductionOrderAction(actor(shop, opts.canWriteOff ?? true), shop.main, detail.order.id, {
    ...body, expectedVersion: detail.order.version, idempotencyKey: opts.key ?? `k-${randomUUID()}`,
  } as Parameters<typeof production.applyProductionOrderAction>[3]);
}

async function errorOf(promise: Promise<unknown>): Promise<{ code: string; status: number; detail?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code: string; status: number; detail?: Record<string, unknown> };
    return { code: e.code, status: e.status, detail: e.detail };
  }
  throw new Error("expected a refusal");
}

describe("fashion production — full flow, scrap and costing", () => {
  it("cuts, sews, finishes, QCs (1 scrapped), packs and receipts 9 dresses with WIP closing at exactly zero", async () => {
    const shop = await seed();
    let o = await newOrder(shop, "10");
    expect(o.order.status).toBe("draft");
    expect(o.stages.map((s) => s.code)).toEqual(["cut", "sew", "finish", "qc", "pack"]);
    expect(o.materials.find((m) => m.materialItemId === shop.fabric)?.requiredQuantity).toBe("20");

    o = await act(shop, o, { action: "release" });
    expect(o.order.status).toBe("released");
    o = await act(shop, o, { action: "issue" });
    expect(o.order.status).toBe("in_progress");
    // 20 m × 50,000 + 10 zips × 10,000 at the exact WAC relieved.
    expect(o.order.costs.materialRial).toBe(1_100_000);
    expect(await glNet(shop.id, "1310")).toBe(1_100_000n);
    expect((await stockOf(shop.fabric)).quantity).toBe("80");
    await expectReconciled(shop);

    for (const stage of ["cut", "sew", "finish"]) o = await act(shop, o, { action: "progress", stage, completed: "10" });
    o = await act(shop, o, { action: "progress", stage: "qc", completed: "9", scrapped: "1" });
    o = await act(shop, o, { action: "progress", stage: "pack", completed: "9" });
    expect(o.order.scrappedQuantity).toBe("1");
    expect(o.order.receivableQuantity).toBe("9");

    o = await act(shop, o, { action: "cost", kind: "labour", amountRial: 450_000, stage: "sew" });
    expect(o.order.costs.wipRial).toBe(1_550_000);
    expect(await glNet(shop.id, "5180")).toBe(-450_000n);

    // Partial receipt: 4 of 9 outstanding good units take 4/9 of WIP.
    o = await act(shop, o, { action: "receive", quantity: "4" });
    expect(o.order.status).toBe("in_progress");
    expect(o.order.costs.receivedRial).toBe(688_889);
    await expectReconciled(shop);
    // The last receipt takes the remainder — the scrapped dress is in the good units' cost.
    o = await act(shop, o, { action: "receive", quantity: "5" });
    expect(o.order.status).toBe("completed");
    expect(o.order.costs.receivedRial).toBe(1_550_000);
    expect(o.order.costs.wipRial).toBe(0);
    expect(o.order.costs.unitCostRial).toBe("172222.22");
    expect(await glNet(shop.id, "1310")).toBe(0n);
    expect(await stockOf(shop.dress)).toEqual({ quantity: "9", total: "1550000" });
    await expectReconciled(shop);

    const report = await production.productionReport(actor(shop), shop.main);
    expect(report).toMatchObject({ completedOrders: 1, receivedQuantity: "9", scrappedQuantity: "1", scrapRate: "0.1" });
    expect(o.actions.map((a) => a.action)).toEqual(
      ["create", "release", "issue", "progress", "progress", "progress", "progress", "progress", "cost", "receive", "receive"]);
    // A completed order accepts nothing more.
    expect((await errorOf(act(shop, o, { action: "receive", quantity: "1" }))).code).toBe("action_not_allowed");
  });

  it("refuses to receipt more than the last stage finished, or more than the material issued supports", async () => {
    const shop = await seed();
    let o = await newOrder(shop, "4");
    o = await act(shop, o, { action: "release" });
    o = await act(shop, o, { action: "issue", lines: [{ materialItemId: shop.fabric, quantity: "8" }, { materialItemId: shop.zip, quantity: "2" }] });
    for (const stage of ["cut", "sew", "finish", "qc", "pack"]) o = await act(shop, o, { action: "progress", stage, completed: "3" });
    expect((await errorOf(act(shop, o, { action: "receive", quantity: "4" }))).code).toBe("receipt_exceeds_finished");
    const uncovered = await errorOf(act(shop, o, { action: "receive", quantity: "3" }));
    expect(uncovered.code).toBe("materials_not_issued");
    expect(uncovered.detail).toMatchObject({ materialItemId: shop.zip });
    // A stage cannot complete more than it received.
    expect((await errorOf(act(shop, o, { action: "progress", stage: "pack", completed: "1" }))).code).toBe("stage_quantity_exceeded");
  });
});

describe("fashion production — reservations and shortage", () => {
  it("refuses a release the free fabric cannot cover, counting other open orders' reservations", async () => {
    const shop = await seed();
    const big = await newOrder(shop, "60"); // needs 120 m, 100 m on hand
    const shortage = await errorOf(act(shop, big, { action: "release" }));
    expect(shortage.code).toBe("material_shortage");
    expect(shortage.detail?.shortages).toEqual(expect.arrayContaining([
      expect.objectContaining({ materialItemId: shop.fabric, need: "120", available: "100", missing: "20" }),
      expect.objectContaining({ materialItemId: shop.zip, need: "60", available: "50", missing: "10" }),
    ]));

    let a = await newOrder(shop, "30"); // reserves 60 m
    a = await act(shop, a, { action: "release" });
    const b = await newOrder(shop, "25"); // needs 50 m, only 40 free
    const blocked = await errorOf(act(shop, b, { action: "release" }));
    expect(blocked.detail?.shortages).toEqual(expect.arrayContaining([
      expect.objectContaining({ materialItemId: shop.fabric, need: "50", available: "40", missing: "10" }),
      expect.objectContaining({ materialItemId: shop.zip, need: "25", available: "20", missing: "5" }),
    ]));
    // Nothing moved while refusing.
    expect((await stockOf(shop.fabric)).quantity).toBe("100");
    expect(a.order.status).toBe("released");
  });
});

describe("fashion production — rework, cancellation and write-off", () => {
  it("sends QC failures back to sewing, and they must be sewn again before they can pass", async () => {
    const shop = await seed();
    let o = await newOrder(shop, "5");
    o = await act(shop, o, { action: "release" });
    o = await act(shop, o, { action: "issue" });
    for (const stage of ["cut", "sew", "finish"]) o = await act(shop, o, { action: "progress", stage, completed: "5" });
    o = await act(shop, o, { action: "progress", stage: "qc", completed: "3" });
    o = await act(shop, o, { action: "rework", fromStage: "qc", toStage: "sew", quantity: "2" });
    const byCode = Object.fromEntries(o.stages.map((s) => [s.code, s]));
    expect(byCode.sew.completedQuantity).toBe("3");
    expect(byCode.finish.completedQuantity).toBe("3");
    expect(byCode.sew.reworkQuantity).toBe("2");
    // Nothing waits at QC until the two are re-sewn and re-finished.
    expect((await errorOf(act(shop, o, { action: "progress", stage: "qc", completed: "1" }))).code).toBe("stage_quantity_exceeded");
    o = await act(shop, o, { action: "progress", stage: "sew", completed: "2" });
    o = await act(shop, o, { action: "progress", stage: "finish", completed: "2" });
    o = await act(shop, o, { action: "progress", stage: "qc", completed: "2" });
    expect(o.stages.find((s) => s.code === "qc")?.completedQuantity).toBe("5");
    expect((await errorOf(act(shop, o, { action: "rework", fromStage: "sew", toStage: "qc", quantity: "1" }))).code).toBe("rework_must_go_back");
  });

  it("cancels: unused fabric goes back at its issue value, the residual WIP needs ledger approval and is written off", async () => {
    const shop = await seed();
    let o = await newOrder(shop, "10");
    o = await act(shop, o, { action: "release" });
    o = await act(shop, o, { action: "issue" });
    o = await act(shop, o, { action: "cost", kind: "subcontract", amountRial: 200_000, supplierName: "کارگاه دوخت" });
    o = await act(shop, o, { action: "progress", stage: "cut", completed: "4" });
    const returns = [{ materialItemId: shop.fabric, quantity: "12" }, { materialItemId: shop.zip, quantity: "10" }];

    const refused = await errorOf(act(shop, o, { action: "cancel", reason: "سفارش مشتری لغو شد", returns }, { canWriteOff: false }));
    expect(refused).toMatchObject({ code: "ledger_approval_required", status: 403 });
    expect((await stockOf(shop.fabric)).quantity).toBe("80"); // the refused cancel rolled back entirely

    o = await act(shop, o, { action: "cancel", reason: "سفارش مشتری لغو شد", returns });
    expect(o.order.status).toBe("cancelled");
    // 12 m back at 50,000 and 10 zips at 10,000; 8 m cut (400,000) + subcontract 200,000 written off.
    expect(o.order.costs.returnedRial).toBe(700_000);
    expect(o.order.costs.writtenOffRial).toBe(600_000);
    expect(o.order.costs.wipRial).toBe(0);
    expect((await stockOf(shop.fabric)).quantity).toBe("92");
    expect(await glNet(shop.id, "5170")).toBe(600_000n);
    expect(await glNet(shop.id, "1310")).toBe(0n);
    await expectReconciled(shop);
    expect((await errorOf(act(shop, o, { action: "release" }))).code).toBe("action_not_allowed");
  });
});

describe("fashion production — retry, concurrency and isolation", () => {
  it("a retried request returns the first result and moves nothing twice; a stale version is refused", async () => {
    const shop = await seed();
    let o = await newOrder(shop, "5");
    o = await act(shop, o, { action: "release" });
    const issued = await act(shop, o, { action: "issue" }, { key: "issue-once-123" });
    const retry = await act(shop, o, { action: "issue" }, { key: "issue-once-123" });
    expect(retry.duplicate).toBe(true);
    expect(retry.order.costs.materialRial).toBe(issued.order.costs.materialRial);
    expect((await stockOf(shop.fabric)).quantity).toBe("90");
    expect(await glNet(shop.id, "1310")).toBe(550_000n);
    // The same key cannot be replayed as a different action.
    expect((await errorOf(act(shop, issued, { action: "progress", stage: "cut", completed: "1" }, { key: "issue-once-123" }))).code)
      .toBe("idempotency_key_reused");
    // The pre-issue version is stale now.
    expect((await errorOf(act(shop, o, { action: "progress", stage: "cut", completed: "1" }))).code).toBe("version_conflict");
    // Creating twice with one key creates one order.
    const key = `create-${randomUUID()}`;
    const first = await production.createProductionOrder(actor(shop), shop.main, { outputItemId: shop.dress,
      lines: [{ materialItemId: shop.fabric, quantityPerUnit: "2" }], plannedQuantity: "1", idempotencyKey: key });
    const second = await production.createProductionOrder(actor(shop), shop.main, { outputItemId: shop.dress,
      lines: [{ materialItemId: shop.fabric, quantityPerUnit: "2" }], plannedQuantity: "1", idempotencyKey: key });
    expect(second.order.id).toBe(first.order.id);
    expect(second.duplicate).toBe(true);
  });

  it("two simultaneous receipts on one version: exactly one lands", async () => {
    const shop = await seed();
    let o = await newOrder(shop, "2");
    o = await act(shop, o, { action: "release" });
    o = await act(shop, o, { action: "issue" });
    for (const stage of ["cut", "sew", "finish", "qc", "pack"]) o = await act(shop, o, { action: "progress", stage, completed: "2" });
    const results = await Promise.allSettled([
      act(shop, o, { action: "receive", quantity: "2" }),
      act(shop, o, { action: "receive", quantity: "2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe("version_conflict");
    expect((await stockOf(shop.dress)).quantity).toBe("2");
    await expectReconciled(shop);
  });

  it("an order is invisible from another branch and another tenant; another branch's items are refused", async () => {
    const shop = await seed();
    const other = await seed();
    const o = await newOrder(shop, "1");
    expect((await errorOf(production.getProductionOrder(actor(shop), shop.branch, o.order.id))).code).toBe("order_not_found");
    expect((await errorOf(production.getProductionOrder(actor(other), other.main, o.order.id))).code).toBe("order_not_found");
    expect(await production.listProductionOrders(actor(shop), shop.branch)).toEqual([]);
    const crossBranch = await errorOf(production.createProductionOrder(actor(shop), shop.branch, {
      outputItemId: shop.dress, lines: [{ materialItemId: shop.fabric, quantityPerUnit: "1" }], plannedQuantity: "1",
      idempotencyKey: `create-${randomUUID()}`,
    }));
    expect(crossBranch).toMatchObject({ code: "item_not_found", status: 404 });
    const crossTenant = await errorOf(production.createProductionOrder(actor(other), other.main, {
      outputItemId: shop.dress, lines: [{ materialItemId: other.fabric, quantityPerUnit: "1" }], plannedQuantity: "1",
      idempotencyKey: `create-${randomUUID()}`,
    }));
    expect(crossTenant.code).toBe("item_not_found");
    // A variant parent cannot be produced into.
    const { rows: [parent] } = await db.query<{ parent_item_id: string }>("SELECT parent_item_id FROM items WHERE id = $1", [shop.dress]);
    expect((await errorOf(production.createProductionOrder(actor(shop), shop.main, {
      outputItemId: parent.parent_item_id, lines: [{ materialItemId: shop.fabric, quantityPerUnit: "1" }], plannedQuantity: "1",
      idempotencyKey: `create-${randomUUID()}`,
    }))).code).toBe("item_is_variant_parent");
  });

  it("forces tenant RLS on every production table and keeps the action log append-only", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('item_production_boms', 'item_production_bom_lines', 'item_production_orders',
                          'item_production_order_materials', 'item_production_order_stages', 'item_production_order_actions')`,
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const shop = await seed();
    await newOrder(shop, "1");
    await expect(db.query("UPDATE item_production_order_actions SET action = 'cancel'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM item_production_order_actions")).rejects.toThrow(/append-only/);
  });
});
