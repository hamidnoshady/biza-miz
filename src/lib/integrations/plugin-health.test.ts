import { describe, expect, it } from "vitest";
import { PLUGIN_ALERT_AFTER_MS, shouldAlertPluginStale, summarizePluginHealth } from "./plugin-health";

const now = new Date("2026-10-26T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe("summarizePluginHealth (issue #1149, C5)", () => {
  it("reports legacy plugin silence after two missed five-minute pulls", () => {
    const at = (minutes: number) =>
      summarizePluginHealth(
        { last_plugin_seen_at: ago(minutes * 60_000), last_sync_at: null, plugin_health: {} },
        { size: 0, oldestAt: null },
        now,
      );
    expect(at(10)).toMatchObject({ silentMinutes: 10, stale: false, alert: false });
    expect(at(11)).toMatchObject({ stale: true, alert: true });
    expect(at(31)).toMatchObject({ stale: true, alert: true });
  });

  it("alerts after two missed pulls of an upgraded one-minute plugin", () => {
    const connection = { last_plugin_seen_at: ago(121_000), last_sync_at: null, plugin_health: { fastIntervalSeconds: 60 } };
    expect(summarizePluginHealth(connection, { size: 0, oldestAt: null }, now)).toMatchObject({ stale: true, alert: true });
    expect(shouldAlertPluginStale({ ...connection, link_mode: "plugin", status: "active" }, now)).toBe(true);
  });

  it("carries the plugin's own cron report and the queue's size and age", () => {
    const summary = summarizePluginHealth(
      { last_plugin_seen_at: ago(60_000), last_sync_at: ago(120_000), plugin_health: { cronStale: true, cronGapSeconds: 4000 } },
      { size: 12, oldestAt: ago(90 * 60_000) },
      now,
    );
    expect(summary).toMatchObject({ cronStale: true, cronGapSeconds: 4000, queueSize: 12, oldestQueuedAgeSeconds: 5400 });
  });

  it("never-seen and unreported fields are null, not zero or false", () => {
    const summary = summarizePluginHealth({ last_plugin_seen_at: null, last_sync_at: null, plugin_health: {} }, { size: 0, oldestAt: null }, now);
    expect(summary).toMatchObject({ silentMinutes: null, stale: false, alert: false, cronStale: null, cronGapSeconds: null, oldestQueuedAgeSeconds: null });
  });
});

describe("shouldAlertPluginStale", () => {
  const base = { link_mode: "plugin", status: "active", last_plugin_seen_at: ago(PLUGIN_ALERT_AFTER_MS + 60_000) };
  it("alerts an active plugin connection silent past the threshold", () => {
    expect(shouldAlertPluginStale(base, now)).toBe(true);
  });
  it("does not alert a fresh, paused, never-connected or REST connection", () => {
    expect(shouldAlertPluginStale({ ...base, last_plugin_seen_at: ago(60_000) }, now)).toBe(false);
    expect(shouldAlertPluginStale({ ...base, status: "paused" }, now)).toBe(false);
    expect(shouldAlertPluginStale({ ...base, last_plugin_seen_at: null }, now)).toBe(false);
    expect(shouldAlertPluginStale({ ...base, link_mode: "rest_api" }, now)).toBe(false);
  });
});
