/**
 * The service desk's clock — one rule, one implementation, three readers.
 *
 * ## Why this is its own module
 *
 * A case's lateness was decided in **two** places with two different rules:
 *
 * - `caseSla()` in `crm-case-service.ts` — the SLA backend. It subtracts the
 *   time a case spent *waiting on the customer*, and once somebody has replied,
 *   it measures the breach against **first response** rather than age.
 * - `caseBreached()` in `crm-shared.ts` — the badge on the list, which compared
 *   raw age against the target and ignored both facts.
 *
 * So the same ticket could be «در زمان هدف» in the summary panel at the top of
 * the screen and «معوق» in its own row, and a saved view filtering on breach
 * would have been a third opinion. That is the class of disagreement this
 * codebase refuses elsewhere (`docs/crm-architecture.md`: *"the reader's filter
 * offers the entity the writer used"*), and the fix is not to reconcile two
 * rules but to have one.
 *
 * The rule now lives here: **pure** — no `db`, no clock of its own (`now` is a
 * parameter), so the client can recompute a countdown without asking the
 * server, the service can use it for the summary, and the SQL filter in
 * `listCases` can be proven to agree with it by test.
 *
 * ## The rule itself, in one paragraph
 *
 * A case is the team's responsibility only while the ball is in the team's
 * court:
 *
 * - **A case in `waiting` is never late.** The clock belongs to the customer
 *   while we are waiting for an answer, and marking the shop late for the
 *   customer's silence makes the whole indicator meaningless — which is also why
 *   the summary reports waiting cases as their own figure and counts them in
 *   neither `breached` nor `atRisk`.
 * - **Waiting time is accumulated and subtracted**, so a case that was asked a
 *   question for four days and then answered is not judged on those four days,
 *   even after it leaves `waiting`.
 * - **Breach is judged against `first_response_at` once anybody has replied** —
 *   "somebody acknowledged me" and "my problem is fixed" are different promises
 *   — and against elapsed active time before that.
 * - **A resolved or closed case is not breaching anything**: the clock stops at
 *   resolution, and a case resolved in two hours did not become a breach because
 *   nobody closed the tab for a week.
 */

import {
  CASE_PRIORITY_TARGET_HOURS,
  type CasePriority,
  type CaseStatus,
} from "./crm-shared";

/** Statuses where the team owes the customer something. */
export const CASE_ACTIVE_STATUSES: readonly CaseStatus[] = ["open", "in_progress"];

/** The status that means the clock is paused because we are waiting on them. */
export const CASE_WAITING_STATUS: CaseStatus = "waiting";

/** Statuses where the case is finished and no clock runs at all. */
export const CASE_CLOSED_STATUSES: readonly CaseStatus[] = ["resolved", "closed"];

export interface CaseClock {
  /** Target for this case's priority, in hours. */
  targetHours: number;
  /**
   * Seconds the case has been the team's responsibility — elapsed time minus
   * everything spent waiting on the customer.
   */
  activeSeconds: number;
  /** True once the promise this case's priority measures has been missed. */
  breached: boolean;
  /** Seconds left before breach; negative once breached. */
  remainingSeconds: number;
  /** Seconds from opening to first response, excluding waiting. Null if none yet. */
  firstResponseSeconds: number | null;
  /** True while the customer owes us something — the clock is paused. */
  waitingOnCustomer: boolean;
}

export interface CaseClockInput {
  priority: CasePriority;
  status: CaseStatus;
  openedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  /** Accumulated seconds spent waiting on the customer (a stored total). */
  waitingSeconds: number;
  /** When the current wait began, if the case is waiting right now. */
  waitingSince: string | null;
  /** Injectable so tests do not have to freeze time. */
  now?: Date;
}

export function caseClock(input: CaseClockInput): CaseClock {
  const now = input.now ?? new Date();
  const targetHours = CASE_PRIORITY_TARGET_HOURS[input.priority] ?? 72;
  const opened = new Date(input.openedAt).getTime();

  // The clock stops at resolution. A case resolved in two hours did not become
  // a breach because nobody closed the tab for a week.
  const endpoint = input.resolvedAt ? new Date(input.resolvedAt).getTime() : now.getTime();

  // Accumulated waiting, plus the stretch currently in progress if the case is
  // waiting right now — `waiting_seconds` is only closed out on the way back to
  // an active status, so an in-flight wait is not in it yet.
  let waiting = Math.max(0, Number(input.waitingSeconds) || 0);
  if (input.status === CASE_WAITING_STATUS && input.waitingSince) {
    waiting += Math.max(0, (endpoint - new Date(input.waitingSince).getTime()) / 1000);
  }

  const elapsed = Math.max(0, (endpoint - opened) / 1000);
  const activeSeconds = Math.max(0, Math.round(elapsed - waiting));
  const targetSeconds = targetHours * 3600;

  let firstResponseSeconds: number | null = null;
  if (input.firstResponseAt) {
    // Waiting before the first response is unusual but possible — the team can
    // ask a clarifying question without that counting as a substantive reply.
    // Subtracting it keeps this consistent with `activeSeconds`.
    const responded = new Date(input.firstResponseAt).getTime();
    const waitBeforeResponse = Math.min(waiting, Math.max(0, (responded - opened) / 1000));
    firstResponseSeconds = Math.max(0, Math.round((responded - opened) / 1000 - waitBeforeResponse));
  }

  const closed = CASE_CLOSED_STATUSES.includes(input.status);
  const waitingOnCustomer = input.status === CASE_WAITING_STATUS;
  return {
    targetHours,
    activeSeconds,
    // A case that has been responded to is not breaching its *response* target
    // any more, even if it is still open — the promise it measures was kept.
    // And while the customer owes us an answer, nothing is late.
    breached:
      waitingOnCustomer
        ? false
        : firstResponseSeconds === null
          ? activeSeconds > targetSeconds && !closed
          : firstResponseSeconds > targetSeconds,
    remainingSeconds: targetSeconds - activeSeconds,
    firstResponseSeconds,
    waitingOnCustomer,
  };
}

/**
 * The plain boolean, for a row that carries the whole case.
 *
 * Kept as its own name because that is how every reader asks the question, and
 * because a caller passing a *partial* row should get "not breached" rather
 * than a crash: the fields default to "no response yet, no accumulated wait",
 * which is the pre-0160 state of a case and the honest reading of a row that
 * predates them.
 */
export function caseIsBreached(
  input: {
    status: CaseStatus;
    priority: CasePriority;
    openedAt: string;
    resolvedAt: string | null;
    firstResponseAt?: string | null;
    waitingSeconds?: number | null;
    waitingSince?: string | null;
  },
  now?: Date,
): boolean {
  if (Number.isNaN(Date.parse(input.openedAt))) return false;
  return caseClock({
    priority: input.priority,
    status: input.status,
    openedAt: input.openedAt,
    firstResponseAt: input.firstResponseAt ?? null,
    resolvedAt: input.resolvedAt,
    waitingSeconds: Number(input.waitingSeconds ?? 0),
    waitingSince: input.waitingSince ?? null,
    now,
  }).breached;
}

/**
 * The policy values the SQL predicate is handed, as one object.
 *
 * The SQL holds the arithmetic and nothing else: the hours map and the closed
 * statuses arrive as parameters built from *these* constants — the same ones the
 * TypeScript clock reads — so a change to a target cannot land in one
 * implementation and miss the other. `listCases` passes this object through
 * rather than assembling the parameters itself for exactly that reason.
 */
export const CASE_BREACH_SQL_CASES = {
  targets: CASE_PRIORITY_TARGET_HOURS,
  closed: CASE_CLOSED_STATUSES,
} as const;

/**
 * The waiting expression the SQL breach predicate refers to, by name.
 *
 * Written once here so the predicate and the reader agree on what "waiting"
 * even means: `waiting_seconds` only carries waits that have *finished* — a case
 * waiting right now has not closed out its stretch yet — so the in-flight wait
 * is added from `waiting_since`. Parameter-free, because the expression is
 * inlined wherever it is needed.
 */
export const CASE_WAITING_SQL = `(
  greatest(0, k.waiting_seconds)
  + CASE WHEN k.status = 'waiting' AND k.waiting_since IS NOT NULL
         THEN greatest(0, extract(epoch FROM (coalesce(k.resolved_at, now()) - k.waiting_since)))
         ELSE 0 END
)`;

/**
 * The SQL predicate that decides the same thing as `caseClock().breached`.
 *
 * `listCases` has to narrow in the database — a filter applied after the read
 * would be a filter the `LIMIT` had already broken, and `breached` is a *count*
 * somebody acts on — so the rule is written twice: once in TypeScript, once in
 * SQL. That is a real cost, paid deliberately rather than by loading every case
 * and filtering in memory. The two are proven to agree by
 * `integration/crm-case-views.test.ts`, and that agreement test is the point of
 * writing it twice.
 *
 * Only the arithmetic is duplicated. The policy — which priorities have which
 * target (`CASE_PRIORITY_TARGET_HOURS`), which statuses run no clock
 * (`CASE_CLOSED_STATUSES`), and that `waiting` is never late — is passed in by
 * the caller from the same constants the TypeScript side reads, and the waiting
 * expression itself is `CASE_WAITING_SQL` above.
 *
 * `params.targets` is a `$n` holding the hours map as jsonb; `params.closed` is a
 * `$n` holding the closed statuses as `text[]`.
 */
export function caseBreachSql(params: { targets: string; closed: string }): string {
  return `(
  -- The clock belongs to the customer while we are waiting for an answer, so a
  -- waiting case is late for nothing.
  k.status <> 'waiting'
  AND CASE WHEN k.first_response_at IS NOT NULL THEN
    -- Responded: the promise being measured is the first response, minus any
    -- wait that happened before it.
    greatest(0,
      extract(epoch FROM (k.first_response_at - k.opened_at))
      - least(${CASE_WAITING_SQL}, extract(epoch FROM (k.first_response_at - k.opened_at)))
    ) > (${params.targets}::jsonb ->> k.priority)::numeric * 3600
  ELSE
    -- Not responded: active time, and a closed case is not late for anything.
    (k.status <> ALL(${params.closed}::text[]))
    AND greatest(0,
      extract(epoch FROM (coalesce(k.resolved_at, now()) - k.opened_at)) - ${CASE_WAITING_SQL}
    ) > (${params.targets}::jsonb ->> k.priority)::numeric * 3600
  END
)`;
}
