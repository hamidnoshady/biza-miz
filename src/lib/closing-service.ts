/**
 * Phase 16 — exact year-end closing entries.
 *
 * Rolls a fiscal year's revenue/expense accounts into Retained Earnings and
 * locks all twelve periods in one transaction. The closing entry is dated on
 * the year's final day and constructed while the last period is soft-closed;
 * the DB trigger allows that one initial parent-and-lines construction only
 * when the live canonical authorization snapshot holds ledger.close_period.
 */
import { getPool, type PoolClient } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  accountIdsByCode,
  MissingLedgerAccountError,
  postExactJournalEntry,
  type ExactJournalLine,
} from "./ledger-service";
import { FiscalPeriodError, readUncoveredEntries } from "./fiscal-periods-service";
import { FISCAL_PERIOD_COUNT, fiscalPeriodLockErrorCode } from "./fiscal-periods";
import type { RialText } from "./inventory-exact";
import { isUuid } from "./uuid";
import {
  calculateDimensionalClosingLines,
  closingTupleRows,
} from "./closing-dimensions";

export { MissingLedgerAccountError };

export interface CloseFiscalYearResult {
  fiscalYearId: string;
  closingEntryId: string | null;
  /** Exact signed integer Rial, serialized as a decimal string. */
  netIncome: string;
}

export interface ClosingBalance {
  account_id: string;
  account_type: "revenue" | "expense";
  debit: string;
  credit: string;
  /** Issue #868 — the dimension tuple this balance sits in. */
  cost_center_id?: string | null;
  profit_center_id?: string | null;
  department_id?: string | null;
  detail_dimension_id?: string | null;
}

export interface CalculatedClosingLines {
  lines: ExactJournalLine[];
  netIncome: bigint;
}

/**
 * Pure exact-Rial closing calculation. PostgreSQL aggregates arrive as decimal
 * strings; this function never crosses JavaScript's floating-point boundary.
 */
export function calculateClosingLines(totals: readonly ClosingBalance[]): CalculatedClosingLines {
  let netIncome = 0n;
  const lines: ExactJournalLine[] = [];

  for (const row of totals) {
    const debit = BigInt(row.debit);
    const credit = BigInt(row.credit);
    if (debit < 0n || credit < 0n) throw new Error("invalid_closing_balance");

    if (row.account_type === "revenue") {
      const balance = credit - debit; // normal credit balance; close with a debit
      netIncome += balance;
      lines.push({
        accountId: row.account_id,
        debit: (balance > 0n ? balance : 0n).toString() as RialText,
        credit: (balance < 0n ? -balance : 0n).toString() as RialText,
      });
    } else {
      const balance = debit - credit; // normal debit balance; close with a credit
      netIncome -= balance;
      lines.push({
        accountId: row.account_id,
        debit: (balance < 0n ? -balance : 0n).toString() as RialText,
        credit: (balance > 0n ? balance : 0n).toString() as RialText,
      });
    }
  }

  return { lines, netIncome };
}

async function writeClosingAudit(
  client: PoolClient,
  input: {
    businessId: string;
    actorId: string;
    action: string;
    entity: "fiscal_period" | "fiscal_year";
    entityId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.businessId, input.actorId, input.action, input.entity, input.entityId, JSON.stringify(input.payload)],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => {});
}

/**
 * Closes fiscal year `fiscalYearId`: all twelve periods must already be
 * soft-closed. Posts one exact closing entry (or none for an empty year),
 * locks every period, and appends their audit events plus the final year event
 * in the same transaction.
 */
export async function closeFiscalYear(
  businessId: string,
  fiscalYearId: string,
  actorId: string,
): Promise<CloseFiscalYearResult> {
  if (!isUuid(fiscalYearId)) throw new FiscalPeriodError("fiscal_year_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: yearRows } = await client.query<{
      id: string;
      label: string;
      starts_on: string;
      ends_on: string;
      closed_at: string | null;
    }>(
      `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, closed_at
         FROM fiscal_years WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [fiscalYearId, businessId],
    );
    const year = yearRows[0];
    if (!year) throw new FiscalPeriodError("fiscal_year_not_found", 404);
    if (year.closed_at) throw new FiscalPeriodError("fiscal_year_already_closed", 409);

    // Period transitions lock this parent before locking any child. Holding the
    // same year row serializes final close against reopen/status transitions.
    const { rows: periods } = await client.query<{
      id: string;
      label: string;
      starts_on: string;
      ends_on: string;
      status: string;
    }>(
      `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, status::text AS status
         FROM fiscal_periods
        WHERE business_id = $1 AND fiscal_year_id = $2
        FOR UPDATE`,
      [businessId, fiscalYearId],
    );
    if (periods.length !== FISCAL_PERIOD_COUNT) {
      throw new FiscalPeriodError("periods_incomplete", 409);
    }
    if (periods.some((period) => period.status !== "soft_closed")) {
      throw new FiscalPeriodError("periods_not_ready", 409);
    }

    // Do not silently omit legacy entries dated outside all configured years.
    const uncovered = await readUncoveredEntries(businessId, { upTo: year.ends_on, client });
    if (uncovered.count > 0) {
      throw new FiscalPeriodError("uncovered_entries_before_close", 409, { uncovered });
    }

    // Issue #868 — the closing balances grouped by (account × dimension
    // tuple): each group closes against retained earnings carrying its own
    // tuple, so every dimension group balances within itself and a year with
    // no attribution produces exactly the entry this always produced.
    const { rows: totals } = await client.query<ClosingBalance>(
      `SELECT a.id AS account_id, a.type::text AS account_type,
              jl.cost_center_id, jl.profit_center_id, jl.department_id, jl.detail_dimension_id,
              SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND a.type IN ('revenue', 'expense')
          AND je.entry_date BETWEEN $2 AND $3
        GROUP BY a.id, a.type, jl.cost_center_id, jl.profit_center_id, jl.department_id, jl.detail_dimension_id
       HAVING SUM(jl.debit) <> SUM(jl.credit)`,
      [businessId, year.starts_on, year.ends_on],
    );

    const retainedEarnings = await accountIdsByCode(client, businessId, [WELL_KNOWN_CODES.retainedEarnings]);
    const retainedEarningsId = retainedEarnings.get(WELL_KNOWN_CODES.retainedEarnings)!;
    const calculated = calculateDimensionalClosingLines(closingTupleRows(totals), retainedEarningsId);
    const lines: ExactJournalLine[] = calculated.lines;
    const netIncome = calculated.netIncome;

    let closingEntryId: string | null = null;
    try {
      closingEntryId = await postExactJournalEntry(client, {
        businessId,
        locationId: null,
        entryDate: year.ends_on,
        memo: "بستن حساب‌های سال مالی",
        sourceType: "closing",
        sourceId: fiscalYearId,
        lines,
        createdBy: actorId,
        postingKind: "closing",
        // The closing entry mirrors the year's own attribution (issue #868):
        // a dimension value archived after the year's postings must not stop
        // the year from closing. The database's structural guards still apply.
        dimensionMirror: true,
      });
    } catch (err) {
      const code = fiscalPeriodLockErrorCode(err);
      if (code === "fiscal_period_not_defined") {
        throw new FiscalPeriodError("fiscal_period_not_defined", 409);
      }
      if (code) throw new FiscalPeriodError("period_locked_for_closing", 409);
      throw err;
    }

    const { rows: lockedPeriods } = await client.query<{
      id: string;
      label: string;
      starts_on: string;
      ends_on: string;
      locked_at: string;
    }>(
      `UPDATE fiscal_periods
          SET status = 'locked', locked_at = now(), locked_by = $3
        WHERE business_id = $1 AND fiscal_year_id = $2 AND status = 'soft_closed'
        RETURNING id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, locked_at`,
      [businessId, fiscalYearId, actorId],
    );
    for (const period of lockedPeriods) {
      await writeClosingAudit(client, {
        businessId,
        actorId,
        action: "fiscal_period.locked",
        entity: "fiscal_period",
        entityId: period.id,
        payload: {
          fiscalYearId,
          periodId: period.id,
          periodLabel: period.label,
          actorId,
          startsOn: period.starts_on,
          endsOn: period.ends_on,
          previousStatus: "soft_closed",
          newStatus: "locked",
          before: { status: "soft_closed" },
          after: { status: "locked", lockedAt: period.locked_at },
          closingEntryId,
          netIncome: netIncome.toString(),
          finalClose: true,
        },
      });
    }

    const { rows: closedYears } = await client.query<{ closed_at: string }>(
      `UPDATE fiscal_years SET closed_at = now(), closed_by = $3
        WHERE id = $1 AND business_id = $2 AND closed_at IS NULL
        RETURNING closed_at`,
      [fiscalYearId, businessId, actorId],
    );
    if (!closedYears[0]) throw new FiscalPeriodError("fiscal_year_already_closed", 409);

    const exactNetIncome = netIncome.toString();
    await writeClosingAudit(client, {
      businessId,
      actorId,
      action: "fiscal_year.closed",
      entity: "fiscal_year",
      entityId: fiscalYearId,
      payload: {
        fiscalYearId,
        label: year.label,
        actorId,
        startsOn: year.starts_on,
        endsOn: year.ends_on,
        closingEntryId,
        netIncome: exactNetIncome,
        before: { closedAt: null },
        after: { closedAt: closedYears[0].closed_at, closingEntryId, netIncome: exactNetIncome },
        lockedPeriodIds: lockedPeriods.map((period) => period.id),
      },
    });

    await client.query("COMMIT");
    return { fiscalYearId, closingEntryId, netIncome: exactNetIncome };
  } catch (err) {
    await rollback(client);
    throw err;
  } finally {
    client.release();
  }
}
