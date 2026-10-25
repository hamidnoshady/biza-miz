import { describe, expect, it } from "vitest";
import { APP_KEYS } from "../apps";
import { SERVICE_KINDS } from "./catalog";
import {
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
  WIZARD_VALUE_MAX_LENGTH,
  nextWizardStepKey,
  normalizeWizardProgress,
  validateWizardStep,
  wizardProgress,
  wizardServiceLabel,
  wizardStepsFor,
} from "./wizard";

describe("the per-service setup wizard (issue #1041 §B)", () => {
  it("gives every registered app, workspace capability and agent a wizard", () => {
    // A service a member can activate but cannot configure would leave the
    // activation with nowhere to put its own preflight answers.
    for (const kind of SERVICE_KINDS) {
      const keys = kind === "app" ? [...APP_KEYS] : kind === "workspace" ? ["projects", "documents", "media-library"] : ["watch-keeper"];
      for (const key of keys) {
        const steps = wizardStepsFor(kind, key);
        expect(steps.length, `${kind}:${key}`).toBeGreaterThan(0);
        for (const step of steps) {
          expect(step.fields.length, `${kind}:${key}/${step.key}`).toBeGreaterThan(0);
          // Every step must be answerable, or the wizard can never complete.
          expect(step.fields.some((field) => field.required)).toBe(true);
        }
      }
    }
  });

  it("gives an app key the registry accepts but the wizard has not seen a generic step", () => {
    // The registry is the authority on which app keys exist; a missing
    // hand-written definition must degrade to a usable wizard, not to none.
    expect(wizardStepsFor("app", "not-a-registered-app").length).toBeGreaterThan(0);
  });

  it("validates the fiscal year against the Jalali window, not a Gregorian one", () => {
    const [fiscal] = wizardStepsFor("app", "accounting");
    expect(validateWizardStep(fiscal, { fiscalYear: "1404", moneyUnit: "toman" })).toBeNull();
    expect(validateWizardStep(fiscal, { fiscalYear: "2026", moneyUnit: "toman" })).toEqual({
      field: "fiscalYear",
      code: "invalid_year",
    });
    expect(validateWizardStep(fiscal, { moneyUnit: "toman" })).toEqual({
      field: "fiscalYear",
      code: "required",
    });
    expect(FISCAL_YEAR_MIN).toBeLessThan(FISCAL_YEAR_MAX);
  });

  it("refuses a value outside a select's own options", () => {
    const [fiscal] = wizardStepsFor("app", "accounting");
    expect(validateWizardStep(fiscal, { fiscalYear: "1404", moneyUnit: "dollar" })).toEqual({
      field: "moneyUnit",
      code: "invalid_option",
    });
  });

  it("requires a bare hostname for a website's domain", () => {
    const [address] = wizardStepsFor("app", "website");
    expect(validateWizardStep(address, { domain: "shop.example.ir" })).toBeNull();
    expect(validateWizardStep(address, { domain: "https://shop.example.ir" })?.code).toBe(
      "invalid_domain",
    );
    expect(validateWizardStep(address, { domain: "shop example" })?.code).toBe("invalid_domain");
  });

  it("reports which steps are answered and which comes next", () => {
    const steps = wizardStepsFor("app", "accounting");
    const empty = wizardProgress(steps, {});
    expect(empty.completedSteps).toEqual([]);
    expect(empty.nextStep?.key).toBe(steps[0].key);
    expect(empty.complete).toBe(false);

    const half = wizardProgress(steps, { fiscalYear: "1404", moneyUnit: "toman" });
    expect(half.completedSteps).toEqual([steps[0].key]);
    expect(half.nextStep?.key).toBe(steps[1].key);

    const full = wizardProgress(steps, {
      fiscalYear: "1404",
      moneyUnit: "toman",
      openingMode: "none",
    });
    expect(full.complete).toBe(true);
    expect(full.nextStep).toBeNull();
    expect(nextWizardStepKey(steps, { fiscalYear: "1404", moneyUnit: "toman" })).toBe(
      steps[1].key,
    );
  });

  it("stores only the wizard's own answers, trimmed and bounded", () => {
    const steps = wizardStepsFor("app", "crm");
    const normalized = normalizeWizardProgress(steps, {
      customerSource: "  existing  ",
      firstStage: "x".repeat(500),
      // Free-form answers are dropped: this row is deleted by the retention
      // purge, so it must not become an accidental document store.
      notes: "something the customer typed that nothing reads",
      empty: "   ",
    });
    expect(normalized.customerSource).toBe("existing");
    expect(normalized.firstStage).toHaveLength(WIZARD_VALUE_MAX_LENGTH);
    expect(normalized).not.toHaveProperty("notes");
    expect(normalized).not.toHaveProperty("empty");
  });

  it("labels the wizard with the service's own Persian name", () => {
    expect(wizardServiceLabel("app", "crm")).toBe("ارتباط با مشتری");
    // An agent has no static label; its key is the honest fallback.
    expect(wizardServiceLabel("agent", "watch-keeper")).toBe("watch-keeper");
  });
});
