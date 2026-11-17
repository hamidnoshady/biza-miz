import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readCatalogueWorksheet, parseCatalogueRows, suggestCatalogueMapping, validateCatalogueMapping } from "./catalogue-profile";

async function makeSheet(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("p");
  for (const row of rows) sheet.addRow(row);
  const bytes = await workbook.xlsx.writeBuffer();
  return readCatalogueWorksheet(bytes, 100);
}

describe("catalogue XLSX profile", () => {
  it("preserves physical rows and flags even numeric formula caches", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("p");
    sheet.addRow(["sku", "title", "موجودی ", "price", "case_dimension", "drive", "face"]);
    sheet.addRow(["ab۱۲", "Watch", { formula: "A1", result: 9 }, { error: "#NAME?" }, "۴۲×۳۱ mm", "اتوماتیک (Hand Winding)", "Silver"]);
    sheet.getRow(8).values = ["AB12", "Other title"];
    const bytes = await workbook.xlsx.writeBuffer();
    const parsed = await readCatalogueWorksheet(bytes, 10);
    const result = parseCatalogueRows(parsed, suggestCatalogueMapping(parsed.columns), { fallbackBrand: "Seiko" });
    expect(result.totals).toEqual({
      rows: 2,
      distinctSkus: 1,
      repeated: 1,
      blankBrandRows: 0,
      excelBrandRows: 0,
      fallbackBrandRows: 2,
      unbrandedRows: 0,
    });
    expect(result.rows[0]).toMatchObject({
      number: 2,
      duplicateRows: [8],
      dimensions: [42, 31],
      movement: null,
      brandSource: "fallback",
      values: { brand: "Seiko", face: "نقره ای" },
    });
    expect(result.rows[0].issues).toEqual(expect.arrayContaining([
      { field: "quantity", code: "formula" }, { field: "price", code: "error" }, { field: "drive", code: "movement_review" },
    ]));
    expect(result.rows[0].values).not.toHaveProperty("price");
    expect(result.rows[0].values).not.toHaveProperty("quantity");
  });

  it("requires an operator fallback when no brand column is mapped, and rejects invalid fallbacks", async () => {
    const parsed = await makeSheet([
      ["sku", "title"],
      ["S-1", "Item 1"],
    ]);
    const mapping = suggestCatalogueMapping(parsed.columns);
    expect(() => parseCatalogueRows(parsed, mapping)).toThrow("catalogue_brand_required");
    expect(() => parseCatalogueRows(parsed, mapping, { fallbackBrand: "   " })).toThrow("catalogue_brand_invalid");
    expect(() => parseCatalogueRows(parsed, mapping, { fallbackBrand: "x".repeat(101) })).toThrow("catalogue_brand_invalid");
  });

  it("preserves multiple brands from the workbook without overwriting them", async () => {
    const parsed = await makeSheet([
      ["sku", "title", "برند"],
      ["S-1", "Watch A", "Casio"],
      ["S-2", "Watch B", "Citizen"],
    ]);
    const result = parseCatalogueRows(parsed, suggestCatalogueMapping(parsed.columns));
    expect(result.rows.map((r) => [r.values.brand, r.brandSource])).toEqual([
      ["Casio", "excel"],
      ["Citizen", "excel"],
    ]);
    expect(result.totals).toMatchObject({
      blankBrandRows: 0,
      excelBrandRows: 2,
      fallbackBrandRows: 0,
      unbrandedRows: 0,
    });
  });

  it("counts blank brand cells and applies fallback only to blanks without touching populated cells", async () => {
    const parsed = await makeSheet([
      ["sku", "title", "برند"],
      ["S-1", "Watch A", "Casio"],
      ["S-2", "Watch B", ""],
      ["S-3", "Watch C", "   "],
    ]);
    const mapping = suggestCatalogueMapping(parsed.columns);

    const withoutFallback = parseCatalogueRows(parsed, mapping);
    expect(withoutFallback.totals).toMatchObject({
      blankBrandRows: 2,
      excelBrandRows: 1,
      fallbackBrandRows: 0,
      unbrandedRows: 2,
    });
    expect(withoutFallback.rows.map((r) => [r.values.brand ?? null, r.brandSource])).toEqual([
      ["Casio", "excel"],
      [null, "none"],
      [null, "none"],
    ]);

    const withFallback = parseCatalogueRows(parsed, mapping, { fallbackBrand: "Seiko" });
    expect(withFallback.totals).toMatchObject({
      blankBrandRows: 2,
      excelBrandRows: 1,
      fallbackBrandRows: 2,
      unbrandedRows: 0,
    });
    expect(withFallback.rows.map((r) => [r.values.brand, r.brandSource])).toEqual([
      ["Casio", "excel"],
      ["Seiko", "fallback"],
      ["Seiko", "fallback"],
    ]);
  });

  it("rejects out-of-range and duplicate mapping indexes", () => {
    expect(() => validateCatalogueMapping({ sku: 0, title: 0 }, 2)).toThrow("catalogue_mapping_invalid");
    expect(() => validateCatalogueMapping({ sku: 0, title: 2 }, 2)).toThrow("catalogue_mapping_invalid");
  });

  it.skipIf(!process.env.OMAX_CATALOGUE_FIXTURE)("verifies the customer workbook without committing customer data", async () => {
    const data = await readFile(process.env.OMAX_CATALOGUE_FIXTURE!);
    const sheet = await readCatalogueWorksheet(Uint8Array.from(data).buffer, 1_000);
    const result = parseCatalogueRows(sheet, suggestCatalogueMapping(sheet.columns), { fallbackBrand: "Omax" });
    expect(result.totals).toMatchObject({ rows: 433, distinctSkus: 408, repeated: 25 });
    expect(result.rows.every(row => row.issues.some(issue => issue.field === "price" && ["formula", "error"].includes(issue.code)))).toBe(true);
    expect(result.rows.filter(row => row.duplicateRows.length > 0).every(row => row.duplicateRows.every(n => n > 1))).toBe(true);
  });
});
