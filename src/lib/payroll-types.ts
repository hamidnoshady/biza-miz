/**
 * The payroll wire shapes — one definition for the service that produces them
 * and the screen that reads them.
 *
 * Every money amount is **integer Rial as text** (`"30000000"`), never a JSON
 * number: a run total can pass `Number.MAX_SAFE_INTEGER` even when every wage
 * in it is safe, and a number that silently rounds is the one thing a ledger
 * must not do (issue #835 §10). The text is parsed with `BigInt` and shown
 * through `useMoney().formatText`. Signed figures (a liability difference, a net
 * commission that returns turned negative) are the same text with a leading `-`.
 *
 * Types only — safe to import from a client component without dragging `pg`
 * along with it.
 */

export type PayrollRunStatus = "accrued" | "paid" | "voided";

/**
 * The standing figures a member's pay is built from, named as the PATCH body and
 * the history name them. Only the wage may be «unset» (null); the others are an
 * amount, with 0 meaning «none».
 */
export type PayTerm = "monthlyWage" | "taxableAllowance" | "nonTaxableAllowance" | "fixedDeduction";

export const PAY_TERMS: readonly PayTerm[] = ["monthlyWage", "taxableAllowance", "nonTaxableAllowance", "fixedDeduction"];

export interface StaffWage {
  id: string;
  fullName: string;
  role: string;
  /** Integer Rial, or null when no wage has been set. */
  monthlyWage: string | null;
  /** Integer Rial; "0" = none. */
  taxableAllowance: string;
  nonTaxableAllowance: string;
  fixedDeduction: string;
  /** Salary advances still to be recovered from this member's pay, integer Rial. */
  advanceOutstanding: string;
}

/**
 * One person's line on a run — a snapshot, immune to later renames, removals
 * and rate changes. Every figure is what that run computed with the standing
 * terms and the settings of the day.
 */
export interface PayrollRunLine {
  /** The member, or null once that member row no longer exists. */
  userId: string | null;
  /** The name at accrual time; null only for a legacy line whose member was already gone. */
  fullName: string | null;
  employeeCode: string | null;
  role: string | null;
  /** Gross for the period (a line from before gross-to-net: the whole amount, which was also the net). */
  amount: string;
  baseSalaryRial: string;
  taxableAllowancesRial: string;
  nonTaxableAllowancesRial: string;
  overtimeRial: string;
  grossRial: string;
  insuranceBaseRial: string;
  employeeInsuranceRial: string;
  employerInsuranceRial: string;
  unemploymentInsuranceRial: string;
  taxableIncomeRial: string;
  incomeTaxRial: string;
  otherDeductionsRial: string;
  advanceRecoveryRial: string;
  /** What the member is paid for wages: gross minus every employee-side deduction. */
  netPayRial: string;
  employerCostRial: string;
  /** The commission component settled by this run, integer Rial. */
  commissionAmount: string;
  /** `netPayRial + commissionAmount` — what paying this line pays out. */
  payableAmount: string;
}

/** A run as the history list shows it — no lines (those load on demand). */
export interface PayrollRunSummary {
  id: string;
  /** The Jalali month, `YYYY-MM`; null for a run recorded before periods had a key. */
  periodKey: string | null;
  periodLabel: string;
  status: PayrollRunStatus;
  /** Gross total — the salaries-expense debit. (A run from before gross-to-net: the whole wage bill.) */
  totalAmount: string;
  /** Net wages — exactly what the accrual credited to salaries payable. */
  netAmount: string;
  /** Commission accruals this run settles. Already in salaries payable; not re-accrued. */
  commissionTotal: string;
  /** `netAmount + commissionTotal` — what paying this run posts. */
  payableAmount: string;
  accrualDate: string;
  paidDate: string | null;
  voidedDate: string | null;
  createdByName: string | null;
  lineCount: number;
}

export interface PayrollRun extends PayrollRunSummary {
  lines: PayrollRunLine[];
}

/** An account a payroll payment may leave: cash, a bank account or a petty-cash float. */
export interface PayrollPaymentAccount {
  id: string;
  code: string;
  name: string;
  role: "cash" | "bank" | "petty_cash";
}

export interface PayrollCommissionPreviewLine {
  userId: string;
  fullName: string;
  /** Net commission this run would settle for the member, integer Rial. */
  amount: string;
}

/**
 * The commission an accrual dated `accrualDate` would settle — computed by the
 * same code that claims it. The wage side of the preview (gross to net) is the
 * pure calculator the screen runs over the saved terms; only commission needs
 * the database.
 */
export interface PayrollCommissionPreview {
  accrualDate: string;
  lines: PayrollCommissionPreviewLine[];
  total: string;
}

/**
 * Salaries payable (۲۳۰۰) against what payroll knows is owed — the tie-out.
 *
 * `difference` is `ledgerBalance − awaitingPayment − unsettledCommission`. It is
 * zero while only payroll and commission post to the account; a manual journal
 * on 2300, or commission settled outside payroll, shows up here instead of
 * hiding inside the balance. (Withheld insurance, tax and other deductions sit
 * in their own payables, not in 2300.)
 */
export interface PayrollLiability {
  /** Credits − debits on account 2300 over the whole ledger (signed). */
  ledgerBalance: string;
  /** Net wages + commission of runs that are accrued but not yet paid. */
  awaitingPayment: string;
  /** Net commission accrued to staff and not yet included in any run (signed). */
  unsettledCommission: string;
  difference: string;
}

/** A salary advance (مساعده) paid to a member, to be recovered by a later run. */
export interface PayrollAdvance {
  id: string;
  userId: string;
  fullName: string | null;
  /** Integer Rial. */
  amount: string;
  /** Which kind of account it left: cash/petty cash, or a bank account. */
  method: "cash" | "bank";
  advanceDate: string;
  note: string | null;
  status: "active" | "voided";
  createdByName: string | null;
}

/** One change to one of a member's standing pay terms — an immutable audit row. */
export interface PayTermChange {
  id: string;
  userId: string;
  employeeName: string;
  term: PayTerm;
  /** Integer Rial; null = the wage was not set before (only ever the wage). */
  previousAmount: string | null;
  /** Integer Rial; null = the wage was cleared (only ever the wage). */
  newAmount: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
  reason: string | null;
}
