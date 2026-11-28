import { describe, expect, it } from "vitest";
import { catalogueChildOptions, catalogueFamilyAxes, catalogueRecords, sameVariantOptions } from "./catalogue-plan";
import type { CatalogueRow } from "./catalogue-profile";

function row(number: number, sku: string, values: CatalogueRow["values"] = {}): CatalogueRow {
  return {
    number, sku, title: sku, values, raw: {}, issues: [], duplicateRows: [], movement: null, dimensions: null, brandSource: "none",
    amounts: { price: { raw: null, rial: null, state: "blank" }, cost: { raw: null, rial: null, state: "blank" } },
    stock: { raw: null, quantity: null, state: "blank" },
  };
}
describe("catalogue review planning", () => {
  it("blocks both duplicates until exactly one physical row is selected", () => {
    const rows = [{ ...row(2, "W"), duplicateRows: [9] }, { ...row(9, "W"), duplicateRows: [2] }];
    expect(catalogueRecords(rows, "watch", new Set(), "").every(r => r.invalid)).toBe(true);
    const reviewed = catalogueRecords(rows, "watch", new Set([9]), "");
    expect(reviewed[0].skipped).toBe(true);
    expect(reviewed[1].record).toMatchObject({ externalId: "sku:W", kind: "simple", tracking: "serial" });
    expect(() => catalogueRecords(rows, "watch", new Set([2, 9]), "")).toThrow("catalogue_choose_one_duplicate");
  });

  it("requires explicit parent and options and refuses to turn watch specs into variants", () => {
    const rows = [row(2, "RED", { parent_sku: "P", parent_title: "Family", option: "Red" }),
      row(3, "BLUE", { parent_sku: "P", parent_title: "Family", option: "Blue" })];
    expect(catalogueRecords(rows, "retail", new Set(), "Color")[0].record).toMatchObject({
      externalId: "sku:P", kind: "variant_parent", family: { axis: "Color", children: rows },
    });
    expect(() => catalogueRecords(rows, "watch", new Set(), "Color")).toThrow("catalogue_variant_group_invalid");
    expect(catalogueRecords([row(2, "W", { band_color: "Red" })], "watch", new Set(), "")[0].record.kind).toBe("simple");
  });

  describe("GH #1567 F6 — multi-axis families (size × colour)", () => {
    const grid = (parent = "MNT-1", sizes = ["S", "M", "L"], colours = ["مشکی", "سفید", "کرم"]) =>
      sizes.flatMap((size, i) => colours.map((colour, j) =>
        row(2 + i * colours.length + j, `${parent}-${size}-${j}`, { parent_sku: parent, parent_title: "مانتو", option: size, option_2: colour })));

    it("plans one parent and one child per size × colour cell, each carrying both axes", () => {
      const rows = grid();
      const planned = catalogueRecords(rows, "retail", new Set(), ["سایز", "رنگ"]);
      expect(planned[0].record).toMatchObject({ externalId: "sku:MNT-1", kind: "variant_parent", family: { axis: "سایز", axes: ["سایز", "رنگ"] } });
      expect(planned[0].record.family!.children).toHaveLength(9);
      expect(planned.slice(1).every(entry => entry.skipped && entry.record.familyParentRow === 2)).toBe(true);
      expect(catalogueChildOptions(planned[0].record.family!, rows[4])).toEqual([{ name: "سایز", value: "M" }, { name: "رنگ", value: "سفید" }]);
    });

    it("keeps the one-axis contract: a string axis still plans a one-axis family", () => {
      const rows = [row(2, "A", { parent_sku: "P", parent_title: "F", option: "S" }), row(3, "B", { parent_sku: "P", parent_title: "F", option: "M" })];
      const family = catalogueRecords(rows, "retail", new Set(), "Size")[0].record.family!;
      expect(catalogueFamilyAxes(family)).toEqual(["Size"]);
      // A run staged before multi-axis has no `axes` and still reads as one axis.
      expect(catalogueFamilyAxes({ axis: "Size", children: rows })).toEqual(["Size"]);
    });

    it("refuses a group with a repeated size × colour combination (Persian-aware: ي/ی, digits)", () => {
      const rows = grid();
      rows[1] = { ...rows[1], values: { ...rows[1].values, option_2: "مشكي" } };
      expect(() => catalogueRecords(rows, "retail", new Set(), ["سایز", "رنگ"])).toThrow("catalogue_variant_group_invalid");
    });

    it("refuses a child missing a value for one axis, and a value in an unnamed option column (never dropped silently)", () => {
      const missing = grid();
      missing[3] = { ...missing[3], values: { ...missing[3].values, option_2: undefined } };
      expect(() => catalogueRecords(missing, "retail", new Set(), ["سایز", "رنگ"])).toThrow("catalogue_variant_group_invalid");
      expect(() => catalogueRecords(grid(), "retail", new Set(), ["سایز"])).toThrow("catalogue_variant_group_invalid");
    });

    it("refuses duplicate, blank or more than three axis names", () => {
      expect(() => catalogueRecords(grid(), "retail", new Set(), ["رنگ", "رنگ"])).toThrow("catalogue_variant_group_invalid");
      expect(() => catalogueRecords(grid(), "retail", new Set(), [])).toThrow("catalogue_variant_group_invalid");
      expect(() => catalogueRecords(grid(), "retail", new Set(), ["a", "b", "c", "d"])).toThrow("catalogue_variant_group_invalid");
    });

    it("refuses a group when a child barcode repeats another SKU's barcode, and marks a simple row invalid", () => {
      const rows = grid();
      rows[2] = { ...rows[2], issues: [{ field: "barcode", code: "duplicate_barcode" }] };
      expect(() => catalogueRecords(rows, "retail", new Set(), ["سایز", "رنگ"])).toThrow("catalogue_variant_group_invalid");
      const simple = { ...row(2, "S-1", { barcode: "123" }), issues: [{ field: "barcode" as const, code: "duplicate_barcode" }] };
      expect(catalogueRecords([simple], "retail", new Set(), "")[0].invalid).toBe(true);
    });

    it("a row with a second option but no parent is invalid, not a silent simple product", () => {
      expect(catalogueRecords([row(2, "X", { option_2: "سفید" })], "retail", new Set(), "")[0].invalid).toBe(true);
    });

    it("compares variant options by Persian-aware key and regardless of order", () => {
      expect(sameVariantOptions([{ name: "سایز", value: "M" }, { name: "رنگ", value: "مشکی" }],
        [{ name: "رنگ", value: "مشكي" }, { name: "سايز", value: "m" }])).toBe(true);
      expect(sameVariantOptions([{ name: "سایز", value: "M" }], [{ name: "سایز", value: "M" }, { name: "رنگ", value: "سفید" }])).toBe(false);
      expect(sameVariantOptions([{ name: "سایز", value: "M" }], [{ name: "سایز", value: "L" }])).toBe(false);
    });
  });
});
