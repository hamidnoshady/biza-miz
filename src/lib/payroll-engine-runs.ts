/**
 * Issue #865 — statutory payroll engine, the run lifecycle and reports (DB-touching).
 *
 *   draft ──calculate──▶ calculated ──review──▶ reviewed ──approve──▶ approved
 *     │                    ▲   │                   │                    │
 *     └──────cancel────────┴───┴───────────────────┘                  post
 *                                                                       ▼
 *                                         closed ◀──close── paid ◀──pay── posted
 *
 * - **Deterministic identity.** A run is `(period_key, sequence)`; one standing
 *   *regular* run per Jalali month (partial unique index), any number of
 *   *supplemental* runs after it is approved. #835's journal-level accrual and
 *   the engine never book the same month (each refuses the other's).
 * - **Immutable once approved.** The rule version, the component catalogue and
 *   every payslip are snapshots; database triggers refuse any change other than
 *   moving forward along the workflow (and a payslip's payment status). A
 *   correction is a supplemental run, computed on the cumulative month.
 * - **Exact and idempotent posting.** Amounts are `bigint` end to end; the
 *   accrual and the payment go through `postExactJournalEntry()` (fiscal locks
 *   apply) under a row lock, keyed `(source_type, source_id)` by the run, so a
 *   retry finds the run already posted rather than posting twice.
 * - **Dimensioned.** The accrual is one balanced journal entry per cost-allocation
 *   bucket (branch × project — `journal_entries.location_id` / `project_id`, the
 *   ledger's canonical dimensions), split exactly by `allocatePayslip`. Each entry
 *   is keyed `(payroll_engine_accrual, run, posting_kind = bucket)`, so a retry
 *   can never post a bucket twice.
 * - **Signed corrections** leave an employee *debt* (Debit 1260) instead of a
 *   negative net; it is recovered by later regular runs through
 *   `outstandingAdvances`, the one owner of "what a member still owes".
 * - **Commission** included in a run is *reserved* at calculation
 *   (`commission_accruals.payroll_engine_run_id`) and released on cancel /
 *   recalculation; its posting reclassifies 2300 rather than expensing it again.
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { normalizeOptionalIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { businessToday } from "./business-day-service";
import { accountIdsByCode, postExactJournalEntry } from "./ledger-service";
import { MAX_RIAL } from "./inventory-exact";
import { parseRialInput } from "./payroll-amounts";
import { resolvePayoutAccount } from "./payroll-accounts";
import { asRial, clientRunner, inSnapshot, inTransaction, lockPayroll, poolRunner, type Runner } from "./payroll-db";
import { normalizeIdempotencyKey, PayrollError } from "./payroll-errors";
import { defaultPayrollAccrualDate, resolvePayrollPeriodKey } from "./payroll-period";
import { outstandingAdvances } from "./payroll-advances-service";
import {
  assertAllocationReferences,
  componentsFor,
  ensureCatalogue,
  itemsInForce,
  ruleSetFor,
  type CostAllocationShare,
} from "./payroll-engine-setup";
import {
  accrualPostingSides,
  allocateExact,
  allocatePayslip,
  canTransition,
  computePayslip,
  coveredDays,
  NO_PRIOR,
  PayrollCalcError,
  prorate,
  type PayrollComponentDef,
  type PayslipLine,
  type PostablePayslip,
  type PriorPeriodTotals,
} from "./payroll-engine-calc";

export type EngineRunStatus = "draft" | "calculated" | "reviewed" | "approved" | "posted" | "paid" | "closed" | "cancelled";
export type EngineRunType = "regular" | "supplemental";

/** One employee's inputs for one run. */
export interface EngineRunEmployeeInput {
  overtimeHours?: number;
  unpaidLeaveDays?: number;
  items?: Array<{ code: string; amount: string }>;
}

export interface EngineRunTotals {
  employees: number;
  gross: string;
  employeeInsurance: string;
  employerInsurance: string;
  unemploymentInsurance: string;
  incomeTax: string;
  totalDeductions: string;
  netPay: string;
  employeeDebt: string;
  employerCost: string;
  commission: string;
}

export interface EngineRun {
  id: string;
  periodKey: string;
  periodLabel: string;
  runType: EngineRunType;
  sequence: number;
  status: EngineRunStatus;
  accrualDate: string;
  includeCommission: boolean;
  note: string | null;
  inputs: Record<string, EngineRunEmployeeInput>;
  ruleSetId: string | null;
  ruleSetVersion: number | null;
  totals: EngineRunTotals | null;
  accrualEntryIds: string[];
  paymentEntryId: string | null;
  paidDate: string | null;
  createdAt: string;
  approvedAt: string | null;
  postedAt: string | null;
  closedAt: string | null;
}

export interface Payslip {
  id: string;
  runId: string;
  periodKey: string;
  runType: EngineRunType;
  sequence: number;
  runStatus: EngineRunStatus;
  userId: string | null;
  employeeName: string;
  employeeCode: string | null;
  earnings: Array<{ code: string; name: string; amount: string }>;
  deductions: Array<{ code: string; name: string; amount: string }>;
  employerContributions: Array<{ code: string; name: string; amount: string }>;
  gross: string;
  taxableBase: string;
  insuranceBase: string;
  employeeInsurance: string;
  employerInsurance: string;
  unemploymentInsurance: string;
  incomeTax: string;
  totalDeductions: string;
  netPay: string;
  /** Owed back by the employee after a downward correction; recovered by later runs. */
  employeeDebt: string;
  employerCost: string;
  /** Monthly contract rate used, days employed (rule basis), and this run's own overtime/leave (deltas in a correction). */
  baseSalary: string;
  workedDays: number;
  overtimeHours: number;
  unpaidLeaveDays: number;
  costAllocation: Array<CostAllocationShare & { amount: string }>;
  paymentStatus: "unpaid" | "paid";
  paidAt: string | null;
}

const STANDING = ["approved", "posted", "paid", "closed"] as const;


// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface RunRow extends Record<string, unknown> {
  id: string;
  period_key: string;
  run_type: EngineRunType;
  sequence: number;
  status: EngineRunStatus;
  accrual_date: string;
  include_commission: boolean;
  note: string | null;
  inputs: Record<string, EngineRunEmployeeInput>;
  rule_set_id: string | null;
  rule_set_version: number | null;
  totals: EngineRunTotals | null;
  accrual_entry_ids: string[];
  payment_entry_id: string | null;
  paid_date: string | null;
  created_at: string;
  approved_at: string | null;
  posted_at: string | null;
  closed_at: string | null;
}

const RUN_SELECT = `SELECT r.id, r.period_key, r.run_type, r.sequence, r.status, r.accrual_date::text AS accrual_date,
       r.include_commission, r.note, r.inputs, r.rule_set_id, rs.version AS rule_set_version, r.totals,
       r.accrual_entry_ids::text[] AS accrual_entry_ids, r.payment_entry_id, r.paid_date::text AS paid_date, r.created_at::text AS created_at,
       r.approved_at::text AS approved_at, r.posted_at::text AS posted_at, r.closed_at::text AS closed_at
  FROM payroll_engine_runs r LEFT JOIN payroll_rule_sets rs ON rs.id = r.rule_set_id`;

function periodLabel(key: string): string {
  const resolved = resolvePayrollPeriodKey(key);
  return resolved.ok ? resolved.period.label : key;
}

const toRun = (r: RunRow): EngineRun => ({
  id: r.id,
  periodKey: r.period_key,
  periodLabel: periodLabel(r.period_key),
  runType: r.run_type,
  sequence: r.sequence,
  status: r.status,
  accrualDate: r.accrual_date,
  includeCommission: r.include_commission,
  note: r.note,
  inputs: r.inputs ?? {},
  ruleSetId: r.rule_set_id,
  ruleSetVersion: r.rule_set_version,
  totals: r.totals,
  accrualEntryIds: r.accrual_entry_ids ?? [],
  paymentEntryId: r.payment_entry_id,
  paidDate: r.paid_date,
  createdAt: r.created_at,
  approvedAt: r.approved_at,
  postedAt: r.posted_at,
  closedAt: r.closed_at,
});

export async function listEngineRuns(businessId: string, options: { periodKey?: string | null } = {}): Promise<EngineRun[]> {
  const { rows } = await poolRunner<RunRow>(
    `${RUN_SELECT} WHERE r.business_id = $1 AND ($2::text IS NULL OR r.period_key = $2)
      ORDER BY r.period_key DESC, r.sequence DESC LIMIT 200`,
    [businessId, options.periodKey ?? null],
  );
  return rows.map(toRun);
}

export async function getEngineRun(businessId: string, runId: string): Promise<EngineRun | null> {
  if (!isUuid(runId)) return null;
  const { rows } = await poolRunner<RunRow>(`${RUN_SELECT} WHERE r.business_id = $1 AND r.id = $2`, [businessId, runId]);
  return rows[0] ? toRun(rows[0]) : null;
}

async function mustGetRun(businessId: string, runId: string): Promise<EngineRun> {
  const run = await getEngineRun(businessId, runId);
  if (!run) throw new PayrollError("run_not_found", 404);
  return run;
}

interface PayslipRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  period_key: string;
  run_type: EngineRunType;
  sequence: number;
  run_status: EngineRunStatus;
  user_id: string | null;
  employee_name_snapshot: string;
  employee_code_snapshot: string | null;
  gross: string;
  insurable_raw: string;
  taxable_base: string;
  insurance_base: string;
  employee_insurance: string;
  employer_insurance: string;
  unemployment_insurance: string;
  income_tax: string;
  commission: string;
  advance_recovery: string;
  total_deductions: string;
  net_pay: string;
  employee_debt: string;
  employer_cost: string;
  base_salary: string;
  worked_days: string;
  overtime_hours: string;
  unpaid_leave_days: string;
  lines: Array<{ code: string; name: string; kind: string; amount: string }>;
  cost_allocation: Array<CostAllocationShare & { amount: string }>;
  payment_status: "unpaid" | "paid";
  paid_at: string | null;
}

const PAYSLIP_SELECT = `SELECT p.id, p.run_id, r.period_key, r.run_type, r.sequence, r.status AS run_status, p.user_id,
       p.employee_name_snapshot, p.employee_code_snapshot, p.gross::text AS gross, p.insurable_raw::text AS insurable_raw,
       p.taxable_base::text AS taxable_base, p.insurance_base::text AS insurance_base,
       p.employee_insurance::text AS employee_insurance, p.employer_insurance::text AS employer_insurance,
       p.unemployment_insurance::text AS unemployment_insurance, p.income_tax::text AS income_tax,
       p.commission::text AS commission, p.advance_recovery::text AS advance_recovery,
       p.total_deductions::text AS total_deductions, p.net_pay::text AS net_pay, p.employee_debt::text AS employee_debt,
       p.employer_cost::text AS employer_cost, p.base_salary::text AS base_salary, p.worked_days::text AS worked_days,
       p.overtime_hours::text AS overtime_hours, p.unpaid_leave_days::text AS unpaid_leave_days,
       p.lines, p.cost_allocation, p.payment_status, p.paid_at::text AS paid_at
  FROM payroll_payslips p JOIN payroll_engine_runs r ON r.id = p.run_id`;

const toPayslip = (r: PayslipRow): Payslip => {
  const pick = (kind: string) => r.lines.filter((l) => l.kind === kind).map((l) => ({ code: l.code, name: l.name, amount: l.amount }));
  return {
    id: r.id,
    runId: r.run_id,
    periodKey: r.period_key,
    runType: r.run_type,
    sequence: r.sequence,
    runStatus: r.run_status,
    userId: r.user_id,
    employeeName: r.employee_name_snapshot,
    employeeCode: r.employee_code_snapshot,
    earnings: pick("earning"),
    deductions: pick("deduction"),
    employerContributions: pick("employer_contribution"),
    gross: r.gross,
    taxableBase: r.taxable_base,
    insuranceBase: r.insurance_base,
    employeeInsurance: r.employee_insurance,
    employerInsurance: r.employer_insurance,
    unemploymentInsurance: r.unemployment_insurance,
    incomeTax: r.income_tax,
    totalDeductions: r.total_deductions,
    netPay: r.net_pay,
    employeeDebt: r.employee_debt,
    employerCost: r.employer_cost,
    baseSalary: r.base_salary,
    workedDays: Number(r.worked_days),
    overtimeHours: Number(r.overtime_hours),
    unpaidLeaveDays: Number(r.unpaid_leave_days),
    costAllocation: r.cost_allocation ?? [],
    paymentStatus: r.payment_status,
    paidAt: r.paid_at,
  };
};

export async function listPayslips(businessId: string, runId: string): Promise<Payslip[]> {
  if (!isUuid(runId)) return [];
  const { rows } = await poolRunner<PayslipRow>(
    `${PAYSLIP_SELECT} WHERE p.business_id = $1 AND p.run_id = $2 ORDER BY p.employee_name_snapshot, p.id`,
    [businessId, runId],
  );
  return rows.map(toPayslip);
}

export async function getPayslip(businessId: string, payslipId: string): Promise<Payslip | null> {
  if (!isUuid(payslipId)) return null;
  const { rows } = await poolRunner<PayslipRow>(`${PAYSLIP_SELECT} WHERE p.business_id = $1 AND p.id = $2`, [businessId, payslipId]);
  return rows[0] ? toPayslip(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Validates the per-employee inputs map. Amounts stay integer text; nothing passes through `Number` except hours/days. */
function parseRunInputs(raw: unknown, supplemental: boolean): Record<string, EngineRunEmployeeInput> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PayrollError("invalid_inputs", 400, "inputs");
  const out: Record<string, EngineRunEmployeeInput> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 2000) throw new PayrollError("invalid_inputs", 400, "inputs");
  for (const [userId, value] of entries) {
    if (!isUuid(userId) || typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PayrollError("invalid_inputs", 400, userId);
    }
    const v = value as Record<string, unknown>;
    const entry: EngineRunEmployeeInput = {};
    for (const k of ["overtimeHours", "unpaidLeaveDays"] as const) {
      if (v[k] === undefined || v[k] === null) continue;
      const n = v[k];
      if (typeof n !== "number" || !Number.isFinite(n) || n < (supplemental ? -400 : 0) || n > 400 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
        throw new PayrollError(k === "overtimeHours" ? "invalid_overtime_hours" : "invalid_unpaid_leave_days", 400, userId);
      }
      entry[k] = n;
    }
    if (v.items !== undefined && v.items !== null) {
      if (!Array.isArray(v.items) || v.items.length > 50) throw new PayrollError("invalid_inputs", 400, userId);
      entry.items = v.items.map((item) => {
        const it = item as Record<string, unknown> | null;
        if (typeof it !== "object" || it === null || typeof it.code !== "string") throw new PayrollError("invalid_inputs", 400, userId);
        let amount: bigint;
        const text = typeof it.amount === "string" ? it.amount.trim() : it.amount;
        if (supplemental && typeof text === "string" && text.startsWith("-")) amount = -parseRialInput(text.slice(1));
        else if (supplemental && typeof text === "number" && text < 0) amount = -parseRialInput(-text);
        else amount = parseRialInput(text);
        if (amount > MAX_RIAL || -amount > MAX_RIAL) throw new PayrollError("amount_out_of_range", 400, userId);
        return { code: it.code, amount: amount.toString() };
      });
    }
    out[userId] = entry;
  }
  return out;
}


// ---------------------------------------------------------------------------
// Create / edit / cancel
// ---------------------------------------------------------------------------

export async function createEngineRun(params: {
  businessId: string;
  actorId: string | null;
  periodKey: unknown;
  runType?: unknown;
  accrualDate?: unknown;
  includeCommission?: unknown;
  inputs?: unknown;
  note?: unknown;
  idempotencyKey?: unknown;
}): Promise<EngineRun & { idempotentReplay: boolean }> {
  const resolved = resolvePayrollPeriodKey(params.periodKey);
  if (!resolved.ok) throw new PayrollError(resolved.error);
  const period = resolved.period;
  const runType: EngineRunType = params.runType === undefined || params.runType === null ? "regular" : (params.runType as EngineRunType);
  if (runType !== "regular" && runType !== "supplemental") throw new PayrollError("invalid_run_type", 400, "runType");
  const accrual = normalizeOptionalIsoDate(params.accrualDate);
  if (!accrual.ok) throw new PayrollError("invalid_accrual_date");
  if (params.includeCommission !== undefined && typeof params.includeCommission !== "boolean") throw new PayrollError("invalid_inputs", 400, "includeCommission");
  const note = params.note === undefined || params.note === null || params.note === "" ? null : params.note;
  if (note !== null && (typeof note !== "string" || note.length > 500)) throw new PayrollError("invalid_inputs", 400, "note");
  const inputs = parseRunInputs(params.inputs, runType === "supplemental");
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);

  const today = await businessToday(params.businessId);
  if (period.startsOn > today) throw new PayrollError("period_in_future");
  const accrualDate = accrual.value ?? defaultPayrollAccrualDate(period, today);
  if (accrualDate < period.startsOn) throw new PayrollError("invalid_accrual_date");

  const outcome = await inTransaction(async (client) => {
    await lockPayroll(client, params.businessId);
    if (idempotencyKey) {
      const { rows } = await client.query<{ id: string; period_key: string; run_type: string }>(
        `SELECT id, period_key, run_type FROM payroll_engine_runs WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, idempotencyKey],
      );
      if (rows[0]) {
        if (rows[0].period_key !== period.key || rows[0].run_type !== runType) throw new PayrollError("idempotency_key_conflict", 409);
        return { id: rows[0].id, replay: true };
      }
    }

    // #835 owns a month it already accrued (journal-level) — never book it twice.
    const { rows: legacy } = await client.query<{ id: string }>(
      `SELECT id FROM payroll_runs WHERE business_id = $1 AND period_key = $2 AND status <> 'voided'`,
      [params.businessId, period.key],
    );
    if (legacy[0]) throw new PayrollError("period_held_by_journal_payroll", 409, { runId: legacy[0].id });

    const { rows: existing } = await client.query<{ id: string; status: string; run_type: string }>(
      `SELECT id, status, run_type FROM payroll_engine_runs WHERE business_id = $1 AND period_key = $2 AND status <> 'cancelled'`,
      [params.businessId, period.key],
    );
    const regular = existing.find((r) => r.run_type === "regular");
    if (runType === "regular" && regular) throw new PayrollError("period_already_has_run", 409, { runId: regular.id });
    if (runType === "supplemental") {
      if (!regular || !STANDING.includes(regular.status as never)) throw new PayrollError("supplemental_requires_approved_run", 409);
      const open = existing.find((r) => !STANDING.includes(r.status as never));
      if (open) throw new PayrollError("open_run_exists", 409, { runId: open.id });
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payroll_engine_runs (business_id, period_key, run_type, sequence, accrual_date, include_commission, note, inputs,
                                        idempotency_key, created_by)
       VALUES ($1, $2, $3, COALESCE((SELECT max(sequence) FROM payroll_engine_runs WHERE business_id = $1 AND period_key = $2), 0) + 1,
               $4, $5, $6, $7, $8, $9) RETURNING id`,
      [params.businessId, period.key, runType, accrualDate, params.includeCommission === true, note, JSON.stringify(inputs), idempotencyKey, params.actorId],
    );
    return { id: rows[0].id, replay: false };
  });
  return { ...(await mustGetRun(params.businessId, outcome.id)), idempotentReplay: outcome.replay };
}

async function lockRun(client: PoolClient, businessId: string, runId: string): Promise<RunRow & { business_id: string }> {
  if (!isUuid(runId)) throw new PayrollError("run_not_found", 404);
  await lockPayroll(client, businessId);
  const { rows } = await client.query<RunRow & { business_id: string }>(
    `SELECT r.id, r.business_id, r.period_key, r.run_type, r.sequence, r.status, r.accrual_date::text AS accrual_date,
            r.include_commission, r.inputs FROM payroll_engine_runs r
      WHERE r.business_id = $1 AND r.id = $2 FOR UPDATE`,
    [businessId, runId],
  );
  if (!rows[0]) throw new PayrollError("run_not_found", 404);
  return rows[0];
}

function assertTransition(from: EngineRunStatus, to: EngineRunStatus): void {
  if (!canTransition(from, to)) {
    if (from === "cancelled") throw new PayrollError("run_cancelled", 409);
    if (STANDING.includes(from as never)) throw new PayrollError("run_immutable", 409, { status: from });
    throw new PayrollError("invalid_run_transition", 409, { from, to });
  }
}

/** Replaces a not-yet-approved run's inputs; it goes back to draft and must be recalculated. */
export async function updateEngineRunInputs(params: { businessId: string; runId: string; inputs: unknown; includeCommission?: unknown; note?: unknown }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    if (run.status === "cancelled") throw new PayrollError("run_cancelled", 409);
    if (STANDING.includes(run.status as never)) throw new PayrollError("run_immutable", 409, { status: run.status });
    const inputs = parseRunInputs(params.inputs, run.run_type === "supplemental");
    if (params.includeCommission !== undefined && typeof params.includeCommission !== "boolean") throw new PayrollError("invalid_inputs", 400, "includeCommission");
    await releaseCommission(client, run.id);
    await client.query(`DELETE FROM payroll_payslips WHERE run_id = $1`, [run.id]);
    await client.query(
      `UPDATE payroll_engine_runs SET inputs = $2, include_commission = COALESCE($3, include_commission),
              note = COALESCE($4, note), status = 'draft', totals = NULL, calculated_at = NULL, reviewed_at = NULL, reviewed_by = NULL
        WHERE id = $1`,
      [run.id, JSON.stringify(inputs), params.includeCommission ?? null, typeof params.note === "string" ? params.note.slice(0, 500) : null],
    );
  });
  return mustGetRun(params.businessId, params.runId);
}

async function releaseCommission(client: PoolClient, runId: string): Promise<void> {
  await client.query(`UPDATE commission_accruals SET payroll_engine_run_id = NULL WHERE payroll_engine_run_id = $1`, [runId]);
}

export async function cancelEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    assertTransition(run.status, "cancelled");
    await releaseCommission(client, run.id);
    await client.query(`DELETE FROM payroll_payslips WHERE run_id = $1`, [run.id]);
    await client.query(`UPDATE payroll_engine_runs SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1`, [run.id, params.actorId]);
  });
  return mustGetRun(params.businessId, params.runId);
}

// ---------------------------------------------------------------------------
// Calculate
// ---------------------------------------------------------------------------

interface EmployeeRow extends Record<string, unknown> {
  user_id: string;
  full_name: string;
  code: string | null;
  base_salary: string;
  hire_date: string | null;
  termination_date: string | null;
  insured: boolean;
  tax_exempt: boolean;
  cost_allocation: CostAllocationShare[];
}

/**
 * What earlier standing runs of the same month recorded, per employee — read
 * from the payslip snapshots, never recomputed from today's profile: the rate
 * and days of the regular run, and the overtime / unpaid leave (hours, days and
 * amounts) across every standing run, so a correction is priced like the
 * original and can never reverse more than was paid or deducted.
 */
async function priorTotals(run: Runner, businessId: string, periodKey: string, excludeRunId: string): Promise<Map<string, PriorPeriodTotals>> {
  const { rows } = await run<Record<string, string | null>>(
    `SELECT p.user_id, sum(p.insurable_raw)::text AS insurable_raw, sum(p.insurance_base)::text AS insurance_base,
            sum(p.employee_insurance)::text AS employee_insurance, sum(p.employer_insurance)::text AS employer_insurance,
            sum(p.unemployment_insurance)::text AS unemployment_insurance, sum(p.taxable_base)::text AS taxable_base,
            sum(p.income_tax)::text AS income_tax,
            COALESCE(max(p.base_salary) FILTER (WHERE r.run_type = 'regular'), 0)::text AS base_salary,
            max(p.worked_days) FILTER (WHERE r.run_type = 'regular')::text AS worked_days,
            sum(p.overtime_hours)::text AS overtime_hours, sum(p.unpaid_leave_days)::text AS unpaid_leave_days,
            COALESCE(sum((SELECT sum((l->>'amount')::bigint) FROM jsonb_array_elements(p.lines) l WHERE l->>'systemKey' = 'overtime')), 0)::text AS overtime_amount,
            COALESCE(-sum((SELECT sum((l->>'amount')::bigint) FROM jsonb_array_elements(p.lines) l WHERE l->>'systemKey' = 'unpaid_leave')), 0)::text AS unpaid_leave_amount
       FROM payroll_payslips p JOIN payroll_engine_runs r ON r.id = p.run_id AND r.business_id = p.business_id
      WHERE r.business_id = $1 AND r.period_key = $2 AND r.id <> $3 AND r.status = ANY($4::text[]) AND p.user_id IS NOT NULL
      GROUP BY p.user_id`,
    [businessId, periodKey, excludeRunId, STANDING],
  );
  return new Map(
    rows.map((r) => [
      r.user_id as string,
      {
        insurableRaw: BigInt(r.insurable_raw!),
        insuranceBase: BigInt(r.insurance_base!),
        employeeInsurance: BigInt(r.employee_insurance!),
        employerInsurance: BigInt(r.employer_insurance!),
        unemploymentInsurance: BigInt(r.unemployment_insurance!),
        taxableBase: BigInt(r.taxable_base!),
        incomeTax: BigInt(r.income_tax!),
        baseSalary: BigInt(r.base_salary!),
        workedDays: r.worked_days === null ? null : Number(r.worked_days),
        overtimeHours: Number(r.overtime_hours),
        overtimeAmount: BigInt(r.overtime_amount!),
        unpaidLeaveDays: Number(r.unpaid_leave_days),
        unpaidLeaveAmount: BigInt(r.unpaid_leave_amount!),
      },
    ]),
  );
}

/**
 * Computes every payslip of a draft / calculated / reviewed run against the
 * rule version in force on its accrual date, replacing any earlier draft
 * calculation. A regular run covers every active profile employed during the
 * month — prorated over the days employed (hire / termination) and each
 * recurring item over its own effective window; a supplemental run covers only
 * the employees named in its inputs, with signed corrections.
 */
export async function calculateEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    assertTransition(run.status, "calculated");
    const runner = clientRunner(client);
    const resolved = resolvePayrollPeriodKey(run.period_key);
    if (!resolved.ok) throw new PayrollError("invalid_period");
    const period = resolved.period;
    const supplemental = run.run_type === "supplemental";

    await ensureCatalogue(client, params.businessId);
    const ruleSet = await ruleSetFor(runner, params.businessId, run.accrual_date);
    if (!ruleSet) throw new PayrollError("no_rule_set", 409);
    const monthDays = ruleSet.rules.monthDays;
    const catalogue: PayrollComponentDef[] = (await componentsFor(runner, params.businessId, run.accrual_date)).map((c) => ({
      code: c.code, name: c.name, kind: c.kind, systemKey: c.systemKey, taxable: c.taxable, insurable: c.insurable,
      debitAccountCode: c.debitAccountCode, creditAccountCode: c.creditAccountCode,
    }));

    const { rows: employees } = await client.query<EmployeeRow>(
      `SELECT u.id AS user_id, u.full_name, COALESCE(p.payroll_code, e.employee_code) AS code, p.base_salary::text AS base_salary,
              p.hire_date::text AS hire_date, p.termination_date::text AS termination_date,
              COALESCE((p.insurance_profile->>'insured')::boolean, true) AS insured,
              COALESCE((p.tax_profile->>'exempt')::boolean, false) AS tax_exempt, p.cost_allocation
         FROM payroll_employee_profiles p
         JOIN users u ON u.id = p.user_id AND u.business_id = p.business_id
         LEFT JOIN employees e ON e.id = u.id
        WHERE p.business_id = $1 AND p.is_active
          AND (p.hire_date IS NULL OR p.hire_date <= $3::date)
          AND (p.termination_date IS NULL OR p.termination_date >= $2::date)
        ORDER BY u.full_name, u.id`,
      [params.businessId, period.startsOn, period.endsOn],
    );
    const inputs = run.inputs ?? {};
    for (const userId of Object.keys(inputs)) {
      if (!employees.some((e) => e.user_id === userId)) throw new PayrollError("employee_not_in_payroll", 400, userId);
    }
    const covered = supplemental ? employees.filter((e) => inputs[e.user_id]) : employees;
    if (covered.length === 0) throw new PayrollError("no_employees", 409);

    // Allocations are re-checked here: a branch closed or project archived since
    // the profile was saved must not receive a journal line.
    for (const emp of covered) {
      try {
        await assertAllocationReferences(runner, params.businessId, emp.cost_allocation ?? []);
      } catch (err) {
        if (err instanceof PayrollError) throw new PayrollError(err.message, err.status, { ...err.details, userId: emp.user_id });
        throw err;
      }
    }

    const items = supplemental ? new Map() : await itemsInForce(runner, params.businessId, period.startsOn, period.endsOn);
    const prior = supplemental ? await priorTotals(runner, params.businessId, run.period_key, run.id) : new Map<string, PriorPeriodTotals>();
    const owed = supplemental ? new Map<string, bigint>() : await outstandingAdvances(runner, params.businessId, { excludeEngineRunId: run.id });

    // Commission: release this run's earlier reservation, then reserve what is unsettled now.
    await releaseCommission(client, run.id);
    const commission = new Map<string, bigint>();
    if (run.include_commission) {
      const { rows } = await client.query<{ employee_id: string; net: string; ids: string[] }>(
        `SELECT a.employee_id, sum(a.amount)::text AS net, array_agg(a.id) AS ids
           FROM commission_accruals a LEFT JOIN journal_entries je ON je.id = a.entry_id
          WHERE a.business_id = $1 AND a.payroll_run_id IS NULL AND a.payroll_engine_run_id IS NULL
            AND COALESCE(je.entry_date, a.created_at::date) <= $2::date AND a.employee_id = ANY($3::uuid[])
          GROUP BY a.employee_id HAVING sum(a.amount) > 0`,
        [params.businessId, run.accrual_date, covered.map((e) => e.user_id)],
      );
      for (const r of rows) {
        commission.set(r.employee_id, BigInt(r.net));
        await client.query(`UPDATE commission_accruals SET payroll_engine_run_id = $1 WHERE id = ANY($2::uuid[])`, [run.id, r.ids]);
      }
    }

    await client.query(`DELETE FROM payroll_payslips WHERE run_id = $1`, [run.id]);
    const totals = { gross: 0n, ei: 0n, eri: 0n, ui: 0n, tax: 0n, ded: 0n, net: 0n, debt: 0n, cost: 0n, commission: 0n };
    for (const emp of covered) {
      const input = inputs[emp.user_id] ?? {};
      const before = prior.get(emp.user_id) ?? NO_PRIOR;
      const employment = { from: emp.hire_date, to: emp.termination_date };
      const workedDays = supplemental ? before.workedDays : coveredDays(period.startsOn, period.endsOn, [employment], monthDays);
      const recurring = (items.get(emp.user_id) ?? []) as Array<{ componentCode: string; amount: string; effectiveFrom: string; effectiveTo: string | null }>;
      const baseSalary = supplemental ? before.baseSalary : BigInt(emp.base_salary);
      let slip;
      try {
        slip = computePayslip(
          {
            baseSalary,
            workedDays: supplemental ? null : workedDays,
            insured: emp.insured,
            taxExempt: emp.tax_exempt,
            overtimeHours: input.overtimeHours ?? 0,
            unpaidLeaveDays: input.unpaidLeaveDays ?? 0,
            items: [
              ...recurring.map((i) => ({
                code: i.componentCode,
                amount: prorate(
                  BigInt(i.amount),
                  coveredDays(period.startsOn, period.endsOn, [employment, { from: i.effectiveFrom, to: i.effectiveTo }], monthDays),
                  monthDays,
                ),
              })),
              ...(input.items ?? []).map((i) => ({ code: i.code, amount: BigInt(i.amount) })),
            ],
            commission: commission.get(emp.user_id) ?? 0n,
            advanceOwed: owed.get(emp.user_id) ?? 0n,
          },
          ruleSet.rules,
          catalogue,
          before,
          { supplemental },
        );
      } catch (err) {
        if (err instanceof PayrollCalcError) throw new PayrollError(err.message, 400, { field: err.field ?? emp.user_id, userId: emp.user_id });
        throw err;
      }
      const shares = emp.cost_allocation ?? [];
      const parts = shares.length > 0 ? allocateExact(slip.employerCost, shares.map((s) => s.percent)) : [];
      const allocation = shares.map((s, i) => ({ ...s, amount: parts[i].toString() }));
      const sum = (key: PayslipLine["systemKey"]) => slip.lines.filter((l) => l.systemKey === key).reduce((s, l) => s + l.amount, 0n);
      await client.query(
        `INSERT INTO payroll_payslips (business_id, run_id, user_id, employee_name_snapshot, employee_code_snapshot, gross, insurable_raw,
            insurance_base, employee_insurance, employer_insurance, unemployment_insurance, taxable_base, income_tax, commission,
            advance_recovery, total_deductions, net_pay, employee_debt, employer_cost, base_salary, worked_days, overtime_hours,
            unpaid_leave_days, lines, cost_allocation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          params.businessId, run.id, emp.user_id, emp.full_name, emp.code, slip.gross.toString(), slip.insurableRaw.toString(),
          slip.insuranceBase.toString(), slip.employeeInsurance.toString(), slip.employerInsurance.toString(),
          slip.unemploymentInsurance.toString(), slip.taxableBase.toString(), slip.incomeTax.toString(),
          sum("commission").toString(), sum("advance_recovery").toString(), slip.totalDeductions.toString(),
          slip.netPay.toString(), slip.employeeDebt.toString(), slip.employerCost.toString(), baseSalary.toString(),
          workedDays ?? monthDays, input.overtimeHours ?? 0, input.unpaidLeaveDays ?? 0,
          JSON.stringify(slip.lines.map((l) => ({ ...l, amount: l.amount.toString() }))), JSON.stringify(allocation),
        ],
      );
      totals.gross += slip.gross;
      totals.ei += slip.employeeInsurance;
      totals.eri += slip.employerInsurance;
      totals.ui += slip.unemploymentInsurance;
      totals.tax += slip.incomeTax;
      totals.ded += slip.totalDeductions;
      totals.net += slip.netPay;
      totals.debt += slip.employeeDebt;
      totals.cost += slip.employerCost;
      totals.commission += sum("commission");
    }
    if (totals.cost > MAX_RIAL || totals.gross > MAX_RIAL || -totals.gross > MAX_RIAL) throw new PayrollError("amount_out_of_range");
    const runTotals: EngineRunTotals = {
      employees: covered.length,
      gross: totals.gross.toString(),
      employeeInsurance: totals.ei.toString(),
      employerInsurance: totals.eri.toString(),
      unemploymentInsurance: totals.ui.toString(),
      incomeTax: totals.tax.toString(),
      totalDeductions: totals.ded.toString(),
      netPay: totals.net.toString(),
      employeeDebt: totals.debt.toString(),
      employerCost: totals.cost.toString(),
      commission: totals.commission.toString(),
    };
    await client.query(
      `UPDATE payroll_engine_runs SET status = 'calculated', rule_set_id = $2, rule_snapshot = $3, components_snapshot = $4,
              totals = $5, calculated_at = now(), reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`,
      [run.id, ruleSet.id, JSON.stringify({ version: ruleSet.version, title: ruleSet.title, effectiveFrom: ruleSet.effectiveFrom, rules: ruleSet.rules }),
       JSON.stringify(catalogue), JSON.stringify(runTotals)],
    );
  });
  return mustGetRun(params.businessId, params.runId);
}

// ---------------------------------------------------------------------------
// Review / approve / post / pay / close
// ---------------------------------------------------------------------------

export async function reviewEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    assertTransition(run.status, "reviewed");
    await client.query(`UPDATE payroll_engine_runs SET status = 'reviewed', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [run.id, params.actorId]);
  });
  return mustGetRun(params.businessId, params.runId);
}

/** Freezes the calculation. From here on the run and its payslips are immutable (DB-enforced). */
export async function approveEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    assertTransition(run.status, "approved");
    await client.query(`UPDATE payroll_engine_runs SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [run.id, params.actorId]);
  });
  return mustGetRun(params.businessId, params.runId);
}

/** The accrual, from the frozen payslips. Idempotent: a posted run answers `already_posted`, and the source key is unique. */
/** One accrual journal entry's slice: a branch × project bucket and the payslip shares charged to it. */
interface AccrualBucket {
  postingKind: string;
  locationId: string | null;
  projectId: string | null;
  parts: PostablePayslip[];
}

/**
 * Splits payslips into cost-allocation buckets. Each payslip is divided exactly
 * by its own allocation snapshot (`allocatePayslip` — every line and the debt
 * split to the Rial, net derived per share so each share balances); an
 * unallocated payslip goes whole to the undimensioned bucket. Buckets are
 * ordered by key so posting order — and so entry ids order — is deterministic.
 */
function accrualBuckets(
  payslips: ReadonlyArray<PostablePayslip & { costAllocation: readonly CostAllocationShare[] }>,
): AccrualBucket[] {
  const buckets = new Map<string, AccrualBucket>();
  const bucketFor = (locationId: string | null, projectId: string | null) => {
    const postingKind = `alloc:${locationId ?? "-"}:${projectId ?? "-"}`;
    let bucket = buckets.get(postingKind);
    if (!bucket) buckets.set(postingKind, (bucket = { postingKind, locationId, projectId, parts: [] }));
    return bucket;
  };
  for (const slip of payslips) {
    const shares = slip.costAllocation;
    const parts = allocatePayslip(slip, shares.map((s) => s.percent));
    if (shares.length === 0) bucketFor(null, null).parts.push(parts[0]);
    else shares.forEach((share, i) => bucketFor(share.locationId ?? null, share.projectId ?? null).parts.push(parts[i]));
  }
  return [...buckets.values()].sort((x, y) => x.postingKind.localeCompare(y.postingKind));
}

/**
 * Posts the accrual: one balanced entry per cost-allocation bucket, carrying the
 * bucket's branch (`location_id`) and project (`project_id`). Each entry is
 * keyed `(payroll_engine_accrual, run id, posting_kind)` under the ledger's
 * unique posting index, so no bucket can be posted twice even by a racing retry.
 */
export async function postEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    if (run.status === "posted" || run.status === "paid" || run.status === "closed") throw new PayrollError("already_posted", 409);
    assertTransition(run.status, "posted");
    const { rows } = await client.query<{
      lines: Array<PayslipLine & { amount: string }>;
      net_pay: string;
      employee_debt: string;
      cost_allocation: CostAllocationShare[];
    }>(
      `SELECT lines, net_pay::text AS net_pay, employee_debt::text AS employee_debt, cost_allocation
         FROM payroll_payslips WHERE run_id = $1 AND business_id = $2 ORDER BY id`,
      [run.id, params.businessId],
    );
    const buckets = accrualBuckets(
      rows.map((r) => ({
        netPay: BigInt(r.net_pay),
        employeeDebt: BigInt(r.employee_debt),
        lines: r.lines.map((l) => ({ ...l, amount: BigInt(l.amount) })),
        costAllocation: r.cost_allocation ?? [],
      })),
    );
    const postingAccounts = { salariesPayable: WELL_KNOWN_CODES.salariesPayable, employeeDebt: WELL_KNOWN_CODES.staffAdvances };
    const memo = `حقوق و دستمزد — ${periodLabel(run.period_key)}${run.run_type === "supplemental" ? ` (اصلاحی ${run.sequence})` : ""}`;
    const entryIds: string[] = [];
    for (const bucket of buckets) {
      const sides = accrualPostingSides(bucket.parts, postingAccounts);
      if (sides.length === 0) continue;
      const accounts = await accountIdsByCode(client, params.businessId, sides.map((s) => s.accountCode));
      const entryId = await postExactJournalEntry(client, {
          businessId: params.businessId,
          locationId: bucket.locationId,
          projectId: bucket.projectId,
          postingKind: bucket.postingKind,
          entryDate: run.accrual_date,
          memo,
          sourceType: "payroll_engine_accrual",
          sourceId: run.id,
          createdBy: params.actorId,
          lines: sides.map((s) => ({ accountId: accounts.get(s.accountCode)!, debit: asRial(s.debit), credit: asRial(s.credit) })),
        });
      if (entryId) entryIds.push(entryId);
    }
    await client.query(
      `UPDATE payroll_engine_runs SET status = 'posted', accrual_entry_ids = $2::uuid[], posted_by = $3, posted_at = now() WHERE id = $1`,
      [run.id, entryIds, params.actorId],
    );
  });
  return mustGetRun(params.businessId, params.runId);
}

/** Pays every payslip's net: Debit 2300 / Credit the payout account. Marks the payslips paid. */
export async function payEngineRun(params: {
  businessId: string;
  runId: string;
  actorId: string | null;
  paidDate?: unknown;
  method?: unknown;
  paymentAccountId?: unknown;
}): Promise<EngineRun> {
  const date = normalizeOptionalIsoDate(params.paidDate);
  if (!date.ok) throw new PayrollError("invalid_paid_date");
  const method = params.method === undefined || params.method === null ? "bank" : params.method;
  if (method !== "cash" && method !== "bank") throw new PayrollError("invalid_method");
  if (params.paymentAccountId !== undefined && params.paymentAccountId !== null && !isUuid(params.paymentAccountId)) {
    throw new PayrollError("invalid_payment_account");
  }
  const paidDate = date.value ?? (await businessToday(params.businessId));

  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    if (run.status === "paid" || run.status === "closed") throw new PayrollError("already_paid", 409);
    assertTransition(run.status, "paid");
    if (paidDate < run.accrual_date) throw new PayrollError("paid_date_before_accrual");
    const { rows } = await client.query<{ net: string }>(`SELECT COALESCE(sum(net_pay), 0)::text AS net FROM payroll_payslips WHERE run_id = $1`, [run.id]);
    const net = BigInt(rows[0].net);
    let entryId: string | null = null;
    if (net > 0n) {
      const payout = await resolvePayoutAccount(client, params.businessId, { method, paymentAccountId: (params.paymentAccountId as string | null) ?? null });
      const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.salariesPayable]);
      entryId = await postExactJournalEntry(client, {
        businessId: params.businessId,
        locationId: null,
        entryDate: paidDate,
        memo: `پرداخت حقوق و دستمزد — ${periodLabel(run.period_key)}`,
        sourceType: "payroll_engine_payment",
        sourceId: run.id,
        createdBy: params.actorId,
        lines: [
          { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: asRial(net), credit: asRial(0n) },
          { accountId: payout.accountId, debit: asRial(0n), credit: asRial(net) },
        ],
      });
    }
    await client.query(`UPDATE payroll_payslips SET payment_status = 'paid', paid_at = $2 WHERE run_id = $1`, [run.id, paidDate]);
    await client.query(
      `UPDATE payroll_engine_runs SET status = 'paid', payment_entry_id = $2, paid_date = $3, paid_by = $4 WHERE id = $1`,
      [run.id, entryId, paidDate, params.actorId],
    );
  });
  return mustGetRun(params.businessId, params.runId);
}

export async function closeEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    assertTransition(run.status, "closed");
    await client.query(`UPDATE payroll_engine_runs SET status = 'closed', closed_by = $2, closed_at = now() WHERE id = $1`, [run.id, params.actorId]);
  });
  return mustGetRun(params.businessId, params.runId);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Payroll register — every payslip of a period's standing runs (or of one run). */
/**
 * The payroll register for a period and/or one run. Filters are strict: a
 * malformed `runId` is `invalid_run_id` and a malformed period `invalid_period`
 * — never silently dropped, which would widen the report to every run.
 */
export async function payrollRegister(businessId: string, filter: { periodKey?: string | null; runId?: string | null }) {
  const runId = filter.runId === undefined || filter.runId === null || filter.runId === "" ? null : filter.runId;
  const rawPeriod = filter.periodKey === undefined || filter.periodKey === null || filter.periodKey === "" ? null : filter.periodKey;
  if (runId !== null && !isUuid(runId)) throw new PayrollError("invalid_run_id", 400, "runId");
  let periodKey: string | null = null;
  if (rawPeriod !== null) {
    const resolved = resolvePayrollPeriodKey(rawPeriod);
    if (!resolved.ok) throw new PayrollError("invalid_period", 400, "period");
    periodKey = resolved.period.key;
  }
  if (runId === null && periodKey === null) throw new PayrollError("invalid_period", 400, "period");
  const { rows } = await poolRunner<PayslipRow>(
    `${PAYSLIP_SELECT} WHERE p.business_id = $1 AND ($2::text IS NULL OR r.period_key = $2) AND ($3::uuid IS NULL OR r.id = $3)
        AND (r.id = $3 OR r.status = ANY($4::text[]))
      ORDER BY p.employee_name_snapshot, r.sequence, p.id`,
    [businessId, periodKey, runId, STANDING],
  );
  const payslips = rows.map(toPayslip);
  return { payslips, totals: sumPayslips(payslips) };
}

function sumPayslips(slips: Payslip[]) {
  const keys = ["gross", "taxableBase", "insuranceBase", "employeeInsurance", "employerInsurance", "unemploymentInsurance", "incomeTax", "totalDeductions", "netPay", "employeeDebt", "employerCost"] as const;
  const out = Object.fromEntries(keys.map((k) => [k, 0n])) as Record<(typeof keys)[number], bigint>;
  for (const s of slips) for (const k of keys) out[k] += BigInt(s[k]);
  return Object.fromEntries(keys.map((k) => [k, out[k].toString()])) as Record<(typeof keys)[number], string>;
}

/** Employee payroll card — one member's standing payslips over a Jalali year. */
export async function employeePayrollCard(businessId: string, userId: string, year: string | number) {
  if (!isUuid(userId)) throw new PayrollError("invalid_user_id", 400, "userId");
  const jalaliYear = typeof year === "number" ? year : /^\d{4}$/.test(year) ? Number(year) : NaN;
  if (!Number.isInteger(jalaliYear) || jalaliYear < 1300 || jalaliYear > 1599) throw new PayrollError("invalid_period", 400, "year");
  const { rows } = await poolRunner<PayslipRow>(
    `${PAYSLIP_SELECT} WHERE p.business_id = $1 AND p.user_id = $2 AND r.period_key LIKE $3 AND r.status = ANY($4::text[])
      ORDER BY r.period_key, r.sequence`,
    [businessId, userId, `${jalaliYear}-%`, STANDING],
  );
  const payslips = rows.map(toPayslip);
  return { userId, year: jalaliYear, payslips, totals: sumPayslips(payslips) };
}

/** Per-period summary from standing runs — the basis of the insurance, tax, employer-cost and comparison reports. */
async function periodSummaries(businessId: string, periodKeys: string[] | null) {
  const { rows } = await poolRunner<Record<string, string>>(
    `SELECT r.period_key, count(DISTINCT p.user_id)::text AS employees, sum(p.gross)::text AS gross,
            sum(p.insurance_base)::text AS insurance_base, sum(p.employee_insurance)::text AS employee_insurance,
            sum(p.employer_insurance)::text AS employer_insurance, sum(p.unemployment_insurance)::text AS unemployment_insurance,
            sum(p.taxable_base)::text AS taxable_base, sum(p.income_tax)::text AS income_tax,
            sum(p.total_deductions)::text AS total_deductions, sum(p.net_pay)::text AS net_pay,
            sum(p.employee_debt)::text AS employee_debt, sum(p.employer_cost)::text AS employer_cost
       FROM payroll_payslips p JOIN payroll_engine_runs r ON r.id = p.run_id
      WHERE p.business_id = $1 AND r.status = ANY($2::text[]) AND ($3::text[] IS NULL OR r.period_key = ANY($3::text[]))
      GROUP BY r.period_key ORDER BY r.period_key DESC LIMIT 120`,
    [businessId, STANDING, periodKeys],
  );
  return rows.map((r) => ({
    periodKey: r.period_key,
    periodLabel: periodLabel(r.period_key),
    employees: Number(r.employees),
    gross: r.gross,
    insuranceBase: r.insurance_base,
    employeeInsurance: r.employee_insurance,
    employerInsurance: r.employer_insurance,
    unemploymentInsurance: r.unemployment_insurance,
    totalInsurance: (BigInt(r.employee_insurance) + BigInt(r.employer_insurance) + BigInt(r.unemployment_insurance)).toString(),
    taxableBase: r.taxable_base,
    incomeTax: r.income_tax,
    totalDeductions: r.total_deductions,
    netPay: r.net_pay,
    employeeDebt: r.employee_debt,
    employerCost: r.employer_cost,
  }));
}

/** Insurance summary (the basis of the monthly SSO list) — per employee for one period. */
export async function insuranceSummary(businessId: string, periodKey: string) {
  const { payslips } = await payrollRegister(businessId, { periodKey });
  const perEmployee = groupByEmployee(payslips, ["insuranceBase", "employeeInsurance", "employerInsurance", "unemploymentInsurance"]);
  return { periodKey, employees: perEmployee, totals: (await periodSummaries(businessId, [periodKey]))[0] ?? null };
}

/** Payroll tax summary (the basis of the monthly payroll-tax return) — per employee for one period. */
export async function payrollTaxSummary(businessId: string, periodKey: string) {
  const { payslips } = await payrollRegister(businessId, { periodKey });
  const perEmployee = groupByEmployee(payslips, ["gross", "taxableBase", "incomeTax"]);
  return { periodKey, employees: perEmployee, totals: (await periodSummaries(businessId, [periodKey]))[0] ?? null };
}

/** Employer cost — per employee and per cost-allocation share (branch / project) for one period. */
export async function employerCostReport(businessId: string, periodKey: string) {
  const { payslips } = await payrollRegister(businessId, { periodKey });
  const perEmployee = groupByEmployee(payslips, ["gross", "employerInsurance", "unemploymentInsurance", "employerCost"]);
  const allocation = new Map<string, { locationId: string | null; projectId: string | null; label: string | null; amount: bigint }>();
  let unallocated = 0n;
  for (const s of payslips) {
    if (s.costAllocation.length === 0) unallocated += BigInt(s.employerCost);
    for (const a of s.costAllocation) {
      const key = `${a.locationId ?? ""}|${a.projectId ?? ""}|${a.label ?? ""}`;
      const row = allocation.get(key) ?? { locationId: a.locationId ?? null, projectId: a.projectId ?? null, label: a.label ?? null, amount: 0n };
      row.amount += BigInt(a.amount);
      allocation.set(key, row);
    }
  }
  return {
    periodKey,
    employees: perEmployee,
    allocation: [...allocation.values()].map((a) => ({ ...a, amount: a.amount.toString() })),
    unallocated: unallocated.toString(),
  };
}

function groupByEmployee<K extends keyof Payslip>(payslips: Payslip[], keys: K[]) {
  const map = new Map<string, { userId: string | null; employeeName: string; employeeCode: string | null } & Record<string, string | null>>();
  for (const s of payslips) {
    const id = s.userId ?? `deleted:${s.employeeName}`;
    const row = map.get(id) ?? { userId: s.userId, employeeName: s.employeeName, employeeCode: s.employeeCode, ...Object.fromEntries(keys.map((k) => [k, "0"])) };
    for (const k of keys) row[k as string] = (BigInt(row[k as string] ?? "0") + BigInt(s[k] as string)).toString();
    map.set(id, row);
  }
  return [...map.values()];
}

/** Period comparison — standing-run totals for two months side by side, with the difference. */
export async function periodComparison(businessId: string, periodA: string, periodB: string) {
  const keys = [periodA, periodB].map((raw, i) => {
    const resolved = resolvePayrollPeriodKey(raw);
    if (!resolved.ok) throw new PayrollError("invalid_period", 400, i === 0 ? "a" : "b");
    return resolved.period.key;
  });
  [periodA, periodB] = keys;
  const rows = await periodSummaries(businessId, [periodA, periodB]);
  const a = rows.find((r) => r.periodKey === periodA) ?? null;
  const b = rows.find((r) => r.periodKey === periodB) ?? null;
  const fields = ["gross", "totalInsurance", "incomeTax", "netPay", "employerCost"] as const;
  const difference = Object.fromEntries(fields.map((f) => [f, (BigInt(b?.[f] ?? "0") - BigInt(a?.[f] ?? "0")).toString()]));
  return { a, b, difference };
}

export const payrollPeriodSummaries = (businessId: string) => periodSummaries(businessId, null);

/**
 * Reconciles what the engine's payslips say each payroll account should hold
 * against what the engine's journal entries actually put there (and shows the
 * account's full balance beside it). All reads run on one REPEATABLE READ
 * snapshot, so a run posted or paid mid-report cannot make it disagree with
 * itself. `onSnapshotTaken` is a test seam: it runs after the first read, while
 * the snapshot is held.
 */
export async function payrollLiabilityReconciliation(businessId: string, options: { onSnapshotTaken?: () => Promise<void> } = {}) {
  return inSnapshot(async (client) => {
    const { rows: runs } = await client.query<{ id: string }>(
      `SELECT r.id FROM payroll_engine_runs r WHERE r.business_id = $1 AND r.status IN ('posted', 'paid', 'closed')`,
      [businessId],
    );
    await options.onSnapshotTaken?.();
    const { rows: slipRows } = await client.query<{ lines: Array<PayslipLine & { amount: string }>; net_pay: string; employee_debt: string; paid: boolean }>(
      `SELECT p.lines, p.net_pay::text AS net_pay, p.employee_debt::text AS employee_debt, (r.status IN ('paid', 'closed')) AS paid
         FROM payroll_payslips p JOIN payroll_engine_runs r ON r.id = p.run_id AND r.business_id = p.business_id
        WHERE r.business_id = $1 AND r.status IN ('posted', 'paid', 'closed')`,
      [businessId],
    );
    const salariesPayable = WELL_KNOWN_CODES.salariesPayable;
    const expected = new Map<string, bigint>();
    const sides = accrualPostingSides(
      slipRows.map((r) => ({
        netPay: BigInt(r.net_pay),
        employeeDebt: BigInt(r.employee_debt),
        lines: r.lines.map((l) => ({ ...l, amount: BigInt(l.amount) })),
      })),
      { salariesPayable, employeeDebt: WELL_KNOWN_CODES.staffAdvances },
    );
    for (const s of sides) expected.set(s.accountCode, s.credit - s.debit);
    const paidNet = slipRows.filter((r) => r.paid).reduce((s, r) => s + BigInt(r.net_pay), 0n);
    expected.set(salariesPayable, (expected.get(salariesPayable) ?? 0n) - paidNet);

    const liabilityCodes = [
      ...new Set([salariesPayable, WELL_KNOWN_CODES.insurancePayable, WELL_KNOWN_CODES.payrollTaxPayable, "2490", WELL_KNOWN_CODES.staffAdvances, ...expected.keys()]),
    ].filter((code) => !code.startsWith("5"));
    const { rows: gl } = await client.query<{ code: string; engine: string; total: string }>(
      `SELECT a.code,
              COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE je.source_type IN ('payroll_engine_accrual', 'payroll_engine_payment')), 0)::text AS engine,
              COALESCE(sum(jl.credit - jl.debit), 0)::text AS total
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
         LEFT JOIN journal_entries je ON je.id = jl.entry_id
        WHERE a.business_id = $1 AND a.code = ANY($2::text[])
        GROUP BY a.code`,
      [businessId, liabilityCodes],
    );
    const accounts = liabilityCodes.map((code) => {
      const row = gl.find((g) => g.code === code);
      const exp = expected.get(code) ?? 0n;
      const actual = BigInt(row?.engine ?? "0");
      return { code, expected: exp.toString(), glFromEngine: actual.toString(), difference: (actual - exp).toString(), glTotal: row?.total ?? "0" };
    });
    return { runs: runs.length, payslips: slipRows.length, accounts, reconciled: accounts.every((a) => a.difference === "0") };
  });
}
