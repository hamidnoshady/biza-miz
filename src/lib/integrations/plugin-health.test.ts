import { describe, expect, it } from "vitest";
import { assessPluginCron, shouldAlertPluginStale, summarizePluginHealth } from "./plugin-health";
import { PLUGIN_CRITICAL_AFTER_MS } from "./sync-timing";

const now = new Date("2026-10-26T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const health = (extra: Record<string, unknown> = {}) => ({ fastIntervalSeconds: 60, ...extra });

describe("assessPluginCron (issue #1206)", () => {
  it("grades the scheduler from when a fast handler actually started", () => {
    const at = (seconds: number, extra: Record<string, unknown> = {}) =>
      assessPluginCron({ plugin_health: health({ fastHandlerLastStartedAt: ago(seconds * 1000), ...extra }) }, now).state;
    expect(at(40)).toBe("healthy");
    // Two missed one-minute starts is a shared host, not an outage (#1149's
    // two-interval red was the false positive this corrects).
    expect(at(121)).toBe("healthy");
    expect(at(181)).toBe("delayed");
    expect(at(599)).toBe("delayed");
    expect(at(601)).toBe("failed");
  });

  it("keeps the legacy five-minute cadence for an older plugin", () => {
    const legacy = (minutes: number) =>
      assessPluginCron({ plugin_health: { fastHandlerLastStartedAt: ago(minutes * 60_000) } }, now).state;
    // warn = three 5-minute cycles; critical = the ten-minute floor or the
    // three-cycle grace, whichever is later — 15 minutes here.
    expect(legacy(5)).toBe("healthy");
    expect(legacy(10)).toBe("healthy");
    expect(legacy(16)).toBe("failed");
  });

  it("falls back to the pre-#1206 field name so an older plugin is still graded", () => {
    const legacyField = assessPluginCron({ plugin_health: health({ lastRunAt: ago(601_000) }) }, now);
    expect(legacyField).toMatchObject({ state: "failed", lastAttemptAt: ago(601_000) });
  });

  it("a connection test alone is 'test only', never healthy", () => {
    const assessed = assessPluginCron({ last_plugin_seen_at: ago(30_000), plugin_health: health() }, now);
    expect(assessed).toMatchObject({ state: "test_only", reason: "ping_without_cron" });
  });

  it("says unknown when there is no evidence at all", () => {
    expect(assessPluginCron({ last_plugin_seen_at: null, plugin_health: {} }, now)).toMatchObject({
      state: "unknown",
      reason: "no_cycle_evidence",
    });
  });

  it("does not call a deliberately paused connection broken", () => {
    expect(assessPluginCron({ status: "paused", plugin_health: health({ fastHandlerLastStartedAt: ago(3_600_000) }) }, now).state).toBe("paused");
    expect(assessPluginCron({ plugin_health: health({ fastHandlerLastStartedAt: ago(3_600_000), currentCronState: "paused" }) }, now).state).toBe("paused");
  });

  it("reports the thresholds it graded with, from the plugin's own cadence", () => {
    expect(assessPluginCron({ plugin_health: health() }, now)).toMatchObject({
      warnAfterMs: 180_000,
      failAfterMs: PLUGIN_CRITICAL_AFTER_MS,
    });
  });
});

describe("summarizePluginHealth (issues #1149, #1206)", () => {
  it("warns when late but notifies only when critical", () => {
    const at = (seconds: number) =>
      summarizePluginHealth(
        { last_plugin_seen_at: ago(10_000), last_sync_at: null, plugin_health: health({ fastHandlerLastStartedAt: ago(seconds * 1000) }) },
        { size: 0, oldestAt: null },
        now,
      );
    expect(at(40)).toMatchObject({ stale: false, alert: false });
    expect(at(121)).toMatchObject({ stale: false, alert: false });
    expect(at(181)).toMatchObject({ stale: true, alert: false });
    expect(at(601)).toMatchObject({ stale: true, alert: true });
  });

  it("carries the plugin's own cron report and the queue's size and age", () => {
    const summary = summarizePluginHealth(
      {
        last_plugin_seen_at: ago(60_000),
        last_sync_at: ago(120_000),
        plugin_health: health({ cronStale: true, cronGapSeconds: 4000 }),
      },
      { size: 12, oldestAt: ago(90 * 60_000) },
      now,
    );
    expect(summary).toMatchObject({ cronStale: true, cronGapSeconds: 4000, queueSize: 12, oldestQueuedAgeSeconds: 5400 });
  });

  it("separates the verified cycle, the applied cycle and the recovered outage", () => {
    const summary = summarizePluginHealth(
      {
        last_plugin_seen_at: ago(60_000),
        last_sync_at: ago(120_000),
        plugin_health: health({
          fastHandlerLastStartedAt: ago(60_000),
          lastVerifiedCycleAt: ago(60_000),
          lastActualDataAppliedAt: ago(5 * 60_000),
          lastCycleVerdict: "empty",
          previousOutageAt: "2026-10-26T09:00:00Z",
          recoveredAt: "2026-10-26T10:00:00Z",
        }),
      },
      { size: 0, oldestAt: null },
      now,
    );
    expect(summary).toMatchObject({
      lastVerifiedCycleAt: ago(60_000),
      lastDataAppliedAt: ago(5 * 60_000),
      lastCycleVerdict: "empty",
      previousOutageAt: "2026-10-26T09:00:00Z",
      recoveredAt: "2026-10-26T10:00:00Z",
    });
  });

  it("never shows the recovered outage as the current state", () => {
    // A plugin that just ended a two-hour silence reports the gap as history,
    // not as `cronStale: true` (#1206 P0-3).
    const summary = summarizePluginHealth(
      {
        last_plugin_seen_at: ago(5_000),
        last_sync_at: ago(5_000),
        plugin_health: health({
          fastHandlerLastStartedAt: ago(5_000),
          cronStale: false,
          lastVerifiedCycleAt: ago(5_000),
          previousOutageAt: "2026-10-26T10:00:00Z",
          recoveredAt: "2026-10-26T11:59:55Z",
        }),
      },
      { size: 0, oldestAt: null },
      now,
    );
    expect(summary.cron).toMatchObject({ state: "healthy" });
    expect(summary).toMatchObject({ stale: false, alert: false, recoveredAt: "2026-10-26T11:59:55Z" });
  });

  it("never-seen and unreported fields are null, not zero or false", () => {
    const summary = summarizePluginHealth({ last_plugin_seen_at: null, last_sync_at: null, plugin_health: {} }, { size: 0, oldestAt: null }, now);
    expect(summary).toMatchObject({
      silentMinutes: null,
      stale: false,
      alert: false,
      cronStale: null,
      cronGapSeconds: null,
      oldestQueuedAgeSeconds: null,
      lastVerifiedCycleAt: null,
      lastDataAppliedAt: null,
      previousOutageAt: null,
      recoveredAt: null,
      incidentOpen: false,
    });
    expect(summary.cron.state).toBe("unknown");
  });
});

describe("shouldAlertPluginStale", () => {
  const base = {
    link_mode: "plugin",
    status: "active",
    last_plugin_seen_at: ago(60_000),
    plugin_health: health({ fastHandlerLastStartedAt: ago(PLUGIN_CRITICAL_AFTER_MS + 60_000) }),
  };
  it("alerts an active plugin connection whose cron has stopped", () => {
    expect(shouldAlertPluginStale(base, now)).toBe(true);
  });

  it("does not alert on a fresh cycle, a pause, or a REST connection", () => {
    expect(shouldAlertPluginStale({ ...base, plugin_health: health({ fastHandlerLastStartedAt: ago(120_000) }) }, now)).toBe(false);
    expect(shouldAlertPluginStale({ ...base, status: "paused" }, now)).toBe(false);
    expect(shouldAlertPluginStale({ ...base, link_mode: "rest_api" }, now)).toBe(false);
  });

  it("cannot be cleared by pressing «آزمایش اتصال» during an outage", () => {
    // The ping refreshes last_plugin_seen_at every few seconds; the cron
    // signal is the only thing this grades.
    const pressed = { ...base, last_plugin_seen_at: ago(1_000) };
    expect(shouldAlertPluginStale(pressed, now)).toBe(true);
  });
});
