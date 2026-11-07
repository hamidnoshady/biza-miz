import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readCatalogueWorksheet } from "./codecs";
import { parseCatalogueRows, suggestCatalogueMapping, validateCatalogueMapping } from "./catalogue-profile";

describe("catalogue XLSX profile", () => {
  it("preserves physical rows and flags even numeric formula caches", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("p");
    sheet.addRow(["sku", "title", "موجودی ", "price", "case_dimension", "drive", "face"]);
    sheet.addRow(["ab۱۲", "Watch", { formula: "A1", result: 9 }, { error: "#NAME?" }, "۴۲×۳۱ mm", "اتوماتیک (Hand Winding)", "Silver"]);
    sheet.getRow(8).values = ["AB12", "Other title"];
    const bytes = await workbook.xlsx.writeBuffer();
    const parsed = await readCatalogueWorksheet(bytes, 10);
    const result = parseCatalogueRows(parsed, suggestCatalogueMapping(parsed.columns), true);
    expect(result.totals).toEqual({ rows: 2, distinctSkus: 1, repeated: 1 });
    expect(result.rows[0]).toMatchObject({ number: 2, duplicateRows: [8], dimensions: [42, 31], movement: null, values: { brand: "Omax", face: "نقره ای" } });
    expect(result.rows[0].issues).toEqual(expect.arrayContaining([
      { field: "quantity", code: "formula" }, { field: "price", code: "error" }, { field: "drive", code: "movement_review" },
    ]));
    expect(result.rows[0].values).not.toHaveProperty("price");
    expect(result.rows[0].values).not.toHaveProperty("quantity");
  });

  it("rejects out-of-range and duplicate mapping indexes", () => {
    expect(() => validateCatalogueMapping({ sku: 0, title: 0 }, 2)).toThrow("catalogue_mapping_invalid");
    expect(() => validateCatalogueMapping({ sku: 0, title: 2 }, 2)).toThrow("catalogue_mapping_invalid");
  });

  it.skipIf(!process.env.OMAX_CATALOGUE_FIXTURE)("verifies the customer workbook without committing customer data", async () => {
    const data = await readFile(process.env.OMAX_CATALOGUE_FIXTURE!);
    const sheet = await readCatalogueWorksheet(Uint8Array.from(data).buffer, 1_000);
    const result = parseCatalogueRows(sheet, suggestCatalogueMapping(sheet.columns), true);
    expect(result.totals).toEqual({ rows: 433, distinctSkus: 408, repeated: 25 });
    expect(result.rows.every(row => row.issues.some(issue => issue.field === "price" && ["formula", "error"].includes(issue.code)))).toBe(true);
    expect(result.rows.filter(row => row.duplicateRows.length > 0).every(row => row.duplicateRows.every(n => n > 1))).toBe(true);
  });
});
