/**
 * ESH-193 / #1378 — the one billing calendar.
 *
 * Every commercial boundary in this repository is a *Tehran* calendar boundary:
 * the AI allowance month, a usage period, a prepaid service term's monthly
 * allowance reset and the proration "days remaining" arithmetic. Two different
 * implementations of "which month is this" is how a business gets two
 * allowances in one month or none in another, so this module is the only copy
 * and `ai-plan-allowance.ts` re-exports it rather than keeping a twin.
 *
 * Pure on purpose: no `db`, no `next`. It is unit-tested across the Tehran
 * midnight, a month-end, a leap year and the DST-free fixed offset Iran uses.
 */

/** The billing calendar. A business may live elsewhere; billing is Tehran. */
export const AI_BILLING_TIME_ZONE = "Asia/Tehran";

/**
 * The `period_month` key ('YYYY-MM') for a moment, in the billing calendar.
 * `en-CA` formats as YYYY-MM-DD, so the first seven characters are the key.
 */
export function periodMonthFor(date: Date, timeZone: string = AI_BILLING_TIME_ZONE): string {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return formatted.slice(0, 7);
}

/** The current period key. */
export function currentPeriodMonth(): string {
  return periodMonthFor(new Date());
}

/** Milliseconds the zone is ahead of UTC at one instant (handles any zone). */
function offsetAt(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
    0,
  );
  return asUtc - utcMs;
}

/**
 * The UTC instant of local midnight for a civil date in `timeZone`.
 *
 * Two offset probes (guess, then refine) are enough for every real zone: the
 * only error case is a date inside a DST jump, and Iran has had no DST since
 * 2022 — the refinement still lands on the correct wall clock there.
 */
export function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string = AI_BILLING_TIME_ZONE,
): Date {
  const targetUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const firstGuess = targetUtc - offsetAt(targetUtc, timeZone);
  const refined = targetUtc - offsetAt(firstGuess, timeZone);
  return new Date(refined);
}

export interface BillingMonthWindow {
  /** 'YYYY-MM' in the billing calendar. */
  periodMonth: string;
  /** Inclusive UTC instant of the first local day. */
  startUtc: Date;
  /** Exclusive UTC instant of the next local day. */
  nextStartUtc: Date;
}

/** The exact UTC `[start, nextStart)` window of the calendar month containing `now`. */
export function monthWindow(
  now: Date = new Date(),
  timeZone: string = AI_BILLING_TIME_ZONE,
): BillingMonthWindow {
  const periodMonth = periodMonthFor(now, timeZone);
  const [yStr, mStr] = periodMonth.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    periodMonth,
    startUtc: zonedMidnightUtc(year, month, 1, timeZone),
    nextStartUtc: zonedMidnightUtc(nextYear, nextMonth, 1, timeZone),
  };
}

/** The calendar month window that contains an ISO instant. */
export function monthWindowAt(iso: string, timeZone: string = AI_BILLING_TIME_ZONE): BillingMonthWindow {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_instant");
  return monthWindow(at, timeZone);
}

/**
 * Calendar-month addition with month-end clamping: Jan 31 + 1 month is the
 * last day of February (28 or 29), never March 2/3.
 *
 * UTC arithmetic is deliberate: the value is an instant and the caller owns
 * the civil calendar. Adding "one month" to a Tehran midnight and to a UTC
 * midnight must give the same *instant shift* for a quote, or a quote would
 * change length based on the server's zone.
 */
export function addCalendarMonths(fromIso: string, months: number): string {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) throw new Error("invalid_quote_start");
  if (!Number.isInteger(months) || months <= 0) throw new Error("invalid_quote_term");
  const day = from.getUTCDate();
  const target = new Date(from.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return target.toISOString();
}

/** Whole days between two instants, never negative (ceiling, so a partial day counts). */
export function wholeDaysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("invalid_instant");
  if (end <= start) return 0;
  return Math.ceil((end - start) / 86_400_000);
}
