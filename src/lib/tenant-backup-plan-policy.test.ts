/**
 * Issue #903 §3 — per-plan schedules, alert thresholds and DR objectives.
 *
 * The cases that matter are not "a number is read back". They are the two rules
 * the whole layer rests on: **NULL inherits** (a plan that never decided anything
 * must not pin a business to yesterday's default), and **a plan may only
 * tighten** (a sales tier must not be able to buy weaker protection). Every
 * clamp the resolver applies is asserted from both sides, because a clamp that
 * only works in the friendly direction is the bug this file exists to catch.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_PLAN_POLICY,
  SAFE_BACKUP_THRESHOLDS,
  drillDue,
  layerPlanPolicy,
  layerPlanThresholds,
  validatePlanPolicyBody,
  type BackupPlanPolicyValues,
  type FleetPolicyNumbers,
} from "./tenant-backup-plan-policy";

const fleet: FleetPolicyNumbers = {
  intervalHours: 24,
  retentionDays: 30,
  maxRetentionDays: 365,
  keepCount: 30,
  protectedCopies: 1,
  maxArtifactBytes: 5_368_709_120,
  alertStaleHours: 30,
  alertFailureStreak: 1,
  drillIntervalHours: 24,
  drRpoHours: null,
};

function plan(patch: Partial<BackupPlanPolicyValues>): BackupPlanPolicyValues {
  return { ...EMPTY_PLAN_POLICY, ...patch };
}

describe("layerPlanPolicy — the schedule, retention and capacity half", () => {
  it("inherits everything from the fleet when the plan said nothing", () => {
    expect(layerPlanPolicy(fleet, null)).toEqual({
      intervalHours: 24,
      retentionDays: 30,
      keepCount: 30,
      protectedCopies: 1,
      maxArtifactBytes: 5_368_709_120,
    });
    // An all-NULL row is the same answer as no row: "nobody has decided" is not
    // a decision, and it must not become a zero.
    expect(layerPlanPolicy(fleet, EMPTY_PLAN_POLICY)).toEqual(layerPlanPolicy(fleet, null));
  });

  it("lets a plan back up more often, and silently keeps the fleet cadence if it asks for less", () => {
    // Tighter: six-hourly protection, as the epic's example tier.
    expect(layerPlanPolicy(fleet, plan({ intervalHours: 6 })).intervalHours).toBe(6);
    // Looser: a plan cannot slow the fleet's cadence down.
    expect(layerPlanPolicy(fleet, plan({ intervalHours: 24 })).intervalHours).toBe(24);
    // Not a cadence the scheduler can express: ignored rather than obeyed.
    expect(layerPlanPolicy(fleet, plan({ intervalHours: 7 as unknown as number })).intervalHours).toBe(24);
  });

  it("clamps retention to the fleet ceiling, never past it", () => {
    expect(layerPlanPolicy(fleet, plan({ retentionDays: 90 })).retentionDays).toBe(90);
    expect(layerPlanPolicy(fleet, plan({ retentionDays: 3650 })).retentionDays).toBe(365);
    expect(layerPlanPolicy(fleet, plan({ retentionDays: 0 })).retentionDays).toBe(1);
  });

  it("clamps the keep count and the artifact ceiling downwards", () => {
    expect(layerPlanPolicy(fleet, plan({ keepCount: 10 })).keepCount).toBe(10);
    expect(layerPlanPolicy(fleet, plan({ keepCount: 500 })).keepCount).toBe(30);
    expect(layerPlanPolicy(fleet, plan({ maxArtifactBytes: 1024 })).maxArtifactBytes).toBe(1024);
    expect(layerPlanPolicy(fleet, plan({ maxArtifactBytes: 1e15 })).maxArtifactBytes).toBe(5_368_709_120);
  });

  it("treats protected copies as a floor a plan may raise but never lower", () => {
    // The direction differs from every other number on purpose: keeping *more*
    // restorable copies is the safer state.
    expect(layerPlanPolicy(fleet, plan({ protectedCopies: 3 })).protectedCopies).toBe(3);
    expect(layerPlanPolicy(fleet, plan({ protectedCopies: 0 })).protectedCopies).toBe(1);
  });
});

describe("layerPlanThresholds — alerts and the recovery-point objective", () => {
  it("falls back to the cadence's own window when neither layer set one", () => {
    const thresholds = layerPlanThresholds({ ...fleet, alertStaleHours: null }, null, 24);
    // 24h + 6h grace, the pre-#903 rule `backup.ts` has always applied.
    expect(thresholds.staleAfterHours).toBe(30);
    expect(thresholds.source).toBe("managed");
  });

  it("never lets the window fall below the cadence, so a healthy backup is not called stale", () => {
    const thresholds = layerPlanThresholds(fleet, plan({ alertStaleHours: 1 }), 24);
    expect(thresholds.staleAfterHours).toBe(30);
  });

  it("lets a plan alert sooner, and never later than the fleet's window", () => {
    // A plan that backs up every 6 hours gets a floor of 7.5h and may ask for it.
    expect(layerPlanThresholds(fleet, plan({ alertStaleHours: 8 }), 6).staleAfterHours).toBe(8);
    // Asking for a *longer* window than the fleet's is clamped back to the fleet.
    expect(layerPlanThresholds(fleet, plan({ alertStaleHours: 200 }), 6).staleAfterHours).toBe(30);
  });

  it("keeps the failure streak at or below the fleet's — stricter, never more patient", () => {
    expect(layerPlanThresholds({ ...fleet, alertFailureStreak: 3 }, null, 24).failureStreak).toBe(3);
    expect(layerPlanThresholds({ ...fleet, alertFailureStreak: 3 }, plan({ alertFailureStreak: 1 }), 24).failureStreak).toBe(1);
    // A plan cannot ask for more tolerance than the fleet allows.
    expect(layerPlanThresholds({ ...fleet, alertFailureStreak: 2 }, plan({ alertFailureStreak: 9 }), 24).failureStreak).toBe(2);
    // Zero is not a streak: one failure is always enough to be evidence.
    expect(layerPlanThresholds({ ...fleet, alertFailureStreak: 0 }, null, 24).failureStreak).toBe(1);
  });

  it("lets a plan drill more often, and clamps a lazier cadence to the fleet's", () => {
    expect(layerPlanThresholds(fleet, plan({ drillIntervalHours: 6 }), 24).drillIntervalHours).toBe(6);
    expect(layerPlanThresholds(fleet, plan({ drillIntervalHours: 168 }), 24).drillIntervalHours).toBe(24);
    expect(layerPlanThresholds({ ...fleet, drillIntervalHours: 48 }, plan({ drillIntervalHours: 24 }), 24).drillIntervalHours).toBe(24);
  });

  it("promises the shorter recovery point of the two layers, and inherits an unset one", () => {
    // Fleet promises nothing: a plan may promise something, and that is the one
    // in force.
    expect(layerPlanThresholds(fleet, plan({ drRpoHours: 12 }), 24).rpoHours).toBe(12);
    expect(layerPlanThresholds(fleet, null, 24).rpoHours).toBeNull();
    // Fleet promises 24h: a plan may tighten to 6h, never loosen to 72h.
    const promising = { ...fleet, drRpoHours: 24 };
    expect(layerPlanThresholds(promising, plan({ drRpoHours: 6 }), 24).rpoHours).toBe(6);
    expect(layerPlanThresholds(promising, plan({ drRpoHours: 72 }), 24).rpoHours).toBe(24);
    expect(layerPlanThresholds(promising, null, 24).rpoHours).toBe(24);
  });
});

describe("drillDue", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");

  it("drills a business that has never been drilled", () => {
    expect(drillDue(now, null, 24)).toBe(true);
  });

  it("respects the cadence it is given, in hours", () => {
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);
    expect(drillDue(now, twoHoursAgo, 1)).toBe(true);
    expect(drillDue(now, twoHoursAgo, 6)).toBe(false);
    const thirtyHoursAgo = new Date(now.getTime() - 30 * 3_600_000);
    expect(drillDue(now, thirtyHoursAgo, 24)).toBe(true);
    expect(drillDue(now, thirtyHoursAgo, 48)).toBe(false);
  });

  it("treats a zero or negative cadence as the floor, not as 'always'", () => {
    const justNow = new Date(now.getTime() - 60_000);
    expect(drillDue(now, justNow, 0)).toBe(false);
  });
});

describe("validatePlanPolicyBody", () => {
  it("passes nulls through as 'inherit' and rejects a value the scheduler cannot use", () => {
    expect(validatePlanPolicyBody({ intervalHours: null })).toEqual({
      ok: true,
      value: expect.objectContaining({ intervalHours: null }),
    });
    expect(validatePlanPolicyBody({ intervalHours: 7 })).toEqual({ ok: false, error: "invalid_intervalHours" });
    expect(validatePlanPolicyBody({ intervalHours: 6 })).toEqual({
      ok: true,
      value: expect.objectContaining({ intervalHours: 6 }),
    });
  });

  it("bounds every threshold to the range the migration accepts", () => {
    expect(validatePlanPolicyBody({ alertStaleHours: 0 })).toEqual({ ok: false, error: "invalid_alertStaleHours" });
    expect(validatePlanPolicyBody({ alertStaleHours: 8761 })).toEqual({ ok: false, error: "invalid_alertStaleHours" });
    expect(validatePlanPolicyBody({ alertFailureStreak: 11 })).toEqual({
      ok: false,
      error: "invalid_alertFailureStreak",
    });
    expect(validatePlanPolicyBody({ drillIntervalHours: 169 })).toEqual({
      ok: false,
      error: "invalid_drillIntervalHours",
    });
    expect(validatePlanPolicyBody({ drRpoHours: 721 })).toEqual({ ok: false, error: "invalid_drRpoHours" });
    // A fractional number is refused rather than silently truncated: the console
    // asked for something the schema cannot hold.
    expect(validatePlanPolicyBody({ retentionDays: 2.5 })).toEqual({ ok: false, error: "invalid_retentionDays" });
  });

  it("refuses a field it does not own, so a typo cannot be silently dropped", () => {
    expect(validatePlanPolicyBody({ intervalHours: 6, retentionDay: 30 })).toEqual({
      ok: false,
      error: "unknown_field",
    });
    expect(validatePlanPolicyBody("nope")).toEqual({ ok: false, error: "bad_request" });
  });

  it("carries the audit note but not an endless one", () => {
    expect(validatePlanPolicyBody({ note: "۹۰ روز نگهداری طبق قرارداد" })).toEqual({
      ok: true,
      value: { note: "۹۰ روز نگهداری طبق قرارداد" },
    });
    expect(validatePlanPolicyBody({ note: "x".repeat(501) })).toEqual({ ok: false, error: "invalid_note" });
  });
});

describe("SAFE_BACKUP_THRESHOLDS", () => {
  it("is exactly the pre-#903 behaviour, so an unreadable policy changes nothing", () => {
    expect(SAFE_BACKUP_THRESHOLDS.staleAfterHours).toBe(30);
    expect(SAFE_BACKUP_THRESHOLDS.failureStreak).toBe(1);
    expect(SAFE_BACKUP_THRESHOLDS.drillIntervalHours).toBe(24);
    expect(SAFE_BACKUP_THRESHOLDS.rpoHours).toBeNull();
    expect(SAFE_BACKUP_THRESHOLDS.source).toBe("default");
  });
});
