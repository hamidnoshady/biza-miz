/**
 * Phase 16 — fiscal years & periods, the pure part.
 *
 * A fiscal year is the Jalali year (فروردین–اسفند; no configurable start
 * month for now — see docs/phases/Phase-16-Accounting-Suite.md's resolved
 * open questions), divided into its twelve Jalali months as periods. This
 * module computes those boundaries as ISO dates; the fiscal_years and
 * fiscal_periods tables store the result. Database triggers enforce period
 * locks, authorization at soft-close, and (from adoption onward) date coverage;
 * this file defines the Jalali calendar, not those enforcement rules.
 */
import { JALALI_MONTHS, jalaliMonthLength, jalaliToIsoDate } from "./jalali";

export interface FiscalPeriodSpec {
  label: string; // e.g. "1404-01"
  name: string; // e.g. "فروردین ۱۴۰۴"
  startsOn: string; // ISO date
  endsOn: string; // ISO date, inclusive
}

export interface FiscalYearSpec {
  label: string; // e.g. "1404"
  startsOn: string;
  endsOn: string;
  periods: FiscalPeriodSpec[];
}

/**
 * The financial-years endpoint deliberately has a bounded, human-entered
 * range. Keeping it here gives the API and its form one rule instead of two
 * near-identical magic-number checks. `fiscalYearSpec` itself stays useful for
 * historical/reporting calculations outside that product-input boundary.
 */
export const FISCAL_YEAR_MIN = 1300;
export const FISCAL_YEAR_MAX = 1500;
export const FISCAL_PERIOD_COUNT = 12;

export function isSupportedFiscalYear(value: number): boolean {
  return Number.isInteger(value) && value >= FISCAL_YEAR_MIN && value <= FISCAL_YEAR_MAX;
}

/** The 12 Jalali-month periods making up fiscal year `jy`, as ISO date ranges. */
export function fiscalYearSpec(jy: number): FiscalYearSpec {
  const periods: FiscalPeriodSpec[] = [];
  for (let jm = 1; jm <= FISCAL_PERIOD_COUNT; jm++) {
    const monthLength = jalaliMonthLength(jy, jm);
    periods.push({
      label: `${jy}-${String(jm).padStart(2, "0")}`,
      name: `${JALALI_MONTHS[jm - 1]} ${jy}`,
      startsOn: jalaliToIsoDate(jy, jm, 1),
      endsOn: jalaliToIsoDate(jy, jm, monthLength),
    });
  }
  return {
    label: String(jy),
    startsOn: periods[0].startsOn,
    endsOn: periods[periods.length - 1].endsOn,
    periods,
  };
}

export type FiscalPeriodStatus = "open" | "soft_closed" | "locked";

/** Status transitions a period may make. Anything else is rejected up front, before a query is even run. */
const ALLOWED_TRANSITIONS: Record<FiscalPeriodStatus, FiscalPeriodStatus[]> = {
  open: ["soft_closed"],
  soft_closed: ["locked", "open"],
  locked: ["open"],
};

export function canTransitionPeriod(from: FiscalPeriodStatus, to: FiscalPeriodStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

const POSTING_CONTROL_ERROR_CODES = [
  "fiscal_period_locked",
  "fiscal_period_soft_closed",
  "fiscal_period_not_defined",
] as const;
export type FiscalPeriodPostingErrorCode = (typeof POSTING_CONTROL_ERROR_CODES)[number];

/**
 * Whether `err` is a database posting-control rejection (locked, soft-closed,
 * or outside the adopted fiscal calendar). PostgreSQL surfaces a
 * `RAISE EXCEPTION 'code'` as an Error whose `.message` is exactly that code,
 * so this is a plain string match rather than an error-code lookup.
 */
export function fiscalPeriodLockErrorCode(err: unknown): FiscalPeriodPostingErrorCode | null {
  if (!(err instanceof Error)) return null;
  return (POSTING_CONTROL_ERROR_CODES as readonly string[]).includes(err.message)
    ? (err.message as FiscalPeriodPostingErrorCode)
    : null;
}
