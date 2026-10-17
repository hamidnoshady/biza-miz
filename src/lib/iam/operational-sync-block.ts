/**
 * The durable record of an IAM-sync failure gating operational sync
 * (issue #988).
 *
 * `runServerSyncTick()` refuses to run master-data sync, the site profile,
 * push or pull while `runIamSync()` fails. That gate is correct and stays. What
 * was missing is anywhere to look afterwards: the blocked tick wrote one
 * `console.error` line on the machine, so a Hybrid install whose till kept
 * taking sales that never reached the cloud still read as healthy on every
 * surface — the observed case ran for nine days and 1 092 ticks.
 *
 * The shape is deliberately the one `iam_login_credential_sync_state` (see
 * `login-credential-sync.ts`) introduced for the sibling problem: a table
 * keyed by `(business_id, site_device_id)` with a status, the last error, and
 * the timestamps that turn "it failed once" into "it has been failing since".
 * Reading it is cheap enough for the connection badge, the cloud-and-sync panel
 * and the device fleet alike; writing it is rare, because a converged tick only
 * clears a row that was actually blocked.
 *
 * Two rules keep this from becoming a new source of noise:
 *  - a block is recorded only when the reconciliation itself was attempted and
 *    failed. An install that is merely not configured yet (mid-pairing) has
 *    `runIamSync()` return false for a benign reason and must not read blocked;
 *  - the alert fires once per episode, after
 *    `OPERATIONAL_SYNC_ALERT_AFTER_TICKS` consecutive gated ticks, through the
 *    shared notification engine rather than a scheduler of its own.
 *
 * DB-touching, so per repo convention no direct unit test — the counting rules
 * and the classifier live in the pure `operational-sync-health.ts`, and the
 * end-to-end path is covered by
 * integration/hybrid-operational-sync-block.integration.test.ts.
 */
import { getPool, query } from "../db";
import { notificationDedupeKey } from "../notifications";
import { recordNotification } from "../notification-events";
import { formatJalali } from "../jalali";
import {
  classifyIamFailure,
  isIamFailureCode,
  isOperationalSyncBlockStatus,
  nextBlockedWrite,
  type IamFailureCode,
  type OperationalSyncBlockStatus,
} from "./operational-sync-health";

/** What a surface reads about one paired site's gating state. */
export interface OperationalSyncBlockSnapshot {
  status: OperationalSyncBlockStatus;
  /** Start of the current episode; null once the gate has lifted. */
  firstBlockedAt: string | null;
  lastBlockedAt: string | null;
  lastRecoveredAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastCode: IamFailureCode | null;
  consecutiveBlockedTicks: number;
  totalBlockedTicks: number;
  episodesBlocked: number;
  /** Local events waiting to be pushed, as counted at the last blocked tick. */
  pendingOutbox: number;
  /** Set when this episode was loud enough to alert; cleared when it ends. */
  alertedAt: string | null;
}

type BlockRow = {
  status: string;
  first_blocked_at: Date | null;
  last_blocked_at: Date | null;
  last_recovered_at: Date | null;
  last_attempt_at: Date | null;
  last_error: string | null;
  last_code: string | null;
  consecutive_blocked_ticks: number;
  total_blocked_ticks: number;
  episodes_blocked: number;
  pending_outbox: number;
  alerted_at: Date | null;
};

function toSnapshot(row: BlockRow): OperationalSyncBlockSnapshot {
  const iso = (value: Date | null) => value?.toISOString() ?? null;
  return {
    status: isOperationalSyncBlockStatus(row.status) ? row.status : "blocked",
    firstBlockedAt: iso(row.first_blocked_at),
    lastBlockedAt: iso(row.last_blocked_at),
    lastRecoveredAt: iso(row.last_recovered_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastError: row.last_error,
    lastCode: isIamFailureCode(row.last_code)
      ? row.last_code
      : row.last_code
        ? "sync_error"
        : null,
    consecutiveBlockedTicks: Number(row.consecutive_blocked_ticks ?? 0),
    totalBlockedTicks: Number(row.total_blocked_ticks ?? 0),
    episodesBlocked: Number(row.episodes_blocked ?? 0),
    pendingOutbox: Number(row.pending_outbox ?? 0),
    alertedAt: iso(row.alerted_at),
  };
}

/**
 * How much this till has queued behind the gate right now.
 *
 * The same predicate `runServerPush()` claims with, so the number a surface
 * shows is "events a healthy tick would have sent", not "rows in sync_events".
 */
export async function pendingLocalSyncEvents(businessId: string): Promise<number> {
  const { rows } = await query<{ pending: string }>(
    `SELECT count(*)::text AS pending
       FROM sync_events se
       JOIN locations l ON l.id = se.location_id
      WHERE l.business_id = $1
        AND se.scope = 'location'
        AND se.origin = 'local'
        AND se.pushed_at IS NULL
        AND se.applied_at IS NOT NULL
        AND se.error IS NULL
        AND se.retracted_at IS NULL`,
    [businessId],
  );
  return Number(rows[0]?.pending ?? 0);
}

/** The stored episode for one paired site, or null when it has never been gated. */
export async function readOperationalSyncBlockState(
  businessId: string,
  siteDeviceId: string,
): Promise<OperationalSyncBlockSnapshot | null> {
  const { rows } = await query<BlockRow>(
    `SELECT status,first_blocked_at,last_blocked_at,last_recovered_at,last_attempt_at,last_error,last_code,
            consecutive_blocked_ticks,total_blocked_ticks,episodes_blocked,pending_outbox,alerted_at
       FROM iam_operational_sync_block_state
      WHERE business_id = $1 AND site_device_id = $2`,
    [businessId, siteDeviceId],
  );
  const row = rows[0];
  return row ? toSnapshot(row) : null;
}

/**
 * Record that this tick's operational traffic was gated.
 *
 * Never throws. This runs on the recovery path of a tick that has *already*
 * failed, and visibility is the whole point: a recorder that could throw would
 * either be wrapped in a `catch {}` at the call site (and then be silently
 * skippable — the bug this file exists to fix) or take down the tick that was
 * about to log the block anyway. So the failure is its own `console.error` and
 * the tick continues; the durable evidence simply stays where it was.
 */
export async function recordOperationalSyncBlocked(
  businessId: string,
  siteDeviceId: string,
  info: { error: string | null; pendingOutbox?: number },
): Promise<OperationalSyncBlockSnapshot | null> {
  const code = classifyIamFailure(info.error);
  try {
    const pendingOutbox = info.pendingOutbox ?? (await pendingLocalSyncEvents(businessId));
    const client = await getPool().connect();
    let written: BlockRow | null = null;
    let alerted = false;
    try {
      await client.query("BEGIN");
      const before = await client.query<{
        status: string;
        consecutive_blocked_ticks: number;
        total_blocked_ticks: number;
        episodes_blocked: number;
        alerted_at: Date | null;
      }>(
        `SELECT status,consecutive_blocked_ticks,total_blocked_ticks,episodes_blocked,alerted_at
           FROM iam_operational_sync_block_state
          WHERE business_id = $1 AND site_device_id = $2
          FOR UPDATE`,
        [businessId, siteDeviceId],
      );
      const priorRow = before.rows[0];
      const next = nextBlockedWrite(
        priorRow
          ? {
              status: isOperationalSyncBlockStatus(priorRow.status) ? priorRow.status : "blocked",
              consecutiveBlockedTicks: Number(priorRow.consecutive_blocked_ticks ?? 0),
              totalBlockedTicks: Number(priorRow.total_blocked_ticks ?? 0),
              episodesBlocked: Number(priorRow.episodes_blocked ?? 0),
              alerted: priorRow.alerted_at !== null,
            }
          : null,
      );
      const after = await client.query<BlockRow>(
        `INSERT INTO iam_operational_sync_block_state
           (business_id,site_device_id,status,first_blocked_at,last_blocked_at,last_attempt_at,last_error,last_code,
            consecutive_blocked_ticks,total_blocked_ticks,episodes_blocked,pending_outbox,alerted_at)
         VALUES ($1,$2,'blocked',CASE WHEN $3::boolean THEN now() END,now(),now(),$4,$5,$6,$7,$8,$9,
                 CASE WHEN $10::boolean THEN now() END)
         ON CONFLICT (business_id,site_device_id) DO UPDATE SET
           status='blocked',
           first_blocked_at=CASE WHEN $3::boolean THEN now() ELSE COALESCE(iam_operational_sync_block_state.first_blocked_at, now()) END,
           last_blocked_at=now(),last_attempt_at=now(),last_error=$4,last_code=$5,
           consecutive_blocked_ticks=$6,total_blocked_ticks=$7,episodes_blocked=$8,pending_outbox=$9,
           alerted_at=CASE WHEN $10::boolean THEN now() ELSE iam_operational_sync_block_state.alerted_at END
         RETURNING status,first_blocked_at,last_blocked_at,last_recovered_at,last_attempt_at,last_error,last_code,
                   consecutive_blocked_ticks,total_blocked_ticks,episodes_blocked,pending_outbox,alerted_at`,
        [
          businessId,
          siteDeviceId,
          next.startsEpisode,
          info.error?.slice(0, 500) ?? null,
          code,
          next.consecutiveBlockedTicks,
          next.totalBlockedTicks,
          next.episodesBlocked,
          pendingOutbox,
          next.alertDue,
        ],
      );
      written = after.rows[0] ?? null;
      alerted = next.alertDue;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const snapshot = written ? toSnapshot(written) : null;
    // One notification per blocked episode, raised by the tick that crosses the
    // threshold — after the commit, so a rolled-back record never alerts.
    if (alerted && snapshot) {
      await notifyOperationalSyncBlocked(businessId, siteDeviceId, snapshot);
    }
    return snapshot;
  } catch (error) {
    console.error(
      `operational sync block record failed for business ${businessId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * The message the owner sees. The raw `last_error` never rides along: it is a
 * Node error string (`fetch failed`, `events_http_403`), which is support
 * material and reads like a crash to anyone else.
 */
async function notifyOperationalSyncBlocked(
  businessId: string,
  siteDeviceId: string,
  snapshot: OperationalSyncBlockSnapshot,
): Promise<void> {
  const pending = snapshot.pendingOutbox;
  const since = snapshot.firstBlockedAt ? formatJalali(snapshot.firstBlockedAt, { withTime: true }) : null;
  await recordNotification({
    businessId,
    locationId: null,
    eventKey: "sync.operational_blocked",
    severity: "important",
    title: "همگام‌سازی عملیاتی این دستگاه مسدود است",
    body:
      `همگام‌سازی امنیتی با سرور ابری ناموفق است، پس فروش و داده‌های این دستگاه تا برقراری مجدد به ابر فرستاده نمی‌شود.`
      + (since ? ` از ${since}.` : ".")
      + (pending > 0 ? ` ${pending.toLocaleString("fa-IR")} رویداد در انتظار ارسال است.` : ""),
    url: "/settings/cloud-sync",
    // The fact is one blocked episode of one install, not one tick: deduping on
    // the episode start is what keeps a nine-day outage to a single alert.
    dedupeKey: notificationDedupeKey(
      "sync.operational_blocked",
      siteDeviceId,
      snapshot.firstBlockedAt ?? snapshot.lastBlockedAt ?? "unknown",
    ),
    payload: {
      siteDeviceId,
      consecutiveBlockedTicks: snapshot.consecutiveBlockedTicks,
      pendingOutbox: pending,
      code: snapshot.lastCode,
    },
  });
}

export interface OperationalSyncRecovery {
  /** True when a blocked episode ended on this call. */
  recovered: boolean;
  /** How many ticks this install has ever been gated, after this call. */
  totalBlockedTicks: number;
  lastBlockedAt: string | null;
}

/**
 * Lift the gate on record. Cheap on the common path: a converged tick with no
 * blocked row matches zero rows and writes nothing, so the sync tick does not
 * touch this table at all while everything is healthy.
 */
export async function clearOperationalSyncBlock(
  businessId: string,
  siteDeviceId: string,
): Promise<OperationalSyncRecovery> {
  const empty: OperationalSyncRecovery = { recovered: false, totalBlockedTicks: 0, lastBlockedAt: null };
  try {
    const { rows } = await query<{ total_blocked_ticks: number; last_blocked_at: Date | null }>(
      `UPDATE iam_operational_sync_block_state
          SET status='clear',consecutive_blocked_ticks=0,first_blocked_at=NULL,last_error=NULL,last_code=NULL,
              pending_outbox=0,alerted_at=NULL,last_recovered_at=now()
        WHERE business_id = $1 AND site_device_id = $2 AND status = 'blocked'
        RETURNING total_blocked_ticks,last_blocked_at`,
      [businessId, siteDeviceId],
    );
    const row = rows[0];
    if (!row) return empty;
    return {
      recovered: true,
      totalBlockedTicks: Number(row.total_blocked_ticks ?? 0),
      lastBlockedAt: row.last_blocked_at?.toISOString() ?? null,
    };
  } catch (error) {
    console.error(
      `operational sync block clear failed for business ${businessId}:`,
      error instanceof Error ? error.message : error,
    );
    return empty;
  }
}
