/**
 * Service cases and their response clock — «تیکت‌های خدمات».
 *
 * ## The one thing this gets right that naive SLA tracking gets wrong
 *
 * A case's age is not the time since it was opened. Some of that time was
 * spent **waiting on the customer**: the team asked for the order number, or a
 * photo of the damaged item, and then nothing happened for four days because
 * the customer was on holiday.
 *
 * If that time counts against the response target, three bad things follow:
 *
 * 1. Every report says the team is failing when it is not, so the reports get
 *    ignored — which costs more than never having built them.
 * 2. The fastest way to protect the number becomes *not asking the customer
 *    anything*, which is the opposite of good service.
 * 3. The genuinely-breached cases — the ones actually sitting on somebody's
 *    desk untouched — are buried among false positives and nobody finds them.
 *
 * So `waiting` time is accumulated into `waiting_seconds` and subtracted. The
 * clock a team is judged on runs only while the ball is in the team's court.
 * That is also why the accumulator is a stored total rather than something
 * derived at read time: a case can bounce between waiting and active a dozen
 * times, and reconstructing that from a status column is impossible — the
 * column only knows where the case is now.
 *
 * ## First response is separate from resolution
 *
 * `first_response_at` is stamped once and never moved. "Somebody acknowledged
 * me" and "my problem is fixed" are different promises with different targets,
 * and collapsing them hides the case that got a fast reply and then sat for
 * two weeks.
 */

import { query, withTenantTransaction } from "./db";
import { recordCrmAudit } from "./crm-audit-service";
import {
  CASE_PRIORITY_TARGET_HOURS,
  isCasePriority,
  isCaseStatus,
  type CasePriority,
  type CaseStatus,
} from "./crm-shared";
import { isUuid } from "./uuid";
import {
  CASE_ACTIVE_STATUSES,
  CASE_CLOSED_STATUSES,
  CASE_WAITING_STATUS,
  caseClock,
  type CaseClock,
} from "./crm-case-clock";

/**
 * Statuses where the team owes the customer something. Defined in
 * `crm-case-clock.ts` so the SQL breach predicate, the badge and the summary
 * cannot disagree about which ones run a clock.
 */
const ACTIVE_STATUSES = CASE_ACTIVE_STATUSES;

const WAITING_STATUS = CASE_WAITING_STATUS;

/** Statuses where the case is finished and no clock runs at all. */
const CLOSED_STATUSES = CASE_CLOSED_STATUSES;

/**
 * A case's SLA position. The rule itself lives in `crm-case-clock.ts` — pure,
 * shared with the list's badge and with the SQL filter — and this name is kept
 * because it is what the SLA readers import.
 */
export type CaseSla = CaseClock;

export const caseSla = caseClock;

export interface CaseStatusChange {
  ok: boolean;
  error?: "not_found" | "same_status" | "invalid_status";
  sla?: CaseSla;
}

/**
 * Move a case to another status, maintaining the waiting accumulator.
 *
 * Transactional, because the case row, the accumulator and the history event
 * have to move together — a status change recorded without its event leaves
 * the SLA history permanently unreconstructable, and there is no way to repair
 * it afterwards because the information simply was not written down.
 */
export async function setCaseStatus(
  businessId: string,
  caseId: string,
  nextStatus: string,
  actor: { name: string; userId?: string | null },
  options: { comment?: string; isInternal?: boolean } = {},
): Promise<CaseStatusChange> {
  if (!isUuid(caseId)) return { ok: false, error: "not_found" };
  if (!isCaseStatus(nextStatus)) return { ok: false, error: "invalid_status" };

  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{
      id: string;
      status: CaseStatus;
      priority: CasePriority;
      opened_at: string;
      first_response_at: string | null;
      resolved_at: string | null;
      waiting_seconds: string;
      waiting_since: string | null;
      customer_id: string | null;
      subject: string;
    }>(
      `SELECT id, status, priority, opened_at, first_response_at, resolved_at,
              waiting_seconds, waiting_since, customer_id, subject
         FROM crm_cases
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [businessId, caseId],
    );
    const row = rows[0];
    if (!row) return { ok: false, error: "not_found" as const };
    if (row.status === nextStatus) return { ok: false, error: "same_status" as const };

    const leavingWaiting = row.status === WAITING_STATUS;
    const enteringWaiting = nextStatus === WAITING_STATUS;
    const becomingClosed = CLOSED_STATUSES.includes(nextStatus as CaseStatus);

    // Close out an in-flight wait on the way to any other status. Without
    // this, a case that bounces waiting → active → waiting loses the first
    // stretch entirely and its SLA silently improves each time it bounces.
    const closeOutWait = leavingWaiting && row.waiting_since !== null;

    await query(
      `UPDATE crm_cases
          SET status = $3,
              waiting_seconds = waiting_seconds + CASE
                WHEN $4 THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - waiting_since))::bigint)
                ELSE 0 END,
              waiting_since = CASE WHEN $5 THEN now() ELSE NULL END,
              resolved_at = CASE WHEN $6 THEN COALESCE(resolved_at, now()) ELSE NULL END,
              closed_at = CASE WHEN $3 = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END,
              -- Stamped once, never moved: "somebody acknowledged me" happened
              -- when it happened, and a later reply does not change that.
              first_response_at = COALESCE(first_response_at,
                CASE WHEN $7 THEN now() ELSE NULL END),
              -- A reopened case is a distinct failure mode from a slow one,
              -- and a count of them is the only way to see it.
              reopened_count = reopened_count + CASE
                WHEN $8 AND resolved_at IS NOT NULL THEN 1 ELSE 0 END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        caseId,
        nextStatus,
        closeOutWait,
        enteringWaiting,
        becomingClosed,
        // Moving off `open` for the first time is the team's first response.
        row.status === "open" && row.first_response_at === null && !becomingClosed,
        // Coming back from resolved/closed to anything active is a reopen.
        CLOSED_STATUSES.includes(row.status) && !becomingClosed,
      ],
    );

    await query(
      `INSERT INTO crm_case_events
         (business_id, case_id, kind, from_status, to_status, body, is_internal,
          actor_user_id, actor_name)
       VALUES ($1, $2, 'status_changed', $3, $4, $5, $6, $7, $8)`,
      [
        businessId,
        caseId,
        row.status,
        nextStatus,
        options.comment?.trim() ?? "",
        options.isInternal !== false,
        actor.userId ?? null,
        actor.name,
      ],
    );

    const { rows: after } = await query<{
      status: CaseStatus;
      priority: CasePriority;
      opened_at: string;
      first_response_at: string | null;
      resolved_at: string | null;
      waiting_seconds: string;
      waiting_since: string | null;
    }>(
      `SELECT status, priority, opened_at, first_response_at, resolved_at,
              waiting_seconds, waiting_since
         FROM crm_cases WHERE business_id = $1 AND id = $2`,
      [businessId, caseId],
    );

    await recordCrmAudit({
      businessId,
      kind: "case.status_changed",
      entityType: "case",
      entityId: caseId,
      partyId: row.customer_id,
      summary: `«${row.subject}»: ${row.status} ← ${nextStatus}`,
      detail: { from: row.status, to: nextStatus },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    const current = after[0];
    return {
      ok: true,
      sla: caseSla({
        priority: current.priority,
        status: current.status,
        openedAt: current.opened_at,
        firstResponseAt: current.first_response_at,
        resolvedAt: current.resolved_at,
        waitingSeconds: Number(current.waiting_seconds ?? 0),
        waitingSince: current.waiting_since,
      }),
    };
  });
}

export interface CaseSlaSummary {
  open: number;
  /** Past target and nobody has responded — the list that needs action today. */
  breached: number;
  /** Paused: the customer owes us something. Explicitly not counted as late. */
  waitingOnCustomer: number;
  /** Within target but past 75% of it. */
  atRisk: number;
  medianFirstResponseSeconds: number | null;
}

/**
 * SLA position across all open cases.
 *
 * The three numbers are kept apart deliberately. A single «۱۲ تیکت معطل» that
 * lumps together cases waiting on the customer and cases nobody has touched is
 * worse than useless — it makes the team defensive about a figure they cannot
 * act on, and hides the handful that genuinely need attention today.
 */
export async function caseSlaSummary(businessId: string): Promise<CaseSlaSummary> {
  const { rows } = await query<{
    status: CaseStatus;
    priority: CasePriority;
    opened_at: string;
    first_response_at: string | null;
    resolved_at: string | null;
    waiting_seconds: string;
    waiting_since: string | null;
  }>(
    `SELECT status, priority, opened_at, first_response_at, resolved_at,
            waiting_seconds, waiting_since
       FROM crm_cases
      WHERE business_id = $1 AND status IN ('open', 'in_progress', 'waiting')`,
    [businessId],
  );

  let breached = 0;
  let waitingOnCustomer = 0;
  let atRisk = 0;
  for (const row of rows) {
    const sla = caseSla({
      priority: row.priority,
      status: row.status,
      openedAt: row.opened_at,
      firstResponseAt: row.first_response_at,
      resolvedAt: row.resolved_at,
      waitingSeconds: Number(row.waiting_seconds ?? 0),
      waitingSince: row.waiting_since,
    });
    if (sla.waitingOnCustomer) {
      waitingOnCustomer += 1;
      // Deliberately not also counted as breached or at risk: the clock is
      // paused, and reporting it as late would be blaming the team for the
      // customer's silence.
      continue;
    }
    if (sla.breached) breached += 1;
    else if (sla.remainingSeconds < sla.targetHours * 3600 * 0.25) atRisk += 1;
  }

  // Median, not mean: response times are long-tailed, and one case that sat
  // over Nowruz would drag a mean into meaninglessness.
  const { rows: medianRows } = await query<{ median: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (first_response_at - opened_at)) - waiting_seconds
            )::text AS median
       FROM crm_cases
      WHERE business_id = $1 AND first_response_at IS NOT NULL`,
    [businessId],
  );
  const median = medianRows[0]?.median;

  return {
    open: rows.length,
    breached,
    waitingOnCustomer,
    atRisk,
    medianFirstResponseSeconds: median === null || median === undefined
      ? null
      : Math.max(0, Math.round(Number(median))),
  };
}

/** Allocate this business's next human-readable case number. */
export async function nextCaseNumber(businessId: string): Promise<number> {
  const { rows } = await query<{ next_number: number }>(
    // A per-business counter table rather than a sequence: a global sequence
    // would leak one tenant's case volume to another, and a competitor reading
    // «تیکت #۴۸۲۱» learns something they should not.
    `INSERT INTO crm_case_counters (business_id, next_number) VALUES ($1, 2)
     ON CONFLICT (business_id) DO UPDATE
       SET next_number = crm_case_counters.next_number + 1
     RETURNING next_number - 1 AS next_number`,
    [businessId],
  );
  return Number(rows[0]?.next_number ?? 1);
}

export { ACTIVE_STATUSES, CLOSED_STATUSES, WAITING_STATUS };
