/**
 * Issue #799 §7 — the BOQ catalogue's pure half: the status flow, the unit
 * catalogue and the arithmetic mirror.
 *
 * The arithmetic here is the important part. `computeBoqItemTotals` mirrors the
 * `aec_boq_item_totals()` trigger, and the two MUST agree — a preview that is
 * off by a rial is worse than no preview, because it teaches the user to trust
 * a number the row will not keep. The formula is therefore written in exact
 * integer arithmetic on both sides, and `integration/aec-boq.integration.test.ts`
 * asserts the same inputs through PostgreSQL. These cases pin the mirror's own
 * behaviour, including the rounding ties a float implementation would get wrong.
 */
import { describe, expect, it } from "vitest";
import {
  BOQ_UNITS,
  boqTotalFitsInApp,
  boqUnitLabel,
  canTransitionEstimateVersion,
  computeBoqItemTotals,
  ESTIMATE_EVENT_LABELS,
  ESTIMATE_VERSION_STATUSES,
  ESTIMATE_VERSION_STATUS_LABELS,
  ESTIMATE_VERSION_TRANSITIONS,
  isEditableEstimateVersion,
  normalizeBoqUnit,
} from "./aec-boq";

const base = {
  quantity: 1,
  materialRateRial: 0,
  laborRateRial: 0,
  equipmentRateRial: 0,
  subcontractRateRial: 0,
  wastePercent: 0,
  overheadPercent: 0,
  markupPercent: 0,
};

describe("the estimate status model", () => {
  it("carries §7's five statuses with Persian labels", () => {
    expect([...ESTIMATE_VERSION_STATUSES]).toEqual([
      "draft",
      "submitted",
      "under_review",
      "approved",
      "superseded",
    ]);
    for (const status of ESTIMATE_VERSION_STATUSES) {
      expect(ESTIMATE_VERSION_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
    }
  });

  it("allows the forward flow, a return to the author, and nothing else", () => {
    expect(canTransitionEstimateVersion("draft", "submitted")).toBe(true);
    expect(canTransitionEstimateVersion("submitted", "under_review")).toBe(true);
    expect(canTransitionEstimateVersion("submitted", "approved")).toBe(true);
    expect(canTransitionEstimateVersion("under_review", "approved")).toBe(true);
    expect(canTransitionEstimateVersion("approved", "superseded")).toBe(true);

    // A rejected revision goes back to its author rather than being deleted,
    // and an approved one is never un-approved — it is superseded.
    expect(canTransitionEstimateVersion("submitted", "draft")).toBe(true);
    expect(canTransitionEstimateVersion("under_review", "draft")).toBe(true);
    expect(canTransitionEstimateVersion("approved", "draft")).toBe(false);
    expect(canTransitionEstimateVersion("approved", "under_review")).toBe(false);
    expect(canTransitionEstimateVersion("superseded", "approved")).toBe(false);

    // Forward jumps that would skip the record of a decision.
    expect(canTransitionEstimateVersion("draft", "approved")).toBe(false);
    expect(canTransitionEstimateVersion("draft", "under_review")).toBe(false);
  });

  it("treats only a draft as editable", () => {
    expect(isEditableEstimateVersion("draft")).toBe(true);
    for (const status of ["submitted", "under_review", "approved", "superseded"] as const) {
      expect(isEditableEstimateVersion(status), status).toBe(false);
    }
  });

  it("labels every history action", () => {
    for (const [action, label] of Object.entries(ESTIMATE_EVENT_LABELS)) {
      expect(label.trim().length, action).toBeGreaterThan(0);
    }
  });

  it("never lists a status as its own successor", () => {
    for (const status of ESTIMATE_VERSION_STATUSES) {
      expect(ESTIMATE_VERSION_TRANSITIONS[status]).not.toContain(status);
    }
  });
});

describe("the unit catalogue", () => {
  it("recognises the spellings a spreadsheet uses", () => {
    for (const value of ["m2", "M2", "m²", "متر مربع", "مترمربع", " مترمربع "]) {
      expect(normalizeBoqUnit(value), value).toBe("m2");
    }
    expect(normalizeBoqUnit("kg")).toBe("kg");
    expect(normalizeBoqUnit("نفر-روز")).toBe("man_day");
    expect(normalizeBoqUnit("نفر روز")).toBe("man_day");
  });

  it("keeps an unfamiliar unit as text rather than refusing the row", () => {
    // An office's own unit must survive an import; the picker is where the
    // catalogue matters, not the storage.
    expect(normalizeBoqUnit("متر مربع نما")).toBe("متر مربع نما");
    expect(normalizeBoqUnit("  x ".repeat(20))).toHaveLength(20);
    expect(normalizeBoqUnit("")).toBe("");
    expect(normalizeBoqUnit(null)).toBe("");
  });

  it("labels a stored unit, and falls back to the text itself", () => {
    expect(boqUnitLabel("m3")).toBe("مترمکعب");
    expect(boqUnitLabel("متر مربع نما")).toBe("متر مربع نما");
    expect(boqUnitLabel(null)).toBe("");
  });

  it("has a unique key and label per unit", () => {
    const keys = BOQ_UNITS.map((unit) => unit.key);
    const labels = BOQ_UNITS.map((unit) => unit.label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("the price arithmetic", () => {
  it("is the sum of the four rates when nothing else applies", () => {
    const totals = computeBoqItemTotals({
      ...base,
      quantity: 3,
      materialRateRial: 100_000,
      laborRateRial: 40_000,
      equipmentRateRial: 6_000,
      subcontractRateRial: 4_000,
    });
    expect(totals.unitPriceRial).toBe(150_000);
    expect(totals.totalRial).toBe(450_000);
  });

  it("applies waste, then overhead, then markup — in that order", () => {
    // 1 000 000 × 1.10 × 1.05 × 1.20 = 1 386 000. Applying them in any other
    // order gives the same product, but the *rounding* only stays honest when
    // the whole product is rounded once, which is what both implementations do.
    const totals = computeBoqItemTotals({
      ...base,
      quantity: 2,
      materialRateRial: 1_000_000,
      wastePercent: 10,
      overheadPercent: 5,
      markupPercent: 20,
    });
    expect(totals.unitPriceRial).toBe(1_386_000);
    expect(totals.totalRial).toBe(2_772_000);
  });

  it("rounds the half rial up, exactly as PostgreSQL's round() does", () => {
    // A rate of 1 rial with a 50% markup is 1.5 rial. A float implementation
    // that multiplied 1 × 1.5 would agree here, but 200 × 1.0025 (= 200.5) is
    // the case where binary floating point rounds the wrong way — the reason
    // both sides work in integer basis points.
    expect(computeBoqItemTotals({ ...base, materialRateRial: 1, markupPercent: 50 }).unitPriceRial).toBe(2);
    expect(
      computeBoqItemTotals({ ...base, materialRateRial: 200, wastePercent: 0.25 }).unitPriceRial,
    ).toBe(201);
    // And the line total rounds the same way: 0.5 × 3 = 1.5 rial.
    expect(
      computeBoqItemTotals({ ...base, quantity: "0.5", materialRateRial: 3 }).totalRial,
    ).toBe(2);
  });

  it("reads decimals from strings without floating point", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point; a measured
    // quantity of 0.3 must stay 0.3 through the calculation.
    const totals = computeBoqItemTotals({
      ...base,
      quantity: "0.3000",
      materialRateRial: 10,
    });
    expect(totals.totalRial).toBe(3);

    // Quantities carry four decimals — a half millimetre of a square metre.
    expect(computeBoqItemTotals({ ...base, quantity: "1.2345", materialRateRial: 10_000 }).totalRial).toBe(
      12_345,
    );
    // A fifth decimal is rounded half-up, as `numeric(16, 4)` rounds it on the
    // way into the column: 0.00005 m² becomes 0.0001 m², and at 100 000 rial a
    // square metre that is 10 rial — the same number the row will store.
    expect(computeBoqItemTotals({ ...base, quantity: "0.00005", materialRateRial: 100_000 }).totalRial).toBe(
      10,
    );
  });

  it("treats an empty rate or percent as zero", () => {
    const totals = computeBoqItemTotals({
      ...base,
      quantity: 4,
      materialRateRial: 250,
      wastePercent: "0.00",
      overheadPercent: "",
      markupPercent: "",
    });
    expect(totals.unitPriceRial).toBe(250);
    expect(totals.totalRial).toBe(1000);
  });

  it("refuses a value that is not a number", () => {
    expect(() => computeBoqItemTotals({ ...base, quantity: "چهار" })).toThrow();
    expect(() => computeBoqItemTotals({ ...base, materialRateRial: 100, markupPercent: "٪۵" })).toThrow();
  });

  it("knows the range the database can hold exactly", () => {
    expect(boqTotalFitsInApp(9_007_199_254_740_991)).toBe(true);
    expect(boqTotalFitsInApp(9_007_199_254_740_992)).toBe(false);
    expect(boqTotalFitsInApp(-1)).toBe(false);
    expect(boqTotalFitsInApp(1.5)).toBe(false);
  });
});
