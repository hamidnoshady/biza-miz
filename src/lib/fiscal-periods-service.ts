/**
 * Phase 16 — fiscal years & periods, the DB-touching part.
 *
 * The pure period-generation and transition-validity logic stays in
 * fiscal-periods.ts. This layer owns the transactional boundaries around the
 * records: a status transition locks both its period and parent year, so it
 * cannot race a final year close into an impossible "closed year / open
 * period" state.
 */
import { getPool, query, type PoolClient } from "./db";
import { businessToday } from "./business-day-service";
import {
  canTransitionPeriod,
  fiscalYearSpec,
  type FiscalPeriodStatus,
} from "./fiscal-periods";
import {
  evaluateFiscalReadiness,
  type FiscalReadiness,
  type UncoveredEntrySummary,
} from "./fiscal-readiness";
import { isUuid } from "./uuid";

export class FiscalPeriodError extends Error {
  status: number;
  /** Optional structured context a route may return beside the code. */
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

export interface FiscalYearSummary {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
}

export interface FiscalPeriod {
  id: string;
  fiscalYearId: string;
  label: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: FiscalPeriodStatus;
  softClosedAt: string | null;
  lockedAt: string | null;
  reopenedAt: string | null;
}

interface FiscalYearRow extends Record<string, unknown> {
  id: string;
  label: string;
  starts_on: string;
  ends_on: string;
  closed_at: string | null;
}

interface FiscalPeriodRow extends Record<string, unknown> {
  id: string;
  fiscal_year_id: string;
  label: string;
  starts_on: string;
  ends_on: string;
  status: FiscalPeriodStatus;
  soft_closed_at: string | null;
  locked_at: string | null;
  reopened_at: string | null;
}

interface TransitionRow extends Record<string, unknown> {
  status: FiscalPeriodStatus;
}

interface LockedFiscalYearRow extends Record<string, unknown> {
  closed_at: string | null;
}

function toYearSummary(r: FiscalYearRow): FiscalYearSummary {
  return { id: r.id, label: r.label, startsOn: r.starts_on, endsOn: r.ends_on, closedAt: r.closed_at };
}

const MONTH_NAMES = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

function toPeriod(r: FiscalPeriodRow): FiscalPeriod {
  const monthIndex = Number(r.label.split("-")[1]) - 1;
  const year = r.label.split("-")[0];
  return {
    id: r.id,
    fiscalYearId: r.fiscal_year_id,
    label: r.label,
    name: `${MONTH_NAMES[monthIndex] ?? r.label} ${year}`,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    softClosedAt: r.soft_closed_at,
    lockedAt: r.locked_at,
    reopenedAt: r.reopened_at,
  };
}

function postgresCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/** Best-effort cleanup must not hide the operation's original failure. */
async function rollback(client: { query: (text: string) => Promise<unknown> }): Promise<void> {
  await client.query("ROLLBACK").catch(() => {});
}

/** Every fiscal year defined for this business, newest first. */
export async function listFiscalYears(businessId: string): Promise<FiscalYearSummary[]> {
  const { rows } = await query<FiscalYearRow>(
    `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, closed_at
       FROM fiscal_years WHERE business_id = $1 ORDER BY starts_on DESC`,
    [businessId],
  );
  return rows.map(toYearSummary);
}

/**
 * A fiscal year's twelve periods, in calendar order. A random / stale URL is
 * a missing fiscal year, not an empty valid year: every year is created with
 * all twelve periods in the same transaction.
 */
export async function listPeriods(businessId: string, fiscalYearId: string): Promise<FiscalPeriod[]> {
  if (!isUuid(fiscalYearId)) throw new FiscalPeriodError("fiscal_year_not_found", 404);

  const { rows: yearRows } = await query<{ id: string }>(
    "SELECT id FROM fiscal_years WHERE business_id = $1 AND id = $2",
    [businessId, fiscalYearId],
  );
  if (!yearRows[0]) throw new FiscalPeriodError("fiscal_year_not_found", 404);

  const { rows } = await query<FiscalPeriodRow>(
    `SELECT id, fiscal_year_id, label, starts_on::text AS starts_on, ends_on::text AS ends_on,
            status::text AS status, soft_closed_at, locked_at, reopened_at
       FROM fiscal_periods WHERE business_id = $1 AND fiscal_year_id = $2 ORDER BY starts_on`,
    [businessId, fiscalYearId],
  );
  return rows.map(toPeriod);
}

/**
 * Defines a fiscal year (the Jalali year `jy`) and its twelve periods for a
 * business, atomically. `ON CONFLICT … DO NOTHING` turns two tabs defining the
 * same year at once into the documented 409 instead of leaking a database
 * unique-violation as a 500.
 */
export async function createFiscalYear(businessId: string, jy: number): Promise<FiscalYearSummary> {
  const spec = fiscalYearSpec(jy);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: yearRows } = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, label) DO NOTHING
       RETURNING id`,
      [businessId, spec.label, spec.startsOn, spec.endsOn],
    );
    const fiscalYearId = yearRows[0]?.id;
    if (!fiscalYearId) throw new FiscalPeriodError("fiscal_year_exists", 409);

    for (const period of spec.periods) {
      await client.query(
        `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
         VALUES ($1, $2, $3, $4, $5)`,
        [businessId, fiscalYearId, period.label, period.startsOn, period.endsOn],
      );
    }

    await client.query("COMMIT");
    return { id: fiscalYearId, label: spec.label, startsOn: spec.startsOn, endsOn: spec.endsOn, closedAt: null };
  } catch (err) {
    await rollback(client);
    // A pre-existing malformed/manual period can conflict with this canonical
    // year. Do not turn it into a generic 500; it needs an accounting review.
    if (postgresCode(err) === "23505" || postgresCode(err) === "23P01") {
      throw new FiscalPeriodError("fiscal_period_overlap", 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

const STATUS_COLUMNS: Record<Exclude<FiscalPeriodStatus, "open">, { at: string; by: string }> = {
  soft_closed: { at: "soft_closed_at", by: "soft_closed_by" },
  locked: { at: "locked_at", by: "locked_by" },
};

/**
 * Moves a period through open -> soft closed -> locked, or reopens it. The
 * fiscal-year row is locked together with the period: closeFiscalYear locks
 * that same parent first, which serializes a final year close against an
 * individual reopen and preserves the finalized-year invariant.
 */
export async function setPeriodStatus(
  businessId: string,
  periodId: string,
  status: FiscalPeriodStatus,
  actorId: string,
): Promise<FiscalPeriod> {
  if (!isUuid(periodId)) throw new FiscalPeriodError("period_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // All lifecycle writers take locks in this order: fiscal year, then
    // period. `closeFiscalYear` does the same. The first lightweight lookup
    // only identifies that parent; locking the period first would deadlock if
    // final close held the parent while this transition held the child.
    const { rows: parentRows } = await client.query<{ fiscal_year_id: string }>(
      "SELECT fiscal_year_id FROM fiscal_periods WHERE id = $1 AND business_id = $2",
      [periodId, businessId],
    );
    const fiscalYearId = parentRows[0]?.fiscal_year_id;
    if (!fiscalYearId) throw new FiscalPeriodError("period_not_found", 404);

    const { rows: fiscalYearRows } = await client.query<LockedFiscalYearRow>(
      `SELECT closed_at FROM fiscal_years
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [fiscalYearId, businessId],
    );
    const fiscalYear = fiscalYearRows[0];
    if (!fiscalYear) throw new FiscalPeriodError("period_not_found", 404);

    const { rows } = await client.query<TransitionRow>(
      `SELECT status::text AS status FROM fiscal_periods
        WHERE id = $1 AND business_id = $2 AND fiscal_year_id = $3
        FOR UPDATE`,
      [periodId, businessId, fiscalYearId],
    );
    const current = rows[0];
    if (!current) throw new FiscalPeriodError("period_not_found", 404);
    if (!canTransitionPeriod(current.status, status)) {
      throw new FiscalPeriodError("invalid_transition", 409);
    }
    // A period can't be individually reopened once its whole fiscal year has
    // been closed — that would leave a posted closing entry under an open
    // period. The migration repeats this protection for direct SQL writers.
    if (status === "open" && fiscalYear.closed_at) {
      throw new FiscalPeriodError("fiscal_year_closed", 409);
    }

    let updateSql: string;
    let params: unknown[];
    if (status === "open") {
      updateSql = `UPDATE fiscal_periods SET status = 'open', reopened_at = now(), reopened_by = $3
                   WHERE id = $1 AND business_id = $2
                   RETURNING id, fiscal_year_id, label, starts_on::text AS starts_on, ends_on::text AS ends_on,
                             status::text AS status, soft_closed_at, locked_at, reopened_at`;
      params = [periodId, businessId, actorId];
    } else {
      const cols = STATUS_COLUMNS[status];
      updateSql = `UPDATE fiscal_periods SET status = $3, ${cols.at} = now(), ${cols.by} = $4
                   WHERE id = $1 AND business_id = $2
                   RETURNING id, fiscal_year_id, label, starts_on::text AS starts_on, ends_on::text AS ends_on,
                             status::text AS status, soft_closed_at, locked_at, reopened_at`;
      params = [periodId, businessId, status, actorId];
    }

    const { rows: updated } = await client.query<FiscalPeriodRow>(updateSql, params);
    await client.query("COMMIT");
    return toPeriod(updated[0]);
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Coverage / readiness (audit finding F08). Read-only: nothing here rejects,
// moves or re-dates an entry — see fiscal-readiness.ts for the policy.
// ---------------------------------------------------------------------------

const UNCOVERED_ENTRIES_SQL = `
  SELECT count(*)::int            AS count,
         min(je.entry_date)::text AS earliest,
         max(je.entry_date)::text AS latest
    FROM journal_entries je
   WHERE je.business_id = $1
     AND ($2::date IS NULL OR je.entry_date <= $2::date)
     AND NOT EXISTS (
           SELECT 1 FROM fiscal_periods fp
            WHERE fp.business_id = je.business_id
              AND je.entry_date BETWEEN fp.starts_on AND fp.ends_on
         )`;

interface UncoveredRow extends Record<string, unknown> {
  count: number;
  earliest: string | null;
  latest: string | null;
}

/**
 * Journal entries dated outside every configured fiscal period (optionally
 * only those on or before `upTo`). Pass `client` to read inside a caller's
 * transaction — `closeFiscalYear` does, under its year lock.
 */
export async function readUncoveredEntries(
  businessId: string,
  options: { upTo?: string; client?: PoolClient } = {},
): Promise<UncoveredEntrySummary> {
  const params = [businessId, options.upTo ?? null];
  const { rows } = options.client
    ? await options.client.query<UncoveredRow>(UNCOVERED_ENTRIES_SQL, params)
    : await query<UncoveredRow>(UNCOVERED_ENTRIES_SQL, params);
  const row = rows[0];
  const count = Number(row?.count ?? 0);
  return count > 0
    ? { count, earliest: row.earliest, latest: row.latest }
    : { count: 0, earliest: null, latest: null };
}

/** Is any fiscal year configured, is today covered, what is uncovered, can a year be closed. */
export async function getFiscalReadiness(businessId: string): Promise<FiscalReadiness> {
  const [fiscalYears, today, uncovered] = await Promise.all([
    listFiscalYears(businessId),
    businessToday(businessId),
    readUncoveredEntries(businessId),
  ]);
  const { rows } = await query<{ covered: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM fiscal_periods
        WHERE business_id = $1 AND $2::date BETWEEN starts_on AND ends_on
     ) AS covered`,
    [businessId, today],
  );
  return evaluateFiscalReadiness({
    fiscalYears,
    today,
    todayCovered: rows[0]?.covered === true,
    uncovered,
  });
}
