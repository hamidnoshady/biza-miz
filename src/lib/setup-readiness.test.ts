/**
 * Issue #808 — readiness is derived from persisted domain data, not from the
 * progress markers, and it is a different question from "has the wizard
 * formally finished?".
 *
 * The decision table below is the contract the Finish page and
 * POST /api/setup/complete validate against: a category with no item does not
 * satisfy F&B menu readiness (however the marker reads), non-F&B industries
 * never ask about a menu, and a business whose required data all exists is
 * ready even if a progress write was lost along the way.
 */
import { describe, expect, it } from "vitest";
import { ENABLED_INDUSTRIES } from "./industries";
import { requiredStepsForIndustry } from "./wizard-steps";
import { setupReadiness, wizardStepReconciliation } from "./setup-state";

const PRESENT = {
  hasBusiness: true,
  hasLocation: true,
  hasPrefs: true,
  hasCosting: true,
  hasTax: true,
  accounts: 40,
  sellableMenuItems: 3,
};

describe("setupReadiness", () => {
  it("is ready when every required prerequisite exists (F&B)", () => {
    const readiness = setupReadiness({ industry: "food_service", ...PRESENT });
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
    expect(readiness.steps).toEqual({
      business: true,
      accounts: true,
      costing: true,
      tax: true,
      menu: true,
    });
  });

  it("does not accept a menu with zero sellable items (issue #808 §3)", () => {
    const readiness = setupReadiness({
      industry: "food_service",
      ...PRESENT,
      sellableMenuItems: 0,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.steps.menu).toBe(false);
    expect(readiness.missing.join(" ")).toContain("آیتم فعال");
  });

  it("requires costing for F&B only", () => {
    const fnb = setupReadiness({ industry: "food_service", ...PRESENT, hasCosting: false });
    expect(fnb.ready).toBe(false);
    expect(fnb.steps.costing).toBe(false);

    for (const industry of ["jewelry", "wholesale", "service_saas"] as const) {
      const retail = setupReadiness({ industry, ...PRESENT, hasCosting: false, sellableMenuItems: 0 });
      expect(retail.ready).toBe(true);
      expect(retail.steps).not.toHaveProperty("costing");
      expect(retail.steps).not.toHaveProperty("menu");
    }
  });

  it("treats missing business details broadly", () => {
    for (const patch of [
      { hasBusiness: false },
      { hasLocation: false },
      { hasPrefs: false },
      { accounts: 0 },
      { hasTax: false },
    ]) {
      const readiness = setupReadiness({ industry: "food_service", ...PRESENT, ...patch });
      expect(readiness.ready).toBe(false);
      expect(readiness.missing.length).toBeGreaterThan(0);
    }
  });

  it("has a satisfiable, intentional path for every enabled industry (issue #808 §8)", () => {
    // The industry matrix the audit asked for: not just jewelry. For each
    // enabled industry, the readiness check must demand exactly that industry's
    // declared required steps — no more (a trade goods business is never asked
    // for a menu) and no fewer (F&B is never ready without costing) — and a
    // business that has done those steps must be ready.
    for (const industry of ENABLED_INDUSTRIES) {
      const required = requiredStepsForIndustry(industry);
      const readiness = setupReadiness({
        industry,
        ...PRESENT,
        hasCosting: required.includes("costing"),
        sellableMenuItems: required.includes("menu") ? 1 : 0,
      });
      expect(Object.keys(readiness.steps).sort(), industry).toEqual([...required].sort());
      expect(readiness.ready, industry).toBe(true);
      expect(readiness.missing, industry).toEqual([]);
    }
  });

  it("fails closed for an unknown industry rather than skipping requirements", () => {
    // A row with an industry this build does not know (a downgrade, a hand
    // edit) must not read as "no required steps left"; the unknown industry
    // falls back to the F&B shape in wizardStepsForIndustry and therefore still
    // demands the accounting prerequisites.
    const readiness = setupReadiness({
      industry: "unknown_trade" as never,
      ...PRESENT,
      accounts: 0,
      hasCosting: false,
      hasTax: false,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.missing.length).toBe(3); // accounts, costing, tax
    expect(readiness.steps).toHaveProperty("menu");
  });
});

describe("wizardStepReconciliation", () => {
  it("adds required markers the data supports and clears markers it does not", () => {
    const readiness = setupReadiness({
      industry: "food_service",
      ...PRESENT,
      hasPrefs: false, // business step's data is missing …
      sellableMenuItems: 0, // … and so is the menu's
    });
    const diff = wizardStepReconciliation(
      // … yet the old flow had marked both, and never marked costing/tax.
      {
        business: "2026-01-01T00:00:00.000Z",
        menu: "2026-01-01T00:00:00.000Z",
        accounts: "2026-01-01T00:00:00.000Z",
      },
      readiness,
    );
    expect(diff.done.sort()).toEqual(["costing", "tax"]);
    expect(diff.undone.sort()).toEqual(["business", "menu"]);
  });

  it("never touches optional steps", () => {
    const readiness = setupReadiness({ industry: "jewelry", ...PRESENT });
    const diff = wizardStepReconciliation(
      { users: "2026-01-01T00:00:00.000Z", hardware: "2026-01-01T00:00:00.000Z" },
      readiness,
    );
    // Required markers are filled from the data; the optional markers present
    // in the map are neither removed nor re-stamped.
    expect(diff.undone).toEqual([]);
    expect(diff.done).toEqual(["business", "accounts", "tax"]);
    for (const optional of ["users", "hardware", "backup", "opening"]) {
      expect(diff.done).not.toContain(optional);
      expect(diff.undone).not.toContain(optional);
    }
  });

  it("is a no-op when markers already agree with the data", () => {
    const readiness = setupReadiness({ industry: "food_service", ...PRESENT });
    const steps = Object.fromEntries(Object.keys(readiness.steps).map((s) => [s, "2026-01-01T00:00:00.000Z"]));
    expect(wizardStepReconciliation(steps, readiness)).toEqual({ done: [], undone: [] });
  });
});
