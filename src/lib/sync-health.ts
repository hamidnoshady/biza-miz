/**
 * Hybrid sync health and drift, as pure rules. Pure, so the thresholds and
 * the comparison can be unit-tested; the queries live in sync-health-service.
 *
 * Two different questions:
 *
 *  - **Is it moving?** How many local changes are still waiting to go up and
 *    how old the oldest one is, what the central server is holding back,
 *    what was set aside as a dead letter or a master conflict.
 *  - **Do the two sides agree?** Per business day, the desktop and the
 *    central server each count and sum their settled sales and payments. A
 *    day whose figures differ is drift — something that "synced" did not
 *    land the same — and is the check that would have caught every bug the
 *    Phase 44 work fixed, long before a customer noticed.
 */

export type SyncHealthLevel = "ok" | "warning" | "error";

export interface SyncHealthInput {
  enabled: boolean;
  unsent: number;
  oldestUnsentAt: string | null;
  refused: number;
  deferred: number;
  openDeadLetters: number;
  masterConflicts: number;
  driftDays: number;
  lastPushSuccessAt: string | null;
  lastPullSuccessAt: string | null;
  lastError: string | null;
}

export interface SyncHealthIssue {
  code:
    | "sync_disabled"
    | "backlog_stale"
    | "backlog_growing"
    | "events_refused"
    | "dead_letters"
    | "master_conflicts"
    | "drift"
    | "no_recent_contact";
  level: Exclude<SyncHealthLevel, "ok">;
}

/** An unsent change older than this is a warning; older than the second, an error. */
export const BACKLOG_WARNING_MS = 5 * 60_000;
export const BACKLOG_ERROR_MS = 30 * 60_000;
/** No successful push or pull for this long, while changes wait, is an error. */
export const CONTACT_ERROR_MS = 30 * 60_000;

export function assessSyncHealth(input: SyncHealthInput, now: Date): { level: SyncHealthLevel; issues: SyncHealthIssue[] } {
  const issues: SyncHealthIssue[] = [];
  if (!input.enabled) return { level: "ok", issues: [{ code: "sync_disabled", level: "warning" }] };

  const age = input.oldestUnsentAt ? now.getTime() - Date.parse(input.oldestUnsentAt) : 0;
  if (input.unsent > 0 && age > BACKLOG_ERROR_MS) issues.push({ code: "backlog_stale", level: "error" });
  else if (input.unsent > 0 && age > BACKLOG_WARNING_MS) issues.push({ code: "backlog_growing", level: "warning" });

  if (input.refused > 0) issues.push({ code: "events_refused", level: "warning" });
  if (input.openDeadLetters > 0) issues.push({ code: "dead_letters", level: "error" });
  if (input.masterConflicts > 0) issues.push({ code: "master_conflicts", level: "warning" });
  if (input.driftDays > 0) issues.push({ code: "drift", level: "error" });

  const lastContact = Math.max(
    input.lastPushSuccessAt ? Date.parse(input.lastPushSuccessAt) : 0,
    input.lastPullSuccessAt ? Date.parse(input.lastPullSuccessAt) : 0,
  );
  if (input.unsent > 0 && (lastContact === 0 || now.getTime() - lastContact > CONTACT_ERROR_MS)) {
    issues.push({ code: "no_recent_contact", level: "error" });
  }

  const level: SyncHealthLevel = issues.some((issue) => issue.level === "error")
    ? "error"
    : issues.length > 0
      ? "warning"
      : "ok";
  return { level, issues };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/** One business day's settled figures, integer Rial as decimal strings. */
export interface DayDigest {
  /** ISO business date (storage convention; shown Shamsi). */
  day: string;
  completedOrders: number;
  salesTotal: string;
  paymentsTotal: string;
}

export interface DriftDay {
  day: string;
  site: DayDigest | null;
  cloud: DayDigest | null;
}

const EMPTY = (day: string): DayDigest => ({ day, completedOrders: 0, salesTotal: "0", paymentsTotal: "0" });

function same(a: DayDigest, b: DayDigest): boolean {
  return (
    a.completedOrders === b.completedOrders &&
    BigInt(a.salesTotal) === BigInt(b.salesTotal) &&
    BigInt(a.paymentsTotal) === BigInt(b.paymentsTotal)
  );
}

/** The days on which the two sides disagree; a day missing on one side counts as zero there. */
export function compareDigests(days: readonly string[], site: readonly DayDigest[], cloud: readonly DayDigest[]): DriftDay[] {
  const siteBy = new Map(site.map((digest) => [digest.day, digest]));
  const cloudBy = new Map(cloud.map((digest) => [digest.day, digest]));
  const drift: DriftDay[] = [];
  for (const day of days) {
    const a = siteBy.get(day) ?? EMPTY(day);
    const b = cloudBy.get(day) ?? EMPTY(day);
    if (!same(a, b)) drift.push({ day, site: siteBy.get(day) ?? null, cloud: cloudBy.get(day) ?? null });
  }
  return drift;
}

/** Whether a posted digest is well-formed enough to compare. */
export function isDayDigest(value: unknown): value is DayDigest {
  if (!value || typeof value !== "object") return false;
  const digest = value as Record<string, unknown>;
  return (
    typeof digest.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(digest.day) &&
    Number.isSafeInteger(digest.completedOrders) &&
    typeof digest.salesTotal === "string" &&
    /^-?\d{1,20}$/.test(digest.salesTotal) &&
    typeof digest.paymentsTotal === "string" &&
    /^-?\d{1,20}$/.test(digest.paymentsTotal)
  );
}
