import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { catalogueRecords, readCatalogueWorkbook } from "./catalogue-workbook";

describe("reviewed catalogue XLSX", () => {
  it("preserves Excel rows, detects normalized duplicate SKUs and rejects cached formulas", async () => {
    const workbook = new ExcelJS.Workbook();
    const tab = workbook.addWorksheet("products");
    tab.addRow(["sku", "title", "موجودی ", "price", "drive", "case_dimension", "band_color"]);
    tab.getRow(2).values = [" x۱۲ ", "Watch", { formula: "[1]A!A1", result: 5 }, { error: "#NAME?" }, "اتوماتیک (Hand Winding)", "۴۲ میلی متر", "مشکی"];
    tab.getRow(5).values = ["X12", "Watch 2", 9, 123, "Quartz", "۴۲×۲۹ میلی متر", "آبی"];
    const sheet = await readCatalogueWorkbook(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const result = catalogueRecords(sheet, sheet.suggested, "watch", "Omax");
    expect(result.counts).toEqual({ rows: 2, uniqueSkus: 1, repeated: 1 });
    expect(result.duplicateRows).toEqual([["X12", [2, 5]]]);
    expect(result.records[0]).toMatchObject({ kind: "simple", tracking: "serial", fields: {
      brand: "Omax", watch: { movement: null, caseDiameterMm: 42, braceletColor: "مشکی" },
    } });
    expect(result.records[0].fields?.warnings).toEqual(expect.arrayContaining([
      "quantity:formula_or_error", "price:formula_or_error", "drive:review_required",
    ]));
    expect(result.records[1].fields?.warnings).toContain("case_dimension:diameter_unknown");
  });

  it("requires an explicit parent and option axis, and does not create watch variations", async () => {
    const workbook = new ExcelJS.Workbook();
    const tab = workbook.addWorksheet("products");
    tab.addRow(["sku", "title", "parent_sku", "option_name", "option_value"]);
    tab.addRow(["CHILD-1", "Child", "PARENT", "Color", "RED"]);
    const sheet = await readCatalogueWorkbook(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const [retail] = catalogueRecords(sheet, sheet.suggested, "retail").records;
    expect(retail).toMatchObject({ kind: "variant_child", parentExternalId: "PARENT", variantOptions: { color: "red" }, fields: { errors: [] } });
    expect(catalogueRecords(sheet, sheet.suggested, "watch").records[0].fields?.errors).toContain("catalogue_invalid_variant");
  });

  it.skipIf(!process.env.ESH_142_WORKBOOK)("reconciles the original Omax workbook without checking customer data into git", async () => {
    const bytes = await readFile(process.env.ESH_142_WORKBOOK!);
    const sheet = await readCatalogueWorkbook(Uint8Array.from(bytes).buffer);
    const { counts, records, duplicateRows } = catalogueRecords(sheet, sheet.suggested, "watch");
    expect(counts).toEqual({ rows: 433, uniqueSkus: 408, repeated: 25 });
    expect(records.map((record) => record.rowNumber)).toEqual(Array.from({ length: 433 }, (_, index) => index + 2));
    expect(records.filter((record) => (record.fields?.warnings as string[]).includes("drive:review_required"))).toHaveLength(165);
    expect(records.every((record) => (record.fields?.warnings as string[]).includes("price:formula_or_error"))).toBe(true);
    expect(duplicateRows.flatMap(([, rows]) => rows).every((row) => row >= 2 && row <= 434)).toBe(true);
  });
});
