import { describe, expect, it } from "vitest";
import { catalogueRecords } from "./catalogue-plan";
import type { CatalogueRow } from "./catalogue-profile";

function row(number: number, sku: string, values: CatalogueRow["values"] = {}): CatalogueRow {
  return { number, sku, title: sku, values, raw: {}, issues: [], duplicateRows: [], movement: null, dimensions: null };
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
});
