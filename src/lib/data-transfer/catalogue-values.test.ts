import { describe, expect, it } from "vitest";
import {
  countValuePlans, parseCatalogueMoney, parseCatalogueQuantity, planCatalogueValues,
  type CatalogueStockState, type CatalogueValuePlan,
} from "./catalogue-values";

const state = (over: Partial<CatalogueStockState> = {}): CatalogueStockState => ({
  kind: "simple",
  tracking: "none",
  hasStockRow: true,
  quantity: "0",
  unitPriceRial: null,
  unitCostRial: null,
  ...over,
});

describe("catalogue value parsing", () => {
  it("keeps blank, zero, invalid and formula distinct and converts Toman exactly", () => {
    expect(parseCatalogueMoney("", "rial").state).toBe("blank");
    expect(parseCatalogueMoney("0", "rial")).toMatchObject({ state: "zero", rial: 0 });
    expect(parseCatalogueMoney("abc", "rial").state).toBe("invalid");
    expect(parseCatalogueMoney("1.5", "rial").state).toBe("invalid");
    expect(parseCatalogueMoney("۹۹۹", "rial")).toMatchObject({ state: "valid", rial: 999 });
    expect(parseCatalogueMoney("۱٬۲۵۰٬۰۰۰", "rial")).toMatchObject({ rial: 1_250_000 });
    expect(parseCatalogueMoney("1,250,000 ریال", "rial")).toMatchObject({ rial: 1_250_000 });
    expect(parseCatalogueMoney("125,000", "toman")).toMatchObject({ rial: 1_250_000 });
    expect(parseCatalogueMoney("125000", "rial", "formula").state).toBe("formula");
    expect(parseCatalogueMoney("125000", "rial", "error").state).toBe("error");
  });

  it("keeps quantity text precise and refuses negatives", () => {
    expect(parseCatalogueQuantity("")).toMatchObject({ state: "blank", quantity: null });
    expect(parseCatalogueQuantity("0")).toMatchObject({ state: "zero", quantity: "0" });
    expect(parseCatalogueQuantity("12.500")).toMatchObject({ state: "valid", quantity: "12.5" });
    expect(parseCatalogueQuantity("-3").state).toBe("invalid");
    expect(parseCatalogueQuantity("2+3", "formula").state).toBe("formula");
  });
});

describe("catalogue value plans", () => {
  const incoming = { priceRial: 500_000, costRial: 300_000, quantity: "8" };

  it("does nothing at all in catalogue-only mode", () => {
    expect(planCatalogueValues(incoming, state(), "catalogue_only")).toEqual({});
  });

  it("fills a missing price but preserves an existing one in fill-missing mode", () => {
    expect(planCatalogueValues(incoming, state(), "fill_missing").price).toMatchObject({
      action: "set", current: null, proposed: 500_000,
    });
    expect(planCatalogueValues(incoming, state({ unitPriceRial: 480_000 }), "fill_missing").price).toMatchObject({
      action: "unchanged", current: 480_000,
    });
  });

  it("overwrites only in update mode and treats an equal value as unchanged", () => {
    expect(planCatalogueValues(incoming, state({ unitPriceRial: 480_000 }), "update_existing").price).toMatchObject({
      action: "set", current: 480_000, proposed: 500_000,
    });
    expect(planCatalogueValues(incoming, state({ unitPriceRial: 500_000 }), "update_existing").price?.action).toBe("unchanged");
  });

  it("never sets a zero sale price and never rewrites the cost of stock on hand", () => {
    expect(planCatalogueValues({ ...incoming, priceRial: 0 }, state(), "update_existing").price).toMatchObject({
      action: "held", reason: "catalogue_price_must_be_positive",
    });
    expect(planCatalogueValues(incoming, state({ quantity: "4" }), "update_existing").cost).toMatchObject({
      action: "held", reason: "catalogue_cost_locked_with_stock",
    });
    expect(planCatalogueValues(incoming, state({ quantity: "0" }), "update_existing").cost?.action).toBe("set");
  });

  it("reports a cost the mode preserves as unchanged, not as a refused change", () => {
    // `fill_missing` keeps a cost the product already has, so on-hand stock is
    // not the reason nothing moved and the row must not warn about it.
    expect(planCatalogueValues(incoming, state({ quantity: "4", unitCostRial: 300_000 }), "fill_missing").cost).toMatchObject({
      action: "unchanged", current: 300_000, proposed: 300_000,
    });
    expect(planCatalogueValues(incoming, state({ quantity: "4", unitCostRial: 250_000 }), "fill_missing").cost).toMatchObject({
      action: "unchanged", current: 250_000, proposed: 300_000,
    });
  });

  it("fills stock only where the branch has no stock row, and overwrites with a recorded delta", () => {
    expect(planCatalogueValues(incoming, state({ hasStockRow: false, quantity: "0" }), "fill_missing").quantity).toMatchObject({
      action: "set", current: "0", proposed: "8", delta: 8,
    });
    expect(planCatalogueValues(incoming, state({ quantity: "2" }), "fill_missing").quantity).toMatchObject({
      action: "unchanged", reason: "catalogue_existing_stock_preserved",
    });
    expect(planCatalogueValues(incoming, state({ quantity: "2" }), "update_existing").quantity).toMatchObject({
      action: "set", delta: 6,
    });
    expect(planCatalogueValues(incoming, state({ quantity: "8" }), "update_existing").quantity?.action).toBe("unchanged");
  });

  it("holds tracked and parent products instead of bypassing their native flow", () => {
    expect(planCatalogueValues(incoming, state({ tracking: "serial" }), "update_existing").quantity).toMatchObject({
      action: "held", reason: "catalogue_tracking_serial_unsupported",
    });
    expect(planCatalogueValues(incoming, state({ tracking: "batch" }), "update_existing").quantity).toMatchObject({
      action: "held", reason: "catalogue_tracking_batch_unsupported",
    });
    expect(planCatalogueValues(incoming, state({ kind: "variant_parent" }), "update_existing").quantity).toMatchObject({
      action: "held", reason: "catalogue_variant_parent_has_no_stock",
    });
  });

  it("treats a column without a value as no opinion at all", () => {
    expect(planCatalogueValues({ priceRial: null, costRial: null, quantity: null }, state(), "update_existing")).toEqual({});
    expect(planCatalogueValues(null, state(), "update_existing")).toEqual({});
  });

  it("counts set, unchanged and held per field", () => {
    const plans: CatalogueValuePlan[] = [
      planCatalogueValues(incoming, state({ hasStockRow: false }), "fill_missing"),
      planCatalogueValues(incoming, state({ quantity: "4", unitPriceRial: 500_000 }), "update_existing"),
    ];
    expect(countValuePlans(plans)).toEqual({
      price: { set: 1, unchanged: 1, held: 0 },
      cost: { set: 1, unchanged: 0, held: 1 },
      quantity: { set: 2, unchanged: 0, held: 0 },
    });
  });
});
