/**
 * Payroll period identity — issue #835 §4 and §13, on top of audit F11's
 * "a run is a Jalali month".
 *
 * A run's identity is its month key, `YYYY-MM` (Jalali), and that is what the
 * database makes unique (`uq_payroll_runs_period`, migration 0214, over runs
 * that are not voided). The *label* («مرداد 1404») is only a heading derived
 * from the key. This module is the one place that turns whatever a person or a
 * client typed into that key, so the same month cannot be spelled two ways and
 * booked twice:
 *
 *   - `resolvePayrollPeriodKey` — the accrual request's `periodKey`. Its shape
 *     is fixed — a four-digit year, a dash, a two-digit month — and only the
 *     *spelling* of its characters is normalised: Persian and Arabic-Indic
 *     digits, a typographic dash for the hyphen, spaces and invisible marks
 *     around it. «۱۴۰۴-۰۵», « 1404 – 05 » and «1404-05» are one period; «1404-5»
 *     and «1404/05» are not a key at all.
 *   - `resolvePayrollPeriodFilter` — the history's `period` filter, which also
 *     takes a heading as a person would write it («مرداد ۱۴۰۴»), because that
 *     is how the screen and the old runs name a month.
 *   - `payrollPeriodKeyForLabel` — the month a *legacy* run's free-text label
 *     names, if it names exactly one. Runs recorded before audit F11 have no
 *     key (it stays NULL — the unique index ignores them); comparing their
 *     normalised label is how a month booked under the old rules still blocks a
 *     second booking.
 *
 * Framework-free and pure: the service imports it for the identity, the tests
 * pin every spelling.
 */
import { toLatinDigits } from "./digits";
import { depreciationPeriod, type DepreciationPeriod } from "./depreciation";
import { JALALI_MONTHS } from "./jalali";

/** Jalali years a period may name. Wide enough for any real ledger. */
const PERIOD_YEAR_MIN = 1300;
const PERIOD_YEAR_MAX = 1599;

export interface PayrollPeriod {
  /** Jalali year, e.g. 1404. */
  year: number;
  /** Jalali month, 1 (فروردین) … 12 (اسفند). */
  month: number;
}

/** Invisible marks that survive copy-paste: zero-width spaces/joiners, bidi controls, BOM. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** Arabic harakat, superscript alef and tatweel — never part of a Persian word. */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;
/** Typographic dashes and the minus sign: what a word processor or a keyboard layout types for «-». */
const DASH_VARIANTS = /[\u2010-\u2015\u2212\uFE58\uFE63]/g;

/**
 * One spelling per word, for *comparison*.
 *
 * NFKC folds presentation forms and full-width digits; the digit map folds
 * Persian and Arabic-Indic digits to ASCII; typographic dashes fold to «-»;
 * ي/ى/ك fold to the Persian ی/ک the keyboard layout produces; آ folds to ا
 * because «آبان» is as often typed «ابان»; invisible marks and diacritics are
 * dropped; every whitespace run
 * (NBSP and tabs included) becomes one space. The result is lower-cased.
 * Never shown to anyone — it is only ever compared.
 */
export function normalizePeriodText(input: string): string {
  return toLatinDigits(String(input ?? "").normalize("NFKC"))
    .replace(INVISIBLE, "")
    .replace(ARABIC_MARKS, "")
    .replace(DASH_VARIANTS, "-")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/آ/g, "ا")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MONTH_TOKENS: readonly string[] = JALALI_MONTHS.map((name) => normalizePeriodText(name));

function isPeriod(value: PayrollPeriod): boolean {
  return (
    Number.isInteger(value.year) &&
    Number.isInteger(value.month) &&
    value.year >= PERIOD_YEAR_MIN &&
    value.year <= PERIOD_YEAR_MAX &&
    value.month >= 1 &&
    value.month <= 12
  );
}

/** `1404-05` — the identity of a calendar month, the form the unique index compares. */
export function payrollPeriodKey(period: PayrollPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

/** The month as a canonical `DepreciationPeriod`: key, label, and first/last day. */
function toResolved(period: PayrollPeriod): DepreciationPeriod {
  return depreciationPeriod(period.year, period.month);
}

/** `YYYY-MM`, `YYYY/M`, `YYYY.MM`, `YYYY - MM`, in any digits — and nothing else. (The *filter's* tolerance.) */
function parseNumericPeriod(text: string): PayrollPeriod | null {
  const match = /^(\d{4})\s*[-/.]\s*(\d{1,2})$/.exec(text);
  if (!match) return null;
  const candidate = { year: Number(match[1]), month: Number(match[2]) };
  return isPeriod(candidate) ? candidate : null;
}

/**
 * Does this text name exactly one Jalali month of exactly one Jalali year?
 *
 * Accepts «مرداد ۱۴۰۴», «مرداد 1404», «حقوق مرداد ماه ۱۴۰۴», «1404/05», «۱۴۰۴-۵».
 * Anything ambiguous — two months, two years, a month with no year — names no
 * single calendar month and is `null`.
 */
export function parsePayrollPeriod(input: string): PayrollPeriod | null {
  const text = normalizePeriodText(input);
  if (!text) return null;

  const numeric = parseNumericPeriod(text);
  if (numeric) return numeric;

  const tokens = text.split(/[\s\-/.,،:؛()]+/).filter(Boolean);
  const months = new Set<number>();
  const years = new Set<number>();
  for (const token of tokens) {
    const monthIndex = MONTH_TOKENS.indexOf(token);
    if (monthIndex >= 0) months.add(monthIndex + 1);
    if (/^\d{4}$/.test(token)) {
      const year = Number(token);
      if (year >= PERIOD_YEAR_MIN && year <= PERIOD_YEAR_MAX) years.add(year);
    }
  }
  if (months.size !== 1 || years.size !== 1) return null;
  return { year: [...years][0], month: [...months][0] };
}

export type ResolvedPayrollPeriod = { ok: true; period: DepreciationPeriod } | { ok: false; error: "invalid_period" };

/**
 * The accrual request's `periodKey`, as a month — tolerant of how a key is
 * *spelled* (digits, dash variants, spaces, invisible marks), strict about what
 * it *is*: exactly `YYYY-MM` with a real Jalali year and month. A one-digit
 * month, another separator or a heading («مرداد») is not a key.
 */
export function resolvePayrollPeriodKey(input: unknown): ResolvedPayrollPeriod {
  if (typeof input !== "string") return { ok: false, error: "invalid_period" };
  const text = normalizePeriodText(input).replace(/\s*-\s*/g, "-");
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text);
  if (!match) return { ok: false, error: "invalid_period" };
  const period = { year: Number(match[1]), month: Number(match[2]) };
  if (!isPeriod(period)) return { ok: false, error: "invalid_period" };
  return { ok: true, period: toResolved(period) };
}

/**
 * The history filter's `period`: a key in any spelling, or a heading the way a
 * person writes one («مرداد ۱۴۰۴»). Resolved to the same month either way, so
 * the filter compares identities, not strings.
 */
export function resolvePayrollPeriodFilter(input: string): ResolvedPayrollPeriod {
  const period = parsePayrollPeriod(input);
  if (!period) return { ok: false, error: "invalid_period" };
  return { ok: true, period: toResolved(period) };
}

/**
 * The month key a legacy run's free-text label names — or `null` when it names
 * no single month («مرداد» with no year, «پاداش عید»). A `null` means the label
 * cannot collide with a keyed month, so there is nothing to compare.
 */
export function payrollPeriodKeyForLabel(label: string): string | null {
  const period = parsePayrollPeriod(label);
  return period ? payrollPeriodKey(period) : null;
}

/**
 * A run's accrual date when the caller states none: the last day of the month
 * (so a run for a closed month lands in it), or today while the month is still
 * running. `today` is the business's own (`businessToday`). Shared by the #835
 * journal-level accrual and the #865 statutory engine, so the two can never
 * date the same month differently.
 */
export function defaultPayrollAccrualDate(period: { endsOn: string }, today: string): string {
  return period.endsOn < today ? period.endsOn : today;
}
