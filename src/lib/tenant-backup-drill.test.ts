import { describe, expect, it } from "vitest";
import { DRILL_STEPS, drillPlan, drillVerdict, type DrillStepResult } from "./tenant-backup-drill";

describe("drillPlan", () => {
  it("covers every step exactly once, in dependency order", () => {
    const plan = drillPlan();
    expect(plan.map((entry) => entry.step)).toEqual([...DRILL_STEPS]);
    expect(plan[0].requires).toBeNull();
    for (const entry of plan.slice(1)) {
      expect(DRILL_STEPS.indexOf(entry.step)).toBeGreaterThan(DRILL_STEPS.indexOf(entry.requires!));
    }
  });
});

describe("drillVerdict", () => {
  const ok = (step: DrillStepResult["step"]): DrillStepResult => ({ step, status: "ok", detail: "" });

  it("passes only when every step proved something", () => {
    expect(drillVerdict(DRILL_STEPS.map(ok))).toEqual({ ok: true, missing: [] });
  });

  it("names the steps a drill did not prove", () => {
    const partial = DRILL_STEPS.filter((step) => step !== "portable_envelope").map(ok);
    expect(drillVerdict(partial)).toEqual({ ok: false, missing: ["portable_envelope"] });
  });

  it("treats a skipped step as unproven, never as success", () => {
    const results: DrillStepResult[] = [
      ...DRILL_STEPS.filter((step) => step !== "portable_envelope").map(ok),
      { step: "portable_envelope", status: "skipped", detail: "no passphrase" },
    ];
    expect(drillVerdict(results).ok).toBe(false);
  });

  it("fails on a single failed step", () => {
    const results: DrillStepResult[] = [
      ...DRILL_STEPS.filter((step) => step !== "archive_parsed").map(ok),
      { step: "archive_parsed", status: "failed", detail: "archive_not_json" },
    ];
    expect(drillVerdict(results).missing).toEqual(["archive_parsed"]);
  });
});
