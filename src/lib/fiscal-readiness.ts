/**
 * Fiscal-period readiness, the pure part (audit finding F08).
 *
 * Migration 0024's lock trigger deliberately lets a journal entry land on a
 * date that no fiscal period covers — a business that has never defined a
 * fiscal year can still sell, and imported history keeps the date it really
 * happened on. That stays the policy: **posting is never refused and no entry
 * is moved for want of a period**. What this module adds is the honest answer
 * to "are these books ready to be closed?":
 *
 *   - is any fiscal year configured at all;
 *   - does a period cover the business's today (the next sale's date);
 *   - how many entries sit on dates outside every configured period, and
 *     between which dates;
 *   - which open years coverage would let `closeFiscalYear` close.
 *
 * A year is closable (as far as coverage goes) only when no uncovered entry is
 * dated on or before its last day: the closing entry rolls *that year's*
 * revenue and expense into retained earnings, so uncovered earlier activity
 * would be left in the P&L accounts with no period to lock it.
 * `closing-service.ts` enforces the same predicate (`yearBlockedByUncoveredEntries`)
 * inside its transaction; the screens only explain it.
 *
 * Client-safe: imports nothing that touches the database.
 */
import { toPersianDigits } from "./digits";
import { formatJalali, isoDateToJalali } from "./jalali";

export interface UncoveredEntrySummary {
  count: number;
  /** ISO date of the earliest uncovered entry, null when count is 0. */
  earliest: string | null;
  /** ISO date of the latest uncovered entry, null when count is 0. */
  latest: string | null;
}

export interface FiscalCoverageFacts {
  fiscalYears: { label: string; startsOn: string; endsOn: string; closedAt: string | null }[];
  /** The business's today (ISO), from `businessToday`. */
  today: string;
  /** Whether some configured period's range contains `today`. */
  todayCovered: boolean;
  uncovered: UncoveredEntrySummary;
}

export type FiscalReadinessIssue = "no_fiscal_year" | "today_uncovered" | "uncovered_entries";

export interface FiscalReadiness {
  ready: boolean;
  issues: FiscalReadinessIssue[];
  hasFiscalYear: boolean;
  fiscalYearCount: number;
  today: string;
  todayCovered: boolean;
  uncovered: UncoveredEntrySummary;
  /** Labels of open (not finally closed) years that coverage lets be closed. */
  closableYearLabels: string[];
  /**
   * Coverage permits a year-end close: a year exists, and at least one open
   * year has no uncovered entry on or before its end. Period statuses are a
   * separate precondition `closeFiscalYear` checks on its own.
   */
  canClose: boolean;
}

/** True when an uncovered entry dated on/before `yearEndsOn` must block that year's close. */
export function yearBlockedByUncoveredEntries(yearEndsOn: string, earliestUncovered: string | null): boolean {
  return earliestUncovered !== null && earliestUncovered <= yearEndsOn;
}

export function evaluateFiscalReadiness(facts: FiscalCoverageFacts): FiscalReadiness {
  const hasFiscalYear = facts.fiscalYears.length > 0;
  const uncovered: UncoveredEntrySummary =
    facts.uncovered.count > 0 ? facts.uncovered : { count: 0, earliest: null, latest: null };
  const todayCovered = hasFiscalYear && facts.todayCovered;

  const issues: FiscalReadinessIssue[] = [];
  if (!hasFiscalYear) issues.push("no_fiscal_year");
  else if (!todayCovered) issues.push("today_uncovered");
  if (uncovered.count > 0) issues.push("uncovered_entries");

  const closableYearLabels = facts.fiscalYears
    .filter((year) => !year.closedAt && !yearBlockedByUncoveredEntries(year.endsOn, uncovered.earliest))
    .map((year) => year.label);

  return {
    ready: issues.length === 0,
    issues,
    hasFiscalYear,
    fiscalYearCount: facts.fiscalYears.length,
    today: facts.today,
    todayCovered,
    uncovered,
    closableYearLabels,
    canClose: hasFiscalYear && closableYearLabels.length > 0,
  };
}

function shamsi(iso: string): string {
  try {
    return toPersianDigits(formatJalali(iso));
  } catch {
    return iso;
  }
}

/** The Jalali year a date falls in — what the owner types into «سال شمسی جدید». */
export function jalaliYearOf(iso: string): number | null {
  return isoDateToJalali(iso)?.jy ?? null;
}

export interface FiscalReadinessNotice {
  title: string;
  lines: string[];
}

/**
 * The Persian warning a screen shows when the books are not ready, or null when
 * they are. Every date is Shamsi; the wording always says that nothing is
 * rejected or moved, because that is the policy and an owner reading "خارج از
 * دوره" will otherwise assume their sales were lost.
 */
export function fiscalReadinessNotice(r: FiscalReadiness): FiscalReadinessNotice | null {
  if (r.ready) return null;
  const lines: string[] = [];
  const todayYear = jalaliYearOf(r.today);

  if (!r.hasFiscalYear) {
    lines.push(
      `هنوز هیچ سال مالی‌ای تعریف نشده است؛ بدون آن، دوره‌ها قابل بستن یا قفل نیستند و بستن حساب‌های سال ممکن نیست.${
        todayYear ? ` برای شروع، سال مالی ${toPersianDigits(todayYear)} را تعریف کنید.` : ""
      }`,
    );
  } else if (!r.todayCovered) {
    lines.push(
      `تاریخ امروز (${shamsi(r.today)}) در هیچ دورهٔ مالی تعریف‌شده‌ای نیست؛ اسناد امروز بیرون از دوره‌ها ثبت می‌شوند.${
        todayYear ? ` سال مالی ${toPersianDigits(todayYear)} را تعریف کنید.` : ""
      }`,
    );
  }

  if (r.uncovered.count > 0 && r.uncovered.earliest && r.uncovered.latest) {
    const range =
      r.uncovered.earliest === r.uncovered.latest
        ? `در تاریخ ${shamsi(r.uncovered.earliest)}`
        : `از ${shamsi(r.uncovered.earliest)} تا ${shamsi(r.uncovered.latest)}`;
    lines.push(
      `${toPersianDigits(r.uncovered.count)} سند حسابداری ${range} بیرون از همهٔ دوره‌های مالی تعریف‌شده است. این اسناد رد یا جابه‌جا نمی‌شوند؛ با تعریف سال مالیِ آن تاریخ‌ها زیر پوشش دوره قرار می‌گیرند.`,
    );
  }

  if (r.hasFiscalYear && !r.canClose) {
    lines.push("تا وقتی اسناد پیش از پایان یک سال بیرون از دوره‌ها باشند، بستن نهایی آن سال ممکن نیست.");
  }

  return { title: "دفتر هنوز برای بستن حساب‌ها آماده نیست", lines };
}
