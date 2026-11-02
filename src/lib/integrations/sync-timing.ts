/**
 * How late a plugin's scheduler may be before the app calls it late (#1206).
 *
 * The cadence is whatever the installed plugin reports — a 1.6+ build polls
 * every 60s, an older one every 5 minutes — because a threshold derived from
 * the wrong cadence is the false positive this issue was opened for. These are
 * configuration numbers, not measured production timings.
 */

/** Old plugins keep their five-minute cadence until actually upgraded. */
export function pluginPullIntervalMs(health: Record<string, unknown> | null | undefined): number {
  const reported = health?.fastIntervalSeconds;
  return reported === 60 ? 60_000 : 300_000;
}

/**
 * «کند» — after this many missed cycles the scheduler is worth warning about.
 *
 * Three, not two: two missed one-minute ticks is an ordinary shared host, and
 * #1149's two-interval threshold painted that red.
 */
export const PLUGIN_DELAYED_AFTER_INTERVALS = 3;

/** «اجرا نمی‌شود» — no start for ten minutes is a failure at any cadence. */
export const PLUGIN_CRITICAL_AFTER_MS = 10 * 60 * 1000;

export function pluginSilenceThresholdMs(health: Record<string, unknown> | null | undefined): number {
  return 2 * pluginPullIntervalMs(health);
}

/** Past this age the scheduler is «کند» (amber) but not yet a failure. */
export function pluginCronWarnAfterMs(health: Record<string, unknown> | null | undefined): number {
  return PLUGIN_DELAYED_AFTER_INTERVALS * pluginPullIntervalMs(health);
}

/** Past this age it is «اجرا نمی‌شود» (critical). */
export function pluginCronFailAfterMs(health: Record<string, unknown> | null | undefined): number {
  return Math.max(PLUGIN_CRITICAL_AFTER_MS, pluginCronWarnAfterMs(health));
}
