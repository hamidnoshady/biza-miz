import { describe, expect, it } from "vitest";
import { assessSyncHealth, compareDigests, isDayDigest, type SyncHealthInput } from "./sync-health";

const NOW = new Date("2026-09-28T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const healthy: SyncHealthInput = {
  enabled: true,
  unsent: 0,
  oldestUnsentAt: null,
  refused: 0,
  deferred: 0,
  openDeadLetters: 0,
  masterConflicts: 0,
  driftDays: 0,
  lastPushSuccessAt: minutesAgo(1),
  lastPullSuccessAt: minutesAgo(1),
  lastError: null,
};

describe("assessSyncHealth", () => {
  it("is ok when nothing waits and the sides agree", () => {
    expect(assessSyncHealth(healthy, NOW)).toEqual({ level: "ok", issues: [] });
  });

  it("warns about a growing backlog and errors on a stale one", () => {
    expect(assessSyncHealth({ ...healthy, unsent: 3, oldestUnsentAt: minutesAgo(10) }, NOW).level).toBe("warning");
    expect(assessSyncHealth({ ...healthy, unsent: 3, oldestUnsentAt: minutesAgo(45) }, NOW)).toMatchObject({
      level: "error",
      issues: [{ code: "backlog_stale", level: "error" }],
    });
  });

  it("treats drift and dead letters as errors, conflicts as warnings", () => {
    expect(assessSyncHealth({ ...healthy, driftDays: 1 }, NOW).level).toBe("error");
    expect(assessSyncHealth({ ...healthy, openDeadLetters: 2 }, NOW).level).toBe("error");
    expect(assessSyncHealth({ ...healthy, masterConflicts: 1 }, NOW).level).toBe("warning");
  });

  it("flags a server that has not been reached while changes wait", () => {
    const result = assessSyncHealth(
      { ...healthy, unsent: 1, oldestUnsentAt: minutesAgo(1), lastPushSuccessAt: minutesAgo(90), lastPullSuccessAt: null },
      NOW,
    );
    expect(result.issues.map((issue) => issue.code)).toContain("no_recent_contact");
  });
});

describe("compareDigests", () => {
  const day = (d: string, orders: number, sales: string, payments = sales) => ({
    day: d,
    completedOrders: orders,
    salesTotal: sales,
    paymentsTotal: payments,
  });

  it("reports only the days whose figures differ", () => {
    const drift = compareDigests(
      ["2026-09-26", "2026-09-27"],
      [day("2026-09-26", 4, "1000000"), day("2026-09-27", 2, "500000")],
      [day("2026-09-26", 4, "1000000"), day("2026-09-27", 1, "250000")],
    );
    expect(drift.map((entry) => entry.day)).toEqual(["2026-09-27"]);
  });

  it("counts a day missing on one side as zero there", () => {
    expect(compareDigests(["2026-09-27"], [day("2026-09-27", 1, "5")], [])).toHaveLength(1);
    expect(compareDigests(["2026-09-27"], [], [])).toEqual([]);
  });

  it("validates a posted digest", () => {
    expect(isDayDigest(day("2026-09-27", 1, "5"))).toBe(true);
    expect(isDayDigest({ ...day("2026-09-27", 1, "5"), salesTotal: 5 })).toBe(false);
    expect(isDayDigest({ ...day("27/09", 1, "5") })).toBe(false);
  });
});
