/**
 * Issue #1367 — the reconciliation policy for Deep Research work that was open
 * when the workflow was retired.
 *
 * Retirement is a code deploy. This module answers the one operational
 * question the deploy cannot: a run row may have been `awaiting_approval` or
 * `running` at cutover, and those states are now unreachable. What should they
 * become?
 *
 * The policy is deliberately narrow and non-destructive:
 *
 *  - `awaiting_approval` → `cancelled`. It never started, and creation writes
 *    no cost, so no money is involved.
 *  - `running` **whose environment has expired** → `failed`. It did start, so
 *    "failed" is the truthful terminal state; its recorded cost, tokens and
 *    settlement rows are untouched.
 *  - `running` that has not expired is **left alone**. During a rolling deploy
 *    an old instance may still be finishing it; the report can be re-run after
 *    the TTL.
 *
 * Nothing here approves, executes, reprices or deletes a run. The database
 * client is passed in so the policy is testable without a live Postgres and so
 * the operator script (which connects with the RLS-bypass session) is the only
 * thing that decides *whether* to apply it.
 */

export interface ResearchReconcileClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows?: T[]; rowCount?: number | null }>;
}

export interface OpenResearchRuns {
  pending: number;
  runningLive: number;
  runningExpired: number;
  running: number;
}

export interface ResearchReconcileOutcome {
  before: OpenResearchRuns;
  after: OpenResearchRuns;
  applied: { cancelled: number; failed: number } | null;
}

const OPEN_SQL = `SELECT
   count(*) FILTER (WHERE status = 'awaiting_approval')::text AS pending,
   count(*) FILTER (WHERE status = 'running' AND (expires_at IS NULL OR expires_at >= now()))::text
     AS running_live,
   count(*) FILTER (WHERE status = 'running' AND expires_at < now())::text AS running_expired
 FROM ai_research_runs
 WHERE status IN ('awaiting_approval', 'running')
   AND ($1::uuid IS NULL OR business_id = $1)`;

/** Count the runs still in a state the retirement made unreachable. */
export async function readOpenResearchRuns(
  client: ResearchReconcileClient,
  businessId: string | null,
): Promise<OpenResearchRuns> {
  const { rows } = await client.query<{
    pending: string;
    running_live: string;
    running_expired: string;
  }>(OPEN_SQL, [businessId]);
  const row = rows?.[0];
  const pending = Number(row?.pending ?? 0);
  const runningLive = Number(row?.running_live ?? 0);
  const runningExpired = Number(row?.running_expired ?? 0);
  return { pending, runningLive, runningExpired, running: runningLive + runningExpired };
}

/**
 * Apply the documented terminal states. Only the two shapes above are touched;
 * the `expires_at < now()` predicate is what keeps a live rolling-deploy run out
 * of the update.
 */
export async function reconcileRetiredResearchRuns(
  client: ResearchReconcileClient,
  businessId: string | null,
): Promise<{ cancelled: number; failed: number }> {
  const cancelled = await client.query(
    `UPDATE ai_research_runs
        SET status = 'cancelled', error = 'research_retired',
            finished_at = COALESCE(finished_at, now()), updated_at = now()
      WHERE status = 'awaiting_approval'
        AND ($1::uuid IS NULL OR business_id = $1)`,
    [businessId],
  );
  const failed = await client.query(
    `UPDATE ai_research_runs
        SET status = 'failed', error = 'research_retired',
            finished_at = COALESCE(finished_at, now()), updated_at = now()
      WHERE status = 'running'
        AND expires_at < now()
        AND ($1::uuid IS NULL OR business_id = $1)`,
    [businessId],
  );
  return {
    cancelled: cancelled.rowCount ?? 0,
    failed: failed.rowCount ?? 0,
  };
}

/**
 * Report, optionally apply, and report what is true afterwards — rather than
 * claiming the update succeeded. The returned `applied: null` means report-only.
 */
export async function reconcileResearchRetirement(
  client: ResearchReconcileClient,
  input: { businessId: string | null; apply: boolean },
): Promise<ResearchReconcileOutcome> {
  const before = await readOpenResearchRuns(client, input.businessId);
  const applied = input.apply
    ? await reconcileRetiredResearchRuns(client, input.businessId)
    : null;
  const after = await readOpenResearchRuns(client, input.businessId);
  return { before, after, applied };
}
