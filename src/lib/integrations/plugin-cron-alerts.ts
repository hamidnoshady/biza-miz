/**
 * The cron notifications (issue #1206, P1): warn, escalate, and say when it is
 * over — without ever flooding.
 *
 * What was wrong with the previous alert, and why this file exists:
 *
 *   - its **dedupe key was `last_plugin_seen_at`**, a timestamp any
 *     authenticated contact refreshes. So during a real outage, pressing
 *     «آزمایش اتصال» in WordPress changed the key and the same alarm was raised
 *     again on the next tick. The key now comes from the *cron signal* — the
 *     last time a fast handler actually started — which no button can move;
 *   - it had **one level**. Three missed cycles and ten minutes of nothing are
 *     different emergencies, and the issue asks for both: a warning that costs
 *     nothing at night, and an escalation that is allowed to interrupt;
 *   - it had **no ending**. A recovered store kept the last alarm standing, so
 *     an owner could not tell "still broken" from "fixed an hour ago".
 *
 * Everything here is pure: the thresholds come from `sync-timing.ts` (which
 * itself reads the cadence the plugin reports), and the caller only has to
 * record what this returns.
 */
import { notificationDedupeKey } from "../notifications";
import type { NotificationSeverity } from "../notifications";
import { assessPluginCron, type PluginCronAssessment } from "./plugin-health";
import { pluginCronWarnAfterMs } from "./sync-timing";

export type PluginCronAlertEventKey =
  | "integrations.plugin_cron_delayed"
  | "integrations.plugin_cron_failed"
  | "integrations.plugin_cron_recovered";

export interface PluginCronAlert {
  eventKey: PluginCronAlertEventKey;
  /** `warn` is quiet-hours friendly; `critical` is allowed to interrupt. */
  level: "warn" | "critical" | "recovered";
  severity: NotificationSeverity;
  title: string;
  body: string;
  url: string;
  /**
   * Stable for the whole episode, so the same alarm is never recorded twice.
   * Built from the cron signal, never from a timestamp a button can refresh.
   */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/** Where the panel that can fix this lives. */
const CONNECTIONS_URL = "/websites/wp/connections";

function minutes(seconds: number): string {
  const value = Math.max(1, Math.round(seconds / 60));
  return value.toLocaleString("fa-IR");
}

/**
 * The identity of one outage: the last real cron start that began it.
 *
 * A store that never ran its scheduler at all has no anchor, and using `now()`
 * would mint a new key every tick — the flooding this file exists to prevent —
 * so "never" is a fixed, honest anchor.
 */
function outageAnchor(cron: PluginCronAssessment): string {
  return cron.lastAttemptAt ?? "never";
}

/**
 * What, if anything, to tell the owner about this connection's scheduler.
 *
 * Returns at most one alert per call: the states are exclusive, and a recovery
 * is only reported for an outage long enough to have been worth warning about
 * (a two-minute blip produces nothing at all).
 *
 * @param connection The connection row, including the plugin's last report.
 * @param now        The instant to grade at.
 */
export function pluginCronAlerts(
  connection: {
    id: string;
    name: string;
    link_mode: string;
    status: string;
    last_plugin_seen_at: string | null;
    plugin_health?: Record<string, unknown> | null;
  },
  now: Date,
): PluginCronAlert[] {
  // A connection nobody finished setting up, one deliberately stopped, or one
  // whose owner stopped it on purpose is not an outage. `assessPluginCron`
  // returns `paused` for those, and nothing is said.
  if (connection.link_mode !== "plugin" || connection.status !== "active") return [];
  if (!connection.last_plugin_seen_at) return [];

  const health = connection.plugin_health ?? {};
  const cron = assessPluginCron(
    { status: connection.status, last_plugin_seen_at: connection.last_plugin_seen_at, plugin_health: health },
    now,
  );
  const anchor = outageAnchor(cron);
  const warnAfterMs = pluginCronWarnAfterMs(health);

  if (cron.state === "failed") {
    const silentSeconds = cron.lastAttemptAt
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(cron.lastAttemptAt)) / 1000))
      : null;
    return [
      {
        eventKey: "integrations.plugin_cron_failed",
        level: "critical",
        severity: "important",
        title: "کرون فروشگاه اجرا نمی‌شود",
        body:
          `«${connection.name}» بیش از ${minutes(warnAfterMs / 1000 * 3)} دقیقه است هیچ اجرای زمان‌بندی‌شده‌ای نداشته است. ` +
          (silentSeconds === null
            ? "از زمان فعال‌سازی، زمان‌بند هرگز اجرا نشده. "
            : `آخرین اجرای واقعی ${minutes(silentSeconds)} دقیقه پیش بود. `) +
          "سفارش‌ها و تغییرات در صف می‌مانند و از دست نمی‌روند، ولی تا رفع نشود اعمال هم نمی‌شوند. کرون سرور را بررسی کنید.",
        url: CONNECTIONS_URL,
        dedupeKey: notificationDedupeKey("integrations.plugin_cron_failed", connection.id, anchor),
        payload: { connectionId: connection.id, lastAttemptAt: cron.lastAttemptAt, missedIntervals: cron.missedIntervals },
      },
    ];
  }

  if (cron.state === "delayed") {
    return [
      {
        eventKey: "integrations.plugin_cron_delayed",
        level: "warn",
        severity: "info",
        title: "کرون فروشگاه دیرکرده",
        body:
          `«${connection.name}» چند اجرای پیاپی زمان‌بند را از دست داده است` +
          (cron.missedIntervals !== null ? ` (حدود ${minutes((cron.missedIntervals * 60)).toLocaleString("fa-IR")} دقیقه)` : "") +
          ". هنوز چیزی از دست نرفته — صف نگه می‌دارد — ولی اگر ادامه پیدا کند، سفارش‌ها دیرتر می‌رسند.",
        url: CONNECTIONS_URL,
        dedupeKey: notificationDedupeKey("integrations.plugin_cron_delayed", connection.id, anchor),
        payload: { connectionId: connection.id, lastAttemptAt: cron.lastAttemptAt, missedIntervals: cron.missedIntervals },
      },
    ];
  }

  // Recovery is history, and it is only worth a line if the outage was long
  // enough to have been reported: a blip is not an incident.
  if (cron.state === "healthy") {
    const previousOutageAt = typeof health.previousOutageAt === "string" ? health.previousOutageAt : "";
    const recoveredAt = typeof health.recoveredAt === "string" ? health.recoveredAt : "";
    const outageSeconds = Number(health.previousOutageSeconds);
    const longEnough = Number.isFinite(outageSeconds) && outageSeconds * 1000 >= warnAfterMs;
    if (previousOutageAt && recoveredAt && longEnough) {
      return [
        {
          eventKey: "integrations.plugin_cron_recovered",
          level: "recovered",
          severity: "info",
          title: "همگام‌سازی فروشگاه بازگشت",
          body:
            `«${connection.name}» دوباره اجرا می‌شود و صف در حال تخلیه است. ` +
            `وقفه ${minutes(outageSeconds)} دقیقه طول کشید و بسته شد؛ کاری از دست نرفته است.`,
          url: CONNECTIONS_URL,
          // Keyed on the incident, so one recovery notice per outage — never one
          // per tick after it.
          dedupeKey: notificationDedupeKey("integrations.plugin_cron_recovered", connection.id, previousOutageAt),
          payload: { connectionId: connection.id, previousOutageAt, recoveredAt, outageSeconds },
        },
      ];
    }
  }

  // `test_only`, `unknown` and `paused` are not emergencies. Reporting them as
  // one is how an owner learns to ignore the inbox.
  return [];
}
