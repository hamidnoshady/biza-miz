import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const base = process.env.DATABASE_URL!;
const databaseName = `pos_catalogue_${randomUUID().replaceAll("-", "")}`;
const url = new URL(base);
url.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: base });
let db: Client;
let dbLib: typeof import("../src/lib/db");
let catalogue: typeof import("../src/lib/data-transfer/catalogue-import-service");
let reconciler: typeof import("../src/lib/import-reconciliation/service");
let readCatalogueWorkbook: typeof import("../src/lib/data-transfer/catalogue-workbook").readCatalogueWorkbook;
let scope: import("../src/lib/data-transfer/catalogue-import-service").CatalogueScope;

async function workbook(sku: string) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("catalogue");
  sheet.addRow(["sku", "title", "price", "موجودی", "case_dimension", "band_color"]);
  sheet.addRow([sku, "Watch", { formula: "[1]Prices!A1", result: 123 }, { error: "#NAME?" }, "۴۲ میلی متر", "مشکی"]);
  return readCatalogueWorkbook(await book.xlsx.writeBuffer() as ArrayBuffer);
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await runMigrations({ databaseUrl: url.toString(), quiet: true });
  process.env.DATABASE_URL = url.toString();
  dbLib = await import("../src/lib/db");
  catalogue = await import("../src/lib/data-transfer/catalogue-import-service");
  reconciler = await import("../src/lib/import-reconciliation/service");
  ({ readCatalogueWorkbook } = await import("../src/lib/data-transfer/catalogue-workbook"));
  db = new Client({ connectionString: url.toString() });
  await db.connect();
  const { rows: [business] } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Watch test', 'catalogue-test', 'watch') RETURNING id");
  const { rows: [location] } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Branch') RETURNING id", [business.id]);
  scope = { businessId: business.id, locationId: location.id, target: "watch", actor: { userId: null, name: "Test" } };
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool();
  process.env.DATABASE_URL = base;
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await admin.end();
});

describe("reviewed XLSX catalogue", () => {
  it("stages without writes, imports watch metadata only and reuses the verified identity", async () => {
    const sheet = await workbook("WATCH-123");
    const first = await catalogue.stageCatalogue(scope, sheet, sheet.suggested, "watch.xlsx", "supplier", "Omax");
    expect((await db.query("SELECT id FROM items WHERE sku='WATCH-123'")).rowCount).toBe(0);
    await reconciler.approveSafeBatch(scope.businessId, first.run.id, scope.actor);
    const result = await catalogue.applyCatalogue(scope, first.run.id);
    expect(result.run).toMatchObject({ status: "applied", crossChecked: true });
    const { rows } = await db.query(`SELECT i.tracking, i.publish_status, a.case_diameter_mm, a.bracelet_color,
      s.item_id AS stock_item_id, b.name AS brand FROM items i JOIN watch_item_attributes a ON a.item_id=i.id
      LEFT JOIN item_stock s ON s.item_id=i.id LEFT JOIN item_brands b ON b.id=i.brand_id WHERE i.sku='WATCH-123'`);
    expect(rows).toEqual([{ tracking: "serial", publish_status: "draft", case_diameter_mm: "42.0", bracelet_color: "مشکی", stock_item_id: null, brand: "Omax" }]);
    const repeat = await catalogue.stageCatalogue(scope, sheet, sheet.suggested, "watch.xlsx", "supplier");
    expect(repeat.counts.alreadyMapped).toBe(1);
    expect((await catalogue.applyCatalogue(scope, repeat.run.id)).counts.applied).toBe(1);
    expect((await db.query("SELECT id FROM items WHERE sku='WATCH-123'")).rowCount).toBe(1);
  });

  it("rechecks the canonical state and refuses a run from another branch", async () => {
    const sheet = await workbook("WATCH-STALE");
    const staged = await catalogue.stageCatalogue(scope, sheet, sheet.suggested, "watch.xlsx", "supplier");
    await expect(catalogue.getCatalogueRun({ ...scope, locationId: randomUUID() }, staged.run.id)).rejects.toThrow("catalogue_run_not_found");
    await reconciler.approveSafeBatch(scope.businessId, staged.run.id, scope.actor);
    await db.query("INSERT INTO items (location_id, name, sku, tracking) VALUES ($1, 'New watch', 'WATCH-STALE', 'serial')", [scope.locationId]);
    await expect(catalogue.applyCatalogue(scope, staged.run.id)).rejects.toThrow("preview_stale");
    expect((await catalogue.getCatalogueRun(scope, staged.run.id)).run.status).toBe("stale");
    expect((await db.query("SELECT id FROM items WHERE sku='WATCH-STALE'")).rowCount).toBe(1);
  });
});
