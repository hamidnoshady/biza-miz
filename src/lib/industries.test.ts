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

  it("adds no trade-specific caution between two unrelated trades", () => {
    expect(industrySwitchCautions("jewelry", "cosmetics")).toEqual([]);
    expect(industrySwitchCautions("food_service", "watch")).toEqual([]);
  });
});
