import { describe, expect, it } from "vitest";
import { OPTIONAL_STEPS, WIZARD_STEPS, wizardStepsForIndustry } from "./wizard-steps";
import { INDUSTRIES } from "./industries";

/**
 * Issue #799 Wave 2 added a step (`aec_profile`) that only one industry walks,
 * the mirror image of the two F&B-only steps (`costing`, `menu`) that have
 * existed since Phase 2. These tests are the contract for both directions.
 */
describe("wizardStepsForIndustry", () => {
  it("walks every step for the AEC industry", () => {
    expect(wizardStepsForIndustry("architecture_construction")).toEqual([...WIZARD_STEPS]);
  });

  it("walks every F&B step except the AEC-only one for food_service", () => {
    expect(wizardStepsForIndustry("food_service")).toEqual(
      WIZARD_STEPS.filter((step) => step !== "aec_profile"),
    );
  });

  it("skips costing, menu and the AEC profile for jewelry -- none of them exist in its data model", () => {
    const steps = wizardStepsForIndustry("jewelry");
    expect(steps).not.toContain("costing");
    expect(steps).not.toContain("menu");
    expect(steps).not.toContain("aec_profile");
    expect(steps).toEqual([
      "business",
      "accounts",
      "tax",
      "users",
      "hardware",
      "backup",
      "opening",
    ]);
  });

  it("keeps every other step, in the same relative order, for jewelry", () => {
    const steps = wizardStepsForIndustry("jewelry");
    const expected = WIZARD_STEPS.filter(
      (step) => step !== "costing" && step !== "menu" && step !== "aec_profile",
    );
    expect(steps).toEqual(expected);
  });

  it("asks the AEC industry for its operating profile right after the business step", () => {
    const steps = wizardStepsForIndustry("architecture_construction");
    expect(steps.indexOf("aec_profile")).toBe(steps.indexOf("business") + 1);
  });

  it("gives every enabled/reserved industry a non-empty, in-order subsequence of WIZARD_STEPS", () => {
    for (const industry of INDUSTRIES) {
      const steps = wizardStepsForIndustry(industry);
      expect(steps.length).toBeGreaterThan(0);
      const indices = steps.map((s) => WIZARD_STEPS.indexOf(s));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it("keeps every optional step that applies to the industry, and only where it applies", () => {
    for (const industry of INDUSTRIES) {
      const steps = new Set(wizardStepsForIndustry(industry));
      for (const optional of OPTIONAL_STEPS) {
        if (optional === "aec_profile" && industry !== "architecture_construction") {
          expect(steps.has(optional), `${industry} should not be asked for an AEC profile`).toBe(false);
          continue;
        }
        expect(steps.has(optional), `${industry} is missing the optional step ${optional}`).toBe(true);
      }
    }
  });
});
