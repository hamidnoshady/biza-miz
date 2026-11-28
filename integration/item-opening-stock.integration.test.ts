/**
 * GH #1567 F2 — opening stock is a reviewed document, posted exactly once.
 *
 * Catalogue creation (the product form, an external catalogue, a Holoo
 * opening sheet) never moves stock; it proposes a draft. Posting the reviewed
 * draft receives the stock and posts Dr inventory / Cr opening equity (3900)
 * in one transaction, bound to the reviewed fingerprint, at most once per
 * item; anything else is refused with a stable code and moves nothing.
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
let opening: typeof import("../src/lib/item-opening-stock-service");
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
  databaseName = `pos_opening_stock_${randomUUID().replaceAll("-", "")}`;
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
  opening = await import("../src/lib/item-opening-stock-service");
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


async function equity(b: Biz): Promise<bigint> {
  return glNet(b, "3900");
}

async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return tx(fn);
}

async function draft(b: Biz, locationId: string, lines: Array<{ itemId: string; quantity: string; unitCost: string | number }>, key = `k-${randomUUID()}`, cutoverDate?: string) {
  return inTx((client) =>
    opening.createOpeningStockDraft(client, {
      businessId: b.id,
      locationId,
      idempotencyKey: key,
      cutoverDate: cutoverDate ?? null,
      lines,
      createdBy: b.ownerId,
    }),
  );
}

async function review(b: Biz, documentId: string) {
  return opening.previewOpeningStock(db as unknown as PoolClient, { businessId: b.id, documentId });
}

async function post(b: Biz, documentId: string, fingerprint: string) {
  return inTx((client) => opening.postOpeningStock(client, { businessId: b.id, documentId, reviewedFingerprint: fingerprint, postedBy: b.ownerId }));
}

async function expectTiedOut(b: Biz): Promise<void> {
  expect(await sumCarrying(b)).toBe(await glNet(b, b.inventoryCode));
  for (const locationId of [b.main, b.branch]) {
    const dry = await reconciliation.readItemStockValuationReconciliation(db as unknown as PoolClient, { businessId: b.id, locationId });
    expect(dry.rows).toEqual([]);
  }
}

describe("F2 — product form proposes, review posts", () => {
  it("creates the catalogue with no stock and no journal, then posts the reviewed draft exactly once", async () => {
    const b = await seed("fashion_apparel", "1374");
    await db.query("INSERT INTO item_attribute_definitions (location_id, name, options) VALUES ($1, 'سایز', '{}')", [b.main]);
    const parsed = productInput.parseProductCreateInput({
      name: "پیراهن",
      sellPrice: 100_000,
      variants: [
        { quantity: "10", purchasePrice: 50_000, attributes: [{ name: "سایز", value: "M" }] },
        { quantity: "4", purchasePrice: 52_500, attributes: [{ name: "سایز", value: "L" }] },
        { attributes: [{ name: "سایز", value: "S" }] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const created = await productCreation.createProductRecord(b.main, parsed.data, { businessId: b.id, userId: b.ownerId });
    const [m, l, s] = created.variants.map((v) => v.id);

    // Catalogue only: prices and costs are known, nothing is on the shelf or in the ledger.
    expect(await stock(m)).toMatchObject({ quantity: "0", unitCost: "50000" });
    expect(await stock(l)).toMatchObject({ quantity: "0", unitCost: "52500" });
    expect(await glNet(b, "1374")).toBe(0n);
    expect(created.openingStockDocumentId).toBeTruthy();

    const preview = await review(b, created.openingStockDocumentId!);
    expect(preview.document).toMatchObject({ status: "draft", source: "product_form", locationId: b.main });
    expect(preview.lines.map((line) => [line.itemId, line.quantity, line.unitCost, line.lineValue, line.issues]).sort()).toEqual(
      [
        [m, "10", "50000", "500000", []],
        [l, "4", "52500", "210000", []],
      ].sort(),
    );
    expect(preview.lines.some((line) => line.itemId === s)).toBe(false);
    expect(preview).toMatchObject({ totalQuantity: "14", totalValue: "710000", inventoryAccountCode: "1374", equityAccountCode: "3900", postable: true });

    const posted = await post(b, preview.document.id, preview.fingerprint);
    expect(posted).toMatchObject({ totalValue: "710000", lineCount: 2, duplicate: false });
    expect(await stock(m)).toMatchObject({ quantity: "10", total: "500000" });
    expect(await stock(l)).toMatchObject({ quantity: "4", total: "210000" });
    expect(await glNet(b, "1374")).toBe(710_000n);
    expect(await equity(b)).toBe(-710_000n);
    const entry = await db.query<{ entry_date: string; source_type: string; n: string }>(
      `SELECT je.entry_date::text, je.source_type, count(*) OVER ()::text AS n FROM journal_entries je WHERE je.business_id = $1`,
      [b.id],
    );
    expect(entry.rows).toEqual([{ entry_date: preview.document.cutoverDate, source_type: "item_opening_stock", n: "1" }]);
    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events WHERE business_id = $1 AND event_type = 'item.opening_stock_posted'`,
      [b.id],
    );
    expect(audit.rows[0].n).toBe("2");

    // A retried post (same reviewed fingerprint) is the same post.
    const replay = await post(b, preview.document.id, preview.fingerprint);
    expect(replay).toMatchObject({ duplicate: true, totalValue: "710000", journalEntryId: posted.journalEntryId });
    expect(await glNet(b, "1374")).toBe(710_000n);
    expect(await stock(m)).toMatchObject({ quantity: "10", total: "500000" });

    // F1 continues from the opening value: sell 4 M → COGS 200,000, tied out.
    await sell(b, b.main, m, "4");
    expect(await stock(m)).toMatchObject({ quantity: "6", total: "300000" });
    expect(await glNet(b, "5184")).toBe(200_000n);
    await expectTiedOut(b);
  });
});

describe("F2 — refusals move nothing", () => {
  it("refuses a stale review, missing cost, tracked/parent/foreign items and stock already on the shelf", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await sku(b.main, "شلوار");
    const noCost = await sku(b.main, "کت");
    const stocked = await sku(b.main, "جوراب");
    await purchase(b, b.main, stocked, "3", 10_000);
    const branchItem = await sku(b.branch, "کلاه");
    const parent = await itemsService.createItem({ locationId: b.main, name: "خانواده", kind: "variant_parent" });
    const serial = await itemsService.createItem({ locationId: b.main, name: "ساعت", tracking: "serial" });
    const glBefore = await glNet(b, "1374");

    const { document } = await draft(b, b.main, [
      { itemId: a, quantity: "5", unitCost: 40_000 },
      { itemId: noCost, quantity: "2", unitCost: 0 },
      { itemId: stocked, quantity: "1", unitCost: 10_000 },
      { itemId: branchItem, quantity: "1", unitCost: 10_000 },
      { itemId: parent.id, quantity: "1", unitCost: 10_000 },
      { itemId: serial.id, quantity: "1", unitCost: 10_000 },
    ]);
    const preview = await review(b, document.id);
    const issues = Object.fromEntries(preview.lines.map((line) => [line.itemId, line.issues]));
    expect(issues).toEqual({
      [a]: [],
      [noCost]: ["unit_cost_required"],
      [stocked]: ["item_has_stock"],
      [branchItem]: ["wrong_branch"],
      [parent.id]: ["not_sellable"],
      [serial.id]: ["tracking_unsupported"],
    });
    expect(preview.postable).toBe(false);
    await expect(post(b, document.id, preview.fingerprint)).rejects.toMatchObject({ message: "lines_not_postable", status: 409 });

    // Fix the draft: drop the bad lines, enter the missing cost.
    await inTx((client) =>
      opening.updateOpeningStockDraft(client, {
        businessId: b.id,
        documentId: document.id,
        lines: [{ itemId: noCost, quantity: "2", unitCost: 75_000 }],
        removeItemIds: [stocked, branchItem, parent.id, serial.id],
      }),
    );
    // The old fingerprint no longer describes the draft.
    await expect(post(b, document.id, preview.fingerprint)).rejects.toMatchObject({ message: "review_stale" });
    await expect(post(b, document.id, "")).rejects.toMatchObject({ message: "fingerprint_required" });
    expect(await stock(a)).toMatchObject({ quantity: "0" });
    expect(await glNet(b, "1374")).toBe(glBefore);

    const fresh = await review(b, document.id);
    expect(fresh).toMatchObject({ postable: true, totalValue: "350000" });
    await post(b, document.id, fresh.fingerprint);
    expect(await glNet(b, "1374")).toBe(glBefore + 350_000n);
    expect(await equity(b)).toBe(-350_000n);
    // A posted document is frozen.
    await expect(
      inTx((client) => opening.updateOpeningStockDraft(client, { businessId: b.id, documentId: document.id, lines: [{ itemId: a, quantity: "9", unitCost: 1 }] })),
    ).rejects.toMatchObject({ message: "document_not_draft" });
    await expect(inTx((client) => opening.cancelOpeningStockDraft(client, { businessId: b.id, documentId: document.id, cancelledBy: b.ownerId }))).rejects.toMatchObject({ message: "document_not_draft" });
    await expectTiedOut(b);
  });

  it("validates input, cutover date and idempotent creation", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await sku(b.main, "دامن");
    await expect(draft(b, b.main, [{ itemId: a, quantity: "-1", unitCost: 1 }])).rejects.toMatchObject({ message: "invalid_quantity" });
    await expect(draft(b, b.main, [{ itemId: a, quantity: "1", unitCost: "1.5" }])).rejects.toMatchObject({ message: "invalid_unit_cost" });
    await expect(draft(b, b.main, [{ itemId: a, quantity: "1", unitCost: 1 }, { itemId: a, quantity: "2", unitCost: 1 }])).rejects.toMatchObject({ message: "duplicate_item" });
    await expect(draft(b, b.main, [{ itemId: a, quantity: "1", unitCost: 1 }], `k-${randomUUID()}`, "2999-01-01")).rejects.toMatchObject({ message: "cutover_in_future" });
    await expect(draft(b, b.main, [{ itemId: a, quantity: "1", unitCost: 1 }], "short")).rejects.toMatchObject({ message: "idempotency_key_required" });

    const key = `same-${randomUUID()}`;
    const first = await draft(b, b.main, [{ itemId: a, quantity: "3", unitCost: 20_000 }], key, "2026-03-20");
    const again = await draft(b, b.main, [{ itemId: a, quantity: "3", unitCost: 20_000 }], key, "2026-03-20");
    expect(again).toMatchObject({ duplicate: true, document: { id: first.document.id } });
    await expect(draft(b, b.main, [{ itemId: a, quantity: "4", unitCost: 20_000 }], key, "2026-03-20")).rejects.toMatchObject({ message: "idempotency_conflict" });

    // A back-dated cutover posts on that date.
    const preview = await review(b, first.document.id);
    const posted = await post(b, first.document.id, preview.fingerprint);
    const { rows } = await db.query<{ entry_date: string }>("SELECT entry_date::text FROM journal_entries WHERE id = $1", [posted.journalEntryId]);
    expect(rows[0].entry_date).toBe("2026-03-20");

    // A cancelled draft cannot be posted.
    const other = await sku(b.main, "روسری");
    const second = await draft(b, b.main, [{ itemId: other, quantity: "1", unitCost: 5_000 }]);
    const secondPreview = await review(b, second.document.id);
    await inTx((client) => opening.cancelOpeningStockDraft(client, { businessId: b.id, documentId: second.document.id, cancelledBy: b.ownerId }));
    await expect(post(b, second.document.id, secondPreview.fingerprint)).rejects.toMatchObject({ message: "document_not_draft" });
    expect(await stock(other)).toMatchObject({ quantity: "0" });
  });

  it("is tenant- and branch-scoped", async () => {
    const b = await seed("fashion_apparel", "1374");
    const intruder = await seed("fashion_apparel", "1374");
    const a = await sku(b.main, "مانتو");
    const { document } = await draft(b, b.main, [{ itemId: a, quantity: "1", unitCost: 10_000 }]);
    await expect(opening.previewOpeningStock(db as unknown as PoolClient, { businessId: intruder.id, documentId: document.id })).rejects.toMatchObject({ message: "document_not_found", status: 404 });
    const preview = await review(b, document.id);
    await expect(
      inTx((client) => opening.postOpeningStock(client, { businessId: intruder.id, documentId: document.id, reviewedFingerprint: preview.fingerprint, postedBy: intruder.ownerId })),
    ).rejects.toMatchObject({ message: "document_not_found" });
    // Another tenant's branch cannot host a draft.
    await expect(draft(intruder, b.main, [{ itemId: a, quantity: "1", unitCost: 1 }])).rejects.toMatchObject({ message: "location_not_found" });
    // An item of another tenant is "not found" in this tenant's draft.
    const foreign = await draft(intruder, intruder.main, [{ itemId: a, quantity: "1", unitCost: 10_000 }]);
    const foreignPreview = await review(intruder, foreign.document.id);
    expect(foreignPreview.lines[0].issues).toContain("wrong_branch");
    const listed = await opening.listOpeningStockDocuments(db as unknown as PoolClient, { businessId: intruder.id });
    expect(listed.map((d) => d.id)).toEqual([foreign.document.id]);
  });
});

describe("F2 — exactly once per item", () => {
  it("refuses a second opening of the same item, sequentially and concurrently", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await sku(b.main, "بلوز");
    const c = await sku(b.main, "تاپ");
    const one = await draft(b, b.main, [{ itemId: a, quantity: "5", unitCost: 30_000 }]);
    const two = await draft(b, b.main, [{ itemId: a, quantity: "7", unitCost: 30_000 }]);
    const oneReview = await review(b, one.document.id);
    const twoReview = await review(b, two.document.id);
    await post(b, one.document.id, oneReview.fingerprint);
    await expect(post(b, two.document.id, twoReview.fingerprint)).rejects.toMatchObject({ message: "lines_not_postable" });
    expect((await review(b, two.document.id)).lines[0].issues).toEqual(["already_opened"]);
    expect(await stock(a)).toMatchObject({ quantity: "5", total: "150000" });

    // Two documents for the same fresh item posted at the same time: one wins.
    const p = await draft(b, b.main, [{ itemId: c, quantity: "2", unitCost: 10_000 }]);
    const q = await draft(b, b.main, [{ itemId: c, quantity: "3", unitCost: 10_000 }]);
    const [pr, qr] = [await review(b, p.document.id), await review(b, q.document.id)];
    const results = await Promise.allSettled([post(b, p.document.id, pr.fingerprint), post(b, q.document.id, qr.fingerprint)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toBe("lines_not_postable");
    const after = await stock(c);
    expect(["2", "3"]).toContain(after.quantity);
    expect(await glNet(b, "1374")).toBe(150_000n + BigInt(after.total!));
    await expectTiedOut(b);

    // Concurrent replays of one post: posted once.
    const r = await sku(b.main, "شال");
    const d = await draft(b, b.main, [{ itemId: r, quantity: "4", unitCost: 25_000 }]);
    const dr = await review(b, d.document.id);
    const replays = await Promise.all([1, 2, 3].map(() => post(b, d.document.id, dr.fingerprint)));
    expect(replays.filter((x) => !x.duplicate)).toHaveLength(1);
    expect(await stock(r)).toMatchObject({ quantity: "4", total: "100000" });
    await expectTiedOut(b);
  });
});

describe("F2 — other items-model trades and the matrix editor", () => {
  it("opens accessories and cosmetics stock into their own inventory accounts", async () => {
    for (const [industry, code] of [["accessories", "1340"], ["cosmetics", "1350"]] as const) {
      const b = await seed(industry, code);
      const a = await sku(b.main, `کالا ${industry}`);
      const { document } = await draft(b, b.main, [{ itemId: a, quantity: "3", unitCost: "33333" }]);
      const preview = await review(b, document.id);
      expect(preview.inventoryAccountCode).toBe(code);
      await post(b, document.id, preview.fingerprint);
      expect(await stock(a)).toMatchObject({ quantity: "3", total: "99999" });
      expect(await glNet(b, code)).toBe(99_999n);
      expect(await equity(b)).toBe(-99_999n);
      await expectTiedOut(b);
    }
  });

  it("turns a matrix quantity edit into a posted, reversible count and refuses a variant with no cost", async () => {
    const b = await seed("fashion_apparel", "1374");
    const a = await sku(b.main, "ژاکت");
    await purchase(b, b.main, a, "10", 50_000);
    await tx((client) => merch.bulkUpdateVariantMatrix(client, { businessId: b.id, locationId: b.main, updates: [{ itemId: a, quantity: 8 }] }));
    expect(await stock(a)).toMatchObject({ quantity: "8", total: "400000" });
    expect(await glNet(b, "5190")).toBe(100_000n);
    await expectTiedOut(b);
    // Unchanged cell → no count document.
    const before = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM item_stock_counts WHERE location_id = $1", [b.main]);
    await tx((client) => merch.bulkUpdateVariantMatrix(client, { businessId: b.id, locationId: b.main, updates: [{ itemId: a, quantity: 8 }] }));
    const after = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM item_stock_counts WHERE location_id = $1", [b.main]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const blank = await sku(b.main, "ژاکت نو");
    await expect(
      tx((client) => merch.bulkUpdateVariantMatrix(client, { businessId: b.id, locationId: b.main, updates: [{ itemId: blank, quantity: 5 }] })),
    ).rejects.toThrow(/موجودی افتتاحیه/);
    expect(await stock(blank)).toMatchObject({ quantity: "0" });
    await expectTiedOut(b);
  });
});
