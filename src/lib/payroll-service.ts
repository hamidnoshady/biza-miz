/**
 * Phase 16 + audit F11 + issue #835 — payroll, the DB-touching part.
 *
 * Journal-level payroll, gross to net, with every rate the business's own: a
 * run is one Jalali month; it computes each active member's gross-to-net with
 * the pure calculator in `payroll-gross-to-net.ts` against the business's own
 * settings (`SETTING_KEYS.payroll` — nothing statutory is assumed, and an empty
 * document means no deduction, so gross = net), snapshots each person's full
 * breakdown into `payroll_run_lines`, and posts ONE accrual:
 *
 *   Dr 5200 salaries expense            gross
 *   Dr 5220 employer insurance expense  employer + unemployment shares
 *      Cr 2300 salaries payable         net pay
 *      Cr 2460 insurance payable        employee + employer + unemployment shares
 *      Cr 2470 payroll tax payable      income tax withheld
 *      Cr 1260 staff advances           advances recovered
 *      Cr 2490 other deductions payable other fixed deductions withheld
 *
 * Paying the run posts the other half for the *net* (plus any commission it
 * settles): Debit 2300 / Credit a cash, bank or petty-cash account. The
 * withholdings stay in their payables until the business remits them. Every
 * posting goes through the shared `postExactJournalEntry()` /
 * `postExactMirrorEntry()` every other path uses, so the fiscal-period lock
 * applies to all of them. Advances (مساعده) live in
 * `payroll-advances-service.ts`.
 *
 * ## What issue #835 settled, and why
 *
 * **Business-wide.** A run covers *every* active member with a wage, so it is a
 * business-wide fact. It used to be posted under whichever branch the caller
 * happened to have active, and the payment and the void re-resolved the active
 * branch again — so one salary bill could land on three branches. A run, its
 * accrual, its payment and its void now all post with a NULL location: no branch
 * selector can move them. A *legacy* run that was stored with a branch keeps it,
 * and its payment and void reuse that stored location — never the caller's.
 * Voids mirror each original entry with that entry's own location.
 *
 * **One run per month, retry-safe.** `period_key` (`YYYY-MM`) is what the
 * database makes unique among runs that are not voided (migration 0214); an
 * `idempotencyKey` makes a retry of the same request return the run it created
 * (migration 0215). A month booked before periods had a key is recognised by
 * its normalised label. See `accruePayroll`.
 *
 * **Commission is paid with payroll.** Commission accrues Debit 5210 / Credit
 * 2300 when a sale posts, so it is already in salaries payable. A run claims the
 * unsettled commission accruals it settles (one `payroll_run_id` per accrual, so
 * nothing is settled twice), snapshots the per-employee amount, and its payment
 * debits 2300 for net wages + commission. No second accrual is posted for
 * commission, and no deduction is applied to it: it is settled as it accrued.
 *
 * **Exact money.** Amounts are `bigint` in the database and in the calculator,
 * and integer *text* on the wire (`RialText`); nothing is converted through
 * `Number`.
 *
 * DB-touching, so per repo convention it has no direct unit test. Covered by
 * integration/payroll.integration.test.ts; the pure parts have their own tests
 * (payroll-gross-to-net, payroll-period, payroll-amounts, payroll-history-query,
 * payroll-payment-accounts).
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { normalizeOptionalIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { businessToday } from "./business-day-service";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { accountIdsByCode, MissingLedgerAccountError, postExactJournalEntry, postExactMirrorEntry } from "./ledger-service";
import { MAX_RIAL, type RialText } from "./inventory-exact";
import {
  computeGrossToNet,
  EMPTY_PAYROLL_SETTINGS,
  parsePayrollSettings,
  payrollAccrualTotals,
  type GrossToNetBreakdown,
  type PayrollSettings,
} from "./payroll-gross-to-net";
import { parseRialInput } from "./payroll-amounts";
import { resolvePayoutAccount } from "./payroll-accounts";
import { outstandingAdvances } from "./payroll-advances-service";
import { asRial, clientRunner, inTransaction, lockPayroll, poolRunner, type Runner } from "./payroll-db";
import { PayrollError } from "./payroll-errors";
import {
  decodePayTermCursor,
  decodeRunCursor,
  encodePayTermCursor,
  encodeRunCursor,
  pageSize,
  type ListPayrollRunsOptions,
  type PayTermCursor,
  type RunCursor,
} from "./payroll-history-query";
import { payrollPeriodKeyForLabel, resolvePayrollPeriodFilter, resolvePayrollPeriodKey } from "./payroll-period";
import type {
  PayrollCommissionPreview,
  PayrollLiability,
  PayrollRun,
  PayrollRunLine,
  PayrollRunStatus,
  PayrollRunSummary,
  PayTerm,
  PayTermChange,
  StaffWage,
} from "./payroll-types";
import { PAY_TERMS } from "./payroll-types";

export { MissingLedgerAccountError, PayrollError };
export type {
  ListPayrollRunsOptions,
  PayrollCommissionPreview,
  PayrollLiability,
  PayrollRun,
  PayrollRunLine,
  PayrollRunStatus,
  PayrollRunSummary,
  PayTerm,
  PayTermChange,
  StaffWage,
};

/** The longest reason a pay-term change may carry. */
const REASON_MAX = 500;

/** Keys a client may attach to an accrual request: printable ASCII, no spaces, 8–128 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The business's payroll settings, normalised. A stored document that no
 * longer parses (hand-edited, or written by an older shape) reads as nothing
 * entered rather than failing the screen.
 */
export async function getPayrollSettings(businessId: string): Promise<PayrollSettings> {
  const stored = await getSetting<unknown>(businessId, SETTING_KEYS.payroll);
  const parsed = parsePayrollSettings(stored);
  return parsed.ok ? parsed.value : { ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [] };
}

export async function savePayrollSettings(businessId: string, raw: unknown): Promise<PayrollSettings> {
  const parsed = parsePayrollSettings(raw);
  if (!parsed.ok) throw new PayrollError(parsed.error, 400, parsed.field);
  await setSetting(businessId, SETTING_KEYS.payroll, parsed.value);
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Staff pay terms
// ---------------------------------------------------------------------------

/** The `users` column that holds each term — and the value `payroll_pay_term_changes.term` stores. */
const TERM_COLUMN: Record<PayTerm, string> = {
  monthlyWage: "monthly_wage",
  taxableAllowance: "monthly_taxable_allowance",
  nonTaxableAllowance: "monthly_non_taxable_allowance",
  fixedDeduction: "monthly_fixed_deduction",
};
const TERM_OF_COLUMN = new Map(Object.entries(TERM_COLUMN).map(([term, column]) => [column, term as PayTerm]));

export async function listStaffWages(businessId: string): Promise<StaffWage[]> {
  const { rows } = await query<{
    id: string;
    full_name: string;
    role: string;
    monthly_wage: string | null;
    monthly_taxable_allowance: string;
    monthly_non_taxable_allowance: string;
    monthly_fixed_deduction: string;
  }>(
    `SELECT id, full_name, role, monthly_wage::text AS monthly_wage,
            monthly_taxable_allowance::text AS monthly_taxable_allowance,
            monthly_non_taxable_allowance::text AS monthly_non_taxable_allowance,
            monthly_fixed_deduction::text AS monthly_fixed_deduction
       FROM users WHERE business_id = $1 AND is_active ORDER BY full_name, id`,
    [businessId],
  );
  const advances = await outstandingAdvances(poolRunner, businessId);
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    role: r.role,
    monthlyWage: r.monthly_wage,
    taxableAllowance: r.monthly_taxable_allowance,
    nonTaxableAllowance: r.monthly_non_taxable_allowance,
    fixedDeduction: r.monthly_fixed_deduction,
    advanceOutstanding: (advances.get(r.id) ?? 0n).toString(),
  }));
}

function parseReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PayrollError("invalid_wage_reason");
  const reason = value.trim();
  if (reason === "") return null;
  if (reason.length > REASON_MAX) throw new PayrollError("invalid_wage_reason");
  return reason;
}

/**
 * What a PATCH may carry: only the keys present are written, so saving the
 * wage cannot zero an allowance the caller did not send. Values are checked
 * here (`parseRialInput`): a JSON number up to 2^53 − 1 or integer text; the
 * wage alone may be `null`, meaning «no wage set».
 */
export type StaffPayTermsPatch = Partial<Record<PayTerm, unknown>>;

export interface PayTermChangeResult {
  term: PayTerm;
  /** Integer Rial; null = no wage was set. */
  previousAmount: string | null;
  /** Integer Rial; null = the wage was cleared. */
  newAmount: string | null;
}

/**
 * `parseRialInput`, but a refusal names the term it refused. A patch can carry
 * four amounts, so `invalid_amount` on its own would not say which box is
 * wrong; the code and the HTTP status are unchanged.
 */
function parseTermAmount(term: PayTerm, value: unknown): bigint {
  try {
    return parseRialInput(value);
  } catch (err) {
    if (err instanceof PayrollError) throw new PayrollError(err.message, err.status, term);
    throw err;
  }
}

/**
 * Updates one member's standing pay terms — and records every change.
 *
 * The member row is locked, the previous values read from it, the new ones
 * written and the history rows inserted in one transaction, so every history
 * row's previous amount is the previous row's new amount even under concurrent
 * edits. Saving the value a member already has writes nothing: no UPDATE, no
 * history row. `actorId` is who is changing it; the history keeps their name as
 * it was (see `payroll_pay_term_changes`, which is append-only).
 *
 * A patch that names none of the four terms is a `bad_request`: it used to
 * clear the wage.
 */
export async function setStaffPayTerms(params: {
  businessId: string;
  userId: string;
  patch: StaffPayTermsPatch;
  actorId: string | null;
  reason?: string | null;
}): Promise<{ changed: boolean; changes: PayTermChangeResult[] }> {
  // `users.id` is a uuid: `WHERE id = $1` against a non-uuid raises
  // `invalid input syntax for type uuid` rather than matching no row — a 500
  // and «خطای غیرمنتظره» where an honest 404 belongs. See `isUuid`.
  if (!isUuid(params.userId)) throw new PayrollError("user_not_found", 404);

  const requested: Array<{ term: PayTerm; next: bigint | null }> = [];
  for (const term of PAY_TERMS) {
    if (!(term in params.patch)) continue;
    const value = params.patch[term];
    if (value === null && term === "monthlyWage") requested.push({ term, next: null });
    else requested.push({ term, next: parseTermAmount(term, value) });
  }
  if (requested.length === 0) throw new PayrollError("bad_request");
  const reason = parseReason(params.reason);

  return inTransaction(async (client) => {
    const { rows } = await client.query<Record<string, string | null>>(
      `SELECT full_name, monthly_wage::text AS monthly_wage,
              monthly_taxable_allowance::text AS monthly_taxable_allowance,
              monthly_non_taxable_allowance::text AS monthly_non_taxable_allowance,
              monthly_fixed_deduction::text AS monthly_fixed_deduction
         FROM users WHERE id = $1 AND business_id = $2 AND is_active FOR UPDATE`,
      [params.userId, params.businessId],
    );
    const member = rows[0];
    if (!member) throw new PayrollError("user_not_found", 404);

    const changes: PayTermChangeResult[] = [];
    for (const { term, next } of requested) {
      const previous = member[TERM_COLUMN[term]] ?? null;
      const nextText = next === null ? null : next.toString();
      if (previous === nextText) continue;
      changes.push({ term, previousAmount: previous, newAmount: nextText });
    }
    if (changes.length === 0) return { changed: false, changes };

    const sets = changes.map((change, i) => `${TERM_COLUMN[change.term]} = $${i + 3}`);
    await client.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 AND business_id = $2`, [
      params.userId,
      params.businessId,
      ...changes.map((change) => change.newAmount),
    ]);

    let actorName: string | null = null;
    if (params.actorId && isUuid(params.actorId)) {
      const { rows: actorRows } = await client.query<{ full_name: string }>(
        `SELECT full_name FROM users WHERE id = $1 AND business_id = $2`,
        [params.actorId, params.businessId],
      );
      actorName = actorRows[0]?.full_name ?? null;
    }
    for (const change of changes) {
      await client.query(
        `INSERT INTO payroll_pay_term_changes
           (business_id, user_id, employee_name_snapshot, term, previous_amount, new_amount,
            changed_by, changed_by_name_snapshot, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          params.businessId,
          params.userId,
          member.full_name,
          TERM_COLUMN[change.term],
          change.previousAmount,
          change.newAmount,
          params.actorId && isUuid(params.actorId) ? params.actorId : null,
          actorName,
          reason,
        ],
      );
    }
    return { changed: true, changes };
  });
}

/**
 * One member's pay-term history, newest first, with a keyset cursor.
 *
 * Deliberately readable for a member who is no longer active or has been
 * deleted — an audit trail that vanished with the person it audits would not be
 * one. The route that serves it needs `payroll.view`; this function does no
 * permission check of its own.
 */
export async function listPayTermChanges(
  businessId: string,
  userId: string,
  options: { limit?: number | null; cursor?: string | null } = {},
): Promise<{ changes: PayTermChange[]; nextCursor: string | null }> {
  if (!isUuid(userId)) throw new PayrollError("user_not_found", 404);
  const limit = pageSize(options.limit);

  const after: PayTermCursor | null = options.cursor ? decodePayTermCursor(options.cursor) : null;

  const { rows } = await query<{
    id: string;
    user_id: string;
    employee_name_snapshot: string;
    term: string;
    previous_amount: string | null;
    new_amount: string | null;
    changed_by: string | null;
    changed_by_name_snapshot: string | null;
    changed_at: string;
    changed_at_text: string;
    reason: string | null;
  }>(
    `SELECT id, user_id, employee_name_snapshot, term, previous_amount::text AS previous_amount,
            new_amount::text AS new_amount, changed_by, changed_by_name_snapshot,
            to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at,
            changed_at::text AS changed_at_text, reason
       FROM payroll_pay_term_changes
      WHERE business_id = $1 AND user_id = $2
        AND ($3::timestamptz IS NULL OR (changed_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY changed_at DESC, id DESC
      LIMIT $5`,
    [businessId, userId, after?.c ?? null, after?.i ?? null, limit + 1],
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    changes: page.map((r) => ({
      id: r.id,
      userId: r.user_id,
      employeeName: r.employee_name_snapshot,
      term: TERM_OF_COLUMN.get(r.term) ?? "monthlyWage",
      previousAmount: r.previous_amount,
      newAmount: r.new_amount,
      changedBy: r.changed_by,
      changedByName: r.changed_by_name_snapshot,
      changedAt: r.changed_at,
      reason: r.reason,
    })),
    nextCursor: rows.length > limit && last ? encodePayTermCursor({ c: last.changed_at_text, i: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// Reading runs
// ---------------------------------------------------------------------------

interface RunRow extends Record<string, unknown> {
  id: string;
  period_key: string | null;
  period_label: string;
  status: PayrollRunStatus;
  total_amount: string;
  net_amount: string;
  commission_total: string;
  payable_amount: string;
  accrual_date: string;
  paid_date: string | null;
  voided_date: string | null;
  created_by_name: string | null;
  line_count: number;
  created_at_text: string;
}

/**
 * The columns every run read returns, so the call sites (list, detail, accrue,
 * pay, void) can never drift on which fields a `RunRow` carries. `r` is the
 * `payroll_runs` alias, `u` the joined creator. Every sum is computed in SQL —
 * `numeric`-safe, never through a JavaScript number. `voided_date` is an ISO
 * instant (Postgres's own `timestamptz::text` is not something `new Date`
 * promises to parse, and a date that fails to parse renders as a dash). A run
 * from before gross-to-net has no `net_amount`: its gross was its net.
 */
const RUN_SELECT_COLUMNS = `r.id, r.period_key, r.period_label, r.status,
            r.total_amount::text AS total_amount,
            COALESCE(r.net_amount, r.total_amount)::text AS net_amount,
            r.commission_total::text AS commission_total,
            (COALESCE(r.net_amount, r.total_amount) + r.commission_total)::text AS payable_amount,
            r.accrual_date::text AS accrual_date, r.paid_date::text AS paid_date,
            to_char(r.voided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS voided_date,
            u.full_name AS created_by_name,
            (SELECT count(*)::int FROM payroll_run_lines rl WHERE rl.run_id = r.id) AS line_count,
            r.created_at::text AS created_at_text`;

function toSummary(r: RunRow): PayrollRunSummary {
  return {
    id: r.id,
    periodKey: r.period_key,
    periodLabel: r.period_label,
    status: r.status,
    totalAmount: r.total_amount,
    netAmount: r.net_amount,
    commissionTotal: r.commission_total,
    payableAmount: r.payable_amount,
    accrualDate: r.accrual_date,
    paidDate: r.paid_date,
    voidedDate: r.voided_date,
    createdByName: r.created_by_name,
    lineCount: r.line_count,
  };
}

interface RunLineRow extends Record<string, unknown> {
  run_id: string;
  user_id: string | null;
  full_name: string | null;
  employee_code: string | null;
  role: string | null;
  amount: string;
  legacy: boolean;
  base_salary: string;
  taxable_allowance: string;
  non_taxable_allowance: string;
  overtime: string;
  insurance_base: string;
  employee_insurance: string;
  employer_insurance: string;
  unemployment_insurance: string;
  taxable_income: string;
  income_tax: string;
  other_deductions: string;
  advance_recovery: string;
  net_pay: string;
  employer_cost: string;
  commission_amount: string;
  payable_amount: string;
}

async function loadLines(businessId: string, runIds: string[]): Promise<Map<string, PayrollRunLine[]>> {
  const byRun = new Map<string, PayrollRunLine[]>();
  if (runIds.length === 0) return byRun;
  // The snapshot is the line's identity; the live member is only a fallback for
  // a legacy line written before snapshots existed. A line from before
  // gross-to-net (`net_pay` NULL) has no breakdown: its whole amount was base
  // pay, gross and net.
  const { rows } = await query<RunLineRow>(
    `SELECT rl.run_id, rl.user_id,
            COALESCE(rl.employee_name_snapshot, u.full_name) AS full_name,
            rl.employee_code_snapshot AS employee_code,
            COALESCE(rl.employee_role_snapshot, u.role::text) AS role,
            rl.amount::text AS amount, rl.net_pay IS NULL AS legacy,
            rl.base_salary::text AS base_salary, rl.taxable_allowance::text AS taxable_allowance,
            rl.non_taxable_allowance::text AS non_taxable_allowance, rl.overtime::text AS overtime,
            rl.insurance_base::text AS insurance_base, rl.employee_insurance::text AS employee_insurance,
            rl.employer_insurance::text AS employer_insurance,
            rl.unemployment_insurance::text AS unemployment_insurance,
            rl.taxable_income::text AS taxable_income, rl.income_tax::text AS income_tax,
            rl.other_deductions::text AS other_deductions, rl.advance_recovery::text AS advance_recovery,
            COALESCE(rl.net_pay, rl.amount)::text AS net_pay,
            (rl.amount + rl.employer_insurance + rl.unemployment_insurance)::text AS employer_cost,
            rl.commission_amount::text AS commission_amount,
            (COALESCE(rl.net_pay, rl.amount) + rl.commission_amount)::text AS payable_amount
       FROM payroll_run_lines rl
       JOIN payroll_runs r ON r.id = rl.run_id
       LEFT JOIN users u ON u.id = rl.user_id
      WHERE r.business_id = $1 AND rl.run_id = ANY($2::uuid[])
      ORDER BY COALESCE(rl.employee_name_snapshot, u.full_name) NULLS LAST, rl.id`,
    [businessId, runIds],
  );
  for (const l of rows) {
    const list = byRun.get(l.run_id) ?? [];
    list.push({
      userId: l.user_id,
      fullName: l.full_name,
      employeeCode: l.employee_code,
      role: l.role,
      amount: l.amount,
      baseSalaryRial: l.legacy ? l.amount : l.base_salary,
      taxableAllowancesRial: l.taxable_allowance,
      nonTaxableAllowancesRial: l.non_taxable_allowance,
      overtimeRial: l.overtime,
      grossRial: l.amount,
      insuranceBaseRial: l.insurance_base,
      employeeInsuranceRial: l.employee_insurance,
      employerInsuranceRial: l.employer_insurance,
      unemploymentInsuranceRial: l.unemployment_insurance,
      taxableIncomeRial: l.taxable_income,
      incomeTaxRial: l.income_tax,
      otherDeductionsRial: l.other_deductions,
      advanceRecoveryRial: l.advance_recovery,
      netPayRial: l.net_pay,
      employerCostRial: l.employer_cost,
      commissionAmount: l.commission_amount,
      payableAmount: l.payable_amount,
    });
    byRun.set(l.run_id, list);
  }
  return byRun;
}

/**
 * The payroll history: newest first, filtered, bounded and cursor-paginated —
 * see `payroll-history-query.ts` for the contract. A page carries summaries; a
 * run's lines are fetched with `getPayrollRun` when its details are opened
 * (`includeLines` exists for internal callers such as the assistant, and is
 * bounded by the same page size).
 */
export async function listPayrollRuns(
  businessId: string,
  options: ListPayrollRunsOptions = {},
): Promise<{ runs: Array<PayrollRunSummary & { lines?: PayrollRunLine[] }>; nextCursor: string | null }> {
  const limit = pageSize(options.limit);
  const after: RunCursor | null = options.cursor ? decodeRunCursor(options.cursor) : null;

  // The period filter compares identities, so «مرداد 1404» finds «۱۴۰۴-۰۵».
  // (A run from before periods had a key has none to compare; reach it by date.)
  const period = options.period ? resolvePayrollPeriodFilter(options.period) : null;
  if (period && !period.ok) throw new PayrollError(period.error);

  const { rows } = await query<RunRow>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.business_id = $1
        AND ($2::text IS NULL OR r.status = $2)
        AND ($3::date IS NULL OR r.accrual_date >= $3::date)
        AND ($4::date IS NULL OR r.accrual_date <= $4::date)
        AND ($5::text IS NULL OR r.period_key = $5)
        AND ($6::date IS NULL OR (r.accrual_date, r.created_at, r.id) < ($6::date, $7::timestamptz, $8::uuid))
      ORDER BY r.accrual_date DESC, r.created_at DESC, r.id DESC
      LIMIT $9`,
    [
      businessId,
      options.status ?? null,
      options.from ?? null,
      options.to ?? null,
      period?.ok ? period.period.key : null,
      after?.d ?? null,
      after?.c ?? null,
      after?.i ?? null,
      limit + 1,
    ],
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeRunCursor({ d: last.accrual_date, c: last.created_at_text, i: last.id }) : null;

  const summaries = page.map(toSummary);
  if (!options.includeLines) return { runs: summaries, nextCursor };

  const lines = await loadLines(businessId, summaries.map((r) => r.id));
  return { runs: summaries.map((r) => ({ ...r, lines: lines.get(r.id) ?? [] })), nextCursor };
}

/** One run with its lines — the lazy half of the history, and what every mutation returns. */
export async function getPayrollRun(businessId: string, runId: string): Promise<PayrollRun | null> {
  if (!isUuid(runId)) return null;
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1 AND r.business_id = $2`,
    [runId, businessId],
  );
  if (!rows[0]) return null;
  const lines = await loadLines(businessId, [rows[0].id]);
  return { ...toSummary(rows[0]), lines: lines.get(rows[0].id) ?? [] };
}

async function mustGetRun(businessId: string, runId: string): Promise<PayrollRun> {
  const run = await getPayrollRun(businessId, runId);
  if (!run) throw new PayrollError("run_not_found", 404);
  return run;
}

// ---------------------------------------------------------------------------
// The 2300 tie-out
// ---------------------------------------------------------------------------

/**
 * Salaries payable (۲۳۰۰) against what payroll knows is owed.
 *
 * A run credits 2300 with the *net* wages it accrues; commission posts to 2300
 * when a sale does and a run settles it later. So the account's balance is the
 * sum of (a) runs accrued and not yet paid — net wages and commission both — and
 * (b) commission accruals no run has taken yet. This reports that decomposition
 * next to the ledger balance; `difference` is what is left unexplained (a manual
 * journal on 2300, or commission paid outside payroll). A «پرداخت‌شده» run
 * therefore never hides an unsettled balance: the commission still owed shows up
 * here by name. (The withholdings sit in 2460/2470/2490 and the recovered
 * advances in 1260; none of them is part of 2300.)
 */
export async function getPayrollLiability(businessId: string): Promise<PayrollLiability> {
  const [ledger, awaiting, unsettled] = await Promise.all([
    query<{ balance: string }>(
      `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS balance
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND a.business_id = $1 AND a.code = $2`,
      [businessId, WELL_KNOWN_CODES.salariesPayable],
    ),
    query<{ total: string }>(
      `SELECT COALESCE(SUM(COALESCE(net_amount, total_amount) + commission_total), 0)::text AS total
         FROM payroll_runs WHERE business_id = $1 AND status = 'accrued'`,
      [businessId],
    ),
    query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM commission_accruals WHERE business_id = $1 AND payroll_run_id IS NULL`,
      [businessId],
    ),
  ]);
  const ledgerBalance = BigInt(ledger.rows[0].balance);
  const awaitingPayment = BigInt(awaiting.rows[0].total);
  const unsettledCommission = BigInt(unsettled.rows[0].total);
  return {
    ledgerBalance: ledgerBalance.toString(),
    awaitingPayment: awaitingPayment.toString(),
    unsettledCommission: unsettledCommission.toString(),
    difference: (ledgerBalance - awaitingPayment - unsettledCommission).toString(),
  };
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

interface CommissionMember {
  userId: string;
  fullName: string;
  role: string;
  employeeCode: string | null;
  /** Net commission this run settles for the member, integer Rial (always positive). */
  amount: bigint;
}

interface CommissionDraft {
  members: CommissionMember[];
  total: bigint;
  /** The commission accrual rows this run would settle (all of each member's rows when their net is positive). */
  claimIds: string[];
}

/**
 * Work out which commission an accrual dated `accrualDate` would settle. The
 * preview and the accrual both call this, so what the screen shows is what is
 * claimed.
 *
 * Each member's unsettled accruals — those no run has claimed, whose journal
 * entry is dated on or before the accrual date (so a back-dated run does not
 * swallow later sales) — are summed as signed amounts, because a return posts a
 * negative accrual. A member whose net is positive is settled in full (every one
 * of their rows is claimed); a member whose net is zero or negative claims
 * nothing, and the rows wait for a later run to net against. Members who have
 * left are included — the liability does not go away with the person.
 *
 * With `lock`, the candidate accrual rows are `FOR UPDATE`d in id order, so two
 * runs building at once cannot both claim the same row: the second waits, then
 * re-reads and finds it taken.
 */
async function collectCommission(
  run: Runner,
  businessId: string,
  accrualDate: string,
  options: { lock: boolean },
): Promise<CommissionDraft> {
  const { rows: accruals } = await run<{ id: string; employee_id: string; amount: string }>(
    `SELECT a.id, a.employee_id, a.amount::text AS amount
       FROM commission_accruals a
       JOIN users cu ON cu.id = a.employee_id AND cu.business_id = a.business_id
       LEFT JOIN journal_entries je ON je.id = a.entry_id
      WHERE a.business_id = $1 AND a.payroll_run_id IS NULL
        AND a.payroll_engine_run_id IS NULL -- issue #865: not reserved by the statutory engine
        AND COALESCE(je.entry_date, a.created_at::date) <= $2::date
      ORDER BY a.id
      ${options.lock ? "FOR UPDATE OF a" : ""}`,
    [businessId, accrualDate],
  );

  const perMember = new Map<string, { net: bigint; ids: string[] }>();
  for (const a of accruals) {
    const entry = perMember.get(a.employee_id) ?? { net: 0n, ids: [] };
    entry.net += BigInt(a.amount);
    entry.ids.push(a.id);
    perMember.set(a.employee_id, entry);
  }
  const settled = [...perMember].filter(([, v]) => v.net > 0n);
  if (settled.length === 0) return { members: [], total: 0n, claimIds: [] };

  const { rows: people } = await run<{ id: string; full_name: string; role: string; employee_code: string | null }>(
    `SELECT u.id, u.full_name, u.role::text AS role, e.employee_code
       FROM users u LEFT JOIN employees e ON e.id = u.id
      WHERE u.business_id = $1 AND u.id = ANY($2::uuid[])`,
    [businessId, settled.map(([id]) => id)],
  );
  const identity = new Map(people.map((p) => [p.id, p]));

  const members: CommissionMember[] = [];
  const claimIds: string[] = [];
  for (const [userId, value] of settled) {
    const person = identity.get(userId);
    if (!person) continue; // not a member of this business: never settle it
    members.push({ userId, fullName: person.full_name, role: person.role, employeeCode: person.employee_code, amount: value.net });
    claimIds.push(...value.ids);
  }
  members.sort((a, b) => a.fullName.localeCompare(b.fullName, "fa") || (a.userId < b.userId ? -1 : 1));
  const total = members.reduce((sum, m) => sum + m.amount, 0n);
  if (total > MAX_RIAL) throw new PayrollError("amount_out_of_range");
  return { members, total, claimIds };
}

/**
 * A run's accrual date when the caller states none: the last day of the month
 * (so a run for a closed month lands in it), or today while the month is still
 * running. `today` is the business's own (`businessToday`), the same value the
 * payment's default date uses, so «accrue, then pay today» can never be refused
 * as a payment before its accrual around midnight.
 */
function defaultAccrualDate(period: { endsOn: string }, today: string): string {
  return period.endsOn < today ? period.endsOn : today;
}

/**
 * The commission an accrual would settle, without claiming it — the screen's
 * preview, built by the same code the accrual runs. `periodKey` fixes the
 * default accrual date (and so the sales cut-off) the way the accrual does.
 */
export async function previewCommission(
  businessId: string,
  options: { periodKey?: string | null; accrualDate?: string | null; includeCommission?: boolean } = {},
): Promise<PayrollCommissionPreview> {
  const normalized = normalizeOptionalIsoDate(options.accrualDate);
  if (!normalized.ok) throw new PayrollError("invalid_accrual_date");
  const period = options.periodKey ? resolvePayrollPeriodKey(options.periodKey) : null;
  if (period && !period.ok) throw new PayrollError(period.error);

  const today = await businessToday(businessId);
  const accrualDate = normalized.value ?? (period?.ok ? defaultAccrualDate(period.period, today) : today);
  if (options.includeCommission === false) return { accrualDate, lines: [], total: "0" };

  const draft = await collectCommission(poolRunner, businessId, accrualDate, { lock: false });
  return {
    accrualDate,
    lines: draft.members.map((m) => ({ userId: m.userId, fullName: m.fullName, amount: m.amount.toString() })),
    total: draft.total.toString(),
  };
}

/** The run that already stands for a month — what `period_already_accrued` names. */
interface StandingRun extends Record<string, unknown> {
  id: string;
  period_label: string;
  status: string;
}

function periodTaken(existing: StandingRun): PayrollError {
  return new PayrollError("period_already_accrued", 409, {
    run: { id: existing.id, periodLabel: existing.period_label, status: existing.status },
  });
}

/** A standing (not voided) run for this month, keyed or legacy, or null. */
async function findStandingRun(client: PoolClient, businessId: string, periodKey: string): Promise<StandingRun | null> {
  const { rows } = await client.query<StandingRun>(
    `SELECT id, period_label, status FROM payroll_runs
      WHERE business_id = $1 AND period_key = $2 AND status <> 'voided'`,
    [businessId, periodKey],
  );
  if (rows[0]) return rows[0];

  // Runs made before periods had a key carry only a free-text label (migration
  // 0214 left their key NULL). They cannot be created any more, so this set only
  // ever shrinks and there is nothing to race; comparing their normalised labels
  // keeps a month booked under the old rules from being booked again under the
  // new ones.
  const { rows: legacy } = await client.query<StandingRun>(
    `SELECT id, period_label, status FROM payroll_runs
      WHERE business_id = $1 AND period_key IS NULL AND status <> 'voided'`,
    [businessId],
  );
  return legacy.find((r) => payrollPeriodKeyForLabel(r.period_label) === periodKey) ?? null;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PayrollError("idempotency_key_invalid");
  const key = value.trim();
  if (key === "") return null;
  if (!IDEMPOTENCY_KEY.test(key)) throw new PayrollError("idempotency_key_invalid");
  return key;
}

/** One member's month on a run: the calculator's breakdown, plus identity and commission. */
interface AccrualLine {
  userId: string;
  fullName: string;
  role: string;
  employeeCode: string | null;
  breakdown: GrossToNetBreakdown;
  commission: bigint;
}

/** A member with commission to settle and no wage: every wage-side figure is zero. */
const NO_WAGE: GrossToNetBreakdown = {
  baseSalaryRial: 0n,
  taxableAllowancesRial: 0n,
  nonTaxableAllowancesRial: 0n,
  overtimeRial: 0n,
  grossRial: 0n,
  insuranceBaseRial: 0n,
  employeeInsuranceRial: 0n,
  employerInsuranceRial: 0n,
  unemploymentInsuranceRial: 0n,
  taxableIncomeRial: 0n,
  incomeTaxRial: 0n,
  otherDeductionsRial: 0n,
  advanceRecoveryRial: 0n,
  advanceCarriedRial: 0n,
  netPayRial: 0n,
  employerCostRial: 0n,
};

/**
 * This month's overtime per member. The only figure that is not a standing term,
 * so it arrives with the request: `{ [userId]: amount }`. Anything that is not a
 * uuid, or not an amount, or not for someone on the run, is `invalid_overtime`
 * naming the offender. Zero and absent are the same thing.
 */
function parseOvertime(raw: Record<string, unknown> | null | undefined): Map<string, bigint> {
  const overtime = new Map<string, bigint>();
  for (const [userId, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    let amount: bigint;
    try {
      amount = parseRialInput(value);
    } catch {
      throw new PayrollError("invalid_overtime", 400, userId);
    }
    if (amount === 0n) continue;
    if (!isUuid(userId)) throw new PayrollError("invalid_overtime", 400, userId);
    overtime.set(userId, amount);
  }
  return overtime;
}

/**
 * Accrues one Jalali month's payroll.
 *
 * ## Duplicate protection (server-side — the UI warning is not the boundary)
 *
 * - The period is a month key, `YYYY-MM` (`resolvePayrollPeriodKey`): «۱۴۰۴/۵»,
 *   « 1404-05 » and «1404-05» are one period, and a month that has not started
 *   cannot be accrued (`period_in_future`).
 * - Payroll mutations for a business are serialised by a transaction advisory
 *   lock, then a standing run for the month (keyed or legacy) refuses the
 *   accrual with `period_already_accrued` (409), naming the run. The partial
 *   unique index `uq_payroll_runs_period` is the backstop for any writer that
 *   bypasses this function; a voided run releases its month, so void-and-redo
 *   works.
 * - An `idempotencyKey` makes a retry safe: the same key with the same month
 *   returns the run it created (`idempotentReplay: true`) instead of a second
 *   run or an error; the same key with a *different* month is
 *   `idempotency_key_conflict`.
 *
 * The run, its lines, the commission claims and the journal entry commit or roll
 * back together — a fiscal-period lock on the accrual date leaves nothing behind.
 */
export async function accruePayroll(params: {
  businessId: string;
  createdBy: string | null;
  /** The Jalali month, `YYYY-MM`. */
  periodKey: unknown;
  accrualDate?: string | null;
  /** This month's overtime per member: `{ [userId]: amount }`. */
  overtime?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  /** Settle unsettled commission in this run (default true). */
  includeCommission?: boolean;
}): Promise<PayrollRun & { idempotentReplay: boolean }> {
  const resolved = resolvePayrollPeriodKey(params.periodKey);
  if (!resolved.ok) throw new PayrollError(resolved.error);
  const period = resolved.period;

  // Normalise the date once, up front: the run row and its journal entry must
  // share the same value. A malformed one («banana», `2026-02-31`) is a 400
  // with its own code, never a date-cast 500.
  const normalizedAccrual = normalizeOptionalIsoDate(params.accrualDate);
  if (!normalizedAccrual.ok) throw new PayrollError("invalid_accrual_date");
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);
  const includeCommission = params.includeCommission ?? true;

  const today = await businessToday(params.businessId);
  // A month that has not started yet cannot be accrued: its work has not been done.
  if (period.startsOn > today) throw new PayrollError("period_in_future");
  const accrualDate = normalizedAccrual.value ?? defaultAccrualDate(period, today);

  const overtime = parseOvertime(params.overtime);
  const settings = await getPayrollSettings(params.businessId);

  const replayOf = async (existingId: string) => ({
    ...(await mustGetRun(params.businessId, existingId)),
    idempotentReplay: true,
  });

  let outcome: { runId: string } | { replayRunId: string };
  try {
    outcome = await inTransaction(async (client) => {
      // One accrual at a time per business: the duplicate checks below read
      // state this transaction is about to change, and the advances it recovers
      // must not move under it.
      await lockPayroll(client, params.businessId);

      if (idempotencyKey) {
        const { rows } = await client.query<{ id: string; period_key: string | null; accrual_date: string }>(
          `SELECT id, period_key, accrual_date::text AS accrual_date FROM payroll_runs
            WHERE business_id = $1 AND idempotency_key = $2`,
          [params.businessId, idempotencyKey],
        );
        if (rows[0]) {
          if (rows[0].period_key !== period.key || (normalizedAccrual.value && rows[0].accrual_date !== accrualDate)) {
            throw new PayrollError("idempotency_key_conflict", 409);
          }
          return { replayRunId: rows[0].id };
        }
      }

      const standing = await findStandingRun(client, params.businessId, period.key);
      if (standing) throw periodTaken(standing);
      // Issue #865: a month booked by the statutory payroll engine is not
      // accrued a second time here (the engine refuses the converse).
      const { rows: engineRuns } = await client.query<{ id: string }>(
        `SELECT id FROM payroll_engine_runs
          WHERE business_id = $1 AND period_key = $2 AND run_type = 'regular' AND status <> 'cancelled'`,
        [params.businessId, period.key],
      );
      if (engineRuns[0]) throw new PayrollError("period_held_by_engine", 409, { runId: engineRuns[0].id });

      const lines = await buildAccrualLines(client, params.businessId, {
        accrualDate,
        overtime,
        settings,
        includeCommission,
      });
      if (lines.claimIds.length === 0 && lines.members.length === 0) throw new PayrollError("no_wages_set");

      const totals = payrollAccrualTotals(lines.members.map((m) => m.breakdown));
      assertLedgerFits(totals, lines.commissionTotal);

      // Only the accounts a non-zero side needs are looked up, so a business
      // with no deductions configured posts exactly the two-line entry it always
      // did — and needs no account it has never used. A commission-only run
      // posts no accrual at all (its liability is already in 2300).
      const sides: Array<{ code: string; debit: bigint; credit: bigint }> = [
        { code: WELL_KNOWN_CODES.salariesExpense, debit: totals.grossRial, credit: 0n },
        { code: WELL_KNOWN_CODES.employerInsuranceExpense, debit: totals.employerInsuranceExpenseRial, credit: 0n },
        { code: WELL_KNOWN_CODES.salariesPayable, debit: 0n, credit: totals.netPayableRial },
        { code: WELL_KNOWN_CODES.insurancePayable, debit: 0n, credit: totals.insurancePayableRial },
        { code: WELL_KNOWN_CODES.payrollTaxPayable, debit: 0n, credit: totals.incomeTaxPayableRial },
        { code: WELL_KNOWN_CODES.staffAdvances, debit: 0n, credit: totals.advanceRecoveryRial },
        { code: WELL_KNOWN_CODES.otherPayrollDeductionsPayable, debit: 0n, credit: totals.otherDeductionsPayableRial },
      ].filter((s) => s.debit !== 0n || s.credit !== 0n);
      const accounts = sides.length > 0 ? await accountIdsByCode(client, params.businessId, sides.map((s) => s.code)) : null;

      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO payroll_runs
           (business_id, location_id, period_key, period_label, idempotency_key, total_amount, net_amount,
            commission_total, settings_snapshot, accrual_date, created_by)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          params.businessId,
          period.key,
          period.label,
          idempotencyKey,
          totals.grossRial.toString(),
          totals.netPayableRial.toString(),
          lines.commissionTotal.toString(),
          JSON.stringify(settings),
          accrualDate,
          params.createdBy,
        ],
      );
      const runId = created[0].id;

      for (const member of lines.members) {
        const b = member.breakdown;
        await client.query(
          `INSERT INTO payroll_run_lines
             (run_id, user_id, amount, base_salary, taxable_allowance, non_taxable_allowance, overtime,
              insurance_base, employee_insurance, employer_insurance, unemployment_insurance,
              taxable_income, income_tax, other_deductions, advance_recovery, net_pay,
              commission_amount, employee_name_snapshot, employee_code_snapshot, employee_role_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            runId,
            member.userId,
            b.grossRial.toString(),
            b.baseSalaryRial.toString(),
            b.taxableAllowancesRial.toString(),
            b.nonTaxableAllowancesRial.toString(),
            b.overtimeRial.toString(),
            b.insuranceBaseRial.toString(),
            b.employeeInsuranceRial.toString(),
            b.employerInsuranceRial.toString(),
            b.unemploymentInsuranceRial.toString(),
            b.taxableIncomeRial.toString(),
            b.incomeTaxRial.toString(),
            b.otherDeductionsRial.toString(),
            b.advanceRecoveryRial.toString(),
            b.netPayRial.toString(),
            member.commission.toString(),
            member.fullName,
            member.employeeCode,
            member.role,
          ],
        );
      }

      if (lines.claimIds.length > 0) {
        // The rows are locked by this transaction, so all of them are still free.
        const claimed = await client.query(
          `UPDATE commission_accruals SET payroll_run_id = $1
            WHERE business_id = $2 AND id = ANY($3::uuid[]) AND payroll_run_id IS NULL`,
          [runId, params.businessId, lines.claimIds],
        );
        if (claimed.rowCount !== lines.claimIds.length) throw new PayrollError("commission_already_settled", 409);
      }

      if (accounts) {
        await postExactJournalEntry(client, {
          businessId: params.businessId,
          locationId: null,
          entryDate: accrualDate,
          memo: `تعهد حقوق و دستمزد — ${period.label}`,
          sourceType: "payroll_accrual",
          sourceId: runId,
          createdBy: params.createdBy,
          lines: sides.map((s) => ({
            accountId: accounts.get(s.code)!,
            debit: asRial(s.debit),
            credit: asRial(s.credit),
          })),
        });
      }
      return { runId };
    });
  } catch (err) {
    // Defence in depth: the advisory lock already serialises this function, so
    // the unique indexes only fire for a writer that bypassed it. Answer them
    // exactly as the checks above would have.
    const violation = err as { code?: string; constraint?: string };
    if (violation.code === UNIQUE_VIOLATION && violation.constraint === "uq_payroll_runs_period") {
      const { rows } = await query<StandingRun>(
        `SELECT id, period_label, status FROM payroll_runs
          WHERE business_id = $1 AND period_key = $2 AND status <> 'voided'`,
        [params.businessId, period.key],
      );
      if (rows[0]) throw periodTaken(rows[0]);
    }
    if (violation.code === UNIQUE_VIOLATION && violation.constraint === "uq_payroll_runs_idempotency" && idempotencyKey) {
      const { rows } = await query<{ id: string; period_key: string | null }>(
        `SELECT id, period_key FROM payroll_runs WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, idempotencyKey],
      );
      if (rows[0]?.period_key === period.key) return replayOf(rows[0].id);
      if (rows[0]) throw new PayrollError("idempotency_key_conflict", 409);
    }
    throw err;
  }

  if ("replayRunId" in outcome) return replayOf(outcome.replayRunId);
  return { ...(await mustGetRun(params.businessId, outcome.runId)), idempotentReplay: false };
}

/**
 * Every member the run covers, with their month computed: an active member with
 * a positive wage gets the calculator's gross-to-net over their standing terms,
 * this month's overtime and the advances still owed; a member with commission to
 * settle and no wage gets a commission-only line. The calculator refuses a month
 * whose deductions exceed gross, naming the member (a run is never a negative
 * salary).
 */
async function buildAccrualLines(
  client: PoolClient,
  businessId: string,
  options: { accrualDate: string; overtime: Map<string, bigint>; settings: PayrollSettings; includeCommission: boolean },
): Promise<{ members: AccrualLine[]; commissionTotal: bigint; claimIds: string[] }> {
  const run = clientRunner(client);
  const { rows: staff } = await run<{
    id: string;
    full_name: string;
    role: string;
    employee_code: string | null;
    monthly_wage: string;
    monthly_taxable_allowance: string;
    monthly_non_taxable_allowance: string;
    monthly_fixed_deduction: string;
  }>(
    `SELECT u.id, u.full_name, u.role::text AS role, e.employee_code, u.monthly_wage::text AS monthly_wage,
            u.monthly_taxable_allowance::text AS monthly_taxable_allowance,
            u.monthly_non_taxable_allowance::text AS monthly_non_taxable_allowance,
            u.monthly_fixed_deduction::text AS monthly_fixed_deduction
       FROM users u
       LEFT JOIN employees e ON e.id = u.id
      WHERE u.business_id = $1 AND u.is_active AND u.monthly_wage IS NOT NULL AND u.monthly_wage > 0
      ORDER BY u.full_name, u.id`,
    [businessId],
  );
  for (const userId of options.overtime.keys()) {
    if (!staff.some((s) => s.id === userId)) throw new PayrollError("invalid_overtime", 400, userId);
  }

  const commission = options.includeCommission
    ? await collectCommission(run, businessId, options.accrualDate, { lock: true })
    : { members: [], total: 0n, claimIds: [] as string[] };
  const commissionOf = new Map(commission.members.map((m) => [m.userId, m]));

  const advances = await outstandingAdvances(run, businessId);

  const members: AccrualLine[] = [];
  for (const s of staff) {
    const result = computeGrossToNet(
      {
        baseSalaryRial: BigInt(s.monthly_wage),
        taxableAllowancesRial: BigInt(s.monthly_taxable_allowance),
        nonTaxableAllowancesRial: BigInt(s.monthly_non_taxable_allowance),
        overtimeRial: options.overtime.get(s.id) ?? 0n,
        otherDeductionsRial: BigInt(s.monthly_fixed_deduction),
        advanceOutstandingRial: advances.get(s.id) ?? 0n,
      },
      options.settings,
    );
    if (!result.ok) throw new PayrollError(result.error, 400, s.id);
    members.push({
      userId: s.id,
      fullName: s.full_name,
      role: s.role,
      employeeCode: s.employee_code,
      breakdown: result,
      commission: commissionOf.get(s.id)?.amount ?? 0n,
    });
  }
  const covered = new Set(members.map((m) => m.userId));
  for (const c of commission.members) {
    if (covered.has(c.userId)) continue;
    members.push({
      userId: c.userId,
      fullName: c.fullName,
      role: c.role,
      employeeCode: c.employeeCode,
      breakdown: NO_WAGE,
      commission: c.amount,
    });
  }
  members.sort((a, b) => a.fullName.localeCompare(b.fullName, "fa") || (a.userId < b.userId ? -1 : 1));
  return { members, commissionTotal: commission.total, claimIds: commission.claimIds };
}

/**
 * The columns are `bigint`; a total past that is a 400, not an INSERT that
 * aborts the transaction — and it is checked on the *sums*, because every line
 * can fit while their total does not.
 */
function assertLedgerFits(
  totals: ReturnType<typeof payrollAccrualTotals>,
  commissionTotal: bigint,
): void {
  const figures = [
    totals.grossRial + totals.employerInsuranceExpenseRial,
    totals.netPayableRial + commissionTotal,
    totals.insurancePayableRial,
    totals.incomeTaxPayableRial,
    totals.advanceRecoveryRial,
    totals.otherDeductionsPayableRial,
    commissionTotal,
  ];
  if (figures.some((figure) => figure > MAX_RIAL)) throw new PayrollError("amount_out_of_range");
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * Pays out an accrued run: Debit salariesPayable / Credit the chosen payment
 * account, for the run's **net** wages and the commission it settles together —
 * the withholdings stay in their payables until the business remits them.
 *
 * - The run row is locked inside the transaction, so two concurrent payments
 *   (a double-click, two tabs) cannot both post: the second waits, sees `paid`,
 *   and is refused.
 * - The payment is posted with the **run's own location** (NULL for every run
 *   created since #835), never the caller's active branch — the payment cannot
 *   drift to another branch than the accrual.
 * - The payment date defaults to the business's today and must not precede the
 *   accrual date: `paid_date_before_accrual`. The same value is written to the
 *   journal entry and the run. The fiscal-period lock still applies to that date.
 * - The credit side is a cash/bank/petty-cash account of the business's own
 *   chart (`payroll-accounts.ts`), never the card-clearing account.
 * - A run whose whole pay was recovered against advances has nothing to pay out:
 *   it is marked paid without a payment entry.
 */
export async function payPayroll(params: {
  businessId: string;
  runId: string;
  method?: "cash" | "bank";
  /** An account from `listPaymentAccounts`; takes precedence over `method`. */
  paymentAccountId?: string | null;
  paidDate?: string | null;
  actorId: string | null;
}): Promise<PayrollRun> {
  if (!isUuid(params.runId)) throw new PayrollError("run_not_found", 404);

  const method = params.method ?? "cash";
  if (method !== "cash" && method !== "bank") throw new PayrollError("invalid_method");
  const paymentAccountId = params.paymentAccountId ?? null;
  if (paymentAccountId !== null && !isUuid(paymentAccountId)) throw new PayrollError("invalid_payment_account");

  // The payment entry and the run's paid_date must share one normalised value,
  // and a malformed date is a 400 here rather than a `date` cast error (500).
  const normalizedPaid = normalizeOptionalIsoDate(params.paidDate);
  if (!normalizedPaid.ok) throw new PayrollError("invalid_paid_date");
  const paidDate = normalizedPaid.value ?? (await businessToday(params.businessId));

  await inTransaction(async (client) => {
    /*
     * Read the run *inside* the transaction and lock the row: the status check
     * used to run on an unlocked read before the transaction opened, so two
     * concurrent «ثبت پرداخت حقوق» clicks both saw `accrued` and both posted a
     * payment — the wage bill left Cash twice and salariesPayable went
     * negative. `FOR UPDATE` makes the second one wait, then see `paid`.
     */
    const { rows } = await client.query<{
      id: string;
      status: string;
      net_amount: string;
      commission_total: string;
      period_label: string;
      accrual_date: string;
      location_id: string | null;
    }>(
      `SELECT id, status, COALESCE(net_amount, total_amount)::text AS net_amount,
              commission_total::text AS commission_total,
              period_label, accrual_date::text AS accrual_date, location_id
         FROM payroll_runs WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.runId, params.businessId],
    );
    const run = rows[0];
    if (!run) throw new PayrollError("run_not_found", 404);
    // A voided run reads as "already handled" too, but say so precisely rather
    // than reporting «قبلاً پرداخت شده» for a run that was actually cancelled.
    if (run.status === "voided") throw new PayrollError("run_voided", 409);
    if (run.status !== "accrued") throw new PayrollError("already_paid", 409);

    if (paidDate < run.accrual_date) throw new PayrollError("paid_date_before_accrual");

    const net = BigInt(run.net_amount);
    const commission = BigInt(run.commission_total);
    const payable = net + commission;
    if (payable > 0n) {
      const payout = await resolvePayoutAccount(client, params.businessId, { method, paymentAccountId });
      const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.salariesPayable]);

      await postExactJournalEntry(client, {
        businessId: params.businessId,
        locationId: run.location_id,
        entryDate: paidDate,
        memo:
          commission > 0n
            ? `پرداخت حقوق، دستمزد و پورسانت — ${run.period_label}`
            : `پرداخت حقوق و دستمزد — ${run.period_label}`,
        sourceType: "payroll_payment",
        sourceId: run.id,
        createdBy: params.actorId,
        lines: [
          { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: asRial(payable), credit: "0" as RialText },
          { accountId: payout.accountId, debit: "0" as RialText, credit: asRial(payable) },
        ],
      });
    }

    await client.query(`UPDATE payroll_runs SET status = 'paid', paid_date = $2::date WHERE id = $1`, [run.id, paidDate]);
  });

  return mustGetRun(params.businessId, params.runId);
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

/**
 * Voids a payroll run — the reversal path this surface was missing.
 *
 * It posts the exact mirror of each of the run's still-standing journal entries
 * (the accrual, if the run had wages, and the payment if it was paid) through
 * the same `postExactMirrorEntry()` every other reversal in the app uses: dated
 * today rather than backdated, and refused when today's fiscal period is locked,
 * so a closed period is never reopened to fix a mistake. Each mirror carries its
 * **original entry's** location, never the caller's active branch.
 *
 * The commission the run had claimed is released (`payroll_run_id` cleared), so
 * the voided run's accruals are claimable by the next one; the advances it
 * recovered are owed again by construction (what is outstanding is derived from
 * runs that are not voided); the run's lines keep their snapshot as history. Its
 * month is released too, so the month can be accrued again.
 *
 * Idempotent by construction: `status = 'voided'` is rejected up front under a
 * row lock, and an entry already reversed (its `reversed_at` set) is skipped
 * rather than mirrored twice.
 */
export async function voidPayrollRun(params: {
  businessId: string;
  runId: string;
  actorId: string | null;
}): Promise<PayrollRun> {
  if (!isUuid(params.runId)) throw new PayrollError("run_not_found", 404);

  await inTransaction(async (client) => {
    // Serialised with accruals and advance voids: the claims it releases and the
    // advance balances it gives back must not move under a run being built.
    await lockPayroll(client, params.businessId);

    // Locked inside the transaction, for the same reason `payPayroll` locks:
    // two concurrent «ابطال» clicks both read `accrued` on an unlocked check
    // and both mirrored the run's entries, double-reversing it.
    const { rows } = await client.query<{ id: string; status: PayrollRunStatus; period_label: string }>(
      `SELECT id, status, period_label FROM payroll_runs WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.runId, params.businessId],
    );
    const run = rows[0];
    if (!run) throw new PayrollError("run_not_found", 404);
    if (run.status === "voided") throw new PayrollError("already_voided", 409);

    // Every posting this run made, still standing (not already reversed): the
    // payment first, then the accrual — the credits are put back before the
    // expense is, the natural order of an undo.
    const { rows: entries } = await client.query<{ id: string; source_type: string; location_id: string | null }>(
      `SELECT id, source_type, location_id FROM journal_entries
        WHERE business_id = $1
          AND source_type IN ('payroll_accrual', 'payroll_payment')
          AND source_id = $2
          AND reversed_at IS NULL
          AND reverses_entry_id IS NULL
        ORDER BY (source_type = 'payroll_payment') DESC, posted_at DESC, id`,
      [params.businessId, params.runId],
    );

    for (const entry of entries) {
      const paymentEntry = entry.source_type === "payroll_payment";
      await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: entry.location_id,
        originalEntryId: entry.id,
        sourceType: paymentEntry ? "payroll_payment_void" : "payroll_accrual_void",
        sourceId: params.runId,
        postingKind: "payroll_void",
        memo: `ابطال ${paymentEntry ? "پرداخت" : "تعهد"} حقوق و دستمزد — ${run.period_label}`,
        createdBy: params.actorId,
      });
    }

    await client.query(`UPDATE commission_accruals SET payroll_run_id = NULL WHERE business_id = $1 AND payroll_run_id = $2`, [
      params.businessId,
      params.runId,
    ]);
    await client.query(`UPDATE payroll_runs SET status = 'voided', voided_at = now(), voided_by = $2 WHERE id = $1`, [
      params.runId,
      params.actorId,
    ]);
  });

  return mustGetRun(params.businessId, params.runId);
}
