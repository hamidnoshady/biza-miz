/**
 * Hybrid sync health and drift, the database half (the rules are pure, in
 * sync-health.ts). DB-touching; exercised by the hybrid-sync integration test.
 */
import { query } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import {
  assessSyncHealth,
  compareDigests,
  type DayDigest,
  type DriftDay,
  type SyncHealthIssue,
  type SyncHealthLevel,
} from "./sync-health";
import { getMasterSyncState } from "./master-sync-transport";

/**
 * Settled bills per business day for one branch — only bills that took part
 * in hybrid sync (`orders.sync_state_hlc` is stamped on every paid bill since
 * migration 0190, on both sides). Website and imported sales that exist only
 * on the central server, and bills settled before sync, are thereby left out
 * of the comparison rather than reported as drift. Bucketed by the day the
 * bill was *opened* on (`app_business_date`), which both sides now share.
 */
export async function computeDayDigests(locationId: string, days: readonly string[]): Promise<DayDigest[]> {
  if (days.length === 0) return [];
  const { rows } = await query<{ day: string; orders: number; sales: string; payments: string }>(
    `WITH bills AS (
       SELECT o.id, o.total,
              app_business_date(o.opened_at, l.timezone, l.business_day_start_minutes)::text AS day
         FROM orders o JOIN locations l ON l.id = o.location_id
        WHERE o.location_id = $1 AND o.status = 'completed' AND o.type <> 'retail'
          AND o.sync_state_hlc IS NOT NULL
     )
     SELECT b.day, count(*)::int AS orders, coalesce(sum(b.total), 0)::text AS sales,
            coalesce(sum((SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.order_id = b.id)), 0)::text AS payments
       FROM bills b
      WHERE b.day = ANY($2::text[])
      GROUP BY b.day`,
    [locationId, days],
  );
  return rows.map((row) => ({
    day: row.day,
    completedOrders: row.orders,
    salesTotal: row.sales,
    paymentsTotal: row.payments,
  }));
}

/** The last `count` complete business days of a branch (today excluded — it is still trading). */
export async function recentBusinessDays(locationId: string, count = 7): Promise<string[]> {
  const { rows } = await query<{ day: string }>(
    `SELECT (app_business_date(now(), l.timezone, l.business_day_start_minutes) - g)::text AS day
       FROM locations l, generate_series(1, $2::int) g
      WHERE l.id = $1
      ORDER BY 1`,
    [locationId, count],
  );
  return rows.map((row) => row.day);
}

// ---------------------------------------------------------------------------
// The desktop's drift check
// ---------------------------------------------------------------------------

export interface DriftState {
  checkedAt: string | null;
  status: "ok" | "drift" | "pending" | "error" | null;
  days: DriftDay[];
  error: string | null;
}

const EMPTY_DRIFT: DriftState = { checkedAt: null, status: null, days: [], error: null };

export async function getDriftState(businessId: string): Promise<DriftState> {
  return { ...EMPTY_DRIFT, ...((await getSetting<Partial<DriftState>>(businessId, SETTING_KEYS.syncDriftState)) ?? {}) };
}

/** How often the desktop compares its books with the central server's. */
export const DRIFT_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * Compare the last week's settled figures with the central server's. Skipped
 * (status `pending`) while either side still holds unsettled sync work for
 * this branch — a difference then is expected, not drift.
 */
export async function runDriftCheck(businessId: string, now: Date = new Date()): Promise<DriftState> {
  const previous = await getDriftState(businessId);
  if (previous.checkedAt && now.getTime() - Date.parse(previous.checkedAt) < DRIFT_CHECK_INTERVAL_MS) return previous;
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim() || !config.locationId) return previous;

  const save = async (state: DriftState) => {
    await setSetting(businessId, SETTING_KEYS.syncDriftState, state);
    return state;
  };
  const backlog = await localBacklog(businessId);
  if (backlog.unsent > 0 || backlog.deferred > 0) {
    return save({ checkedAt: now.toISOString(), status: "pending", days: [], error: null });
  }
  const days = await recentBusinessDays(config.locationId);
  const site = await computeDayDigests(config.locationId, days);
  try {
    const response = await fetch(`${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token.trim()}` },
      body: JSON.stringify({ days, digests: site }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`digest_rejected: HTTP ${response.status}`);
    const body = (await response.json()) as { drift?: DriftDay[]; pending?: boolean };
    if (body.pending) return save({ checkedAt: now.toISOString(), status: "pending", days: [], error: null });
    const drift = Array.isArray(body.drift) ? body.drift : [];
    return save({ checkedAt: now.toISOString(), status: drift.length > 0 ? "drift" : "ok", days: drift, error: null });
  } catch (error) {
    return save({
      checkedAt: now.toISOString(),
      status: "error",
      days: previous.days,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
}

/** The central server's answer to a desktop's digest. */
export async function compareWithSiteDigest(
  locationId: string,
  days: readonly string[],
  siteDigests: readonly DayDigest[],
): Promise<{ pending: boolean; drift: DriftDay[] }> {
  // Still applying (or waiting to apply) this branch's events: not drift yet.
  const { rows } = await query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM sync_domain_effects WHERE location_id = $1 AND status = 'deferred'`,
    [locationId],
  );
  if ((rows[0]?.waiting ?? 0) > 0) return { pending: true, drift: [] };
  const cloud = await computeDayDigests(locationId, days);
  return { pending: false, drift: compareDigests(days, siteDigests, cloud) };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function localBacklog(businessId: string): Promise<{
  unsent: number;
  oldestUnsentAt: string | null;
  refused: number;
  deferred: number;
  openDeadLetters: number;
  masterConflicts: number;
}> {
  const { rows } = await query<{
    unsent: number;
    oldest: Date | null;
    refused: number;
    deferred: number;
    dead: number;
    conflicts: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM sync_events se JOIN locations l ON l.id = se.location_id
         WHERE l.business_id = $1 AND se.origin = 'local' AND se.applied_at IS NOT NULL
           AND se.error IS NULL AND se.pushed_at IS NULL) AS unsent,
       (SELECT min(se.received_at) FROM sync_events se JOIN locations l ON l.id = se.location_id
         WHERE l.business_id = $1 AND se.origin = 'local' AND se.applied_at IS NOT NULL
           AND se.error IS NULL AND se.pushed_at IS NULL) AS oldest,
       (SELECT count(*)::int FROM sync_events se JOIN locations l ON l.id = se.location_id
         WHERE l.business_id = $1 AND se.pushed_at IS NULL AND se.push_attempts > 0) AS refused,
       (SELECT count(*)::int FROM sync_domain_effects WHERE business_id = $1 AND status = 'deferred') AS deferred,
       (SELECT count(*)::int FROM sync_event_dead_letters WHERE business_id = $1 AND status = 'open') AS dead,
       (SELECT count(*)::int FROM sync_master_conflicts WHERE business_id = $1 AND status = 'open') AS conflicts`,
    [businessId],
  );
  const row = rows[0];
  return {
    unsent: row?.unsent ?? 0,
    oldestUnsentAt: row?.oldest ? row.oldest.toISOString() : null,
    refused: row?.refused ?? 0,
    deferred: row?.deferred ?? 0,
    openDeadLetters: row?.dead ?? 0,
    masterConflicts: row?.conflicts ?? 0,
  };
}

export interface SyncHealthReport {
  level: SyncHealthLevel;
  issues: SyncHealthIssue[];
  unsent: number;
  oldestUnsentAt: string | null;
  refused: number;
  deferred: number;
  openDeadLetters: number;
  masterConflicts: number;
  lastPushSuccessAt: string | null;
  lastPullSuccessAt: string | null;
  lastMasterSyncAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  drift: DriftState;
}

export async function getSyncHealth(businessId: string, now: Date = new Date()): Promise<SyncHealthReport> {
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  const state = (await getSetting<{
    lastPushSuccessAt?: string | null;
    lastPullSuccessAt?: string | null;
    lastPushError?: string | null;
    lastPullError?: string | null;
    pushNextAttemptAt?: string | null;
    pullNextAttemptAt?: string | null;
  }>(businessId, SETTING_KEYS.serverSyncState)) ?? {};
  const master = await getMasterSyncState(businessId);
  const drift = await getDriftState(businessId);
  const backlog = await localBacklog(businessId);
  const lastError = state.lastPushError ?? state.lastPullError ?? master.lastError ?? null;
  const assessed = assessSyncHealth(
    {
      enabled: Boolean(config?.enabled),
      ...backlog,
      driftDays: drift.status === "drift" ? drift.days.length : 0,
      lastPushSuccessAt: state.lastPushSuccessAt ?? null,
      lastPullSuccessAt: state.lastPullSuccessAt ?? null,
      lastError,
    },
    now,
  );
  const nextAttempts = [state.pushNextAttemptAt, state.pullNextAttemptAt, master.nextAttemptAt].filter(
    (value): value is string => Boolean(value),
  );
  return {
    ...assessed,
    ...backlog,
    lastPushSuccessAt: state.lastPushSuccessAt ?? null,
    lastPullSuccessAt: state.lastPullSuccessAt ?? null,
    lastMasterSyncAt: master.lastSuccessAt,
    lastError,
    nextAttemptAt: nextAttempts.sort()[0] ?? null,
    drift,
  };
}
