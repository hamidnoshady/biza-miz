/**
 * GH #1567 Phase 6.3 — subcontracted production stages against a real database.
 * (Fixture helpers follow fashion-production.integration.test.ts.)
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
let ap: typeof import("../src/lib/ap-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_fashion_subcontract_${randomUUID().replaceAll("-", "")}`;
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
  ap = await import("../src/lib/ap-service");
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

async function supplier(shop: Shop, name: string, opts: { location?: string; active?: boolean } = {}): Promise<string> {
  // The canonical identity is the party; the supplier row is its branch alias.
  const { rows: [party] } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name, role, person_type) VALUES ($1, $2, 'supplier', 'legal') RETURNING id", [shop.id, name]);
  const { rows: [alias] } = await db.query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name, party_id, is_active) VALUES ($1, $2, $3, $4) RETURNING id",
    [opts.location ?? shop.main, name, party.id, opts.active ?? true]);
  return alias.id;
}

async function supplierBalance(shop: Shop, supplierId: string): Promise<number> {
  const balances = await ap.listSupplierBalances(shop.id);
  return balances.find((b) => b.supplierId === supplierId)?.balance ?? 0;
}

function sub(detail: Detail, id: string) {
  const found = detail.subcontracts.find((s) => s.id === id);
  if (!found) throw new Error("subcontract missing from detail");
  return found;
}

/** Releases the order, issues the zips in-house and cuts every unit. */
async function cutOrder(shop: Shop, planned: string): Promise<Detail> {
  let o = await newOrder(shop, planned);
  o = await act(shop, o, { action: "release" });
  o = await act(shop, o, { action: "issue", lines: [{ materialItemId: shop.zip, quantity: planned }] });
  o = await act(shop, o, { action: "progress", stage: "cut", completed: planned });
  return o;
}

async function newSubcontract(shop: Shop, o: Detail, supplierId: string, rate = 150_000): Promise<{ o: Detail; id: string }> {
  const created = await act(shop, o, { action: "subcontract_create", supplierId, stage: "sew", ratePerUnitRial: rate });
  const id = created.subcontracts[created.subcontracts.length - 1].id;
  return { o: created, id };
}

describe("fashion production 6.3 — a subcontracted sewing stage end to end", () => {
  it("assigns, approves, sends work and fabric, inspects (accept/rework/scrap/shortage), disputes, charges back, closes, pays and completes — stock, WIP and A/P reconciled", async () => {
    const shop = await seed();
    // The seed's stock purchase is on credit; A/P movements are measured from here.
    const ap0 = await glNet(shop.id, "2100");
    const sara = await supplier(shop, "خیاطی سارا");
    let o = await cutOrder(shop, "10");
    expect(o.suppliers.map((s) => s.id)).toContain(sara);

    const created = await newSubcontract(shop, o, sara);
    o = created.o;
    const id = created.id;
    expect(sub(o, id)).toMatchObject({ status: "draft", supplierName: "خیاطی سارا", stageCode: "sew", ratePerUnitRial: 150_000 });

    // Nothing goes out before approval, and approval needs ledger.approve.
    expect((await errorOf(act(shop, o, { action: "subcontract_send", subcontractId: id, quantity: "10" }))).code).toBe("subcontract_action_not_allowed");
    const denied = await errorOf(act(shop, o, { action: "subcontract_approve", subcontractId: id }, { canWriteOff: false }));
    expect(denied).toMatchObject({ code: "subcontract_approval_required", status: 403 });
    o = await act(shop, o, { action: "subcontract_approve", subcontractId: id });
    expect(sub(o, id)).toMatchObject({ status: "approved", approvedByName: "Owner" });

    // Send the 10 cut units and 20 m of fabric into the subcontractor's custody.
    o = await act(shop, o, { action: "subcontract_send", subcontractId: id, quantity: "10",
      materials: [{ materialItemId: shop.fabric, quantity: "20" }] });
    expect(sub(o, id)).toMatchObject({ sentQuantity: "10", heldQuantity: "10" });
    expect(sub(o, id).custody[0]).toMatchObject({ sentQuantity: "20", heldQuantity: "20" });
    expect((await stockOf(shop.fabric)).quantity).toBe("80");
    // 20 m × 50,000 + 10 zips × 10,000, all in WIP.
    expect(await glNet(shop.id, "1310")).toBe(1_100_000n);
    await expectReconciled(shop);

    // In-house work may not touch what the subcontractor holds.
    expect((await errorOf(act(shop, o, { action: "progress", stage: "sew", completed: "1" }))).code).toBe("units_with_subcontractor");
    expect((await errorOf(act(shop, o, { action: "return", lines: [{ materialItemId: shop.fabric, quantity: "1" }] }))).code)
      .toBe("material_held_by_subcontractor");

    // First delivery: 6 accepted, 2 back for rework, 1 scrapped, 1 missing.
    o = await act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "6", rework: "2", scrapped: "1", shortage: "1" });
    expect(sub(o, id)).toMatchObject({ acceptedQuantity: "6", reworkQuantity: "2", scrappedQuantity: "1", shortageQuantity: "1",
      heldQuantity: "2", accruedRial: 900_000 });
    // 7 worked units consumed 14 m; the missing unit lost its 2 m.
    expect(sub(o, id).custody[0]).toMatchObject({ consumedQuantity: "14", lostQuantity: "2", heldQuantity: "4" });
    const sew = o.stages.find((s) => s.code === "sew")!;
    expect(sew).toMatchObject({ completedQuantity: "6", scrappedQuantity: "2" });
    expect(o.order.scrappedQuantity).toBe("2");
    expect((await glNet(shop.id, "2100") - ap0)).toBe(-900_000n);
    expect(await glNet(shop.id, "1310")).toBe(2_000_000n);
    expect(await supplierBalance(shop, sara)).toBe(900_000);
    await expectReconciled(shop);

    // A dispute freezes sending and closing, but the rework can still come back.
    o = await act(shop, o, { action: "subcontract_dispute", subcontractId: id, note: "یک پیراهن گم شده است" });
    expect(sub(o, id).status).toBe("disputed");
    expect((await errorOf(act(shop, o, { action: "subcontract_close", subcontractId: id }))).code).toBe("subcontract_action_not_allowed");
    o = await act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "2" });
    expect(sub(o, id)).toMatchObject({ acceptedQuantity: "8", heldQuantity: "0", accruedRial: 1_200_000 });
    expect(sub(o, id).custody[0]).toMatchObject({ consumedQuantity: "18", heldQuantity: "0" });

    // The dispute settles with a chargeback for the lost dress (out of WIP, against the payable).
    expect((await errorOf(act(shop, o, { action: "subcontract_resolve", subcontractId: id, note: "توافق شد", chargebackRial: 9_000_000 }))).code)
      .toBe("chargeback_exceeds_wip");
    o = await act(shop, o, { action: "subcontract_resolve", subcontractId: id, note: "توافق شد", chargebackRial: 100_000 });
    expect(sub(o, id)).toMatchObject({ status: "approved", chargebackRial: 100_000 });
    expect(o.order.costs.recoveredRial).toBe(100_000);
    expect((await glNet(shop.id, "2100") - ap0)).toBe(-1_100_000n);
    expect(await supplierBalance(shop, sara)).toBe(1_100_000);
    await expectReconciled(shop);

    // Close; a retry of the same request replays instead of acting twice.
    const closeKey = `close-${randomUUID()}`;
    const closed = await act(shop, o, { action: "subcontract_close", subcontractId: id }, { key: closeKey });
    expect(sub(closed, id).status).toBe("closed");
    const replay = await act(shop, o, { action: "subcontract_close", subcontractId: id }, { key: closeKey });
    expect(replay.duplicate).toBe(true);
    expect(replay.order.version).toBe(closed.order.version);
    o = closed;

    // Settlement is the ordinary A/P payment to the canonical supplier alias.
    await ap.payBill({ businessId: shop.id, locationId: shop.main, supplierId: sara, method: "cash", amount: 1_100_000,
      clientRequestId: `pay-${randomUUID()}`, createdBy: shop.ownerId });
    expect(await supplierBalance(shop, sara)).toBe(0);
    expect((await glNet(shop.id, "2100") - ap0)).toBe(0n);
    const statement = await ap.getSupplierStatement(shop.id, sara);
    expect(statement.filter((l) => l.sourceType === "item_production_subcontract")).toHaveLength(3);

    // The rest of the line runs in-house; the last receipt completes the order.
    for (const stage of ["finish", "qc", "pack"]) o = await act(shop, o, { action: "progress", stage, completed: "8" });
    o = await act(shop, o, { action: "receive", quantity: "8" });
    expect(o.order.status).toBe("completed");
    // 1,100,000 material + 1,200,000 subcontract − 100,000 recovered.
    expect(o.order.costs.receivedRial).toBe(2_200_000);
    expect(o.order.costs.wipRial).toBe(0);
    expect(o.order.costs.unitCostRial).toBe("275000");
    expect(await glNet(shop.id, "1310")).toBe(0n);
    await expectReconciled(shop);

    const report = await production.productionReport(actor(shop), shop.main);
    expect(report.subcontracting).toMatchObject({ openSubcontracts: 0, unitsWithSubcontractors: "0", accruedRial: 1_200_000, chargebackRial: 100_000 });
    expect(report.subcontracting.reconciliation).toEqual({ subledgerPayableRial: 1_100_000, glPayableRial: 1_100_000, reconciled: true });
    expect(o.actions.filter((a) => a.action.startsWith("subcontract_")).map((a) => a.action)).toEqual([
      "subcontract_create", "subcontract_approve", "subcontract_send", "subcontract_receive", "subcontract_dispute",
      "subcontract_receive", "subcontract_resolve", "subcontract_close",
    ]);
  });
});

describe("fashion production 6.3 — custody, cancellation and close", () => {
  it("returns custody material at its issued value, recalls held units on cancel, and blocks an order cancel while a subcontract is open", async () => {
    const shop = await seed();
    // The seed's stock purchase is on credit; A/P movements are measured from here.
    const ap0 = await glNet(shop.id, "2100");
    const sara = await supplier(shop, "خیاطی سارا");
    let o = await cutOrder(shop, "5");
    const { o: next, id } = await newSubcontract(shop, o, sara);
    o = await act(shop, next, { action: "subcontract_approve", subcontractId: id });
    o = await act(shop, o, { action: "subcontract_send", subcontractId: id, quantity: "5", materials: [{ materialItemId: shop.fabric, quantity: "10" }] });
    const fabricValueOut = (await stockOf(shop.fabric)).total;

    expect((await errorOf(act(shop, o, { action: "cancel", reason: "لغو مشتری" }))).code).toBe("subcontract_open");
    expect((await errorOf(act(shop, o, { action: "subcontract_cancel", subcontractId: id, reason: "منصرف شدیم" }))).code).toBe("subcontract_custody_held");
    expect((await errorOf(act(shop, o, { action: "subcontract_return_materials", subcontractId: id,
      lines: [{ materialItemId: shop.fabric, quantity: "11" }] }))).code).toBe("custody_return_exceeds_held");

    o = await act(shop, o, { action: "subcontract_return_materials", subcontractId: id, lines: [{ materialItemId: shop.fabric, quantity: "10" }] });
    expect((await stockOf(shop.fabric)).quantity).toBe("100");
    expect(BigInt((await stockOf(shop.fabric)).total!)).toBe(BigInt(fabricValueOut!) + 500_000n);
    o = await act(shop, o, { action: "subcontract_cancel", subcontractId: id, reason: "منصرف شدیم" });
    expect(sub(o, id)).toMatchObject({ status: "cancelled", heldQuantity: "0", sentQuantity: "0" });
    // The recalled units are back at the stage for in-house work.
    o = await act(shop, o, { action: "progress", stage: "sew", completed: "5" });
    expect(o.stages.find((s) => s.code === "sew")?.completedQuantity).toBe("5");
    await expectReconciled(shop);
  });

  it("refuses to close while work or material is still out, unless the remaining custody is declared lost; never cancels accepted work", async () => {
    const shop = await seed();
    // The seed's stock purchase is on credit; A/P movements are measured from here.
    const ap0 = await glNet(shop.id, "2100");
    const sara = await supplier(shop, "خیاطی سارا");
    let o = await cutOrder(shop, "4");
    const { o: next, id } = await newSubcontract(shop, o, sara, 100_000);
    o = await act(shop, next, { action: "subcontract_approve", subcontractId: id });
    o = await act(shop, o, { action: "subcontract_send", subcontractId: id, quantity: "4", materials: [{ materialItemId: shop.fabric, quantity: "9" }] });
    o = await act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "3" });
    const blocked = await errorOf(act(shop, o, { action: "subcontract_close", subcontractId: id }));
    expect(blocked.code).toBe("subcontract_not_settled");
    expect(blocked.detail).toMatchObject({ unitsHeld: "1" });
    expect((await errorOf(act(shop, o, { action: "subcontract_cancel", subcontractId: id, reason: "منصرف شدیم" }))).code)
      .toBe("subcontract_has_accepted_work");
    o = await act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "1" });
    // 4 units × 2 m consumed; 1 m of the 9 sent is still with the subcontractor.
    expect(sub(o, id).custody[0]).toMatchObject({ consumedQuantity: "8", heldQuantity: "1" });
    expect((await errorOf(act(shop, o, { action: "subcontract_close", subcontractId: id }))).detail)
      .toMatchObject({ custody: [{ materialItemId: shop.fabric, held: "1" }] });
    o = await act(shop, o, { action: "subcontract_close", subcontractId: id, declareRemainingLost: true });
    expect(sub(o, id)).toMatchObject({ status: "closed" });
    expect(sub(o, id).custody[0]).toMatchObject({ lostQuantity: "1", heldQuantity: "0" });
    expect((await glNet(shop.id, "2100") - ap0)).toBe(-400_000n);
    await expectReconciled(shop);
  });
});

describe("fashion production 6.3 — isolation, idempotency and concurrency", () => {
  it("accepts only an active supplier of the same branch and tenant", async () => {
    const shop = await seed();
    const other = await seed();
    const elsewhere = await supplier(shop, "تأمین‌کنندهٔ شعبهٔ دیگر", { location: shop.branch });
    const inactive = await supplier(shop, "تأمین‌کنندهٔ غیرفعال", { active: false });
    const foreign = await supplier(other, "تأمین‌کنندهٔ کسب‌وکار دیگر");
    const o = await cutOrder(shop, "2");
    for (const supplierId of [elsewhere, foreign]) {
      expect(await errorOf(act(shop, o, { action: "subcontract_create", supplierId, stage: "sew", ratePerUnitRial: 1 })))
        .toMatchObject({ code: "supplier_not_found", status: 404 });
    }
    expect((await errorOf(act(shop, o, { action: "subcontract_create", supplierId: inactive, stage: "sew", ratePerUnitRial: 1 }))).code)
      .toBe("supplier_inactive");
    expect((await errorOf(act(shop, o, { action: "subcontract_create", supplierId: await supplier(shop, "x"), stage: "embroidery", ratePerUnitRial: 1 }))).code)
      .toBe("stage_not_found");
    // Another tenant (or branch) cannot reach this order's subcontracts at all.
    const crossTenant = await errorOf(production.applyProductionOrderAction(actor(other), other.main, o.order.id, {
      action: "subcontract_create", supplierId: foreign, stage: "sew", ratePerUnitRial: 1, expectedVersion: o.order.version, idempotencyKey: `x-${randomUUID()}`,
    }));
    expect(crossTenant).toMatchObject({ code: "order_not_found", status: 404 });
    const crossBranch = await errorOf(production.applyProductionOrderAction(actor(shop), shop.branch, o.order.id, {
      action: "subcontract_create", supplierId: elsewhere, stage: "sew", ratePerUnitRial: 1, expectedVersion: o.order.version, idempotencyKey: `x-${randomUUID()}`,
    }));
    expect(crossBranch).toMatchObject({ code: "order_not_found", status: 404 });
    // RLS: a tenant session sees none of the other tenant's subcontract rows.
    const visible = await dbLib.withTenantTransaction(other.id, async (client) =>
      (await client.query("SELECT count(*)::int AS n FROM item_production_subcontracts WHERE order_id = $1", [o.order.id])).rows[0].n);
    expect(visible).toBe(0);
  });

  it("rejects a reused key for a different step and lets only one of two concurrent receipts through", async () => {
    const shop = await seed();
    // The seed's stock purchase is on credit; A/P movements are measured from here.
    const ap0 = await glNet(shop.id, "2100");
    const sara = await supplier(shop, "خیاطی سارا");
    let o = await cutOrder(shop, "6");
    const { o: next, id } = await newSubcontract(shop, o, sara, 50_000);
    o = await act(shop, next, { action: "subcontract_approve", subcontractId: id });
    const key = `send-${randomUUID()}`;
    o = await act(shop, o, { action: "subcontract_send", subcontractId: id, quantity: "6" }, { key });
    expect((await errorOf(act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "1" }, { key }))).code)
      .toBe("idempotency_key_reused");

    const results = await Promise.allSettled([
      act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "6" }),
      act(shop, o, { action: "subcontract_receive", subcontractId: id, accepted: "6" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe("version_conflict");
    expect((await glNet(shop.id, "2100") - ap0)).toBe(-300_000n);
    await expectReconciled(shop);
  });
});
