/**
 * Phase 16 + audit F11 — payroll, the DB-touching part.
 *
 * A run is one Jalali month (`period_key`, `YYYY-MM`). It computes every
 * active staff member's gross-to-net with the pure calculator in
 * `payroll-gross-to-net.ts`, against the business's *own* payroll settings
 * (`SETTING_KEYS.payroll` — nothing statutory is assumed; an empty document
 * means no deduction, so gross = net exactly as before), snapshots each
 * person's full breakdown into `payroll_run_lines`, and posts one accrual:
 *
 *   Dr 5200 salaries expense            gross
 *   Dr 5220 employer insurance expense  employer + unemployment shares
 *      Cr 2300 salaries payable         net pay
 *      Cr 2460 insurance payable        employee + employer + unemployment shares
 *      Cr 2470 payroll tax payable      income tax withheld
 *      Cr 1260 staff advances           advances recovered
 *      Cr 2490 other deductions payable other fixed deductions withheld
 *
 * Paying the run posts the other half for the *net* only (Debit salaries
 * payable / Credit Cash or Bank-Clearing); the withholdings stay in their
 * payables until the business remits them. Every posting goes through the same
 * `postJournalEntry()` every other path uses, so the fiscal-period lock
 * applies.
 *
 * Salary advances (مساعده) are recorded here too: Debit 1260 / Credit the
 * chosen payout account, the same cash/bank choice a run's payment uses. What
 * a member still owes is *derived* — their standing advances minus the
 * recoveries of standing runs — so voiding a run gives its recovery back with
 * no bookkeeping of its own.
 *
 * DB-touching, so per repo convention it has no direct unit test. Covered by
 * integration/payroll.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { normalizeOptionalIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { businessToday } from "./business-day-service";
import { parseDepreciationPeriodKey } from "./depreciation";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  computeGrossToNet,
  EMPTY_PAYROLL_SETTINGS,
  parsePayrollSettings,
  payrollAccrualTotals,
  type GrossToNetBreakdown,
  type PayrollSettings,
} from "./payroll-gross-to-net";
import {
  accountIdsByCode,
  MissingLedgerAccountError,
  postExactMirrorEntry,
  postJournalEntry,
} from "./ledger-service";

export { MissingLedgerAccountError };

export class PayrollError extends Error {
  status: number;
  field?: string;
  constructor(code: string, status = 400, field?: string) {
    super(code);
    this.status = status;
    this.field = field;
  }
}

/** The longest advance note — a line, not a document. */
export const ADVANCE_NOTE_MAX = 200;

/** Serialises every payroll mutation that reads or consumes advance balances. */
async function lockPayroll(client: PoolClient, businessId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payroll:${businessId}`]);
}

function payoutCode(method: "cash" | "bank"): string {
  return method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The business's payroll settings, normalised. A stored document that no
 * longer parses (hand-edited, or written by an older shape) reads as nothing
 * entered rather than failing the screen — and is reported so it can be fixed.
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
// Staff terms
// ---------------------------------------------------------------------------

export interface StaffWage {
  id: string;
  fullName: string;
  role: string;
  monthlyWage: number | null;
  taxableAllowance: number;
  nonTaxableAllowance: number;
  fixedDeduction: number;
  /** Salary advances still to be recovered. */
  advanceOutstanding: number;
}

/**
 * Per member: standing advances minus what standing runs recovered. Run on the
 * caller's client so an accrual reads it under its own lock.
 */
async function outstandingAdvances(
  run: (sql: string, params: unknown[]) => Promise<{ rows: { user_id: string; outstanding: string }[] }>,
  businessId: string,
): Promise<Map<string, number>> {
  const { rows } = await run(
    `SELECT a.user_id, GREATEST(a.total - COALESCE(rec.recovered, 0), 0)::text AS outstanding
       FROM (SELECT user_id, sum(amount) AS total FROM payroll_advances
              WHERE business_id = $1 AND status = 'active' GROUP BY user_id) a
       LEFT JOIN (SELECT rl.user_id, sum(rl.advance_recovery) AS recovered
                    FROM payroll_run_lines rl JOIN payroll_runs r ON r.id = rl.run_id
                   WHERE r.business_id = $1 AND r.status <> 'voided' AND rl.user_id IS NOT NULL
                   GROUP BY rl.user_id) rec ON rec.user_id = a.user_id`,
    [businessId],
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.outstanding)]));
}

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
       FROM users WHERE business_id = $1 AND is_active ORDER BY full_name`,
    [businessId],
  );
  const advances = await outstandingAdvances((sql, params) => query(sql, params), businessId);
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    role: r.role,
    monthlyWage: r.monthly_wage === null ? null : Number(r.monthly_wage),
    taxableAllowance: Number(r.monthly_taxable_allowance),
    nonTaxableAllowance: Number(r.monthly_non_taxable_allowance),
    fixedDeduction: Number(r.monthly_fixed_deduction),
    advanceOutstanding: advances.get(r.id) ?? 0,
  }));
}

function isRialAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function setWage(businessId: string, userId: string, monthlyWage: number | null): Promise<void> {
  await setStaffPayTerms(businessId, userId, { monthlyWage });
}

export interface StaffPayTermsPatch {
  monthlyWage?: number | null;
  taxableAllowance?: number;
  nonTaxableAllowance?: number;
  fixedDeduction?: number;
}

/**
 * Updates one member's standing pay terms. Only the keys present are written,
 * so saving the wage cannot zero an allowance the form did not send.
 */
export async function setStaffPayTerms(businessId: string, userId: string, patch: StaffPayTermsPatch): Promise<void> {
  // `users.id` is a uuid: `WHERE id = $1` against a non-uuid raises
  // `invalid input syntax for type uuid` rather than matching no row — a 500
  // and «خطای غیرمنتظره» where an honest 404 belongs. See `isUuid`.
  if (!isUuid(userId)) throw new PayrollError("user_not_found", 404);
  const sets: string[] = [];
  const params: unknown[] = [userId, businessId];
  if ("monthlyWage" in patch) {
    if (patch.monthlyWage !== null && !isRialAmount(patch.monthlyWage)) throw new PayrollError("invalid_amount");
    params.push(patch.monthlyWage);
    sets.push(`monthly_wage = $${params.length}`);
  }
  const columns: Array<[keyof StaffPayTermsPatch, string]> = [
    ["taxableAllowance", "monthly_taxable_allowance"],
    ["nonTaxableAllowance", "monthly_non_taxable_allowance"],
    ["fixedDeduction", "monthly_fixed_deduction"],
  ];
  for (const [key, column] of columns) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (!isRialAmount(value)) throw new PayrollError("invalid_amount", 400, key);
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) throw new PayrollError("bad_request");
  const { rowCount } = await query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $1 AND business_id = $2 AND is_active`,
    params,
  );
  if (!rowCount) throw new PayrollError("user_not_found", 404);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface PayrollRunLine extends Omit<GrossToNetBreakdown, "advanceCarriedRial"> {
  userId: string | null;
  fullName: string | null;
  /** Gross for the period (pre-F11 lines: the whole amount, which was also the net). */
  amount: number;
}

export type PayrollRunStatus = "accrued" | "paid" | "voided";

export interface PayrollRun {
  id: string;
  /** `YYYY-MM` Jalali month; null on a run recorded before audit F11. */
  periodKey: string | null;
  periodLabel: string;
  status: PayrollRunStatus;
  /** Gross total (the salaries-expense debit). */
  totalAmount: number;
  /** What the payment posts: the net total (pre-F11 runs: the gross). */
  netAmount: number;
  accrualDate: string;
  paidDate: string | null;
  voidedDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

interface RunRow extends Record<string, unknown> {
  id: string;
  period_key: string | null;
  period_label: string;
  status: PayrollRunStatus;
  total_amount: string;
  net_amount: string;
  accrual_date: string;
  paid_date: string | null;
  voided_date: string | null;
  created_by_name: string | null;
}
interface RunLineRow extends Record<string, unknown> {
  run_id: string;
  user_id: string | null;
  full_name: string | null;
  amount: string;
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
  /** A pre-F11 line: no breakdown, its whole amount was base pay, gross and net. */
  legacy: boolean;
}

/**
 * The columns every run read returns, so the three call sites (list, accrue,
 * pay/void) can never drift on which fields a `RunRow` carries. `r` is the
 * `payroll_runs` alias, `u` the joined creator.
 */
const RUN_SELECT_COLUMNS = `r.id, r.period_key, r.period_label, r.status, r.total_amount::text AS total_amount,
            COALESCE(r.net_amount, r.total_amount)::text AS net_amount,
            r.accrual_date::text AS accrual_date, r.paid_date::text AS paid_date,
            r.voided_at::text AS voided_date, u.full_name AS created_by_name`;

async function attachLines(businessId: string, runs: RunRow[]): Promise<PayrollRun[]> {
  if (runs.length === 0) return [];
  const { rows: lines } = await query<RunLineRow>(
    `SELECT rl.run_id, rl.user_id, u.full_name, rl.amount::text AS amount,
            rl.base_salary::text AS base_salary, rl.taxable_allowance::text AS taxable_allowance,
            rl.non_taxable_allowance::text AS non_taxable_allowance, rl.overtime::text AS overtime,
            rl.insurance_base::text AS insurance_base, rl.employee_insurance::text AS employee_insurance,
            rl.employer_insurance::text AS employer_insurance,
            rl.unemployment_insurance::text AS unemployment_insurance,
            rl.taxable_income::text AS taxable_income, rl.income_tax::text AS income_tax,
            rl.other_deductions::text AS other_deductions, rl.advance_recovery::text AS advance_recovery,
            COALESCE(rl.net_pay, rl.amount)::text AS net_pay, rl.net_pay IS NULL AS legacy
       FROM payroll_run_lines rl
       JOIN payroll_runs r ON r.id = rl.run_id
       LEFT JOIN users u ON u.id = rl.user_id
      WHERE r.business_id = $1 AND rl.run_id = ANY($2::uuid[])
      ORDER BY u.full_name`,
    [businessId, runs.map((r) => r.id)],
  );
  const linesByRun = new Map<string, PayrollRunLine[]>();
  for (const l of lines) {
    const list = linesByRun.get(l.run_id) ?? [];
    const amount = Number(l.amount);
    const employerInsurance = Number(l.employer_insurance);
    const unemployment = Number(l.unemployment_insurance);
    // A pre-F11 line has no breakdown: its whole amount was base pay, gross and net.
    const legacy = l.legacy;
    list.push({
      userId: l.user_id,
      fullName: l.full_name,
      amount,
      baseSalaryRial: legacy ? amount : Number(l.base_salary),
      taxableAllowancesRial: Number(l.taxable_allowance),
      nonTaxableAllowancesRial: Number(l.non_taxable_allowance),
      overtimeRial: Number(l.overtime),
      grossRial: amount,
      insuranceBaseRial: Number(l.insurance_base),
      employeeInsuranceRial: Number(l.employee_insurance),
      employerInsuranceRial: employerInsurance,
      unemploymentInsuranceRial: unemployment,
      taxableIncomeRial: Number(l.taxable_income),
      incomeTaxRial: Number(l.income_tax),
      otherDeductionsRial: Number(l.other_deductions),
      advanceRecoveryRial: Number(l.advance_recovery),
      netPayRial: Number(l.net_pay),
      employerCostRial: amount + employerInsurance + unemployment,
    });
    linesByRun.set(l.run_id, list);
  }
  return runs.map((r) => ({
    id: r.id,
    periodKey: r.period_key,
    periodLabel: r.period_label,
    status: r.status,
    totalAmount: Number(r.total_amount),
    netAmount: Number(r.net_amount),
    accrualDate: r.accrual_date,
    paidDate: r.paid_date,
    voidedDate: r.voided_date,
    createdByName: r.created_by_name,
    lines: linesByRun.get(r.id) ?? [],
  }));
}

export async function listPayrollRuns(businessId: string): Promise<PayrollRun[]> {
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.business_id = $1
      ORDER BY r.accrual_date DESC, r.created_at DESC`,
    [businessId],
  );
  return attachLines(businessId, rows);
}

/** Re-read one run by id, with its creator name and lines attached. Shared by every mutation's return. */
async function getRun(businessId: string, runId: string): Promise<PayrollRun> {
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1 AND r.business_id = $2`,
    [runId, businessId],
  );
  const [run] = await attachLines(businessId, rows);
  return run;
}

const UNIQUE_VIOLATION = "23505";

/**
 * Accrues one Jalali month's payroll for every active member with a positive
 * monthly wage. `overtime` is this month's overtime per member (Rial), the
 * only figure that is not a standing term.
 */
export async function accruePayroll(params: {
  businessId: string;
  locationId: string | null;
  periodKey: string;
  accrualDate?: string | null;
  overtime?: Record<string, unknown> | null;
  createdBy: string | null;
}): Promise<PayrollRun> {
  const period = typeof params.periodKey === "string" ? parseDepreciationPeriodKey(params.periodKey) : null;
  if (!period) throw new PayrollError("invalid_period");

  // Normalise the date once, up front: the run row and its journal entry must
  // share the same value. A malformed one («banana», `2026-02-31`) is a 400
  // with its own code rather than a date-cast 500.
  const normalizedAccrual = normalizeOptionalIsoDate(params.accrualDate);
  if (!normalizedAccrual.ok) throw new PayrollError("invalid_accrual_date");

  const today = await businessToday(params.businessId);
  // A month that has not started yet cannot be accrued: its work has not been done.
  if (period.startsOn > today) throw new PayrollError("period_in_future");
  // Absent a date, the run is dated on the month's last day — or today while
  // the month is still running — so a run for a closed month lands in it.
  const accrualDate = normalizedAccrual.value ?? (period.endsOn < today ? period.endsOn : today);

  const overtime = new Map<string, number>();
  for (const [userId, value] of Object.entries(params.overtime ?? {})) {
    if (value === undefined || value === null || value === 0) continue;
    if (!isUuid(userId) || !isRialAmount(value)) throw new PayrollError("invalid_overtime", 400, userId);
    overtime.set(userId, value);
  }

  const settings = await getPayrollSettings(params.businessId);

  const client = await getPool().connect();
  let runId = "";
  try {
    await client.query("BEGIN");
    await lockPayroll(client, params.businessId);

    const { rows: staff } = await client.query<{
      id: string;
      monthly_wage: string;
      monthly_taxable_allowance: string;
      monthly_non_taxable_allowance: string;
      monthly_fixed_deduction: string;
    }>(
      `SELECT id, monthly_wage::text AS monthly_wage,
              monthly_taxable_allowance::text AS monthly_taxable_allowance,
              monthly_non_taxable_allowance::text AS monthly_non_taxable_allowance,
              monthly_fixed_deduction::text AS monthly_fixed_deduction
         FROM users
        WHERE business_id = $1 AND is_active AND monthly_wage IS NOT NULL AND monthly_wage > 0`,
      [params.businessId],
    );
    if (staff.length === 0) throw new PayrollError("no_wages_set");
    for (const userId of overtime.keys()) {
      if (!staff.some((s) => s.id === userId)) throw new PayrollError("invalid_overtime", 400, userId);
    }

    const advances = await outstandingAdvances((sql, p) => client.query(sql, p), params.businessId);

    const computed: Array<{ userId: string; line: GrossToNetBreakdown }> = [];
    for (const s of staff) {
      const result = computeGrossToNet(
        {
          baseSalaryRial: Number(s.monthly_wage),
          taxableAllowancesRial: Number(s.monthly_taxable_allowance),
          nonTaxableAllowancesRial: Number(s.monthly_non_taxable_allowance),
          overtimeRial: overtime.get(s.id) ?? 0,
          otherDeductionsRial: Number(s.monthly_fixed_deduction),
          advanceOutstandingRial: advances.get(s.id) ?? 0,
        },
        settings,
      );
      if (!result.ok) throw new PayrollError(result.error, 400, s.id);
      computed.push({ userId: s.id, line: result });
    }
    const totals = payrollAccrualTotals(computed.map((c) => c.line));

    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO payroll_runs (business_id, location_id, period_key, period_label, total_amount, net_amount,
                                   settings_snapshot, accrual_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          params.businessId,
          params.locationId,
          period.key,
          period.label,
          totals.grossRial,
          totals.netPayableRial,
          JSON.stringify(settings),
          accrualDate,
          params.createdBy,
        ],
      );
      runId = rows[0].id;
    } catch (err) {
      // One standing run per month — the partial UNIQUE index is the rule.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new PayrollError("period_already_accrued", 409);
      throw err;
    }

    for (const { userId, line } of computed) {
      await client.query(
        `INSERT INTO payroll_run_lines
           (run_id, user_id, amount, base_salary, taxable_allowance, non_taxable_allowance, overtime,
            insurance_base, employee_insurance, employer_insurance, unemployment_insurance,
            taxable_income, income_tax, other_deductions, advance_recovery, net_pay)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          runId,
          userId,
          line.grossRial,
          line.baseSalaryRial,
          line.taxableAllowancesRial,
          line.nonTaxableAllowancesRial,
          line.overtimeRial,
          line.insuranceBaseRial,
          line.employeeInsuranceRial,
          line.employerInsuranceRial,
          line.unemploymentInsuranceRial,
          line.taxableIncomeRial,
          line.incomeTaxRial,
          line.otherDeductionsRial,
          line.advanceRecoveryRial,
          line.netPayRial,
        ],
      );
    }

    // Only the accounts a non-zero side needs are looked up, so a business
    // with no deductions configured posts exactly the two-line entry it
    // always did — and needs no account it has never used.
    const sides: Array<{ code: string; debit: number; credit: number }> = [
      { code: WELL_KNOWN_CODES.salariesExpense, debit: totals.grossRial, credit: 0 },
      { code: WELL_KNOWN_CODES.employerInsuranceExpense, debit: totals.employerInsuranceExpenseRial, credit: 0 },
      { code: WELL_KNOWN_CODES.salariesPayable, debit: 0, credit: totals.netPayableRial },
      { code: WELL_KNOWN_CODES.insurancePayable, debit: 0, credit: totals.insurancePayableRial },
      { code: WELL_KNOWN_CODES.payrollTaxPayable, debit: 0, credit: totals.incomeTaxPayableRial },
      { code: WELL_KNOWN_CODES.staffAdvances, debit: 0, credit: totals.advanceRecoveryRial },
      { code: WELL_KNOWN_CODES.otherPayrollDeductionsPayable, debit: 0, credit: totals.otherDeductionsPayableRial },
    ].filter((s) => s.debit !== 0 || s.credit !== 0);
    const accounts = await accountIdsByCode(
      client,
      params.businessId,
      sides.map((s) => s.code),
    );

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: accrualDate,
      memo: `تعهد حقوق و دستمزد — ${period.label}`,
      sourceType: "payroll_accrual",
      sourceId: runId,
      createdBy: params.createdBy,
      lines: sides.map((s) => ({ accountId: accounts.get(s.code)!, debit: s.debit, credit: s.credit })),
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getRun(params.businessId, runId);
}

export async function payPayroll(params: {
  businessId: string;
  locationId: string | null;
  runId: string;
  method: "cash" | "bank";
  paidDate?: string | null;
  actorId: string | null;
}): Promise<PayrollRun> {
  if (!isUuid(params.runId)) throw new PayrollError("run_not_found", 404);

  // Same date-desync fix as accruePayroll: the payment entry and the run's
  // paid_date must share one normalised value, and a malformed date is a 400
  // here rather than a `date` cast error surfacing as a 500.
  const normalizedPaid = normalizeOptionalIsoDate(params.paidDate);
  if (!normalizedPaid.ok) throw new PayrollError("invalid_paid_date");
  const paidDate = normalizedPaid.value;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    /*
     * Read the run *inside* the transaction and lock the row.
     *
     * The status check used to run on an unlocked read before the transaction
     * opened, so two concurrent «ثبت پرداخت حقوق» clicks (a double-click, or
     * the same run open in two tabs) both saw `accrued` and both posted a
     * payment entry: the wage bill left Cash twice and salariesPayable went
     * negative, with nothing in the UI to show it had happened. `FOR UPDATE`
     * makes the second one wait for the first to commit, then see `paid` and
     * be refused.
     */
    const { rows } = await client.query<{ id: string; status: string; net_amount: string; period_label: string }>(
      `SELECT id, status, COALESCE(net_amount, total_amount)::text AS net_amount, period_label
         FROM payroll_runs WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.runId, params.businessId],
    );
    const run = rows[0];
    if (!run) throw new PayrollError("run_not_found", 404);
    // A voided run reads as "already handled" too, but say so precisely rather
    // than reporting «قبلاً پرداخت شده» for a run that was actually cancelled.
    if (run.status === "voided") throw new PayrollError("run_voided", 409);
    if (run.status !== "accrued") throw new PayrollError("already_paid", 409);

    // Only the net leaves the till: the withholdings stay in their payables
    // until the business remits them to the insurer and the tax office.
    const net = Number(run.net_amount);
    if (net > 0) {
      const accounts = await accountIdsByCode(client, params.businessId, [
        WELL_KNOWN_CODES.salariesPayable,
        payoutCode(params.method),
      ]);
      await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        entryDate: paidDate,
        memo: `پرداخت حقوق و دستمزد — ${run.period_label}`,
        sourceType: "payroll_payment",
        sourceId: run.id,
        createdBy: params.actorId,
        lines: [
          { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: net, credit: 0 },
          { accountId: accounts.get(payoutCode(params.method))!, debit: 0, credit: net },
        ],
      });
    }

    await client.query(
      `UPDATE payroll_runs SET status = 'paid', paid_date = COALESCE($2, CURRENT_DATE) WHERE id = $1`,
      [run.id, paidDate],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getRun(params.businessId, params.runId);
}

/**
 * Voids a payroll run — the reversal path this surface was missing.
 *
 * It posts the exact mirror of each of the run's still-standing journal
 * entries (the accrual, and the payment if the run was paid) through the same
 * `postExactMirrorEntry()` every other reversal in the app uses: dated today
 * rather than backdated, and refused when today's fiscal period is locked, so
 * a period that has been closed is never reopened to fix a mistake. The run's
 * own postings are located by their `(source_type, source_id)` identity, the
 * one-directional link this feature has always used instead of an entry_id
 * column.
 *
 * A voided run stops counting toward advance recovery (the outstanding balance
 * is derived from standing runs only), so the advances it recovered are owed
 * again, and its month may be accrued afresh.
 *
 * Idempotent by construction: `status = 'voided'` is rejected up front, and an
 * entry already reversed (its `reversed_at` set) is skipped rather than
 * mirrored twice.
 */
export async function voidPayrollRun(params: {
  businessId: string;
  locationId: string | null;
  runId: string;
  actorId: string | null;
}): Promise<PayrollRun> {
  if (!isUuid(params.runId)) throw new PayrollError("run_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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

    // Every posting this run made, still standing (not already reversed), newest
    // first — the payment, then the accrual — so the credits are put back before
    // the expense is, the natural order of an undo.
    const { rows: entries } = await client.query<{ id: string; source_type: string }>(
      `SELECT id, source_type FROM journal_entries
        WHERE business_id = $1
          AND source_type IN ('payroll_accrual', 'payroll_payment')
          AND source_id = $2
          AND reversed_at IS NULL
          AND reverses_entry_id IS NULL
        ORDER BY entry_date DESC, posted_at DESC`,
      [params.businessId, params.runId],
    );

    for (const entry of entries) {
      await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        originalEntryId: entry.id,
        sourceType: `${entry.source_type}_void`,
        sourceId: params.runId,
        postingKind: "payroll_void",
        memo: `ابطال ${entry.source_type === "payroll_payment" ? "پرداخت" : "تعهد"} حقوق و دستمزد — ${run.period_label}`,
        createdBy: params.actorId,
      });
    }

    await client.query(
      `UPDATE payroll_runs SET status = 'voided', voided_at = now(), voided_by = $2 WHERE id = $1`,
      [params.runId, params.actorId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return getRun(params.businessId, params.runId);
}

// ---------------------------------------------------------------------------
// Salary advances (مساعده)
// ---------------------------------------------------------------------------

export interface PayrollAdvance {
  id: string;
  userId: string;
  fullName: string | null;
  amount: number;
  method: "cash" | "bank";
  advanceDate: string;
  note: string | null;
  status: "active" | "voided";
  createdByName: string | null;
}

interface AdvanceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  full_name: string | null;
  amount: string;
  method: "cash" | "bank";
  advance_date: string;
  note: string | null;
  status: "active" | "voided";
  created_by_name: string | null;
}

function toAdvance(r: AdvanceRow): PayrollAdvance {
  return {
    id: r.id,
    userId: r.user_id,
    fullName: r.full_name,
    amount: Number(r.amount),
    method: r.method,
    advanceDate: r.advance_date,
    note: r.note,
    status: r.status,
    createdByName: r.created_by_name,
  };
}

const ADVANCE_SELECT = `SELECT a.id, a.user_id, m.full_name, a.amount::text AS amount, a.method,
            a.advance_date::text AS advance_date, a.note, a.status, c.full_name AS created_by_name
       FROM payroll_advances a
       LEFT JOIN users m ON m.id = a.user_id
       LEFT JOIN users c ON c.id = a.created_by`;

export async function listAdvances(businessId: string): Promise<PayrollAdvance[]> {
  const { rows } = await query<AdvanceRow>(
    `${ADVANCE_SELECT}
      WHERE a.business_id = $1
      ORDER BY a.advance_date DESC, a.created_at DESC
      LIMIT 200`,
    [businessId],
  );
  return rows.map(toAdvance);
}

async function getAdvance(businessId: string, id: string): Promise<PayrollAdvance> {
  const { rows } = await query<AdvanceRow>(`${ADVANCE_SELECT} WHERE a.business_id = $1 AND a.id = $2`, [businessId, id]);
  return toAdvance(rows[0]);
}

/**
 * Pays a salary advance to a member: Debit 1260 staff advances / Credit the
 * chosen payout account — the same cash/bank choice and the same
 * `postJournalEntry()` a run's payment uses. The next run recovers it.
 */
export async function recordAdvance(params: {
  businessId: string;
  locationId: string | null;
  userId: string;
  amount: unknown;
  method: "cash" | "bank";
  advanceDate?: string | null;
  note?: string | null;
  createdBy: string | null;
}): Promise<PayrollAdvance> {
  if (!isUuid(params.userId)) throw new PayrollError("user_not_found", 404);
  if (!isRialAmount(params.amount) || params.amount === 0) throw new PayrollError("invalid_amount");
  const amount = params.amount;
  const normalized = normalizeOptionalIsoDate(params.advanceDate);
  if (!normalized.ok) throw new PayrollError("invalid_advance_date");
  const note = params.note?.trim() || null;
  if (note && note.length > ADVANCE_NOTE_MAX) throw new PayrollError("note_too_long");

  const client = await getPool().connect();
  let id = "";
  try {
    await client.query("BEGIN");
    const { rows: member } = await client.query<{ full_name: string }>(
      `SELECT full_name FROM users WHERE id = $1 AND business_id = $2 AND is_active`,
      [params.userId, params.businessId],
    );
    if (!member[0]) throw new PayrollError("user_not_found", 404);

    const { rows } = await client.query<{ id: string; advance_date: string }>(
      `INSERT INTO payroll_advances (business_id, location_id, user_id, amount, method, advance_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8) RETURNING id, advance_date::text AS advance_date`,
      [params.businessId, params.locationId, params.userId, amount, params.method, normalized.value, note, params.createdBy],
    );
    id = rows[0].id;

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.staffAdvances,
      payoutCode(params.method),
    ]);
    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: rows[0].advance_date,
      memo: `مساعده — ${member[0].full_name}`,
      sourceType: "payroll_advance",
      sourceId: id,
      createdBy: params.createdBy,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.staffAdvances)!, debit: amount, credit: 0 },
        { accountId: accounts.get(payoutCode(params.method))!, debit: 0, credit: amount },
      ],
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return getAdvance(params.businessId, id);
}

/**
 * Voids an advance recorded by mistake: mirrors its entry (dated today, the
 * fiscal lock applies) and stops it counting. Refused once a run has recovered
 * any of it — that recovery is in a posted run, which is voided first.
 */
export async function voidAdvance(params: {
  businessId: string;
  locationId: string | null;
  advanceId: string;
  actorId: string | null;
}): Promise<PayrollAdvance> {
  if (!isUuid(params.advanceId)) throw new PayrollError("advance_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockPayroll(client, params.businessId);

    const { rows } = await client.query<{ id: string; user_id: string; amount: string; status: string }>(
      `SELECT id, user_id, amount::text AS amount, status FROM payroll_advances
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.advanceId, params.businessId],
    );
    const advance = rows[0];
    if (!advance) throw new PayrollError("advance_not_found", 404);
    if (advance.status === "voided") throw new PayrollError("already_voided", 409);

    const outstanding = await outstandingAdvances((sql, p) => client.query(sql, p), params.businessId);
    if ((outstanding.get(advance.user_id) ?? 0) < Number(advance.amount)) {
      throw new PayrollError("advance_already_recovered", 409);
    }

    const { rows: entries } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'payroll_advance' AND source_id = $2
          AND reversed_at IS NULL AND reverses_entry_id IS NULL`,
      [params.businessId, advance.id],
    );
    for (const entry of entries) {
      await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        originalEntryId: entry.id,
        sourceType: "payroll_advance_void",
        sourceId: advance.id,
        postingKind: "payroll_void",
        memo: "ابطال مساعده",
        createdBy: params.actorId,
      });
    }
    await client.query(
      `UPDATE payroll_advances SET status = 'voided', voided_at = now(), voided_by = $2 WHERE id = $1`,
      [advance.id, params.actorId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return getAdvance(params.businessId, params.advanceId);
}
