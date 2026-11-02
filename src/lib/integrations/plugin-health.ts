/**
 * What an owner needs to know about a plugin-linked store, in one place
 * (issue #1149 C5, corrected by issue #1206) — pure, so the rules are
 * unit-tested and the dashboard, the overview API, the alert producer and the
 * panel cannot disagree.
 *
 * #1206 draws one distinction the old model got wrong. A plugin that has
 * stopped cannot tell the app so; but a *signed plugin contact* is not
 * evidence that its scheduler runs, because a «آزمایش اتصال» press or a manual
 * button click authenticates too. So:
 *
 *   - the **current** scheduler state is graded from actual cycle signals —
 *     when a fast handler last *started*, which only the real cron writes;
 *   - a **verified** cycle is one where every phase succeeded or was verified
 *     empty, so a failed push can never be reported as a successful sync;
 *   - the interruption a recovered store ended is **history** with its own
 *     resolution time (`previousOutageAt` / `recoveredAt`), never the live
 *     warning. The plugin used to advertise the *previous* run's staleness, so
 *     a store that had just recovered kept showing «زمان‌بند اجرا نشده بود».
 *
 * Thresholds come from `sync-timing.ts` and the plugin's own reported cadence.
 */
import { pluginCronFailAfterMs, pluginCronWarnAfterMs, pluginPullIntervalMs } from "./sync-timing";

/** The states the app shows. `test_only` and `unknown` are honest, not failures. */
export type PluginCronState = "healthy" | "delayed" | "failed" | "paused" | "test_only" | "unknown";

export interface PluginCronAssessment {
  state: PluginCronState;
  /** Why — a stable code, so the UI and the alert text cannot drift apart. */
  reason: string;
  /** The actual cycle signal this was graded from (fast handler last started). */
  lastAttemptAt: string | null;
  missedIntervals: number | null;
  warnAfterMs: number;
  failAfterMs: number;
}

export interface PluginHealthSummary {
  /** Last time the plugin authenticated at all. */
  lastPluginSeenAt: string | null;
  /** Last time it delivered or applied work (events pushed, jobs acknowledged). */
  lastSyncAt: string | null;
  /** Whole minutes since the plugin was last heard, or null when never. */
  silentMinutes: number | null;
  /** Late or failing: worth painting amber. */
  stale: boolean;
  /** Failing for longer than the critical threshold: worth notifying. */
  alert: boolean;
  /** The graded current state, with its reason and thresholds. */
  cron: PluginCronAssessment;
  /** The plugin's own account of its scheduler, from its last report. */
  cronStale: boolean | null;
  cronGapSeconds: number | null;
  /** Last cycle in which every phase succeeded or was verified empty. */
  lastVerifiedCycleAt: string | null;
  /** Last cycle that actually moved data — distinct from a verified empty one. */
  lastDataAppliedAt: string | null;
  /** `ok` | `empty` | `partial` | `failed` | `skipped` | `paused` of that cycle. */
  lastCycleVerdict: string | null;
  /** When the plugin says the fast-lane event is next due. */
  nextDueAt: string | null;
  /** When the interruption shown as history began, and when it was verified fixed. */
  previousOutageAt: string | null;
  recoveredAt: string | null;
  /** True while the plugin reports an interruption it has not verified fixed. */
  incidentOpen: boolean;
  /** Jobs this app has queued for the store that nothing has taken yet. */
  queueSize: number;
  oldestQueuedAgeSeconds: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The ISO stamp we grade from; older plugins send `lastRunAt` only. */
function actualCronSignal(health: Record<string, unknown>): string | null {
  return (
    stringOrNull(health.fastHandlerLastStartedAt) ??
    stringOrNull(health.lastRunAt) ??
    null
  );
}

/**
 * Grade the scheduler from the time a fast handler last actually started.
 *
 * Never from `lastPluginSeenAt`: a manual connection test refreshes that and
 * would keep a dead scheduler looking alive (#1206 P0-4).
 */
export function assessPluginCron(
  connection: {
    status?: string;
    last_plugin_seen_at?: string | null;
    plugin_health: Record<string, unknown> | null;
  },
  now: Date,
): PluginCronAssessment {
  const health = connection.plugin_health ?? {};
  const warnAfterMs = pluginCronWarnAfterMs(health);
  const failAfterMs = pluginCronFailAfterMs(health);
  const intervalMs = pluginPullIntervalMs(health);
  const attempt = actualCronSignal(health);
  const attemptMs = attempt ? Date.parse(attempt) : NaN;
  const missed = Number.isFinite(attemptMs) ? Math.max(0, Math.floor((now.getTime() - attemptMs) / intervalMs)) : null;

  const assessment = (state: PluginCronState, reason: string): PluginCronAssessment => ({
    state,
    reason,
    lastAttemptAt: attempt,
    missedIntervals: missed,
    warnAfterMs,
    failAfterMs,
  });

  // A connection its owner stopped on purpose is not an outage.
  if (connection.status === "paused") return assessment("paused", "paused_by_owner");

  // The plugin itself may report a pause it was told about.
  if (health.currentCronState === "paused") return assessment("paused", "paused_by_app");

  if (!Number.isFinite(attemptMs)) {
    // No cycle ever started. If the link was seen recently the honest answer is
    // "you tested the connection, the cron is unproven" — not healthy.
    const seenMs = connection.last_plugin_seen_at ? Date.parse(connection.last_plugin_seen_at) : NaN;
    if (Number.isFinite(seenMs) && now.getTime() - seenMs <= warnAfterMs) {
      return assessment("test_only", "ping_without_cron");
    }
    return assessment("unknown", "no_cycle_evidence");
  }

  const ageMs = Math.max(0, now.getTime() - attemptMs);
  if (ageMs > failAfterMs) return assessment("failed", "no_start_since");
  if (ageMs > warnAfterMs) return assessment("delayed", "missed_starts");
  return assessment("healthy", "recent_start");
}

export function summarizePluginHealth(
  connection: {
    status?: string;
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
  const cron = assessPluginCron(connection, now);
  return {
    lastPluginSeenAt: connection.last_plugin_seen_at,
    lastSyncAt: connection.last_sync_at,
    silentMinutes: silentMs === null ? null : Math.floor(silentMs / 60_000),
    stale: cron.state === "delayed" || cron.state === "failed",
    // Only the critical state notifies. Warning on three missed ticks would
    // page an owner every time a shared host queues its crontab.
    alert: cron.state === "failed",
    cron,
    cronStale: typeof health.cronStale === "boolean" ? health.cronStale : null,
    cronGapSeconds: numberOrNull(health.cronGapSeconds),
    lastVerifiedCycleAt: stringOrNull(health.lastVerifiedCycleAt) ?? stringOrNull(health.lastSuccessfulRun),
    lastDataAppliedAt: stringOrNull(health.lastActualDataAppliedAt),
    lastCycleVerdict: stringOrNull(health.lastCycleVerdict),
    nextDueAt: stringOrNull(health.nextDueAt),
    previousOutageAt: stringOrNull(health.previousOutageAt),
    recoveredAt: stringOrNull(health.recoveredAt),
    incidentOpen: health.previousOutageOpen === true,
    queueSize: queue.size,
    oldestQueuedAgeSeconds: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000)) : null,
  };
}

/**
 * Should the app raise an alert for this connection right now? Only a plugin
 * that has been heard from before and is not paused by its owner — a connection
 * nobody finished setting up, or one deliberately stopped, is not an outage.
 *
 * Graded from actual cycle signals, so repeatedly pressing «آزمایش اتصال»
 * during a cron outage cannot clear the alert (#1206 acceptance).
 */
export function shouldAlertPluginStale(
  connection: {
    link_mode: string;
    status: string;
    last_plugin_seen_at: string | null;
    plugin_health?: Record<string, unknown> | null;
  },
  now: Date,
): boolean {
  if (connection.link_mode !== "plugin" || connection.status !== "active") return false;
  if (!connection.last_plugin_seen_at) return false;
  return assessPluginCron({ status: connection.status, last_plugin_seen_at: connection.last_plugin_seen_at, plugin_health: connection.plugin_health ?? null }, now).state === "failed";
}
