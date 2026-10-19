import { describe, expect, it } from "vitest";
import {
  formatModifierDelta,
  isModifierGroupSatisfied,
  linePriceBreakdown,
  modifierDeltasOf,
  modifierGroupProgressLabel,
  modifierGroupRuleLabel,
  modifierNamesLabel,
  sumModifierDeltas,
} from "./modifier-display";

describe("formatModifierDelta", () => {
  it("signs a paid add-on so it can't be read as the line price", () => {
    // 200_000 rial = 20_000 toman
    expect(formatModifierDelta(200_000)).toBe("+۲۰٬۰۰۰ تومان");
  });

  it("words a free add-on instead of printing zero toman", () => {
    expect(formatModifierDelta(0)).toBe("رایگان");
  });

  it("signs a negative delta with a minus", () => {
    expect(formatModifierDelta(-50_000)).toBe("−۵٬۰۰۰ تومان");
  });

  it("drops the unit when it is already stated nearby", () => {
    expect(formatModifierDelta(200_000, { withUnit: false })).toBe("+۲۰٬۰۰۰");
    expect(formatModifierDelta(0, { withUnit: false })).toBe("رایگان");
  });
});

describe("sumModifierDeltas", () => {
  it("is zero for a line without add-ons", () => {
    expect(sumModifierDeltas([])).toBe(0);
  });

  it("adds signed deltas", () => {
    expect(sumModifierDeltas([200_000, 50_000, -100_000])).toBe(150_000);
  });
});

describe("modifierNamesLabel", () => {
  it("joins names with the Persian comma", () => {
    expect(
      modifierNamesLabel([
        { name: "شکلات تلخ", priceDelta: 200_000 },
        { name: "شات اضافه", priceDelta: 150_000 },
      ]),
    ).toBe("شکلات تلخ، شات اضافه");
  });

  it("is empty for no add-ons", () => {
    expect(modifierNamesLabel([])).toBe("");
  });
});

describe("linePriceBreakdown", () => {
  it("keeps add-ons inside the unit and line price", () => {
    // 60_000 toman drink + a 20_000 toman add-on, twice.
    expect(
      linePriceBreakdown({
        unitPrice: 600_000,
        modifierDeltas: [200_000],
        quantity: 2,
      }),
    ).toEqual({
      base: 600_000,
      addOns: 200_000,
      unit: 800_000,
      total: 1_600_000,
    });
  });

  it("leaves a line without add-ons at its menu price", () => {
    expect(
      linePriceBreakdown({
        unitPrice: 600_000,
        modifierDeltas: [],
        quantity: 3,
      }),
    ).toEqual({ base: 600_000, addOns: 0, unit: 600_000, total: 1_800_000 });
  });

  it("lets a negative add-on lower the unit price", () => {
    expect(
      linePriceBreakdown({
        unitPrice: 600_000,
        modifierDeltas: [-100_000],
        quantity: 1,
      }),
    ).toEqual({
      base: 600_000,
      addOns: -100_000,
      unit: 500_000,
      total: 500_000,
    });
  });
});

describe("modifierGroupRuleLabel", () => {
  it("calls a 0..1 group optional", () => {
    expect(modifierGroupRuleLabel(0, 1)).toBe("اختیاری · تا ۱ مورد");
  });

  it("calls an exact-count group required", () => {
    expect(modifierGroupRuleLabel(1, 1)).toBe("الزامی · ۱ مورد");
    expect(modifierGroupRuleLabel(2, 2)).toBe("الزامی · ۲ مورد");
  });

  it("spells out a required range", () => {
    expect(modifierGroupRuleLabel(1, 3)).toBe("الزامی · ۱ تا ۳ مورد");
  });

  it("spells out an optional ceiling", () => {
    expect(modifierGroupRuleLabel(0, 3)).toBe("اختیاری · تا ۳ مورد");
  });
});

describe("modifierGroupProgressLabel", () => {
  it("counts selections against the ceiling in Persian digits", () => {
    expect(modifierGroupProgressLabel(1, 2)).toBe("۱ از ۲ انتخاب شد");
  });
});

describe("isModifierGroupSatisfied", () => {
  it("rejects a required group with nothing chosen", () => {
    expect(isModifierGroupSatisfied(0, 1, 2)).toBe(false);
  });

  it("accepts a count inside the bounds", () => {
    expect(isModifierGroupSatisfied(1, 1, 2)).toBe(true);
    expect(isModifierGroupSatisfied(2, 1, 2)).toBe(true);
  });

  it("rejects a count past the ceiling", () => {
    expect(isModifierGroupSatisfied(3, 1, 2)).toBe(false);
  });

  it("accepts an untouched optional group", () => {
    expect(isModifierGroupSatisfied(0, 0, 1)).toBe(true);
  });
});

describe("modifierDeltasOf — each add-on repeats by its own quantity", () => {
  it("turns «شات ×۳» into three deltas, not one", () => {
    expect(
      modifierDeltasOf([
        { name: "شات اضافه", priceDelta: 20_000, quantity: 3 },
        { name: "شربت وانیل", priceDelta: 10_000 },
      ]),
    ).toEqual([20_000, 20_000, 20_000, 10_000]);
  });

  it("never drops a quantity below one (a malformed snapshot is one unit)", () => {
    expect(
      modifierDeltasOf([
        { name: "شات", priceDelta: 20_000, quantity: 0 },
        { name: "شربت", priceDelta: 10_000, quantity: Number.NaN },
      ]),
    ).toEqual([20_000, 10_000]);
  });
});

describe("linePriceBreakdown — the quantity invariant", () => {
  it("prices base 100,000 + shot 20,000 ×3, for two products, at 320,000", () => {
    // The regression case from issue #910: (100,000 + 3 × 20,000) × 2.
    const modifiers = [{ name: "شات اضافه", priceDelta: 20_000, quantity: 3 }];
    expect(
      linePriceBreakdown({
        unitPrice: 100_000,
        modifierDeltas: modifierDeltasOf(modifiers),
        quantity: 2,
      }),
    ).toEqual({
      base: 100_000,
      addOns: 60_000,
      unit: 160_000,
      total: 320_000,
    });
  });

  it("keeps a quantity-one add-on and a free add-on exact", () => {
    expect(
      linePriceBreakdown({
        unitPrice: 100_000,
        modifierDeltas: modifierDeltasOf([
          { name: "بدون شکر", priceDelta: 0, quantity: 3 },
          { name: "شات", priceDelta: 20_000, quantity: 1 },
        ]),
        quantity: 1,
      }),
    ).toEqual({ base: 100_000, addOns: 20_000, unit: 120_000, total: 120_000 });
  });
});
