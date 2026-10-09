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
 * - **Commission** included in a run is *reserved* at calculation
 *   (`commission_accruals.payroll_engine_run_id`) and released on cancel /
 *   recalculation; its posting reclassifies 2300 rather than expensing it again.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { normalizeOptionalIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { businessToday } from "./business-day-service";
import { accountIdsByCode, postExactJournalEntry } from "./ledger-service";
import { MAX_RIAL } from "./inventory-exact";
import { parseRialInput } from "./payroll-amounts";
import { resolvePayoutAccount } from "./payroll-accounts";
import { asRial, clientRunner, inTransaction, lockPayroll, poolRunner } from "./payroll-db";
import { PayrollError } from "./payroll-errors";
import { resolvePayrollPeriodKey } from "./payroll-period";
import { componentsFor, ensureCatalogue, itemsInForce, ruleSetFor, type CostAllocationShare } from "./payroll-engine-setup";
import {
  accrualPostingSides,
  allocateExact,
  canTransition,
  computePayslip,
  NO_PRIOR,
  PayrollCalcError,
  type PayrollComponentDef,
  type PayrollRuleSet,
  type PayslipLine,
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
  accrualEntryId: string | null;
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
  employerCost: string;
  costAllocation: Array<CostAllocationShare & { amount: string }>;
  paymentStatus: "unpaid" | "paid";
  paidAt: string | null;
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const STANDING = ["approved", "posted", "paid", "closed"] as const;

function calcError(err: unknown): never {
  if (err instanceof PayrollCalcError) throw new PayrollError(err.message, 400, err.field ? { field: err.field } : undefined);
  throw err;
}

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
  accrual_entry_id: string | null;
  payment_entry_id: string | null;
  paid_date: string | null;
  created_at: string;
  approved_at: string | null;
  posted_at: string | null;
  closed_at: string | null;
}

const RUN_SELECT = `SELECT r.id, r.period_key, r.run_type, r.sequence, r.status, r.accrual_date::text AS accrual_date,
       r.include_commission, r.note, r.inputs, r.rule_set_id, rs.version AS rule_set_version, r.totals,
       r.accrual_entry_id, r.payment_entry_id, r.paid_date::text AS paid_date, r.created_at::text AS created_at,
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
  accrualEntryId: r.accrual_entry_id,
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
  employer_cost: string;
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
       p.total_deductions::text AS total_deductions, p.net_pay::text AS net_pay, p.employer_cost::text AS employer_cost,
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
    employerCost: r.employer_cost,
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
export function parseRunInputs(raw: unknown, supplemental: boolean): Record<string, EngineRunEmployeeInput> {
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
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 400 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
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

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PayrollError("idempotency_key_invalid");
  const key = value.trim();
  if (key === "") return null;
  if (!IDEMPOTENCY_KEY.test(key)) throw new PayrollError("idempotency_key_invalid");
  return key;
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
  const accrualDate = accrual.value ?? (period.endsOn < today ? period.endsOn : today);
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
  insured: boolean;
  tax_exempt: boolean;
  cost_allocation: CostAllocationShare[];
}

/** What earlier standing runs of the same month recorded, per employee. */
async function priorTotals(client: PoolClient, businessId: string, periodKey: string, excludeRunId: string): Promise<Map<string, PriorPeriodTotals>> {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT p.user_id, sum(p.insurable_raw)::text AS insurable_raw, sum(p.insurance_base)::text AS insurance_base,
            sum(p.employee_insurance)::text AS employee_insurance, sum(p.employer_insurance)::text AS employer_insurance,
            sum(p.unemployment_insurance)::text AS unemployment_insurance, sum(p.taxable_base)::text AS taxable_base,
            sum(p.income_tax)::text AS income_tax
       FROM payroll_payslips p JOIN payroll_engine_runs r ON r.id = p.run_id
      WHERE r.business_id = $1 AND r.period_key = $2 AND r.id <> $3 AND r.status = ANY($4::text[]) AND p.user_id IS NOT NULL
      GROUP BY p.user_id`,
    [businessId, periodKey, excludeRunId, STANDING],
  );
  return new Map(
    rows.map((r) => [
      r.user_id,
      {
        insurableRaw: BigInt(r.insurable_raw),
        insuranceBase: BigInt(r.insurance_base),
        employeeInsurance: BigInt(r.employee_insurance),
        employerInsurance: BigInt(r.employer_insurance),
        unemploymentInsurance: BigInt(r.unemployment_insurance),
        taxableBase: BigInt(r.taxable_base),
        incomeTax: BigInt(r.income_tax),
      },
    ]),
  );
}

/** Advances still owed, net of every recovery except this run's own (which is being recomputed). */
async function advancesOwed(client: PoolClient, businessId: string, excludeRunId: string): Promise<Map<string, bigint>> {
  const { rows } = await client.query<{ user_id: string; owed: string }>(
    `SELECT a.user_id, GREATEST(a.total - COALESCE(l.rec, 0) - COALESCE(e.rec, 0), 0)::text AS owed
       FROM (SELECT user_id, sum(amount) AS total FROM payroll_advances WHERE business_id = $1 AND status = 'active' GROUP BY user_id) a
       LEFT JOIN (SELECT rl.user_id, sum(rl.advance_recovery) AS rec FROM payroll_run_lines rl JOIN payroll_runs r ON r.id = rl.run_id
                   WHERE r.business_id = $1 AND r.status <> 'voided' GROUP BY rl.user_id) l ON l.user_id = a.user_id
       LEFT JOIN (SELECT ps.user_id, sum(ps.advance_recovery) AS rec FROM payroll_payslips ps JOIN payroll_engine_runs er ON er.id = ps.run_id
                   WHERE er.business_id = $1 AND er.status <> 'cancelled' AND er.id <> $2 GROUP BY ps.user_id) e ON e.user_id = a.user_id`,
    [businessId, excludeRunId],
  );
  return new Map(rows.map((r) => [r.user_id, BigInt(r.owed)]));
}

/**
 * Computes every payslip of a draft / calculated / reviewed run against the
 * rule version in force on its accrual date, replacing any earlier draft
 * calculation. A regular run covers every active profile employed during the
 * month; a supplemental run covers only the employees named in its inputs.
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
    const catalogue: PayrollComponentDef[] = (await componentsFor(runner, params.businessId, run.accrual_date)).map((c) => ({
      code: c.code, name: c.name, kind: c.kind, systemKey: c.systemKey, taxable: c.taxable, insurable: c.insurable,
      debitAccountCode: c.debitAccountCode, creditAccountCode: c.creditAccountCode,
    }));

    const { rows: employees } = await client.query<EmployeeRow>(
      `SELECT u.id AS user_id, u.full_name, COALESCE(p.payroll_code, e.employee_code) AS code, p.base_salary::text AS base_salary,
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

    const items = supplemental ? new Map() : await itemsInForce(runner, params.businessId, period.startsOn, period.endsOn);
    const prior = supplemental ? await priorTotals(client, params.businessId, run.period_key, run.id) : new Map<string, PriorPeriodTotals>();
    const owed = await advancesOwed(client, params.businessId, run.id);

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
    const totals = { gross: 0n, ei: 0n, eri: 0n, ui: 0n, tax: 0n, ded: 0n, net: 0n, cost: 0n, commission: 0n };
    for (const emp of covered) {
      const input = inputs[emp.user_id] ?? {};
      const recurring = (items.get(emp.user_id) ?? []) as Array<{ componentCode: string; amount: string }>;
      let slip;
      try {
        slip = computePayslip(
          {
            baseSalary: supplemental ? 0n : BigInt(emp.base_salary),
            insured: emp.insured,
            taxExempt: emp.tax_exempt,
            overtimeHours: supplemental ? 0 : input.overtimeHours ?? 0,
            unpaidLeaveDays: supplemental ? 0 : input.unpaidLeaveDays ?? 0,
            items: [
              ...recurring.map((i) => ({ code: i.componentCode, amount: BigInt(i.amount) })),
              ...(input.items ?? []).map((i) => ({ code: i.code, amount: BigInt(i.amount) })),
            ],
            commission: commission.get(emp.user_id) ?? 0n,
            advanceOwed: supplemental ? 0n : owed.get(emp.user_id) ?? 0n,
          },
          ruleSet.rules,
          catalogue,
          prior.get(emp.user_id) ?? NO_PRIOR,
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
            advance_recovery, total_deductions, net_pay, employer_cost, lines, cost_allocation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          params.businessId, run.id, emp.user_id, emp.full_name, emp.code, slip.gross.toString(), slip.insurableRaw.toString(),
          slip.insuranceBase.toString(), slip.employeeInsurance.toString(), slip.employerInsurance.toString(),
          slip.unemploymentInsurance.toString(), slip.taxableBase.toString(), slip.incomeTax.toString(),
          sum("commission").toString(), sum("advance_recovery").toString(), slip.totalDeductions.toString(),
          slip.netPay.toString(), slip.employerCost.toString(),
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
      totals.cost += slip.employerCost;
      totals.commission += sum("commission");
    }
    if (totals.cost > MAX_RIAL) throw new PayrollError("amount_out_of_range");
    const runTotals: EngineRunTotals = {
      employees: covered.length,
      gross: totals.gross.toString(),
      employeeInsurance: totals.ei.toString(),
      employerInsurance: totals.eri.toString(),
      unemploymentInsurance: totals.ui.toString(),
      incomeTax: totals.tax.toString(),
      totalDeductions: totals.ded.toString(),
      netPay: totals.net.toString(),
      employerCost: totals.cost.toString(),
      commission: totals.commission.toString(),
    };
    await client.query(
      `UPDATE payroll_engine_runs SET status = 'calculated', rule_set_id = $2, rule_snapshot = $3, components_snapshot = $4,
              totals = $5, calculated_at = now(), reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`,
      [run.id, ruleSet.id, JSON.stringify({ version: ruleSet.version, title: ruleSet.title, effectiveFrom: ruleSet.effectiveFrom, rules: ruleSet.rules }),
       JSON.stringify(catalogue), JSON.stringify(runTotals)],
    );
  }).catch(calcError);
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
export async function postEngineRun(params: { businessId: string; runId: string; actorId: string | null }): Promise<EngineRun> {
  await inTransaction(async (client) => {
    const run = await lockRun(client, params.businessId, params.runId);
    if (run.status === "posted" || run.status === "paid" || run.status === "closed") throw new PayrollError("already_posted", 409);
    assertTransition(run.status, "posted");
    const { rows } = await client.query<{ lines: Array<PayslipLine & { amount: string }>; net_pay: string }>(
      `SELECT lines, net_pay::text AS net_pay FROM payroll_payslips WHERE run_id = $1`,
      [run.id],
    );
    const sides = accrualPostingSides(
      rows.map((r) => ({ netPay: BigInt(r.net_pay), lines: r.lines.map((l) => ({ ...l, amount: BigInt(l.amount) })) })),
      WELL_KNOWN_CODES.salariesPayable,
    );
    let entryId: string | null = null;
    if (sides.length > 0) {
      const accounts = await accountIdsByCode(client, params.businessId, sides.map((s) => s.accountCode));
      entryId = await postExactJournalEntry(client, {
        businessId: params.businessId,
        locationId: null,
        entryDate: run.accrual_date,
        memo: `حقوق و دستمزد — ${periodLabel(run.period_key)}${run.run_type === "supplemental" ? ` (اصلاحی ${run.sequence})` : ""}`,
        sourceType: "payroll_engine_accrual",
        sourceId: run.id,
        createdBy: params.actorId,
        lines: sides.map((s) => ({ accountId: accounts.get(s.accountCode)!, debit: asRial(s.debit), credit: asRial(s.credit) })),
      });
    }
    await client.query(
      `UPDATE payroll_engine_runs SET status = 'posted', accrual_entry_id = $2, posted_by = $3, posted_at = now() WHERE id = $1`,
      [run.id, entryId, params.actorId],
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
export async function payrollRegister(businessId: string, filter: { periodKey?: string; runId?: string }) {
  const { rows } = await poolRunner<PayslipRow>(
    `${PAYSLIP_SELECT} WHERE p.business_id = $1 AND ($2::text IS NULL OR r.period_key = $2) AND ($3::uuid IS NULL OR r.id = $3)
        AND (r.id = $3 OR r.status = ANY($4::text[]))
      ORDER BY p.employee_name_snapshot, r.sequence, p.id`,
    [businessId, filter.periodKey ?? null, filter.runId && isUuid(filter.runId) ? filter.runId : null, STANDING],
  );
  const payslips = rows.map(toPayslip);
  return { payslips, totals: sumPayslips(payslips) };
}

function sumPayslips(slips: Payslip[]) {
  const keys = ["gross", "taxableBase", "insuranceBase", "employeeInsurance", "employerInsurance", "unemploymentInsurance", "incomeTax", "totalDeductions", "netPay", "employerCost"] as const;
  const out = Object.fromEntries(keys.map((k) => [k, 0n])) as Record<(typeof keys)[number], bigint>;
  for (const s of slips) for (const k of keys) out[k] += BigInt(s[k]);
  return Object.fromEntries(keys.map((k) => [k, out[k].toString()])) as Record<(typeof keys)[number], string>;
}

/** Employee payroll card — one member's standing payslips over a Jalali year. */
export async function employeePayrollCard(businessId: string, userId: string, jalaliYear: number) {
  if (!isUuid(userId)) throw new PayrollError("staff_not_found", 404);
  if (!Number.isInteger(jalaliYear) || jalaliYear < 1300 || jalaliYear > 1599) throw new PayrollError("invalid_period");
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
            sum(p.total_deductions)::text AS total_deductions, sum(p.net_pay)::text AS net_pay, sum(p.employer_cost)::text AS employer_cost
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
  for (const p of [periodA, periodB]) if (!resolvePayrollPeriodKey(p).ok) throw new PayrollError("invalid_period");
  const rows = await periodSummaries(businessId, [periodA, periodB]);
  const a = rows.find((r) => r.periodKey === periodA) ?? null;
  const b = rows.find((r) => r.periodKey === periodB) ?? null;
  const fields = ["gross", "totalInsurance", "incomeTax", "netPay", "employerCost"] as const;
  const difference = Object.fromEntries(fields.map((f) => [f, (BigInt(b?.[f] ?? "0") - BigInt(a?.[f] ?? "0")).toString()]));
  return { a, b, difference };
}

export const payrollPeriodSummaries = (businessId: string) => periodSummaries(businessId, null);

/**
 * Payroll liability reconciliation — what the engine's subledger says each
 * payroll liability account should hold from engine postings, against what the
 * GL actually holds from those same postings (`source_type` of the engine).
 * Every difference must be zero; a non-zero one names the account that drifted.
 * The account's *total* GL balance (which also carries #835 runs, commission
 * accruals and remittances) is reported beside it for context.
 */
export async function payrollLiabilityReconciliation(businessId: string) {
  const { rows: runs } = await query<{ id: string; status: string; net: string }>(
    `SELECT r.id, r.status, COALESCE(sum(p.net_pay), 0)::text AS net FROM payroll_engine_runs r
       LEFT JOIN payroll_payslips p ON p.run_id = r.id
      WHERE r.business_id = $1 AND r.status IN ('posted', 'paid', 'closed') GROUP BY r.id, r.status`,
    [businessId],
  );
  const { rows: slipRows } = await query<{ lines: Array<PayslipLine & { amount: string }>; net_pay: string; paid: boolean }>(
    `SELECT p.lines, p.net_pay::text AS net_pay, (r.status IN ('paid', 'closed')) AS paid
       FROM payroll_payslips p JOIN payroll_engine_runs r ON r.id = p.run_id
      WHERE r.business_id = $1 AND r.status IN ('posted', 'paid', 'closed')`,
    [businessId],
  );
  const expected = new Map<string, bigint>();
  const sides = accrualPostingSides(
    slipRows.map((r) => ({ netPay: BigInt(r.net_pay), lines: r.lines.map((l) => ({ ...l, amount: BigInt(l.amount) })) })),
    WELL_KNOWN_CODES.salariesPayable,
  );
  for (const s of sides) expected.set(s.accountCode, s.credit - s.debit);
  const paidNet = slipRows.filter((r) => r.paid).reduce((s, r) => s + BigInt(r.net_pay), 0n);
  expected.set(WELL_KNOWN_CODES.salariesPayable, (expected.get(WELL_KNOWN_CODES.salariesPayable) ?? 0n) - paidNet);

  const liabilityCodes = [...new Set([WELL_KNOWN_CODES.salariesPayable, WELL_KNOWN_CODES.insurancePayable, WELL_KNOWN_CODES.payrollTaxPayable, "2490", "1260", ...expected.keys()])].filter(
    (code) => !code.startsWith("5"),
  );
  const { rows: gl } = await query<{ code: string; engine: string; total: string }>(
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
  return { runs: runs.length, accounts, reconciled: accounts.every((a) => a.difference === "0") };
}
