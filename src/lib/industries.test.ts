import { describe, expect, it } from "vitest";
import { INDUSTRIES, industrySwitchCautions, isIndustry } from "./industries";

describe("isIndustry", () => {
  it("returns true for all defined valid industries", () => {
    INDUSTRIES.forEach((industry) => {
      expect(isIndustry(industry)).toBe(true);
    });
  });

  it("returns false for invalid industry strings", () => {
    const invalidInputs = [
      "",
      "food-service", // hyphen instead of underscore
      "FOOD_SERVICE", // uppercase
      "unknown_industry",
      "café",
    ];

    invalidInputs.forEach((invalidInput) => {
      expect(isIndustry(invalidInput)).toBe(false);
    });
  });

  it("handles empty and unrelated inputs safely", () => {
    // Technically typing of isIndustry expects a string, but if called from JS or any without strict checking
    expect(isIndustry("")).toBe(false);
    expect(isIndustry("    ")).toBe(false);
  });
});

describe("industrySwitchCautions", () => {
  it("says nothing when the trade does not change", () => {
    expect(industrySwitchCautions("jewelry", "jewelry")).toEqual([]);
    expect(industrySwitchCautions(null, "automotive")).toEqual([]);
    expect(industrySwitchCautions("automotive", "not_a_trade")).toEqual([]);
  });

  it("tells an operator that another trade's stock is not a car", () => {
    const toAutomotive = industrySwitchCautions("jewelry", "automotive");
    expect(toAutomotive.length).toBeGreaterThan(0);
    expect(toAutomotive.join(" ")).toContain("خودرو");
    expect(toAutomotive.join(" ")).not.toContain("سفارش");
    // …and the same switch from F&B, whose stock is a menu rather than a
    // weighed piece, is still warned about the vehicles it does not have.
    expect(industrySwitchCautions("food_service", "automotive").length).toBeGreaterThan(0);
  });

  it("warns before a dealership's inventory leaves the dashboard", () => {
    for (const to of ["watch", "jewelry", "food_service", "service_saas"] as const) {
      const cautions = industrySwitchCautions("automotive", to);
      expect(cautions.length, to).toBeGreaterThan(0);
      expect(cautions.join(" "), to).toContain("خودرو");
    }
  });

  it("warns before a catalogue trade loses its counter (issue #1128)", () => {
    // The console's row counts say how much data the old trade owns; only this
    // caution says that the new trade cannot sell any of it. It is a family
    // rule, so it fires for the agency exactly as it does for AEC and for a
    // service company — whichever way the operator is turning the dial.
    for (const from of ["jewelry", "automotive", "food_service"] as const) {
      for (const to of ["advertising_agency", "architecture_construction", "service_saas"] as const) {
        const cautions = industrySwitchCautions(from, to);
        expect(cautions.length, `${from} → ${to}`).toBeGreaterThan(0);
        expect(cautions.join(" "), `${from} → ${to}`).toContain("صندوق فروش");
      }
    }
    // The reverse is not a caution: an agency that becomes a shop gains a
    // counter and keeps its own records, which is what the generic data
    // message already covers.
    expect(industrySwitchCautions("advertising_agency", "jewelry")).toEqual([]);
    expect(industrySwitchCautions("service_saas", "food_service")).toEqual([]);
  });

  it("adds no trade-specific caution between two unrelated trades", () => {
    expect(industrySwitchCautions("jewelry", "cosmetics")).toEqual([]);
    expect(industrySwitchCautions("food_service", "watch")).toEqual([]);
  });
});
