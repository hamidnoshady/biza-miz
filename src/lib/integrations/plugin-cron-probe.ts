/**
 * The app's half of the "test cron & sync pipeline" probe (issue #1206, P0).
 *
 * A connection test proves a token authenticates. It cannot prove a scheduler
 * runs, because the plugin answers that request from a web worker like any
 * other: a store whose WP-Cron never fires still says «آزمایش اتصال موفق». The
 * probe is the only control that asks a question whose answer can only be
 * produced by a *real* scheduler invocation.
 *
 * The two sides talk about one probe through one correlation id:
 *
 *   1. the app mints 32 lowercase hex and queues a `cron_probe` outbox row with
 *      it (`requestCronProbe`);
 *   2. the plugin leases that row inside a cron run and schedules a second
 *      event five seconds out, keeping the app's id;
 *   3. when that event runs, the plugin records `executed_at` and sends one
 *      signed handshake whose telemetry carries `cronProbe`;
 *   4. this module grades what came back, stage by stage, and says plainly when
 *      the answer is "queued and never executed" — which is the finding, not a
 *      failure to report.
 *
 * Threshold and vocabulary mirror `POS_Connector_Health::probe_state()` on the
 * plugin side: the two must agree, or the screen and the store would tell
 * different stories about the same probe.
 */

/** The outbox entity type the probe travels as (migration 0282). */
export const CRON_PROBE_JOB_TYPE = "cron_probe";

/**
 * How long a queued probe waits for a scheduler before it counts as evidence
 * that the scheduler is not running. Same ten minutes as the plugin's
 * `PROBE_EXPIRY_SECONDS`: long enough for a five-minute crontab, short enough
 * that an owner can act inside the same session.
 */
export const CRON_PROBE_EXPIRY_SECONDS = 600;

import { pluginSupportsJobType } from "./plugin-capabilities";

/** 32 lowercase hex, minted here and accepted verbatim by the plugin. */
export const CRON_PROBE_ID_PATTERN = /^[a-f0-9]{32}$/;

export type CronProbeStage =
  /** No probe has ever run on this store. */
  | "never"
  /** The app queued one; nothing has picked it up yet. */
  | "requested"
  /** The plugin stored it and is waiting for its scheduler. */
  | "queued"
  /** A real scheduler invocation ran it; its report has not landed yet. */
  | "executed"
  /** Signed telemetry arrived: the pipeline works end to end. */
  | "reported"
  /** Queued, and no scheduler ran it inside the grace window — the finding. */
  | "expired"
  /** It ran, but the report did not leave; a different problem from expired. */
  | "failed"
  /** The store's plugin cannot run a probe at all (older release). */
  | "unsupported";

export interface CronProbeAssessment {
  stage: CronProbeStage;
  /** A stable code, so the UI and the docs cannot drift apart. */
  reason: string;
  /** The correlation id both sides agree on, when there is one. */
  probeId: string | null;
  /** Who asked: `admin` (the plugin's own button) or `app` (this control). */
  origin: "admin" | "app" | null;
  queuedAt: string | null;
  executedAt: string | null;
  reportedAt: string | null;
  /** Seconds since the app queued it, or null when nothing was queued. */
  ageSeconds: number | null;
  /** Seconds left before a queued probe is graded expired. */
  expiresInSeconds: number | null;
}

/**
 * What the plugin last reported, from `plugin_health.cronProbe`.
 *
 * The plugin sends `{id, origin, queuedAt, executedAt, reportedAt, error}` with
 * empty strings for the stages that have not happened, and `null` when it has
 * never run a probe — the difference between "never tested" and "tested and
 * queued" is exactly what this must preserve.
 */
export interface CronProbeReport {
  id: string;
  origin: "admin" | "app" | null;
  queuedAt: string | null;
  executedAt: string | null;
  reportedAt: string | null;
  error: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Read the plugin's report, ignoring anything that is not the documented shape. */
export function readCronProbeReport(raw: unknown): CronProbeReport | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = text(record.id);
  if (!id) return null;
  const origin = record.origin === "app" ? "app" : record.origin === "admin" ? "admin" : null;
  return {
    id,
    origin,
    queuedAt: text(record.queuedAt) ?? text(record.queued_at),
    executedAt: text(record.executedAt) ?? text(record.executed_at),
    reportedAt: text(record.reportedAt) ?? text(record.reported_at),
    error: text(record.error),
  };
}

/**
 * Grade one probe.
 *
 * `request` is the app's own record — when it queued a probe and what id it
 * used — so a report that never arrives can still be told apart from a report
 * that has not arrived *yet*. Without it the only honest answers are "never"
 * and whatever the plugin last said.
 */
export function assessCronProbe(
  input: {
    /** `plugin_health.cronProbe`, as the plugin sent it. */
    report?: unknown;
    /** Whether this plugin advertised `cron_probe` at all. */
    supported?: boolean;
    /** The app's own request: when it queued a probe, and under which id. */
    request?: { probeId: string; requestedAt: string | null } | null;
  },
  now: Date,
): CronProbeAssessment {
  const empty: CronProbeAssessment = {
    stage: "never",
    reason: "no_probe",
    probeId: null,
    origin: null,
    queuedAt: null,
    executedAt: null,
    reportedAt: null,
    ageSeconds: null,
    expiresInSeconds: null,
  };

  const report = readCronProbeReport(input.report);
  const request = input.request ?? null;

  if (input.supported === false) {
    return { ...empty, stage: "unsupported", reason: "plugin_cannot_run_probe" };
  }

  if (report) {
    const queuedMs = report.queuedAt ? Date.parse(report.queuedAt) : NaN;
    const ageSeconds = Number.isFinite(queuedMs) ? Math.max(0, Math.floor((now.getTime() - queuedMs) / 1000)) : null;
    const expiresInSeconds = ageSeconds === null ? null : Math.max(0, CRON_PROBE_EXPIRY_SECONDS - ageSeconds);
    const base: CronProbeAssessment = {
      ...empty,
      probeId: report.id,
      origin: report.origin,
      queuedAt: report.queuedAt,
      executedAt: report.executedAt,
      reportedAt: report.reportedAt,
      ageSeconds,
      expiresInSeconds,
    };
    // Order matters and mirrors the plugin: a report that left is proof even if
    // a later stage record was lost, and an error outranks "executed" because
    // "ran but could not tell the app" is not a success.
    if (report.reportedAt) return { ...base, stage: "reported", reason: "telemetry_received" };
    if (report.error) return { ...base, stage: "failed", reason: report.error.slice(0, 120) };
    if (report.executedAt) return { ...base, stage: "executed", reason: "scheduler_ran_it" };
    if (ageSeconds !== null && ageSeconds > CRON_PROBE_EXPIRY_SECONDS) {
      return { ...base, stage: "expired", reason: "queued_but_never_executed" };
    }
    return { ...base, stage: "queued", reason: "awaiting_scheduler" };
  }

  if (request) {
    const requestedMs = request.requestedAt ? Date.parse(request.requestedAt) : NaN;
    const ageSeconds = Number.isFinite(requestedMs) ? Math.max(0, Math.floor((now.getTime() - requestedMs) / 1000)) : null;
    return {
      ...empty,
      stage: "requested",
      // The app asked. Whether the plugin has leased the job is a queue
      // question, so the wording claims nothing about the plugin yet.
      reason: "requested_by_app",
      probeId: request.probeId,
      origin: "app",
      ageSeconds,
      expiresInSeconds: ageSeconds === null ? null : Math.max(0, CRON_PROBE_EXPIRY_SECONDS - ageSeconds),
    };
  }

  return empty;
}

/**
 * Whether the panel may offer «تست کرون» for this connection.
 *
 * A plugin that never advertised `cron_probe` (anything before this release)
 * would lease nothing: the lease query filters by supported type, so the row
 * would sit `pending` forever and the button would look broken rather than
 * unavailable. REST-mode connections have no scheduler to probe at all.
 */
export function cronProbeOffered(connection: {
  link_mode?: string;
  capabilities?: Record<string, unknown> | null;
}): boolean {
  if (connection.link_mode !== "plugin") return false;
  // The shared rule, not a second copy of it: an older plugin falls back to the
  // legacy job list, which has no `cron_probe` in it.
  return pluginSupportsJobType(connection.capabilities ?? null, CRON_PROBE_JOB_TYPE);
}
