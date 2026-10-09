/**
 * Issue #865 — the statutory payroll engine, pure half.
 *
 * Framework-free and DB-free so the API preview, the stored payslip and the
 * journal all come from one function. Built *on top of* the #835 journal-level
 * payroll (which keeps owning `payroll_runs`, advances and commission
 * settlement); nothing here replaces it.
 *
 * Three things live here:
 *
 *  1. **The versioned rule set** (`PayrollRuleSet`) — the Iranian statutory
 *     parameters (insurance shares, insurance ceiling, monthly tax exemption and
 *     brackets, month length, overtime factor). Stored as an append-only
 *     version row (`payroll_rule_sets`); a run snapshots the version it used, so
 *     historical payroll keeps its rules after a new version is entered.
 *  2. **The component catalogue** (`PayrollComponentDef`) — every earning,
 *     deduction and employer contribution with its taxable / insurable
 *     behaviour and its debit / credit posting accounts.
 *  3. **The calculator** (`computePayslip`) — one employee's month, in exact
 *     integer Rial (`bigint`), percentages as basis points, every product
 *     rounded half-away-from-zero once per figure.
 *
 * ## Order of calculation (fixed, because it decides the answer)
 *
 *   base wage       = base salary
 *   unpaid leave    = −round(base × days / monthDays)
 *   overtime        = round(base ÷ monthlyHours × hours × factor%)
 *   gross           = Σ earnings (signed)
 *   insurance base  = min(Σ insurable earnings, ceiling)                   [0 if not insured]
 *   employee / employer / unemployment insurance = base × share
 *   taxable base    = Σ taxable earnings − employee insurance (if the rule says so)  [0 if exempt]
 *   income tax      = progressive over the brackets, above the exemption
 *   fixed deductions (loan installments, other) must fit inside what is left
 *   advance recovery = min(advance owed, what is left)  — the only partial one
 *   net             = gross − employee insurance − tax − deductions
 *   employer cost   = gross + employer insurance + unemployment insurance
 *
 * ## Supplemental (adjustment) runs
 *
 * An approved run is never recalculated. A correction is a *supplemental* run
 * for the same month: its insurance and tax are computed on the **cumulative**
 * month (everything already approved for the period + this run) minus what was
 * already withheld (`PriorPeriodTotals`), so the ceiling and the progressive
 * brackets apply to the month as a whole, never twice.
 *
 * Corrections may be signed. Overtime hours and unpaid-leave days in a
 * supplemental run are *deltas* to what the month already paid, priced at the
 * regular run's contract rate on the cumulative month (so +5 h then −5 h nets to
 * the Rial). A downward correction that leaves gross − deductions below zero is
 * never clamped: net pay is 0 and the shortfall is the employee's **debt**,
 * posted Debit staff receivable (1260) and recovered by later regular runs
 * exactly like a salary advance.
 *
 * ## Partial months
 *
 * Base salary and recurring items are prorated by the days of the Jalali month
 * the employee was employed (hire/termination) — and, for an item, the days it
 * was in force — on the rule's month basis: `amount × days ÷ monthDays`. A
 * window covering the whole month pays the full amount regardless of the
 * month's calendar length (`coveredDays`). Overtime and leave are priced at the
 * full monthly rate; leave cannot exceed the days worked.
 */

/** One income-tax band: monthly income up to `upToRial` is taxed at `ratePercent`. `null` = open-ended. */
export interface PayrollRuleTaxBracket {
  upToRial: number | null;
  ratePercent: number;
}

export interface PayrollRuleSet {
  /** Employee's social-insurance share, percent (statutory 7). */
  employeeInsurancePercent: number;
  /** Employer's social-insurance share, percent (statutory 20). */
  employerInsurancePercent: number;
  /** Employer's unemployment-insurance share, percent (statutory 3). */
  unemploymentInsurancePercent: number;
  /** Monthly insurance-base ceiling in Rial; null = none. */
  insuranceCeilingRial: number | null;
  /** Monthly taxable income exempt from tax, in Rial. */
  taxExemptMonthlyRial: number;
  /** Bands *above* zero, absolute monthly bounds, ascending, last open-ended. Income below the exemption is never taxed. */
  taxBrackets: PayrollRuleTaxBracket[];
  /** Whether the employee's insurance share is deducted from the taxable base. */
  deductEmployeeInsuranceFromTaxable: boolean;
  /** Days in a payroll month, for unpaid-leave proration (statutory 30). */
  monthDays: number;
  /** Working hours in a month, for the hourly rate behind overtime (e.g. 176 / 192 / 220). */
  monthlyHours: number;
  /** Overtime premium, percent of the hourly rate (statutory 140). */
  overtimeFactorPercent: number;
}

export type PayrollRuleError =
  | "invalid_rules"
  | "invalid_percent"
  | "invalid_amount"
  | "invalid_brackets"
  | "brackets_not_ascending"
  | "last_bracket_must_be_open"
  | "invalid_month_days"
  | "invalid_monthly_hours";

export type RuleParse = { ok: true; value: PayrollRuleSet } | { ok: false; error: PayrollRuleError; field?: string };

/**
 * A *template* for an Iranian rule set: the long-standing statutory shares
 * (7 / 20 / 3 percent, 30-day month, 140% overtime). The Rial figures (ceiling,
 * exemption, brackets) change every year with the budget law and the SSO
 * circular, so the template leaves them empty — the business enters the
 * current year's numbers when it creates its version. Nothing is applied until
 * a version exists.
 */
export const IRAN_RULE_TEMPLATE: PayrollRuleSet = Object.freeze({
  employeeInsurancePercent: 7,
  employerInsurancePercent: 20,
  unemploymentInsurancePercent: 3,
  insuranceCeilingRial: null,
  taxExemptMonthlyRial: 0,
  taxBrackets: [],
  deductEmployeeInsuranceFromTaxable: true,
  monthDays: 30,
  monthlyHours: 192,
  overtimeFactorPercent: 140,
}) as PayrollRuleSet;

function isPercent(v: unknown, max = 100): v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) return false;
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
}
const isRial = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Validates a rule-set document (request body, or a stored version). Unknown keys are dropped. */
export function parsePayrollRuleSet(raw: unknown): RuleParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "invalid_rules" };
  const r = raw as Record<string, unknown>;
  const pick = <T>(k: string, fallback: T): unknown => (r[k] === undefined ? fallback : r[k]);

  for (const f of ["employeeInsurancePercent", "employerInsurancePercent", "unemploymentInsurancePercent"] as const) {
    if (!isPercent(pick(f, IRAN_RULE_TEMPLATE[f]))) return { ok: false, error: "invalid_percent", field: f };
  }
  const overtime = pick("overtimeFactorPercent", IRAN_RULE_TEMPLATE.overtimeFactorPercent);
  if (!isPercent(overtime, 1000)) return { ok: false, error: "invalid_percent", field: "overtimeFactorPercent" };

  const ceiling = pick("insuranceCeilingRial", null);
  if (ceiling !== null && ceiling !== "" && !isRial(ceiling)) return { ok: false, error: "invalid_amount", field: "insuranceCeilingRial" };
  const exempt = pick("taxExemptMonthlyRial", 0);
  if (!isRial(exempt)) return { ok: false, error: "invalid_amount", field: "taxExemptMonthlyRial" };

  const monthDays = pick("monthDays", 30);
  if (typeof monthDays !== "number" || !Number.isInteger(monthDays) || monthDays < 28 || monthDays > 31) {
    return { ok: false, error: "invalid_month_days", field: "monthDays" };
  }
  const monthlyHours = pick("monthlyHours", IRAN_RULE_TEMPLATE.monthlyHours);
  if (typeof monthlyHours !== "number" || !Number.isInteger(monthlyHours) || monthlyHours < 1 || monthlyHours > 744) {
    return { ok: false, error: "invalid_monthly_hours", field: "monthlyHours" };
  }
  const deduct = pick("deductEmployeeInsuranceFromTaxable", true);
  if (typeof deduct !== "boolean") return { ok: false, error: "invalid_rules", field: "deductEmployeeInsuranceFromTaxable" };

  const rawBrackets = pick("taxBrackets", []);
  if (!Array.isArray(rawBrackets) || rawBrackets.length > 20) return { ok: false, error: "invalid_brackets", field: "taxBrackets" };
  const brackets: PayrollRuleTaxBracket[] = [];
  let previous = Number(exempt);
  for (let i = 0; i < rawBrackets.length; i++) {
    const b = rawBrackets[i] as Record<string, unknown> | null;
    if (typeof b !== "object" || b === null) return { ok: false, error: "invalid_brackets", field: "taxBrackets" };
    const upTo = b.upToRial ?? null;
    if (!isPercent(b.ratePercent)) return { ok: false, error: "invalid_percent", field: `taxBrackets.${i}.ratePercent` };
    if (upTo !== null) {
      if (!isRial(upTo)) return { ok: false, error: "invalid_amount", field: `taxBrackets.${i}.upToRial` };
      if (upTo <= previous) return { ok: false, error: "brackets_not_ascending", field: `taxBrackets.${i}.upToRial` };
      previous = upTo;
    } else if (i !== rawBrackets.length - 1) {
      return { ok: false, error: "last_bracket_must_be_open", field: `taxBrackets.${i}.upToRial` };
    }
    brackets.push({ upToRial: upTo as number | null, ratePercent: b.ratePercent as number });
  }
  if (brackets.length > 0 && brackets[brackets.length - 1].upToRial !== null) {
    return { ok: false, error: "last_bracket_must_be_open", field: "taxBrackets" };
  }

  return {
    ok: true,
    value: {
      employeeInsurancePercent: pick("employeeInsurancePercent", 7) as number,
      employerInsurancePercent: pick("employerInsurancePercent", 20) as number,
      unemploymentInsurancePercent: pick("unemploymentInsurancePercent", 3) as number,
      insuranceCeilingRial: ceiling === null || ceiling === "" ? null : (ceiling as number),
      taxExemptMonthlyRial: exempt,
      taxBrackets: brackets,
      deductEmployeeInsuranceFromTaxable: deduct,
      monthDays,
      monthlyHours,
      overtimeFactorPercent: overtime as number,
    },
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export type ComponentKind = "earning" | "deduction" | "employer_contribution";

/** The components the engine computes itself; everything else is a business-defined fixed/input amount. */
const SYSTEM_COMPONENT_KEYS = [
  "base_wage",
  "overtime",
  "bonus",
  "commission",
  "unpaid_leave",
  "loan_installment",
  "advance_recovery",
  "insurance_employee",
  "insurance_employer",
  "insurance_unemployment",
  "income_tax",
] as const;
export type SystemComponentKey = (typeof SYSTEM_COMPONENT_KEYS)[number];

export interface PayrollComponentDef {
  code: string;
  name: string;
  kind: ComponentKind;
  systemKey: SystemComponentKey | null;
  taxable: boolean;
  insurable: boolean;
  debitAccountCode: string;
  creditAccountCode: string;
}

/**
 * The catalogue every business starts with (seeded on first use). Codes are
 * the business's to rename; the system keys and account mappings are the
 * defaults the chart of accounts template already carries:
 * 5200 salaries expense, 5220 employer insurance, 2300 salaries payable,
 * 2460 insurance payable, 2470 payroll tax payable, 1260 staff advances/loans,
 * 2490 other deductions payable.
 *
 * Commission debits 2300: it was already expensed and credited to 2300 when the
 * sale posted, so including it in a payslip *reclassifies* it into this run's
 * net rather than expensing it twice.
 */
export const DEFAULT_COMPONENTS: readonly PayrollComponentDef[] = Object.freeze([
  { code: "BASE", name: "حقوق پایه", kind: "earning", systemKey: "base_wage", taxable: true, insurable: true, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "OVERTIME", name: "اضافه‌کار", kind: "earning", systemKey: "overtime", taxable: true, insurable: true, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "BONUS", name: "پاداش", kind: "earning", systemKey: "bonus", taxable: true, insurable: false, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "COMMISSION", name: "پورسانت", kind: "earning", systemKey: "commission", taxable: true, insurable: false, debitAccountCode: "2300", creditAccountCode: "2300" },
  { code: "UNPAID_LEAVE", name: "کسر مرخصی بدون حقوق", kind: "earning", systemKey: "unpaid_leave", taxable: true, insurable: true, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "HOUSING", name: "حق مسکن", kind: "earning", systemKey: null, taxable: true, insurable: true, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "GROCERY", name: "بن خواربار", kind: "earning", systemKey: null, taxable: true, insurable: true, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "CHILD", name: "حق اولاد", kind: "earning", systemKey: null, taxable: true, insurable: false, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "BENEFIT", name: "مزایای غیرنقدی", kind: "earning", systemKey: null, taxable: true, insurable: false, debitAccountCode: "5200", creditAccountCode: "2300" },
  { code: "LOAN", name: "قسط وام", kind: "deduction", systemKey: "loan_installment", taxable: false, insurable: false, debitAccountCode: "2300", creditAccountCode: "1260" },
  { code: "ADVANCE", name: "کسر مساعده", kind: "deduction", systemKey: "advance_recovery", taxable: false, insurable: false, debitAccountCode: "2300", creditAccountCode: "1260" },
  { code: "OTHER_DED", name: "سایر کسور", kind: "deduction", systemKey: null, taxable: false, insurable: false, debitAccountCode: "2300", creditAccountCode: "2490" },
  { code: "INS_EMP", name: "بیمه سهم کارگر", kind: "deduction", systemKey: "insurance_employee", taxable: false, insurable: false, debitAccountCode: "2300", creditAccountCode: "2460" },
  { code: "TAX", name: "مالیات حقوق", kind: "deduction", systemKey: "income_tax", taxable: false, insurable: false, debitAccountCode: "2300", creditAccountCode: "2470" },
  { code: "INS_ER", name: "بیمه سهم کارفرما", kind: "employer_contribution", systemKey: "insurance_employer", taxable: false, insurable: false, debitAccountCode: "5220", creditAccountCode: "2460" },
  { code: "INS_UNEMP", name: "بیمه بیکاری", kind: "employer_contribution", systemKey: "insurance_unemployment", taxable: false, insurable: false, debitAccountCode: "5220", creditAccountCode: "2460" },
] satisfies PayrollComponentDef[]);

// ---------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------

const bp = (percent: number): bigint => BigInt(Math.round(percent * 100));

/** Rounds `numerator / denominator` half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("invalid_denominator");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (n * 2n + denominator) / (denominator * 2n);
  return negative ? -q : q;
}

const mulPercent = (amount: bigint, percent: number): bigint => divRound(amount * bp(percent), 10_000n);

/** Progressive monthly tax on `taxable` (absolute monthly amount). */
export function progressiveTax(taxable: bigint, rules: PayrollRuleSet): bigint {
  if (taxable <= 0n) return 0n;
  let lower = BigInt(rules.taxExemptMonthlyRial);
  let tax = 0n;
  for (const band of rules.taxBrackets) {
    if (taxable <= lower) break;
    const upper = band.upToRial === null ? taxable : BigInt(band.upToRial);
    const slice = (taxable < upper ? taxable : upper) - lower;
    if (slice > 0n) tax += slice * bp(band.ratePercent);
    lower = upper;
  }
  return divRound(tax, 10_000n);
}

// ---------------------------------------------------------------------------
// Partial months
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const isoDay = (iso: string): number => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);

/** A date window, inclusive; `null` = open on that side. */
export interface DateWindow {
  from: string | null;
  to: string | null;
}

/**
 * How much of a payroll month a set of windows covers (employment, and an
 * item's own effective dates), intersected.
 *
 * Returns `null` when the whole month is covered — the amount is paid in full,
 * whatever the month's calendar length. Otherwise the covered calendar days,
 * capped at the rule's month basis (`monthDays`, statutorily 30), which is what
 * a monthly amount is prorated over: `amount × days ÷ monthDays`. Zero when the
 * windows do not meet the month at all.
 */
export function coveredDays(periodStart: string, periodEnd: string, windows: readonly DateWindow[], monthDays: number): number | null {
  let from = isoDay(periodStart);
  let to = isoDay(periodEnd);
  const full = to - from + 1;
  for (const w of windows) {
    if (w.from) from = Math.max(from, isoDay(w.from));
    if (w.to) to = Math.min(to, isoDay(w.to));
  }
  const days = Math.max(0, to - from + 1);
  if (days >= full) return null;
  return Math.min(days, monthDays);
}

/** A monthly amount for `days` of a `monthDays` month (`null` days = the full amount). Exact, half away from zero. */
export function prorate(amount: bigint, days: number | null, monthDays: number): bigint {
  if (days === null) return amount;
  return divRound(amount * BigInt(Math.round(days * 100)), BigInt(monthDays) * 100n);
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

export interface PayslipItemInput {
  /** Component code from the catalogue. */
  code: string;
  /** Signed Rial: negative only in a supplemental run (a correction). */
  amount: bigint;
}

export interface PayslipInput {
  /**
   * The monthly contract rate (base salary). In a regular run it is paid
   * (prorated by `workedDays`); in a supplemental run it is not paid again and
   * only prices overtime / unpaid-leave corrections.
   */
  baseSalary: bigint;
  /** Days employed in the month on the rule's basis; `null` = the full month. Regular runs only. */
  workedDays: number | null;
  insured: boolean;
  taxExempt: boolean;
  /**
   * Regular run: the month's overtime hours (≥ 0).
   * Supplemental run: a signed *correction* to the hours already paid this month.
   */
  overtimeHours: number;
  /**
   * Regular run: the month's unpaid-leave days (≥ 0, at most the days worked).
   * Supplemental run: a signed *correction* to the days already deducted.
   */
  unpaidLeaveDays: number;
  /** Recurring allowances / deductions / benefits (already prorated) and this month's inputs. */
  items: PayslipItemInput[];
  /** Unsettled commission to include (0 = not included). */
  commission: bigint;
  /** Salary advance / payroll debt still owed; recovered up to what the month leaves. Regular runs only. */
  advanceOwed: bigint;
}

/** What earlier approved runs of the *same month* already recorded for this employee. */
export interface PriorPeriodTotals {
  insurableRaw: bigint;
  insuranceBase: bigint;
  employeeInsurance: bigint;
  employerInsurance: bigint;
  unemploymentInsurance: bigint;
  taxableBase: bigint;
  incomeTax: bigint;
  /** The contract rate the regular run used (0 = the employee was not in it). */
  baseSalary: bigint;
  /** The days the regular run counted as worked (`null` = full month). */
  workedDays: number | null;
  overtimeHours: number;
  overtimeAmount: bigint;
  unpaidLeaveDays: number;
  /** Positive: the total unpaid-leave deduction already applied. */
  unpaidLeaveAmount: bigint;
}

export const NO_PRIOR: PriorPeriodTotals = Object.freeze({
  insurableRaw: 0n,
  insuranceBase: 0n,
  employeeInsurance: 0n,
  employerInsurance: 0n,
  unemploymentInsurance: 0n,
  taxableBase: 0n,
  incomeTax: 0n,
  baseSalary: 0n,
  workedDays: null,
  overtimeHours: 0,
  overtimeAmount: 0n,
  unpaidLeaveDays: 0,
  unpaidLeaveAmount: 0n,
}) as PriorPeriodTotals;

export interface PayslipLine {
  code: string;
  name: string;
  kind: ComponentKind;
  systemKey: SystemComponentKey | null;
  amount: bigint;
  taxable: boolean;
  insurable: boolean;
  debitAccountCode: string;
  creditAccountCode: string;
}

export interface PayslipResult {
  lines: PayslipLine[];
  gross: bigint;
  /** Raw insurable earnings of this run (before the ceiling) — kept for the next supplemental run. */
  insurableRaw: bigint;
  insuranceBase: bigint;
  employeeInsurance: bigint;
  employerInsurance: bigint;
  unemploymentInsurance: bigint;
  taxableBase: bigint;
  incomeTax: bigint;
  totalDeductions: bigint;
  /** What is paid to the employee; never negative. */
  netPay: bigint;
  /**
   * What the employee owes back after a downward correction (gross − deductions
   * < 0 in a supplemental run). Posted Debit staff receivable (1260) and recovered
   * by later regular runs like a salary advance. Never both net and debt.
   */
  employeeDebt: bigint;
  employerCost: bigint;
  /** Snapshot of this run's own inputs, for later corrections. */
  baseSalary: bigint;
  workedDays: number | null;
  overtimeHours: number;
  unpaidLeaveDays: number;
}

export type PayrollCalcErrorCode =
  | "invalid_amount"
  | "invalid_overtime_hours"
  | "invalid_unpaid_leave_days"
  | "invalid_worked_days"
  | "no_base_salary"
  | "unknown_component"
  | "component_not_enterable"
  | "component_missing"
  | "negative_gross"
  | "deductions_exceed_gross"
  | "allocation_must_total_100";

export class PayrollCalcError extends Error {
  constructor(
    code: PayrollCalcErrorCode,
    public field?: string,
  ) {
    super(code);
  }
}

function bySystemKey(catalogue: readonly PayrollComponentDef[], key: SystemComponentKey): PayrollComponentDef {
  const def = catalogue.find((c) => c.systemKey === key);
  if (!def) throw new PayrollCalcError("component_missing", key);
  return def;
}

const lineOf = (def: PayrollComponentDef, amount: bigint): PayslipLine => ({
  code: def.code,
  name: def.name,
  kind: def.kind,
  systemKey: def.systemKey,
  amount,
  taxable: def.taxable,
  insurable: def.insurable,
  debitAccountCode: def.debitAccountCode,
  creditAccountCode: def.creditAccountCode,
});

const hundredths = (n: number): bigint => BigInt(Math.round(n * 100));
const isHundredths = (n: number): boolean => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;

/** Overtime pay for `hours` at `base`'s hourly rate. */
function overtimeFor(base: bigint, hours: number, rules: PayrollRuleSet): bigint {
  return divRound(base * hundredths(hours) * bp(rules.overtimeFactorPercent), BigInt(rules.monthlyHours) * 100n * 10_000n);
}

/** The unpaid-leave deduction (positive) for `days` at `base`'s daily rate. */
function leaveFor(base: bigint, days: number, rules: PayrollRuleSet): bigint {
  return divRound(base * hundredths(days), BigInt(rules.monthDays) * 100n);
}

/**
 * One employee's payslip for one run. `options.supplemental` makes it a
 * correction of the month: signed items, signed overtime/leave deltas priced at
 * the regular run's contract rate, cumulative insurance and tax, and an
 * employee debt instead of a negative net.
 */
export function computePayslip(
  input: PayslipInput,
  rules: PayrollRuleSet,
  catalogue: readonly PayrollComponentDef[],
  prior: PriorPeriodTotals = NO_PRIOR,
  options: { supplemental?: boolean } = {},
): PayslipResult {
  const supplemental = options.supplemental === true;
  if (input.baseSalary < 0n) throw new PayrollCalcError("invalid_amount", "baseSalary");
  if (!isHundredths(input.overtimeHours) || Math.abs(input.overtimeHours) > 400 || (!supplemental && input.overtimeHours < 0)) {
    throw new PayrollCalcError("invalid_overtime_hours");
  }
  if (!isHundredths(input.unpaidLeaveDays) || Math.abs(input.unpaidLeaveDays) > rules.monthDays || (!supplemental && input.unpaidLeaveDays < 0)) {
    throw new PayrollCalcError("invalid_unpaid_leave_days");
  }
  if (input.workedDays !== null && (!isHundredths(input.workedDays) || input.workedDays < 0 || input.workedDays > rules.monthDays)) {
    throw new PayrollCalcError("invalid_worked_days");
  }

  const earnings: PayslipLine[] = [];
  const fixedDeductions: PayslipLine[] = [];
  let workedDays = input.workedDays;
  let rate = input.baseSalary;

  if (!supplemental) {
    const available = workedDays ?? rules.monthDays;
    if (input.unpaidLeaveDays > available) throw new PayrollCalcError("invalid_unpaid_leave_days");
    if (rate === 0n && (input.overtimeHours > 0 || input.unpaidLeaveDays > 0)) throw new PayrollCalcError("no_base_salary");
    if (rate > 0n) {
      const paid = prorate(rate, workedDays, rules.monthDays);
      if (paid > 0n) earnings.push(lineOf(bySystemKey(catalogue, "base_wage"), paid));
      if (input.unpaidLeaveDays > 0) earnings.push(lineOf(bySystemKey(catalogue, "unpaid_leave"), -leaveFor(rate, input.unpaidLeaveDays, rules)));
      if (input.overtimeHours > 0) earnings.push(lineOf(bySystemKey(catalogue, "overtime"), overtimeFor(rate, input.overtimeHours, rules)));
    }
  } else {
    // Corrections are priced at the rate the regular run used, on the cumulative
    // month, so a correction and its reversal cancel to the Rial.
    rate = prior.baseSalary;
    workedDays = prior.workedDays;
    if (input.overtimeHours !== 0 || input.unpaidLeaveDays !== 0) {
      if (rate === 0n) throw new PayrollCalcError("no_base_salary");
      const hours = prior.overtimeHours + input.overtimeHours;
      if (hours < 0 || hours > 400) throw new PayrollCalcError("invalid_overtime_hours");
      const days = prior.unpaidLeaveDays + input.unpaidLeaveDays;
      if (days < 0 || days > (workedDays ?? rules.monthDays)) throw new PayrollCalcError("invalid_unpaid_leave_days");
      if (input.unpaidLeaveDays !== 0) {
        const delta = leaveFor(rate, days, rules) - prior.unpaidLeaveAmount;
        if (delta !== 0n) earnings.push(lineOf(bySystemKey(catalogue, "unpaid_leave"), -delta));
      }
      if (input.overtimeHours !== 0) {
        const delta = overtimeFor(rate, hours, rules) - prior.overtimeAmount;
        if (delta !== 0n) earnings.push(lineOf(bySystemKey(catalogue, "overtime"), delta));
      }
    }
  }

  if (input.commission !== 0n) earnings.push(lineOf(bySystemKey(catalogue, "commission"), input.commission));

  for (const item of input.items) {
    const def = catalogue.find((c) => c.code === item.code);
    if (!def) throw new PayrollCalcError("unknown_component", item.code);
    if (item.amount === 0n) continue;
    if (item.amount < 0n && !supplemental) throw new PayrollCalcError("invalid_amount", item.code);
    if (def.kind === "employer_contribution" || (def.systemKey && !["bonus", "loan_installment"].includes(def.systemKey))) {
      // Statutory components, overtime/leave and advance recovery are computed, never entered.
      throw new PayrollCalcError("component_not_enterable", item.code);
    }
    if (def.kind === "earning") earnings.push(lineOf(def, item.amount));
    else fixedDeductions.push(lineOf(def, item.amount));
  }

  const gross = earnings.reduce((s, l) => s + l.amount, 0n);
  if (gross < 0n && !supplemental) throw new PayrollCalcError("negative_gross");

  // Insurance — cumulative over the month, minus what earlier runs withheld.
  const insurableRaw = input.insured ? earnings.filter((l) => l.insurable).reduce((s, l) => s + l.amount, 0n) : 0n;
  let cumulativeBase = prior.insurableRaw + insurableRaw;
  if (cumulativeBase < 0n) cumulativeBase = 0n;
  if (rules.insuranceCeilingRial !== null && cumulativeBase > BigInt(rules.insuranceCeilingRial)) {
    cumulativeBase = BigInt(rules.insuranceCeilingRial);
  }
  const insuranceBase = cumulativeBase - prior.insuranceBase;
  const employeeInsurance = mulPercent(cumulativeBase, rules.employeeInsurancePercent) - prior.employeeInsurance;
  const employerInsurance = mulPercent(cumulativeBase, rules.employerInsurancePercent) - prior.employerInsurance;
  const unemploymentInsurance = mulPercent(cumulativeBase, rules.unemploymentInsurancePercent) - prior.unemploymentInsurance;

  // Tax — cumulative over the month as well.
  let taxableBase = 0n;
  let incomeTax = 0n;
  if (!input.taxExempt) {
    const taxableEarnings = earnings.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0n);
    taxableBase = taxableEarnings - (rules.deductEmployeeInsuranceFromTaxable ? employeeInsurance : 0n);
    let cumulativeTaxable = prior.taxableBase + taxableBase;
    if (cumulativeTaxable < 0n) cumulativeTaxable = 0n;
    taxableBase = cumulativeTaxable - prior.taxableBase;
    incomeTax = progressiveTax(cumulativeTaxable, rules) - prior.incomeTax;
  }

  const lines: PayslipLine[] = [...earnings];
  if (employeeInsurance !== 0n) lines.push(lineOf(bySystemKey(catalogue, "insurance_employee"), employeeInsurance));
  if (incomeTax !== 0n) lines.push(lineOf(bySystemKey(catalogue, "income_tax"), incomeTax));

  let remaining = gross - employeeInsurance - incomeTax;
  for (const d of fixedDeductions) {
    remaining -= d.amount;
    lines.push(d);
  }
  if (remaining < 0n && !supplemental) throw new PayrollCalcError("deductions_exceed_gross");

  if (!supplemental && input.advanceOwed > 0n && remaining > 0n) {
    const advance = input.advanceOwed < remaining ? input.advanceOwed : remaining;
    lines.push(lineOf(bySystemKey(catalogue, "advance_recovery"), advance));
    remaining -= advance;
  }

  if (employerInsurance !== 0n) lines.push(lineOf(bySystemKey(catalogue, "insurance_employer"), employerInsurance));
  if (unemploymentInsurance !== 0n) lines.push(lineOf(bySystemKey(catalogue, "insurance_unemployment"), unemploymentInsurance));

  const netPay = remaining > 0n ? remaining : 0n;
  const employeeDebt = remaining < 0n ? -remaining : 0n;
  return {
    lines,
    gross,
    insurableRaw,
    insuranceBase,
    employeeInsurance,
    employerInsurance,
    unemploymentInsurance,
    taxableBase,
    incomeTax,
    totalDeductions: gross - remaining,
    netPay,
    employeeDebt,
    employerCost: gross + employerInsurance + unemploymentInsurance,
    baseSalary: rate,
    workedDays,
    overtimeHours: input.overtimeHours,
    unpaidLeaveDays: input.unpaidLeaveDays,
  };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export interface PostingSide {
  accountCode: string;
  debit: bigint;
  credit: bigint;
}

/** The part of a payslip the accrual posts. */
export type PostablePayslip = Pick<PayslipResult, "lines" | "netPay" | "employeeDebt">;

export interface PostingAccounts {
  salariesPayable: string;
  /** Where an employee's debt from a downward correction is carried (staff advances / receivable). */
  employeeDebt: string;
}

const DEFAULT_POSTING_ACCOUNTS: PostingAccounts = Object.freeze({ salariesPayable: "2300", employeeDebt: "1260" });

/**
 * The accrual entry for a set of payslips, netted per account and always balanced:
 *
 *   earning               Dr its debit account   (commission: Dr 2300 — a reclassification)
 *   employer contribution Dr its debit account / Cr its credit account
 *   deduction             Cr its credit account
 *   net pay               Cr salaries payable
 *   employee debt         Dr staff receivable (a downward correction the employee owes back)
 *
 * Earnings' own credit side is the employee's gross claim, which is exactly
 * net − debt + deductions — so it is not posted separately. A negative net per
 * account (a correction) flips sides; zero-sum accounts drop out.
 */
export function accrualPostingSides(payslips: readonly PostablePayslip[], accounts: PostingAccounts = DEFAULT_POSTING_ACCOUNTS): PostingSide[] {
  const net = new Map<string, bigint>();
  const add = (code: string, signed: bigint) => net.set(code, (net.get(code) ?? 0n) + signed);
  for (const slip of payslips) {
    for (const line of slip.lines) {
      if (line.kind === "earning") add(line.debitAccountCode, line.amount);
      else if (line.kind === "employer_contribution") {
        add(line.debitAccountCode, line.amount);
        add(line.creditAccountCode, -line.amount);
      } else add(line.creditAccountCode, -line.amount);
    }
    add(accounts.salariesPayable, -slip.netPay);
    add(accounts.employeeDebt, slip.employeeDebt);
  }
  const sides: PostingSide[] = [];
  for (const [accountCode, amount] of [...net.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (amount > 0n) sides.push({ accountCode, debit: amount, credit: 0n });
    else if (amount < 0n) sides.push({ accountCode, debit: 0n, credit: -amount });
  }
  const debit = sides.reduce((s, x) => s + x.debit, 0n);
  const credit = sides.reduce((s, x) => s + x.credit, 0n);
  if (debit !== credit) throw new Error("unbalanced_payroll_accrual");
  return sides;
}

/** Splits `amount` by percentage weights exactly: the last share absorbs the rounding, so the parts sum to the whole. */
export function allocateExact(amount: bigint, percents: readonly number[]): bigint[] {
  if (percents.length === 0) return [];
  const weights = percents.map((p) => bp(p));
  const total = weights.reduce((s, w) => s + w, 0n);
  if (total !== 10_000n) throw new PayrollCalcError("allocation_must_total_100");
  const parts = weights.map((w) => divRound(amount * w, 10_000n));
  const drift = amount - parts.reduce((s, p) => s + p, 0n);
  parts[parts.length - 1] += drift;
  return parts;
}

/**
 * Splits one payslip across its cost-allocation shares, exactly. Every line and
 * the debt are allocated with `allocateExact`; each share's net is *derived*
 * (its earnings − its deductions + its debt), so every share balances on its
 * own and the shares sum back to the payslip to the Rial. An empty allocation
 * is one unallocated share.
 */
export function allocatePayslip(slip: PostablePayslip, percents: readonly number[]): PostablePayslip[] {
  if (percents.length === 0) return [slip];
  const lineParts = slip.lines.map((l) => allocateExact(l.amount, percents));
  const debtParts = allocateExact(slip.employeeDebt, percents);
  return percents.map((_, i) => {
    const lines = slip.lines.map((l, j) => ({ ...l, amount: lineParts[j][i] }));
    let remaining = 0n;
    for (const l of lines) {
      if (l.kind === "earning") remaining += l.amount;
      else if (l.kind === "deduction") remaining -= l.amount;
    }
    return { lines, employeeDebt: debtParts[i], netPay: remaining + debtParts[i] };
  });
}

/** The run lifecycle — the only transitions the service performs. */
const RUN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  draft: ["calculated", "cancelled"],
  calculated: ["calculated", "reviewed", "cancelled"],
  reviewed: ["calculated", "approved", "cancelled"],
  approved: ["posted"],
  posted: ["paid"],
  paid: ["closed"],
  closed: [],
  cancelled: [],
});

export function canTransition(from: string, to: string): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}
