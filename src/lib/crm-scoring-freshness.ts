/**
 * Keeping RFM scores fresh, in the background.
 *
 * ## Why this is a job and not a hook
 *
 * An RFM score is a **whole-population** property: a customer is in the top
 * recency quintile only relative to everyone else. So one customer buying
 * something does not change one score — in principle it shifts the quintile
 * boundaries for the entire customer base.
 *
 * There are three ways to handle that, and two of them are wrong:
 *
 * 1. **Rescore on checkout.** Fatally wrong. It puts a full-table aggregation
 *    over every customer and every order on the critical path of taking money.
 *    On a busy Friday with 20k customers, the till waits for a report. Worse,
 *    a failure in a *reporting* calculation would fail the *sale* — the
 *    customer is standing there with a card in their hand and the CRM's
 *    analytics broke the payment.
 * 2. **Rescore on read.** Subtly wrong. Scores would change between two page
 *    loads while an owner was looking at them, and every viewer would pay for
 *    a full population scan.
 * 3. **Mark dirty on change; rescore on a timer.** What this module does.
 *
 * ## Staleness is visible, not hidden
 *
 * `crm_scoring_state` records when the data last changed (`dirty_since`), when
 * scoring last ran, and whether it worked. The UI shows the age of the numbers
 * rather than implying they are live. A day-old score labelled «به‌روزرسانی:
 * دیروز» is honest and useful; the same score presented as current is a lie
 * that nobody can detect.
 *
 * A failure is recorded and surfaced, never swallowed. Scores that silently
 * stopped updating three weeks ago are worse than no scores, because decisions
 * get made on them.
 */

import type { PoolClient } from "pg";
import { query, withTenant, withoutTenantScope } from "./db";
import { isAppServiceOperational } from "./service-activation/app-gate-service";
import { recomputeRfm } from "./crm-service";

/**
 * How often the tick looks for work.
 *
 * Fifteen minutes, not one: RFM is a behavioural measure over months, and a
 * quintile boundary does not meaningfully move in sixty seconds. The cost of
 * being fifteen minutes stale is nil; the cost of scanning every business's
 * order history every minute is real.
 */
export const CRM_SCORING_TICK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long a business must have been dirty before it is rescored.
 *
 * Debounce, not delay. A lunch rush marks a business dirty on every single
 * order; without this, the tick would rescore the same business repeatedly
 * while the rush is still going. Waiting for a quiet-ish gap means one scan
 * covers the whole rush.
 */
const DIRTY_DEBOUNCE_MS = 10 * 60 * 1000;

/**
 * Rescore at least this often even with no activity at all.
 *
 * Recency decays with the calendar, not with events: a customer who last
 * bought in Farvardin becomes more «در خطر» every day that passes, and no
 * order will ever arrive to mark that business dirty. A shop that closes for
 * Nowruz must not come back to scores frozen at the moment it shut.
 */
const MAX_SCORE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A scoring run that has been "running" longer than this is presumed dead.
 *
 * The `running_since` guard stops two workers scoring one business at once,
 * but a process killed mid-run leaves the flag set forever and that business
 * would never be scored again. Reclaiming after an hour costs at worst one
 * duplicated scan — and scoring is idempotent, so a duplicate is harmless.
 */
const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Mark a business's scores as out of date.
 *
 * Called from the paths that change what a score is derived from: a completed
 * order, a merge, an import. Deliberately **tiny** — one upsert of one row,
 * with no aggregation — because it runs on the checkout path and anything
 * heavier there is the mistake this whole module exists to avoid.
 *
 * Never throws. A failure to note that scores are stale must not fail the sale
 * that made them stale; the next event, or the daily floor, will catch it.
 */
const MARK_DIRTY_SQL = `INSERT INTO crm_scoring_state (business_id, dirty_since)
   VALUES ($1, now())
   ON CONFLICT (business_id) DO UPDATE
     -- COALESCE, not now(): dirty_since is when the data *first* diverged from
     -- the scores. Overwriting it on every order would push it forward
     -- continuously during a rush, and the debounce that waits for a quiet gap
     -- would never fire.
     SET dirty_since = COALESCE(crm_scoring_state.dirty_since, now()),
         updated_at = now()`;

export async function markScoringDirty(businessId: string): Promise<void> {
  try {
    await withTenant(businessId, () => query(MARK_DIRTY_SQL, [businessId]));
  } catch {
    // Intentionally swallowed — see above. The daily floor is the backstop.
  }
}

/**
 * The same mark, inside a caller's transaction.
 *
 * Used by the checkout path, which already holds a client and a transaction.
 * Joining it costs no extra connection and no extra round trip beyond the one
 * insert — and if the sale rolls back, so does the dirty mark, which is right:
 * an order that did not happen did not change anyone's score.
 *
 * Note this one does **not** swallow errors. Inside somebody else's
 * transaction, catching a failed statement would leave the transaction aborted
 * while telling the caller everything was fine, and every later statement
 * would fail with a far more confusing error. The caller decides.
 */
export async function markScoringDirtyIn(
  client: PoolClient,
  businessId: string,
): Promise<void> {
  await client.query(MARK_DIRTY_SQL, [businessId]);
}

/**
 * Clear only the dirtiness a completed run actually accounted for.
 *
 * The run scanned the data as it stood at `runStartedAt`. Any dirty mark from
 * before that moment is satisfied; any mark set *during* the scan refers to a
 * change the run did not see and must survive, or the signal is lost until the
 * daily floor picks it up hours later.
 *
 * ## Why a timestamp comparison and not an equality check
 *
 * The obvious implementation — remember `dirty_since`, clear it if it has not
 * changed — does not work across this boundary. Postgres stores `timestamptz`
 * with microsecond precision; a value round-tripped through a JavaScript
 * `Date` has milliseconds. `2026-09-20T11:16:35.277333Z` comes back as
 * `…277Z`, so the equality never holds, the flag is never cleared, and the
 * business is rescored on every single tick forever. That is a slow, silent,
 * expensive failure, and it is exactly what the first version of this did.
 *
 * Comparing against the run's own start time avoids the round trip entirely
 * and expresses the actual intent.
 */
const CLEAR_SATISFIED_DIRT = `dirty_since = CASE
             WHEN crm_scoring_state.dirty_since <= $3::timestamptz
             THEN NULL ELSE crm_scoring_state.dirty_since END`;

/**
 * Record that a manual recompute succeeded.
 *
 * The button in the UI calls `recomputeRfm` directly rather than going through
 * the tick, so without this the state row would still say the business is
 * dirty and the tick would redo the identical scan minutes later.
 */
export async function recordManualScoringRun(
  businessId: string,
  scored: number,
  runStartedAt: Date,
): Promise<void> {
  await withTenant(businessId, () =>
    query(
      `INSERT INTO crm_scoring_state (business_id, last_run_at, last_run_status, last_scored_count)
       VALUES ($1, now(), 'ok', $2)
       ON CONFLICT (business_id) DO UPDATE
         SET last_run_at = now(), last_run_status = 'ok', last_error = '',
             last_scored_count = $2, running_since = NULL,
             ${CLEAR_SATISFIED_DIRT},
             updated_at = now()`,
      [businessId, scored, runStartedAt.toISOString()],
    ),
  );
}

export interface ScoringFreshness {
  /** True when something has changed since the last successful run. */
  dirty: boolean;
  dirtySince: string | null;
  lastRunAt: string | null;
  lastRunStatus: "idle" | "running" | "ok" | "failed";
  lastError: string;
  lastScoredCount: number;
  /** Whole hours since the last successful run — what the UI labels. */
  ageHours: number | null;
}

/**
 * How fresh this business's scores are, for display.
 *
 * Returns a usable shape even when no row exists: a business that has never
 * been scored is `idle` with a null age, which the UI renders as «هنوز
 * محاسبه نشده» rather than as a zero-hour-old score.
 */
export async function scoringFreshness(businessId: string): Promise<ScoringFreshness> {
  const { rows } = await withTenant(businessId, () =>
    query<{
      dirty_since: string | null;
      last_run_at: string | null;
      last_run_status: string;
      last_error: string;
      last_scored_count: number;
      age_hours: number | null;
    }>(
      `SELECT dirty_since, last_run_at, last_run_status, last_error, last_scored_count,
              CASE WHEN last_run_at IS NULL THEN NULL
                   ELSE floor(extract(epoch FROM (now() - last_run_at)) / 3600)::integer
              END AS age_hours
         FROM crm_scoring_state WHERE business_id = $1`,
      [businessId],
    ),
  );
  const row = rows[0];
  if (!row) {
    return {
      dirty: false,
      dirtySince: null,
      lastRunAt: null,
      lastRunStatus: "idle",
      lastError: "",
      lastScoredCount: 0,
      ageHours: null,
    };
  }
  const lastRunAt = row.last_run_at;
  return {
    dirty: row.dirty_since !== null,
    dirtySince: row.dirty_since,
    lastRunAt,
    lastRunStatus: (row.last_run_status as ScoringFreshness["lastRunStatus"]) ?? "idle",
    lastError: row.last_error ?? "",
    lastScoredCount: Number(row.last_scored_count ?? 0),
    // Derive age on the database clock that wrote last_run_at. Comparing a
    // database timestamp with Date.now() makes a boundary answer depend on
    // clock skew between application and database hosts.
    ageHours: row.age_hours === null ? null : Number(row.age_hours),
  };
}

/** Businesses due for a rescore, chosen under the platform bypass. */
async function dueBusinessIds(now: Date): Promise<string[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string }>(
      // Three reasons to be due, and the LEFT JOIN matters: a business with no
      // state row at all has never been scored, which is the most due of all.
      // An inner join would permanently skip exactly the businesses that need
      // it most.
      `SELECT b.id
         FROM businesses b
         LEFT JOIN crm_scoring_state s ON s.business_id = b.id
        WHERE (
                -- dirty, and quiet long enough to be worth a scan
                (s.dirty_since IS NOT NULL AND s.dirty_since < $1)
                -- or simply old: recency decays with the calendar
                OR s.last_run_at IS NULL
                OR s.last_run_at < $2
              )
          -- not already being scored by another worker, unless that claim has
          -- gone stale and is presumed dead
          AND (s.running_since IS NULL OR s.running_since < $3)
        ORDER BY b.id`,
      [
        new Date(now.getTime() - DIRTY_DEBOUNCE_MS).toISOString(),
        new Date(now.getTime() - MAX_SCORE_AGE_MS).toISOString(),
        new Date(now.getTime() - STALE_RUN_MS).toISOString(),
      ],
    );
    return rows.map((row) => row.id);
  });
}

/**
 * Claim a business for scoring.
 *
 * Returns false when another worker got there first. The claim is a
 * conditional UPDATE rather than a read-then-write, so two workers racing
 * cannot both succeed — the second one's WHERE clause matches nothing.
 */
async function claim(businessId: string, now: Date): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO crm_scoring_state (business_id, running_since, last_run_status)
     VALUES ($1, now(), 'running')
     ON CONFLICT (business_id) DO UPDATE
       SET running_since = now(), last_run_status = 'running', updated_at = now()
     WHERE crm_scoring_state.running_since IS NULL
        OR crm_scoring_state.running_since < $2`,
    [businessId, new Date(now.getTime() - STALE_RUN_MS).toISOString()],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Score every business that needs it.
 *
 * One business failing must never stop the next — a single tenant with corrupt
 * data would otherwise freeze scoring for the entire deployment. Each failure
 * is recorded against its own business and the loop continues.
 */
export async function runCrmScoringTick(now = new Date()): Promise<number> {
  const businessIds = await dueBusinessIds(now);
  let scored = 0;

  for (const businessId of businessIds) {
    try {
      // Leave dirty scoring state untouched while CRM is paused so it can be
      // picked up when the service is explicitly active again.
      if (!(await isAppServiceOperational(businessId, "crm"))) continue;
      const didScore = await withTenant(businessId, async () => {
        if (!(await claim(businessId, now))) return false;

        // Stamped before the scan begins: the run accounts for everything that
        // was dirty as of this instant, and nothing that happens after it.
        const runStartedAt = new Date();

        try {
          const result = await recomputeRfm(businessId);
          await query(
            `UPDATE crm_scoring_state
                SET last_run_at = now(), last_run_status = 'ok', last_error = '',
                    last_scored_count = $2, running_since = NULL,
                    ${CLEAR_SATISFIED_DIRT},
                    updated_at = now()
              WHERE business_id = $1`,
            [businessId, result.scored, runStartedAt.toISOString()],
          );
          return true;
        } catch (error) {
          // Recorded against this business and surfaced in the UI. Scores that
          // quietly stopped updating are worse than no scores, because people keep
          // making decisions on them.
          await query(
            `UPDATE crm_scoring_state
                SET last_run_status = 'failed', last_error = $2,
                    running_since = NULL, updated_at = now()
              WHERE business_id = $1`,
            [businessId, String(error).slice(0, 500)],
          ).catch(() => undefined);
          return false;
        }
      });
      if (didScore) scored += 1;
    } catch (err) {
      console.error(`CRM scoring tick failed for business ${businessId}:`, err);
    }
  }

  return scored;
}
