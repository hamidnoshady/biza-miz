/**
 * Issue #903 §12 — the scheduled drill.
 *
 * The point of these cases is not that a function exists; it is that a *claim*
 * ("your backup is restorable") now has a scheduled test behind it, once a day,
 * with the result written down and the Owner told when it fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  scope: vi.fn(),
  lock: vi.fn(),
  drill: vi.fn(),
  notify: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.scope,
}));
vi.mock("./db-locks", () => ({
  withDistributedLock: mocks.lock,
  LOCK_KEYS: { tenantDrill: (businessId: string) => `backup:drill:${businessId}` },
}));
vi.mock("./tenant-backup-drill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tenant-backup-drill")>();
  return { ...actual, runDrill: mocks.drill };
});
vi.mock("./notification-events", () => ({ recordNotification: mocks.notify }));
vi.mock("./deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("./deployment-role", () => ({ deploymentRole: () => "central" }));

import {
  DRILL_INTERVAL_MS,
  SCHEDULED_DRILL_REQUIRED_STEPS,
  lastDrillSummary,
  recordDrillRun,
  runScheduledBackupDrills,
} from "./tenant-backup-drills-job";
import type { DrillReport } from "./tenant-backup-drill";

const now = new Date("2026-10-30T12:00:00.000Z");

function report(patch: Partial<DrillReport> = {}): DrillReport {
  return {
    businessId: "business-a",
    ref: "ref-1",
    startedAt: "2026-10-30T12:00:00.000Z",
    finishedAt: "2026-10-30T12:00:05.000Z",
    ok: true,
    missing: ["portable_envelope"],
    steps: [{ step: "artifact_selected", status: "ok", detail: "" }],
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockImplementation(async (_tag: string, fn: () => Promise<unknown>) => fn());
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.notify.mockResolvedValue(true);
  mocks.drill.mockResolvedValue(report());
  mocks.lock.mockImplementation(async (_key: string, run: () => Promise<unknown>) => ({
    ok: true,
    value: await run(),
  }));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT DISTINCT business_id")) {
      return { rows: [{ business_id: "business-a" }, { business_id: "business-b" }], rowCount: 2 };
    }
    if (sql.includes("FROM tenant_backup_drills")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
});

describe("runScheduledBackupDrills", () => {
  it("drills every business that has a restorable artifact", async () => {
    const outcome = await runScheduledBackupDrills(now);
    expect(outcome).toMatchObject({ candidates: 2, drilled: 2, passed: 2, failed: 0, skipped: 0 });
    expect(mocks.drill).toHaveBeenCalledTimes(2);
    expect(mocks.drill).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-a",
        // The platform holds no tenant passphrase, so the envelope is not even
        // attempted — and it is not required, so a routine skip is not a failure.
        recoveryPassphrase: null,
        requiredSteps: SCHEDULED_DRILL_REQUIRED_STEPS,
      }),
    );
  });

  it("does not require the portable envelope, which needs a passphrase it must not hold", () => {
    expect(SCHEDULED_DRILL_REQUIRED_STEPS).not.toContain("portable_envelope");
    expect(SCHEDULED_DRILL_REQUIRED_STEPS).toContain("restore_preview");
  });

  it("skips a business already drilled inside the window", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT business_id")) {
        return { rows: [{ business_id: "business-a" }], rowCount: 1 };
      }
      if (sql.includes("FROM tenant_backup_drills")) {
        return {
          rows: [{ finished_at: new Date(now.getTime() - DRILL_INTERVAL_MS / 2), ok: true }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const outcome = await runScheduledBackupDrills(now);
    expect(outcome).toMatchObject({ candidates: 1, drilled: 0, skipped: 1 });
    expect(mocks.drill).not.toHaveBeenCalled();
  });

  it("drills again once the window has passed", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT business_id")) {
        return { rows: [{ business_id: "business-a" }], rowCount: 1 };
      }
      if (sql.includes("FROM tenant_backup_drills")) {
        return {
          rows: [{ finished_at: new Date(now.getTime() - DRILL_INTERVAL_MS - 1000), ok: true }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const outcome = await runScheduledBackupDrills(now);
    expect(outcome.drilled).toBe(1);
    expect(outcome.skipped).toBe(0);
  });

  /**
   * Issue #903 §3 — the plan's `drill_interval_hours`. A tier may buy *more*
   * frequent proof; the schedule is per business, and a plan cannot make the
   * proof rarer than the fleet allows (the resolver clamps before it gets here).
   */
  it("honours a plan's shorter drill cadence", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT business_id")) {
        return { rows: [{ business_id: "business-a" }], rowCount: 1 };
      }
      if (sql.includes("FROM tenant_backup_drills")) {
        // Two hours ago: inside the default day, outside a two-hour tier.
        return {
          rows: [{ finished_at: new Date(now.getTime() - 2 * 3_600_000), ok: true }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM platform_tenant_backup_service")) {
        return {
          rows: [{ plan_key: "pro", fleet_drill: 24, plan_drill: 2, fleet_streak: 1, fleet_stale: null, fleet_rpo: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const outcome = await runScheduledBackupDrills(now);
    expect(outcome.drilled).toBe(1);
    expect(outcome.skipped).toBe(0);
  });

  it("keeps the daily cadence when the policy row cannot be read", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT business_id")) {
        return { rows: [{ business_id: "business-a" }], rowCount: 1 };
      }
      if (sql.includes("FROM tenant_backup_drills")) {
        return { rows: [{ finished_at: new Date(now.getTime() - 3_600_000), ok: true }], rowCount: 1 };
      }
      if (sql.includes("FROM platform_tenant_backup_service")) {
        throw new Error("relation does not exist");
      }
      return { rows: [], rowCount: 1 };
    });

    const outcome = await runScheduledBackupDrills(now);
    expect(outcome).toMatchObject({ drilled: 0, skipped: 1 });
  });

  it("notifies the Owner when a backup that exists does not open", async () => {
    mocks.drill.mockResolvedValue(
      report({ ok: false, missing: ["payload_decrypted", "archive_parsed"] }),
    );

    const outcome = await runScheduledBackupDrills(now);
    expect(outcome.failed).toBe(2);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-a",
        eventKey: "backup.drill_failed",
        severity: "critical",
        dedupeKey: "backup.drill_failed:business-a:2026-10-30",
      }),
    );
  });

  it("counts a busy lock as skipped, not as a failure", async () => {
    mocks.lock.mockResolvedValue({ ok: false, value: null });
    const outcome = await runScheduledBackupDrills(now);
    expect(outcome).toMatchObject({ drilled: 0, failed: 0, skipped: 2 });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does nothing at all for an install with no restorable artifacts", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const outcome = await runScheduledBackupDrills(now);
    expect(outcome).toMatchObject({ candidates: 0, drilled: 0 });
    expect(mocks.drill).not.toHaveBeenCalled();
  });
});

describe("drill history", () => {
  it("records what was proved and what was only skipped", async () => {
    const summary = await recordDrillRun(report(), "schedule");
    expect(summary).toMatchObject({ ok: true, missingSteps: ["portable_envelope"] });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO tenant_backup_drills"));
    expect(insert).toBeTruthy();
    expect(String(insert![0])).toContain("missing_steps");
  });

  it("records a drill that never picked an artifact without inventing a reference", async () => {
    await recordDrillRun(report({ ref: null, ok: false, missing: ["artifact_selected"] }));
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO tenant_backup_drills"));
    expect(insert![1]).toContain("");
  });

  it("reads back the most recent run for the console", async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        artifact_ref: "ref-1",
        ok: false,
        missing_steps: ["archive_parsed"],
        started_at: new Date("2026-10-29T00:00:00Z"),
        finished_at: new Date("2026-10-29T00:00:04Z"),
      }],
      rowCount: 1,
    });
    expect(await lastDrillSummary("business-a")).toMatchObject({
      ok: false,
      missingSteps: ["archive_parsed"],
      finishedAt: "2026-10-29T00:00:04.000Z",
    });
  });

  it("answers null for a business that has never been drilled", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await lastDrillSummary("business-a")).toBeNull();
  });
});
