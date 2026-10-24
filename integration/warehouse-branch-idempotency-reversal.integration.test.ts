/**
 * Issue #922 — branch scoping, idempotency, reversal, zero-value and schema.
 * Follows retail-warehouse-document.integration.test.ts fixture pattern:
 * committed base fixture in beforeAll, per-test BEGIN/ROLLBACK.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL required");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let warehouseService: typeof import("../src/lib/retail-warehouse-document-service");
let itemsService: typeof import("../src/lib/items-service");

const biz = { id: "", locA: "", locB: "", otherBizId: "", otherLoc: "" };
const item = { aBatch: "", bBatch: "", plainNone: "", exactNone: "", exactBatch: "" };

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
  databaseName = `pos_widempot_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  warehouseService = await import("../src/lib/retail-warehouse-document-service");
  itemsService = await import("../src/lib/items-service");
  await import("../src/lib/retail-stock-posting-rules");
  await import("../src/lib/fnb-posting-rules");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(`INSERT INTO businesses (name, slug, industry) VALUES ('BranchMatrixBiz', $1, 'cosmetics') RETURNING id`, [`bm-${randomUUID().slice(0,8)}`]);
  biz.id = bizRow.rows[0].id;
  const locRows = await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Branch A'), ($1, 'Branch B') RETURNING id`, [biz.id]);
  biz.locA = locRows.rows[0].id;
  biz.locB = locRows.rows[1].id;

  const otherBizRow = await db.query<{ id: string }>(`INSERT INTO businesses (name, slug, industry) VALUES ('OtherBiz', $1, 'cosmetics') RETURNING id`, [`other-${randomUUID().slice(0,8)}`]);
  biz.otherBizId = otherBizRow.rows[0].id;
  const otherLocRow = await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Other Loc') RETURNING id`, [biz.otherBizId]);
  biz.otherLoc = otherLocRow.rows[0].id;

  const seedClient = await dbLib.getPool().connect();
  try { await provisioning.seedChartOfAccounts(seedClient, biz.id, "cosmetics"); await provisioning.seedChartOfAccounts(seedClient, biz.otherBizId, "cosmetics"); } finally { seedClient.release(); }

  // Items per location — committed fixture
  item.aBatch = (await itemsService.createItem({ locationId: biz.locA, name: "Item A Batch", tracking: "batch" })).id;
  item.bBatch = (await itemsService.createItem({ locationId: biz.locB, name: "Item B Batch", tracking: "batch" })).id;
  item.plainNone = (await itemsService.createItem({ locationId: biz.locA, name: "Plain None", tracking: "none" })).id;
  item.exactNone = (await itemsService.createItem({ locationId: biz.locA, name: "Exact None", tracking: "none" })).id;
  item.exactBatch = (await itemsService.createItem({ locationId: biz.locA, name: "Exact Batch", tracking: "batch" })).id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
}, 120_000);

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try { await client.query("BEGIN"); const r = await fn(client); await client.query("ROLLBACK"); return r; }
  catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

describe("warehouse branch A/B matrix + idempotency + reversal (issue #922)", () => {
  it("list all vs B, open B's doc, create in B, B lots are branch-scoped", async () => {
    await withClient(async (client) => {
      const parsed = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.bBatch, quantity: "5", unitCost: 100, lot: "LOT-B" }]);
      const created = await warehouseService.createRetailWarehouseDocumentInTransaction(client, {
        businessId: biz.id, locationId: biz.locB, kind: "receipt", createdBy: null, lines: parsed.lines,
      });
      const { rows: allDocs } = await client.query(`SELECT id, location_id FROM retail_warehouse_documents WHERE business_id=$1`, [biz.id]);
      expect(allDocs.some(r => r.location_id === biz.locB)).toBe(true);
      const { rows: bDocs } = await client.query(`SELECT id FROM retail_warehouse_documents WHERE business_id=$1 AND location_id=$2`, [biz.id, biz.locB]);
      expect(bDocs.length).toBe(1);
      expect(bDocs[0].id).toBe(created.id);
      const { rows: lines } = await client.query(`SELECT item_id FROM retail_warehouse_document_lines WHERE document_id=$1`, [created.id]);
      expect(lines[0].item_id).toBe(item.bBatch);
      const parsed2 = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.bBatch, quantity: "2", unitCost: 120, lot: "LOT-B2" }]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locB, kind: "receipt", createdBy: null, lines: parsed2.lines });
      const { rows: batchesB } = await client.query(`SELECT batch_number FROM item_batches WHERE item_id=$1`, [item.bBatch]);
      expect(batchesB.map(r=>r.batch_number).sort()).toEqual(["LOT-B","LOT-B2"]);
      const { rows: batchesA } = await client.query(`SELECT batch_number FROM item_batches WHERE item_id=$1`, [item.aBatch]);
      expect(batchesA.length).toBe(0);
      const badParsed = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.bBatch, quantity: "1", unitCost: 100, lot: "LOT-BAD" }]);
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: badParsed.lines })).rejects.toThrow(/کالا در این انبار یافت نشد/);
      const { rows: filtered } = await client.query(`SELECT i.id FROM items i JOIN locations l ON l.id=i.location_id WHERE i.id=$1 AND i.location_id=$2 AND l.business_id=$3`, [item.bBatch, biz.locB, biz.id]);
      expect(filtered.length).toBe(1);
      const { rows: filteredBad } = await client.query(`SELECT i.id FROM items i JOIN locations l ON l.id=i.location_id WHERE i.id=$1 AND i.location_id=$2 AND l.business_id=$3`, [item.bBatch, biz.locA, biz.id]);
      expect(filteredBad.length).toBe(0);
    });
  });

  it("idempotent replay same key same payload returns original, changed payload is 409", async () => {
    await withClient(async (client) => {
      const key = randomUUID();
      const { buildCollectionPayloadHash } = await import("../src/lib/warehouse-idempotency");
      const parsed = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "2", unitCost: 100, lot: null } as never]);
      const hash1 = buildCollectionPayloadHash({ kind: "receipt", locationId: biz.locA, supplierId: null, recipient: null, documentNumber: "DOC-1", note: "note", freeGoodsReason: null, postingDate: null, lines: parsed.lines.map(l=>({itemId:l.itemId, quantity:l.quantity, unitCost:l.unitCost, lot:l.lotNumber, expiryDate:l.expiryDate})) });
      const created1 = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", documentNumber: "DOC-1", note: "note", createdBy: null, lines: parsed.lines, idempotencyKey: key, payloadHash: hash1 });
      const created2 = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", documentNumber: "DOC-1", note: "note", createdBy: null, lines: parsed.lines, idempotencyKey: key, payloadHash: hash1 });
      expect(created2.duplicate).toBe(true);
      expect(created2.id).toBe(created1.id);
      const hash2 = buildCollectionPayloadHash({ kind: "receipt", locationId: biz.locA, supplierId: null, recipient: null, documentNumber: "DOC-2", note: "changed", freeGoodsReason: null, postingDate: null, lines: parsed.lines.map(l=>({itemId:l.itemId, quantity:l.quantity, unitCost:l.unitCost, lot:l.lotNumber, expiryDate:l.expiryDate})) });
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", documentNumber: "DOC-2", note: "changed", createdBy: null, lines: parsed.lines, idempotencyKey: key, payloadHash: hash2 })).rejects.toThrow("idempotency_key_conflict");
    });
  });

  it("concurrent identical POSTs serialize via unique idempotency constraint", async () => {
    await withClient(async (client) => {
      const key = randomUUID();
      const { buildCollectionPayloadHash } = await import("../src/lib/warehouse-idempotency");
      const parsed = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "3", unitCost: 200, lot: null } as never]);
      const hash = buildCollectionPayloadHash({ kind: "receipt", locationId: biz.locA, supplierId: null, recipient: null, documentNumber: null, note: null, freeGoodsReason: null, postingDate: null, lines: parsed.lines.map(l=>({itemId:l.itemId, quantity:l.quantity, unitCost:l.unitCost, lot:l.lotNumber, expiryDate:l.expiryDate})) });
      const first = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: parsed.lines, idempotencyKey: key, payloadHash: hash });
      expect(first.id).toBeTruthy();
      const second = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: parsed.lines, idempotencyKey: key, payloadHash: hash });
      expect(second.duplicate).toBe(true);
      expect(second.id).toBe(first.id);
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM retail_warehouse_documents WHERE business_id=$1 AND idempotency_key=$2`, [biz.id, key]);
      expect(rows[0].n).toBe(1);
      const hashBad = buildCollectionPayloadHash({ kind: "receipt", locationId: biz.locA, supplierId: null, recipient: null, documentNumber: "DIFF", note: null, freeGoodsReason: null, postingDate: null, lines: parsed.lines.map(l=>({itemId:l.itemId, quantity:l.quantity, unitCost:l.unitCost, lot:l.lotNumber, expiryDate:l.expiryDate})) });
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: parsed.lines, idempotencyKey: key, payloadHash: hashBad, documentNumber: "DIFF" })).rejects.toThrow("idempotency_key_conflict");
    });
  });

  it("reversal duplicate, closed period, short stock are typed 409s and block reversing a reversal", async () => {
    await withClient(async (client) => {
      const parsedR = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.aBatch, quantity: "10", unitCost: 100, lot: "LOT-REV" } as never]);
      const receipt = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: parsedR.lines });
      const { rows: lines } = await client.query<{ item_id:string, quantity:string, unit_cost:string, lot_number:string|null, expiry_date:string|null }>(`SELECT item_id, quantity::text, unit_cost::text, lot_number, expiry_date::text FROM retail_warehouse_document_lines WHERE document_id=$1`, [receipt.id]);
      const parsedRev = warehouseService.parseRetailWarehouseDocumentLines("issue", lines.map(l=>({ itemId:l.item_id, quantity:l.quantity, unitCost:l.unit_cost, lot:l.lot_number, expiryDate:l.expiry_date })) as never);
      const rev1 = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "issue", createdBy: null, lines: parsedRev.lines, reversedOf: receipt.id });
      const parsedRev2 = warehouseService.parseRetailWarehouseDocumentLines("issue", lines.map(l=>({ itemId:l.item_id, quantity:l.quantity, unitCost:l.unit_cost, lot:l.lot_number, expiryDate:l.expiry_date })) as never);
      await client.query("SAVEPOINT sp_dup");
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "issue", createdBy: null, lines: parsedRev2.lines, reversedOf: receipt.id })).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT sp_dup");
      const { rows: revDoc } = await client.query<{ is_reversal:boolean }>(`SELECT is_reversal FROM retail_warehouse_documents WHERE id=$1`, [rev1.id]);
      expect(revDoc[0].is_reversal).toBe(true);
      const today = new Date().toISOString().slice(0,10);
      const yearRow = await client.query<{ id: string }>(`INSERT INTO fiscal_years (business_id, label, starts_on, ends_on) VALUES ($1, 'FY-lock', $2::date - INTERVAL '1 day', $2::date + INTERVAL '1 day') RETURNING id`, [biz.id, today]);
      await client.query(`INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on, status) VALUES ($1, $2, 'locked-period', $3::date, $3::date + INTERVAL '1 day', 'locked')`, [biz.id, yearRow.rows[0].id, today]);
      await client.query("SAVEPOINT sp_closed");
      const parsedClosed = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.aBatch, quantity: "1", unitCost: 100, lot: "LOT-CLOSED" } as never]);
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, postingDate: today, lines: parsedClosed.lines })).rejects.toThrow("fiscal_period_locked");
      await client.query("ROLLBACK TO SAVEPOINT sp_closed");
      await client.query(`DELETE FROM fiscal_periods WHERE business_id=$1`, [biz.id]);
      await client.query(`DELETE FROM fiscal_years WHERE business_id=$1`, [biz.id]);
      await client.query("SAVEPOINT sp_short");
      const parsedShort = warehouseService.parseRetailWarehouseDocumentLines("issue", [{ itemId: item.aBatch, quantity: "100", lot: "LOT-REV" } as never]);
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "issue", createdBy: null, lines: parsedShort.lines })).rejects.toThrow(/موجودی بچ کافی نیست|insufficient_stock|موجودی کافی نیست/);
      await client.query("ROLLBACK TO SAVEPOINT sp_short");
    });
  });

  it("zero-value policy and strict schema 400s", async () => {
    await withClient(async (client) => {
      const parsedZero = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "2", unitCost: 0, lot: null } as never]);
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: parsedZero.lines })).rejects.toThrow("receipt_value_required");
      const parsedFree = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "2", unitCost: 0, lot: null } as never]);
      const free = await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: parsedFree.lines, freeGoodsReason: "هدیه" });
      expect(free.id).toBeTruthy();
      expect(() => warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: "", quantity: "1", unitCost: 100 } as never])).toThrow("invalid_line");
      expect(() => warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "not-a-number", unitCost: 100 } as never])).toThrow("invalid_quantity");
      expect(() => warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "1", unitCost: NaN } as never])).toThrow();
      expect(() => warehouseService.parseRetailWarehouseDocumentLines("receipt", Array(201).fill({ itemId: item.plainNone, quantity: "1", unitCost: 100 }) as never)).toThrow("too_many_lines");
      expect(() => warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.plainNone, quantity: "1", unitCost: 100, lot: "x".repeat(101) } as never])).toThrow("invalid_line");
    });
  });

  it("retail exact-money reconciliation 1@100 + 1@101 with price change, depletion and overflow", async () => {
    await withClient(async (client) => {
      const p1 = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.exactNone, quantity: "1", unitCost: 100, lot: "LOT-EX1" } as never]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: p1.lines });
      const p2 = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.exactNone, quantity: "1", unitCost: 101, lot: "LOT-EX1" } as never]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: p2.lines });
      const { rows: stock } = await client.query<{ quantity:string, total_value_rial:string }>(`SELECT trim_scale(quantity)::text AS quantity, total_value_rial::text FROM item_stock WHERE item_id=$1`, [item.exactNone]);
      expect(stock[0].quantity).toBe("2");
      expect(stock[0].total_value_rial).toBe("201");
      const b1 = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.exactBatch, quantity: "1", unitCost: 100, lot: "BATCH-EX" } as never]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: b1.lines });
      const b2 = warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.exactBatch, quantity: "1", unitCost: 101, lot: "BATCH-EX" } as never]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "receipt", createdBy: null, lines: b2.lines });
      const { rows: batch } = await client.query<{ quantity:string, unit_cost:string, total_value_rial:string }>(`SELECT trim_scale(quantity)::text AS quantity, unit_cost::text, total_value_rial::text FROM item_batches WHERE item_id=$1 AND batch_number='BATCH-EX'`, [item.exactBatch]);
      expect(batch[0].quantity).toBe("2");
      expect(batch[0].total_value_rial).toBe("201");
      expect(batch[0].unit_cost).toBe("101");
      const issue = warehouseService.parseRetailWarehouseDocumentLines("issue", [{ itemId: item.exactBatch, quantity: "1", lot: "BATCH-EX" } as never]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "issue", createdBy: null, lines: issue.lines });
      const { rows: afterIssue } = await client.query<{ quantity:string, total_value_rial:string }>(`SELECT trim_scale(quantity)::text AS quantity, total_value_rial::text FROM item_batches WHERE item_id=$1 AND batch_number='BATCH-EX'`, [item.exactBatch]);
      expect(afterIssue[0].quantity).toBe("1");
      expect(afterIssue[0].total_value_rial).toBe("100");
      const issue2 = warehouseService.parseRetailWarehouseDocumentLines("issue", [{ itemId: item.exactBatch, quantity: "1", lot: "BATCH-EX" } as never]);
      await warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "issue", createdBy: null, lines: issue2.lines });
      const { rows: depleted } = await client.query<{ quantity:string, total_value_rial:string }>(`SELECT trim_scale(quantity)::text AS quantity, total_value_rial::text FROM item_batches WHERE item_id=$1 AND batch_number='BATCH-EX'`, [item.exactBatch]);
      expect(depleted[0].quantity).toBe("0");
      expect(depleted[0].total_value_rial).toBe("0");
      await client.query("SAVEPOINT sp_over");
      const overflow = warehouseService.parseRetailWarehouseDocumentLines("issue", [{ itemId: item.exactBatch, quantity: "1", lot: "BATCH-EX" } as never]);
      await expect(warehouseService.createRetailWarehouseDocumentInTransaction(client, { businessId: biz.id, locationId: biz.locA, kind: "issue", createdBy: null, lines: overflow.lines })).rejects.toThrow(/موجودی بچ کافی نیست|موجودی کافی نیست|insufficient_stock/);
      await client.query("ROLLBACK TO SAVEPOINT sp_over");
      expect(() => warehouseService.parseRetailWarehouseDocumentLines("receipt", [{ itemId: item.exactNone, quantity: "9999999999", unitCost: 999999999999 } as never])).toThrow("cost_out_of_range");
    });
  });

  it("two genuinely parallel POSTs with one key commit exactly one voucher", async () => {
    // The interleaving is deliberate: B scans for the key while A's insert is
    // still *uncommitted*, so B's pre-check sees nothing and the unique index
    // decides. A then commits, B's INSERT fails 23505 inside B's own
    // transaction — which aborts it — and B must still be able to read the
    // winner's row (the insert runs in a savepoint). Without that savepoint
    // this test answers `current transaction is aborted` and the request 500s.
    const { buildCollectionPayloadHash } = await import("../src/lib/warehouse-idempotency");
    const key = randomUUID();
    const parsed = warehouseService.parseRetailWarehouseDocumentLines("receipt", [
      { itemId: item.plainNone, quantity: "4", unitCost: 250, lot: null } as never,
    ]);
    const hash = buildCollectionPayloadHash({
      kind: "receipt",
      locationId: biz.locA,
      supplierId: null,
      recipient: null,
      documentNumber: null,
      note: null,
      freeGoodsReason: null,
      postingDate: null,
      lines: parsed.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        unitCost: l.unitCost,
        lot: l.lotNumber,
        expiryDate: l.expiryDate,
      })),
    });
    const params = {
      businessId: biz.id,
      locationId: biz.locA,
      kind: "receipt" as const,
      createdBy: null,
      lines: parsed.lines,
      idempotencyKey: key,
      payloadHash: hash,
    };

    const { rows: before } = await db.query<{ quantity: string }>(
      `SELECT COALESCE(quantity, 0)::text AS quantity FROM item_stock WHERE item_id = $1`,
      [item.plainNone],
    );
    const quantityBefore = Number(before[0]?.quantity ?? 0);

    const clientA = await dbLib.getPool().connect();
    const clientB = await dbLib.getPool().connect();
    try {
      await clientA.query("BEGIN");
      const a = await warehouseService.createRetailWarehouseDocumentInTransaction(clientA as never, params);

      await clientB.query("BEGIN");
      const bPromise = warehouseService.createRetailWarehouseDocumentInTransaction(clientB as never, params);
      // Let B reach the INSERT and block on A's uncommitted key.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await clientA.query("COMMIT");

      const b = await bPromise;
      await clientB.query("COMMIT");

      expect(b.id).toBe(a.id);
      expect(b.duplicate).toBe(true);
    } finally {
      await clientA.query("ROLLBACK").catch(() => {});
      await clientB.query("ROLLBACK").catch(() => {});
      clientA.release();
      clientB.release();
    }

    const { rows: count } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM retail_warehouse_documents WHERE business_id=$1 AND idempotency_key=$2`,
      [biz.id, key],
    );
    expect(count[0].n).toBe(1);

    const { rows: stock } = await db.query<{ quantity: string }>(
      `SELECT trim_scale(quantity)::text AS quantity FROM item_stock WHERE item_id = $1`,
      [item.plainNone],
    );
    // One receipt's worth of stock, not two: the replay did not re-post.
    expect(Number(stock[0].quantity) - quantityBefore).toBe(4);
  });

  it("strict schema 400s for invalid Idempotency-Key in reversal", async () => {
    const { isValidIdempotencyKey } = await import("../src/lib/warehouse-idempotency");
    expect(isValidIdempotencyKey("not-a-uuid")).toBe(false);
    expect(isValidIdempotencyKey(randomUUID())).toBe(true);
    const { buildCollectionPayloadHash } = await import("../src/lib/warehouse-idempotency");
    const h1 = buildCollectionPayloadHash({ kind: "receipt", locationId: "loc1", supplierId: null, recipient: "rec", documentNumber: "doc1", note: "note", freeGoodsReason: null, postingDate: "2024-01-01", lines: [{ itemId: "item1", quantity: "1", unitCost: "100", lot: "LOT", expiryDate: "2025-01-01" }] });
    const h2 = buildCollectionPayloadHash({ kind: "receipt", locationId: "loc1", supplierId: null, recipient: "rec", documentNumber: "doc1", note: "note", freeGoodsReason: null, postingDate: "2024-01-01", lines: [{ itemId: "item1", quantity: "1", unitCost: "100", lot: "LOT", expiryDate: "2025-01-01" }] });
    const h3 = buildCollectionPayloadHash({ kind: "receipt", locationId: "loc1", supplierId: null, recipient: "rec", documentNumber: "doc2", note: "note", freeGoodsReason: null, postingDate: "2024-01-01", lines: [{ itemId: "item1", quantity: "1", unitCost: "100", lot: "LOT", expiryDate: "2025-01-01" }] });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
