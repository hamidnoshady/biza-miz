/**
 * Migration 0179 closes the storage half of "invoice OCR remains ephemeral
 * by original design" (Media Library report, Section M/V): a supplier
 * invoice photo scanned through `POST /api/ai/invoice-ocr` is now a real
 * Media Library asset (migration 0180, `source: "ocr_invoice"`), and the
 * draft purchase it produces can point back at it, mirroring how migration
 * 0177 let an expense point at its receipt photo. `invoiceAssetId` must be
 * tenant-scoped like every other cross-reference in this app
 * (`receipt_asset_not_found`'s sibling), the FK's `ON DELETE SET NULL` must
 * survive the asset it points at actually being deleted, and
 * `getMediaAssetUsage`'s new `purchases` category must find the link back —
 * the authorization primitive `/api/media/[id]/file` relies on for a
 * purchaser with `inventory.view` (but not `media.view`) to open a draft
 * purchase's own invoice photo.
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
let purchaseService: typeof import("../src/lib/purchase-service");
let mediaService: typeof import("../src/lib/media-service");

const biz = { id: "" };
const loc = { id: "" };
const item = { id: "" };

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
  databaseName = `pos_purchase_invoice_${randomUUID().replaceAll("-", "")}`;

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
  purchaseService = await import("../src/lib/purchase-service");
  mediaService = await import("../src/lib/media-service");

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

beforeEach(async () => {
  await db.query("DELETE FROM purchase_items");
  await db.query("DELETE FROM purchases");
  await db.query("DELETE FROM inventory_items");
  await db.query("DELETE FROM media_assets");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Purchase Co', $1) RETURNING id",
    [`purchase-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  loc.id = locRow.rows[0].id;

  const itemRow = await db.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'Sugar', 'kg') RETURNING id",
    [loc.id],
  );
  item.id = itemRow.rows[0].id;
});

async function insertAsset(businessId: string, fileName = "invoice.jpg"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256, source)
     VALUES ($1, 'image', $2, 'image/jpeg', 2048, $3, repeat('c', 64), 'ocr_invoice') RETURNING id`,
    [businessId, fileName, `media/${businessId}/${randomUUID()}/${fileName}`],
  );
  return rows[0].id;
}

const oneLine = () => [{ inventoryItemId: item.id, purchaseQty: "2", totalCost: "500000" }];

describe("createDraftPurchase — invoice asset (migration 0179)", () => {
  it("links the draft purchase to the invoice asset and getMediaAssetUsage finds it back", async () => {
    const assetId = await insertAsset(biz.id);
    const { id: purchaseId } = await purchaseService.createDraftPurchase({
      locationId: loc.id,
      items: oneLine(),
      createdBy: null,
      businessId: biz.id,
      invoiceAssetId: assetId,
      note: "اسکن‌شده از فاکتور",
    });

    const { rows } = await db.query<{ invoice_asset_id: string }>(
      "SELECT invoice_asset_id FROM purchases WHERE id = $1",
      [purchaseId],
    );
    expect(rows[0].invoice_asset_id).toBe(assetId);

    const usage = await mediaService.getMediaAssetUsage(assetId);
    expect(usage.purchases).toEqual([{ id: purchaseId, name: "اسکن‌شده از فاکتور" }]);
    expect(mediaService.mediaAssetUsageIsEmpty(usage)).toBe(false);
  });

  it("falls back to the purchase's own id as the usage name when it has no note", async () => {
    const assetId = await insertAsset(biz.id);
    const { id: purchaseId } = await purchaseService.createDraftPurchase({
      locationId: loc.id,
      items: oneLine(),
      createdBy: null,
      businessId: biz.id,
      invoiceAssetId: assetId,
    });

    const usage = await mediaService.getMediaAssetUsage(assetId);
    expect(usage.purchases).toEqual([{ id: purchaseId, name: purchaseId }]);
  });

  it("rejects an invoice asset belonging to a different business", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Purchase Co', $1) RETURNING id",
      [`other-purchase-${randomUUID().slice(0, 8)}`],
    );
    const foreignAssetId = await insertAsset(other.rows[0].id);

    await expect(
      purchaseService.createDraftPurchase({
        locationId: loc.id,
        items: oneLine(),
        createdBy: null,
        businessId: biz.id,
        invoiceAssetId: foreignAssetId,
      }),
    ).rejects.toThrow("invoice_asset_not_found");

    // The rejected asset link must not leave a half-written purchase behind —
    // the whole insert is one transaction.
    const { rows } = await db.query("SELECT id FROM purchases");
    expect(rows).toHaveLength(0);
  });

  it("rejects an invoiceAssetId that does not exist at all", async () => {
    await expect(
      purchaseService.createDraftPurchase({
        locationId: loc.id,
        items: oneLine(),
        createdBy: null,
        businessId: biz.id,
        invoiceAssetId: randomUUID(),
      }),
    ).rejects.toThrow("invoice_asset_not_found");
  });

  it("survives the invoice asset later being deleted — the purchase keeps its total, just loses the link", async () => {
    const assetId = await insertAsset(biz.id);
    const { id: purchaseId, total } = await purchaseService.createDraftPurchase({
      locationId: loc.id,
      items: oneLine(),
      createdBy: null,
      businessId: biz.id,
      invoiceAssetId: assetId,
    });

    await db.query("DELETE FROM media_assets WHERE id = $1", [assetId]);

    const { rows } = await db.query<{ total: string; invoice_asset_id: string | null }>(
      "SELECT total, invoice_asset_id FROM purchases WHERE id = $1",
      [purchaseId],
    );
    expect(rows[0].invoice_asset_id).toBeNull();
    expect(rows[0].total).toBe(total);
  });

  it("never touches invoice_asset_id when none is given, same as before this migration", async () => {
    const { id: purchaseId } = await purchaseService.createDraftPurchase({
      locationId: loc.id,
      items: oneLine(),
      createdBy: null,
    });
    const { rows } = await db.query<{ invoice_asset_id: string | null }>(
      "SELECT invoice_asset_id FROM purchases WHERE id = $1",
      [purchaseId],
    );
    expect(rows[0].invoice_asset_id).toBeNull();
  });
});
