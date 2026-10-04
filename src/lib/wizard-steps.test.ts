/**
 * Issue #808 §8 — the industry setup matrix.
 *
 * The old rule was "F&B gets everything, every other industry loses costing and
 * menu", which left the multi-industry question answered by a filter rather
 * than by a decision. This pins the decision per enabled industry: every
 * industry has an explicit shape, required steps are exactly the non-optional
 * ones, the catalogue pointer exists exactly where a trade has a catalogue
 * door, and adding an industry without a shape is a compile error (the Record
 * in wizard-steps.ts) rather than a silent inheritance of F&B's path.
 */
import { describe, expect, it } from "vitest";
import { ENABLED_INDUSTRIES, INDUSTRIES } from "./industries";
import {
  OPTIONAL_STEPS,
  WIZARD_STEPS,
  catalogueHrefFor,
  requiredStepsForIndustry,
  setupShapeForIndustry,
  wizardStepsForIndustry,
} from "./wizard-steps";

/** The canonical F&B ordering the wizard is specified against. */
const FNB_ORDER = [
  "business",
  "accounts",
  "costing",
  "tax",
  "users",
  "menu",
  "hardware",
  "backup",
  "opening",
];

describe("wizardStepsForIndustry", () => {
  it("is defined for every industry this build can create", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      expect(wizardStepsForIndustry(industry).length).toBeGreaterThan(0);
      expect(setupShapeForIndustry(industry)).toBeTruthy();
    }
    // The matrix covers the whole enum, not just the enabled subset.
    for (const industry of INDUSTRIES) {
      expect(wizardStepsForIndustry(industry)).toEqual(
        expect.arrayContaining(["business", "accounts", "tax"]),
      );
    }
  });

  it("walks F&B through every step in the documented order", () => {
    expect(wizardStepsForIndustry("food_service")).toEqual(FNB_ORDER);
    expect(wizardStepsForIndustry("food_service")).toEqual([...WIZARD_STEPS]);
  });

  it("gives every industry a non-empty, in-order subsequence of WIZARD_STEPS", () => {
    for (const industry of INDUSTRIES) {
      const steps = wizardStepsForIndustry(industry);
      expect(steps.length).toBeGreaterThan(0);
      const indices = steps.map((s) => WIZARD_STEPS.indexOf(s));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it("never drops an optional step from any industry's path", () => {
    for (const industry of INDUSTRIES) {
      const steps = new Set(wizardStepsForIndustry(industry));
      for (const optional of OPTIONAL_STEPS) {
        expect(steps.has(optional)).toBe(true);
      }
    }
  });

  it("keeps Hardware, local Backup, Opening and Finish reachable for every industry", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      const steps = wizardStepsForIndustry(industry);
      expect(steps).toContain("hardware");
      expect(steps).toContain("backup");
      expect(steps).toContain("opening");
      // The four steps that used to be reachable in theory but never in
      // practice, because the wizard ejected a business as soon as the
      // required set was satisfied (issue #808 §1).
      expect(steps.indexOf("opening")).toBe(steps.length - 1);
    }
  });

  it("gives trade-goods retail a stock-shaped path without F&B-only steps", () => {
    for (const industry of ["jewelry", "watch", "accessories", "cosmetics", "wholesale", "tools_fittings", "haberdashery"] as const) {
      expect(setupShapeForIndustry(industry)).toBe("retail");
      expect(wizardStepsForIndustry(industry)).not.toContain("costing");
      expect(wizardStepsForIndustry(industry)).not.toContain("menu");
    }
    expect(wizardStepsForIndustry("jewelry")).toEqual(
      FNB_ORDER.filter((s) => s !== "costing" && s !== "menu"),
    );
  });

  it("keeps a service company at the accounting/admin skeleton", () => {
    expect(setupShapeForIndustry("service_saas")).toBe("service");
    expect(wizardStepsForIndustry("service_saas")).toEqual(
      FNB_ORDER.filter((s) => s !== "costing" && s !== "menu"),
    );
  });

  it("derives required steps as everything that is not optional", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      const steps = wizardStepsForIndustry(industry);
      const required = requiredStepsForIndustry(industry);
      expect(required).toEqual(steps.filter((s) => !OPTIONAL_STEPS.includes(s)));
      for (const optional of OPTIONAL_STEPS) expect(required).not.toContain(optional);
    }
    expect(requiredStepsForIndustry("food_service")).toEqual([
      "business",
      "accounts",
      "costing",
      "tax",
      "menu",
    ]);
    expect(requiredStepsForIndustry("jewelry")).toEqual(["business", "accounts", "tax"]);
  });

  it("points every trade with a catalogue door at it, and none at a door that does not exist", () => {
    expect(catalogueHrefFor("jewelry")).toBe("/accounting/jewelry");
    expect(catalogueHrefFor("watch")).toBe("/accounting/watch");
    for (const industry of ["accessories", "cosmetics", "wholesale", "tools_fittings", "haberdashery"] as const) {
      expect(catalogueHrefFor(industry)).toBe("/accounting/products");
    }
    // F&B's catalogue *is* a wizard step; service companies invoice services
    // from Billing, so neither gets a pointer card.
    expect(catalogueHrefFor("food_service")).toBeNull();
    expect(catalogueHrefFor("service_saas")).toBeNull();
  });
});

describe("WIZARD_STEPS", () => {
  it("stays in one canonical order with no duplicates", () => {
    expect(WIZARD_STEPS).toEqual(FNB_ORDER);
    expect(new Set(WIZARD_STEPS).size).toBe(WIZARD_STEPS.length);
  });
});
