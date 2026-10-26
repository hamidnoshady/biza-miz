/**
 * What an owner needs to know about a plugin-linked store, in one place
 * (issue #1149, C5) — pure, so the rules are unit-tested and the dashboard,
 * the overview API and the alert producer cannot disagree.
 *
 * A plugin that has stopped cannot tell the app so; its silence is the only
 * evidence. So "stalled" is derived from `last_plugin_seen_at` (any signed
 * call), and the plugin's own report (`cronStale`, from the run that ended the
 * silence) is shown beside it as the explanation, never used as the trigger.
 */
import { PLUGIN_HEALTH_STALE_MS } from "./connections-service";

/** Silence longer than this is worth telling the owner about, not just painting amber. */
export const PLUGIN_ALERT_AFTER_MS = 30 * 60 * 1000;

export interface PluginHealthSummary {
  /** Last time the plugin authenticated at all. */
  lastPluginSeenAt: string | null;
  /** Last time it delivered or applied work (events pushed, jobs acknowledged). */
  lastSyncAt: string | null;
  /** Whole minutes since the plugin was last heard, or null when never. */
  silentMinutes: number | null;
  /** Silent longer than the freshness window. */
  stale: boolean;
  /** Silent longer than the alert threshold. */
  alert: boolean;
  /** The plugin's own account of its scheduler, from its last report. */
  cronStale: boolean | null;
  cronGapSeconds: number | null;
  /** Jobs this app has queued for the store that nothing has taken yet. */
  queueSize: number;
  oldestQueuedAgeSeconds: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizePluginHealth(
  connection: {
    last_plugin_seen_at: string | null;
    last_sync_at: string | null;
    plugin_health: Record<string, unknown> | null;
  },
  queue: { size: number; oldestAt: string | null },
  now: Date,
): PluginHealthSummary {
  const seenMs = connection.last_plugin_seen_at ? Date.parse(connection.last_plugin_seen_at) : NaN;
  const silentMs = Number.isFinite(seenMs) ? Math.max(0, now.getTime() - seenMs) : null;
  const oldestMs = queue.oldestAt ? Date.parse(queue.oldestAt) : NaN;
  const health = connection.plugin_health ?? {};
  return {
    lastPluginSeenAt: connection.last_plugin_seen_at,
    lastSyncAt: connection.last_sync_at,
    silentMinutes: silentMs === null ? null : Math.floor(silentMs / 60_000),
    stale: silentMs !== null && silentMs > PLUGIN_HEALTH_STALE_MS,
    alert: silentMs !== null && silentMs > PLUGIN_ALERT_AFTER_MS,
    cronStale: typeof health.cronStale === "boolean" ? health.cronStale : null,
    cronGapSeconds: numberOrNull(health.cronGapSeconds),
    queueSize: queue.size,
    oldestQueuedAgeSeconds: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000)) : null,
  };
}

/**
 * Should the app raise an alert for this connection right now? Only a plugin
 * that has been heard from before and is not paused by its owner — a connection
 * nobody finished setting up, or one deliberately stopped, is not an outage.
 */
export function shouldAlertPluginStale(
  connection: { link_mode: string; status: string; last_plugin_seen_at: string | null },
  now: Date,
): boolean {
  if (connection.link_mode !== "plugin" || connection.status !== "active" || !connection.last_plugin_seen_at) return false;
  const seenMs = Date.parse(connection.last_plugin_seen_at);
  return Number.isFinite(seenMs) && now.getTime() - seenMs > PLUGIN_ALERT_AFTER_MS;
}
