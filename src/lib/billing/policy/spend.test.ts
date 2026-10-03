import { describe, expect, it } from "vitest";
import { evaluateSpend } from "./spend";

describe("evaluateSpend", () => {
  it("does not block when there is no budget", () => {
    const result = evaluateSpend({
      spentRial: 1_000_000,
      budgetRial: null,
      thresholds: [50, 100],
      action: "block_noncritical",
      critical: false,
    });
    expect(result.blocked).toBe(false);
    expect(result.warned).toBe(false);
  });

  it("blocks non-critical usage at the limit and leaves critical usage available", () => {
    const shared = {
      spentRial: 100,
      budgetRial: 100,
      thresholds: [50, 75, 90, 100],
      action: "block_noncritical" as const,
    };
    const nonCritical = evaluateSpend({ ...shared, critical: false });
    expect(nonCritical.blocked).toBe(true);
    expect(nonCritical.throttled).toBe(false);
    expect(nonCritical.warned).toBe(true);
    expect(nonCritical.crossedThresholds).toEqual([50, 75, 90, 100]);

    const critical = evaluateSpend({ ...shared, critical: true });
    expect(critical.blocked).toBe(false);
    expect(critical.throttled).toBe(false);
  });

  it("throttles non-critical usage at the limit when action is throttle_noncritical and leaves critical usage available", () => {
    const shared = {
      spentRial: 120,
      budgetRial: 100,
      thresholds: [50, 80, 100],
      action: "throttle_noncritical" as const,
    };
    const nonCritical = evaluateSpend({ ...shared, critical: false });
    expect(nonCritical.blocked).toBe(false);
    expect(nonCritical.throttled).toBe(true);
    expect(nonCritical.warned).toBe(true);

    const critical = evaluateSpend({ ...shared, critical: true });
    expect(critical.blocked).toBe(false);
    expect(critical.throttled).toBe(false);
  });

  it("warn-only emits warnings on crossed thresholds and never blocks or throttles", () => {
    const res = evaluateSpend({
      spentRial: 80,
      budgetRial: 100,
      thresholds: [50, 75, 90, 100],
      action: "warn_only",
      critical: false,
    });
    expect(res.blocked).toBe(false);
    expect(res.throttled).toBe(false);
    expect(res.warned).toBe(true);
    expect(res.crossedThresholds).toEqual([50, 75]);
  });

  it("continue action never warns, blocks, or throttles", () => {
    const res = evaluateSpend({
      spentRial: 200,
      budgetRial: 100,
      thresholds: [50, 100],
      action: "continue",
      critical: false,
    });
    expect(res.blocked).toBe(false);
    expect(res.throttled).toBe(false);
    expect(res.warned).toBe(false);
  });
});
