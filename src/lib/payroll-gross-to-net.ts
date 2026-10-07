/**
 * Payroll gross-to-net — the pure half (audit F11, payroll).
 *
 * Two things live here, both framework-free so the payroll screen's preview,
 * the route's validation and the service's posting all read the *same* rules:
 *
 *  1. **The business's payroll settings document** (`SETTING_KEYS.payroll`):
 *     social-insurance shares, the unemployment-insurance employer share, the
 *     insurance ceiling, the monthly income-tax brackets and the exempt
 *     threshold. Nothing statutory is hard-coded — the same principle the VAT
 *     rate follows (`SETTING_KEYS.tax` is the business's own number, never an
 *     assumed one). Every field is optional, and an empty field means *not
 *     applied*: a business that has entered nothing gets gross = net, exactly
 *     the journal-level payroll it had before.
 *  2. **The calculator** (`computeGrossToNet`): one employee's month, in integer
 *     Rial. Percentages become integer basis points and every product is
 *     BigInt, rounded half-up once per figure — the convention `aec-boq.ts` and
 *     `online-platforms-calculation.ts` already follow — so the preview, the
 *     stored run line and the journal agree to the Rial.
 *
 * The order of deductions is fixed and stated, because it decides the answer:
 *
 *   gross          = base + taxable allowances + non-taxable allowances + overtime
 *   insurance base = base + overtime + taxable allowances
 *                    (+ non-taxable allowances when the business says they are insurable),
 *                    capped at the ceiling when one is set
 *   employee / employer / unemployment insurance = insurance base × each share
 *   taxable income = base + overtime + taxable allowances
 *                    (− the employee's insurance share when the business says it is deductible)
 *   income tax     = progressive over the brackets, above the exempt threshold
 *   net            = gross − employee insurance − tax − other deductions − advance recovery
 *   employer cost  = gross + employer insurance + unemployment insurance
 *
 * Advance recovery is the only deduction that may be *partial*: what is owed
 * beyond this month's remaining pay is carried to the next run. Every other
 * deduction must fit inside gross, and a month where it does not is refused
 * rather than posted as a negative salary.
 */

/** One income-tax band: income up to `upToRial` (absolute, monthly) is taxed at `ratePercent`. `null` = no upper bound. */
export interface PayrollTaxBracket {
  upToRial: number | null;
  ratePercent: number;
}

export interface PayrollSettings {
  /** Employee's social-insurance share, percent (e.g. the business may enter 7). */
  employeeInsurancePercent: number | null;
  /** Employer's social-insurance share, percent. */
  employerInsurancePercent: number | null;
  /** Employer's unemployment-insurance share, percent (optional). */
  unemploymentInsurancePercent: number | null;
  /** Monthly insurance-base ceiling in Rial; null = no ceiling. */
  insuranceCeilingRial: number | null;
  /** Whether non-taxable allowances are part of the insurance base. */
  nonTaxableAllowancesInsurable: boolean;
  /** Whether the employee's insurance share is deducted before income tax is computed. */
  deductEmployeeInsuranceFromTaxable: boolean;
  /** Monthly taxable income up to which no tax is due; null = none. */
  taxExemptThresholdRial: number | null;
  /** Progressive brackets in ascending order, the last one open-ended. Empty = no income tax. */
  taxBrackets: PayrollTaxBracket[];
}

/** What a business that has entered nothing has: no deduction of any kind. */
export const EMPTY_PAYROLL_SETTINGS: PayrollSettings = Object.freeze({
  employeeInsurancePercent: null,
  employerInsurancePercent: null,
  unemploymentInsurancePercent: null,
  insuranceCeilingRial: null,
  nonTaxableAllowancesInsurable: false,
  deductEmployeeInsuranceFromTaxable: false,
  taxExemptThresholdRial: null,
  taxBrackets: [],
}) as PayrollSettings;

/** The longest bracket list a business may enter — a table, not a document. */
export const MAX_TAX_BRACKETS = 20;

export type PayrollSettingsError =
  | "invalid_settings"
  | "invalid_percent"
  | "invalid_amount"
  | "invalid_brackets"
  | "brackets_not_ascending"
  | "last_bracket_must_be_open"
  | "too_many_brackets";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: PayrollSettingsError; field?: string };

function isPercent(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return false;
  // At most two decimals: basis points are the unit of computation.
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

function isRial(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalPercent(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  return isPercent(value) ? { ok: true, value } : { ok: false };
}

function optionalRial(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  return isRial(value) ? { ok: true, value } : { ok: false };
}

/**
 * Validates and normalises a payroll settings document — the request body of
 * the settings route, and whatever the `settings` row holds when it is read.
 * Unknown keys are dropped; a missing key is "not entered".
 */
export function parsePayrollSettings(raw: unknown): ParseResult<PayrollSettings> {
  if (raw === null || raw === undefined) return { ok: true, value: { ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [] } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_settings" };
  const r = raw as Record<string, unknown>;

  const percentFields = ["employeeInsurancePercent", "employerInsurancePercent", "unemploymentInsurancePercent"] as const;
  const percents: Record<(typeof percentFields)[number], number | null> = {
    employeeInsurancePercent: null,
    employerInsurancePercent: null,
    unemploymentInsurancePercent: null,
  };
  for (const field of percentFields) {
    const parsed = optionalPercent(r[field]);
    if (!parsed.ok) return { ok: false, error: "invalid_percent", field };
    percents[field] = parsed.value;
  }

  const ceiling = optionalRial(r.insuranceCeilingRial);
  if (!ceiling.ok) return { ok: false, error: "invalid_amount", field: "insuranceCeilingRial" };
  const threshold = optionalRial(r.taxExemptThresholdRial);
  if (!threshold.ok) return { ok: false, error: "invalid_amount", field: "taxExemptThresholdRial" };

  for (const flag of ["nonTaxableAllowancesInsurable", "deductEmployeeInsuranceFromTaxable"] as const) {
    if (r[flag] !== undefined && r[flag] !== null && typeof r[flag] !== "boolean") {
      return { ok: false, error: "invalid_settings", field: flag };
    }
  }

  const rawBrackets = r.taxBrackets ?? [];
  if (!Array.isArray(rawBrackets)) return { ok: false, error: "invalid_brackets", field: "taxBrackets" };
  if (rawBrackets.length > MAX_TAX_BRACKETS) return { ok: false, error: "too_many_brackets", field: "taxBrackets" };
  const taxBrackets: PayrollTaxBracket[] = [];
  for (const entry of rawBrackets) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "invalid_brackets", field: "taxBrackets" };
    }
    const e = entry as Record<string, unknown>;
    if (!isPercent(e.ratePercent)) return { ok: false, error: "invalid_percent", field: "taxBrackets" };
    const upTo = e.upToRial === undefined || e.upToRial === null ? null : e.upToRial;
    if (upTo !== null && (!isRial(upTo) || upTo === 0)) return { ok: false, error: "invalid_amount", field: "taxBrackets" };
    taxBrackets.push({ upToRial: upTo as number | null, ratePercent: e.ratePercent });
  }
  for (let i = 0; i < taxBrackets.length; i++) {
    const upTo = taxBrackets[i].upToRial;
    const isLast = i === taxBrackets.length - 1;
    // Only the last band may be open-ended, and it must be: income above the
    // last bound would otherwise fall into no band and silently go untaxed.
    if (upTo === null && !isLast) return { ok: false, error: "last_bracket_must_be_open", field: "taxBrackets" };
    if (upTo !== null && isLast) return { ok: false, error: "last_bracket_must_be_open", field: "taxBrackets" };
    if (i > 0 && upTo !== null) {
      const prev = taxBrackets[i - 1].upToRial as number;
      if (upTo <= prev) return { ok: false, error: "brackets_not_ascending", field: "taxBrackets" };
    }
    if (upTo !== null && threshold.value !== null && upTo <= threshold.value) {
      return { ok: false, error: "brackets_not_ascending", field: "taxBrackets" };
    }
  }

  return {
    ok: true,
    value: {
      ...percents,
      insuranceCeilingRial: ceiling.value && ceiling.value > 0 ? ceiling.value : null,
      nonTaxableAllowancesInsurable: r.nonTaxableAllowancesInsurable === true,
      deductEmployeeInsuranceFromTaxable: r.deductEmployeeInsuranceFromTaxable === true,
      taxExemptThresholdRial: threshold.value && threshold.value > 0 ? threshold.value : null,
      taxBrackets,
    },
  };
}

/** Whether the business has entered anything that deducts — drives the screen's "no deductions configured" note. */
export function payrollSettingsApplyDeductions(s: PayrollSettings): boolean {
  return (
    (s.employeeInsurancePercent ?? 0) > 0 ||
    (s.employerInsurancePercent ?? 0) > 0 ||
    (s.unemploymentInsurancePercent ?? 0) > 0 ||
    s.taxBrackets.some((b) => b.ratePercent > 0)
  );
}

// ---------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------

export interface GrossToNetInput {
  baseSalaryRial: number;
  taxableAllowancesRial?: number;
  nonTaxableAllowancesRial?: number;
  overtimeRial?: number;
  /** What the employee still owes from salary advances; recovered up to this month's remaining pay. */
  advanceOutstandingRial?: number;
  /** Other fixed monthly deductions (e.g. a loan instalment owed to a third party). */
  otherDeductionsRial?: number;
}

export interface GrossToNetBreakdown {
  baseSalaryRial: number;
  taxableAllowancesRial: number;
  nonTaxableAllowancesRial: number;
  overtimeRial: number;
  grossRial: number;
  insuranceBaseRial: number;
  employeeInsuranceRial: number;
  employerInsuranceRial: number;
  unemploymentInsuranceRial: number;
  taxableIncomeRial: number;
  incomeTaxRial: number;
  otherDeductionsRial: number;
  advanceRecoveryRial: number;
  /** Advance balance still owed after this month's recovery. */
  advanceCarriedRial: number;
  netPayRial: number;
  employerCostRial: number;
}

export type GrossToNetError = "invalid_amount" | "deductions_exceed_gross" | "amount_too_large";

export type GrossToNetResult = ({ ok: true } & GrossToNetBreakdown) | { ok: false; error: GrossToNetError };

const SCALE = 10_000n; // 100% = 10 000 basis points

/** A two-decimal percent as integer basis points (7 → 700, 1.5 → 150). */
export function percentToBasisPoints(percent: number | null): bigint {
  if (percent === null || !Number.isFinite(percent) || percent <= 0) return 0n;
  return BigInt(Math.round(percent * 100));
}

/** `numerator / 10 000`, rounded half-up (all inputs are non-negative). */
function roundBasis(numerator: bigint): bigint {
  return (numerator + SCALE / 2n) / SCALE;
}

/** `amount × bps / 10 000`, rounded half-up. */
export function applyBasisPoints(amountRial: bigint, bps: bigint): bigint {
  return roundBasis(amountRial * bps);
}

/**
 * Progressive monthly income tax: each band's slice of the taxable income above
 * the exempt threshold, at that band's rate. The slices are summed exactly and
 * rounded once, so the tax never drifts by a Rial per band.
 */
export function progressiveIncomeTax(
  taxableIncomeRial: bigint,
  brackets: readonly PayrollTaxBracket[],
  exemptThresholdRial: number | null,
): bigint {
  if (brackets.length === 0 || taxableIncomeRial <= 0n) return 0n;
  const exempt = BigInt(exemptThresholdRial ?? 0);
  let lower = 0n;
  let numerator = 0n;
  for (const bracket of brackets) {
    const upper = bracket.upToRial === null ? null : BigInt(bracket.upToRial);
    const from = lower > exempt ? lower : exempt;
    const to = upper === null || taxableIncomeRial < upper ? taxableIncomeRial : upper;
    if (to > from) numerator += (to - from) * percentToBasisPoints(bracket.ratePercent);
    if (upper === null || taxableIncomeRial <= upper) break;
    lower = upper;
  }
  return roundBasis(numerator);
}

function amount(value: number | undefined): bigint | null {
  if (value === undefined) return 0n;
  if (!isRial(value)) return null;
  return BigInt(value);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function computeGrossToNet(input: GrossToNetInput, settings: PayrollSettings): GrossToNetResult {
  const base = amount(input.baseSalaryRial);
  const taxableAllowances = amount(input.taxableAllowancesRial);
  const nonTaxableAllowances = amount(input.nonTaxableAllowancesRial);
  const overtime = amount(input.overtimeRial);
  const advanceOutstanding = amount(input.advanceOutstandingRial);
  const otherDeductions = amount(input.otherDeductionsRial);
  if (
    base === null ||
    taxableAllowances === null ||
    nonTaxableAllowances === null ||
    overtime === null ||
    advanceOutstanding === null ||
    otherDeductions === null
  ) {
    return { ok: false, error: "invalid_amount" };
  }

  const gross = base + taxableAllowances + nonTaxableAllowances + overtime;

  let insuranceBase = base + overtime + taxableAllowances;
  if (settings.nonTaxableAllowancesInsurable) insuranceBase += nonTaxableAllowances;
  if (settings.insuranceCeilingRial !== null && settings.insuranceCeilingRial > 0) {
    const ceiling = BigInt(settings.insuranceCeilingRial);
    if (insuranceBase > ceiling) insuranceBase = ceiling;
  }

  const employeeInsurance = applyBasisPoints(insuranceBase, percentToBasisPoints(settings.employeeInsurancePercent));
  const employerInsurance = applyBasisPoints(insuranceBase, percentToBasisPoints(settings.employerInsurancePercent));
  const unemploymentInsurance = applyBasisPoints(
    insuranceBase,
    percentToBasisPoints(settings.unemploymentInsurancePercent),
  );

  let taxableIncome = base + overtime + taxableAllowances;
  if (settings.deductEmployeeInsuranceFromTaxable) {
    taxableIncome = taxableIncome > employeeInsurance ? taxableIncome - employeeInsurance : 0n;
  }
  const incomeTax = progressiveIncomeTax(taxableIncome, settings.taxBrackets, settings.taxExemptThresholdRial);

  const fixedDeductions = employeeInsurance + incomeTax + otherDeductions;
  if (fixedDeductions > gross) return { ok: false, error: "deductions_exceed_gross" };

  const remaining = gross - fixedDeductions;
  const advanceRecovery = advanceOutstanding < remaining ? advanceOutstanding : remaining;
  const net = remaining - advanceRecovery;
  const employerCost = gross + employerInsurance + unemploymentInsurance;

  if (employerCost > MAX_SAFE || advanceOutstanding > MAX_SAFE) return { ok: false, error: "amount_too_large" };

  return {
    ok: true,
    baseSalaryRial: Number(base),
    taxableAllowancesRial: Number(taxableAllowances),
    nonTaxableAllowancesRial: Number(nonTaxableAllowances),
    overtimeRial: Number(overtime),
    grossRial: Number(gross),
    insuranceBaseRial: Number(insuranceBase),
    employeeInsuranceRial: Number(employeeInsurance),
    employerInsuranceRial: Number(employerInsurance),
    unemploymentInsuranceRial: Number(unemploymentInsurance),
    taxableIncomeRial: Number(taxableIncome),
    incomeTaxRial: Number(incomeTax),
    otherDeductionsRial: Number(otherDeductions),
    advanceRecoveryRial: Number(advanceRecovery),
    advanceCarriedRial: Number(advanceOutstanding - advanceRecovery),
    netPayRial: Number(net),
    employerCostRial: Number(employerCost),
  };
}

/**
 * The run's journal, summed from its lines — the one place the accrual's
 * debit and credit sides are decided, so the service posts and the test
 * asserts the same shape. Balanced by construction:
 *
 *   Dr salaries expense (gross) + Dr employer insurance expense (employer + unemployment)
 *   = Cr net salary payable + Cr insurance payable (employee + employer + unemployment)
 *   + Cr payroll tax payable + Cr staff advances (recovered) + Cr other deductions payable
 */
export interface PayrollAccrualTotals {
  grossRial: number;
  employerInsuranceExpenseRial: number;
  netPayableRial: number;
  insurancePayableRial: number;
  incomeTaxPayableRial: number;
  advanceRecoveryRial: number;
  otherDeductionsPayableRial: number;
}

export function payrollAccrualTotals(lines: readonly GrossToNetBreakdown[]): PayrollAccrualTotals {
  let gross = 0n;
  let employerExpense = 0n;
  let net = 0n;
  let insurance = 0n;
  let tax = 0n;
  let advance = 0n;
  let other = 0n;
  for (const l of lines) {
    gross += BigInt(l.grossRial);
    employerExpense += BigInt(l.employerInsuranceRial) + BigInt(l.unemploymentInsuranceRial);
    net += BigInt(l.netPayRial);
    insurance += BigInt(l.employeeInsuranceRial) + BigInt(l.employerInsuranceRial) + BigInt(l.unemploymentInsuranceRial);
    tax += BigInt(l.incomeTaxRial);
    advance += BigInt(l.advanceRecoveryRial);
    other += BigInt(l.otherDeductionsRial);
  }
  return {
    grossRial: Number(gross),
    employerInsuranceExpenseRial: Number(employerExpense),
    netPayableRial: Number(net),
    insurancePayableRial: Number(insurance),
    incomeTaxPayableRial: Number(tax),
    advanceRecoveryRial: Number(advance),
    otherDeductionsPayableRial: Number(other),
  };
}
