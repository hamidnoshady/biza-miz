/**
 * ESH-193 / #1378 — prepaid service terms (1, 3 and 12 calendar months).
 *
 * A prepaid service term buys *enabled time* for a fixed window. While the
 * window covers an instant:
 *
 *   - hourly (enabled-time) rental for that service is **not** charged again;
 *   - setup stays a separate one-time charge, and actual usage stays metered;
 *   - monthly allowances keep resetting each calendar month — a 12-month term
 *     does not grant a year of monthly allowance up front, because the
 *     allowance is a per-month fact (see `monthlyPeriodsIn`).
 *
 * Terms are only ever sold for an explicitly published offer; this module never
 * invents a price. It is pure so the settlement boundary and the quote can use
 * the same arithmetic.
 */
import { addCalendarMonths, monthWindowAt, periodMonthFor } from "./calendar";

export const SERVICE_TERM_MONTHS = [1, 3, 12] as const;
export type ServiceTermMonths = (typeof SERVICE_TERM_MONTHS)[number];

export function isServiceTermMonths(value: unknown): value is ServiceTermMonths {
  return typeof value === "number" && (SERVICE_TERM_MONTHS as readonly number[]).includes(value);
}

export type ServiceTermStatus = "active" | "expired" | "cancelled";

export interface PrepaidServiceTerm {
  termMonths: ServiceTermMonths;
  periodStart: string;
  periodEnd: string;
  /** The published offer's Rial amount for the whole term. */
  priceRial: number;
  /** The offer's price version, for reconciliation. */
  priceVersion: number | null;
  status: ServiceTermStatus;
}

/** The exact `[start, end)` a term starting at `startIso` buys. */
export function serviceTermPeriod(
  startIso: string,
  termMonths: ServiceTermMonths,
): { start: string; end: string } {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new Error("invalid_instant");
  return {
    start: start.toISOString(),
    end: addCalendarMonths(start.toISOString(), termMonths),
  };
}

/** Does the term's paid window cover this instant? */
export function isTermActiveAt(term: PrepaidServiceTerm, atIso: string): boolean {
  if (term.status !== "active") return false;
  const at = Date.parse(atIso);
  const start = Date.parse(term.periodStart);
  const end = Date.parse(term.periodEnd);
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= at && at < end;
}

/** The term covering an instant, if any. Never invents coverage from a lapsed row. */
export function activeTermAt(
  terms: readonly PrepaidServiceTerm[],
  atIso: string,
): PrepaidServiceTerm | null {
  return terms.find((term) => isTermActiveAt(term, atIso)) ?? null;
}

/**
 * The status a stored term has at an instant. Expiry is derived from the
 * window, so a worker restart or a missed job cannot extend coverage.
 */
export function termStatusAt(term: PrepaidServiceTerm, atIso: string): ServiceTermStatus {
  if (term.status === "cancelled") return "cancelled";
  const at = Date.parse(atIso);
  const end = Date.parse(term.periodEnd);
  if (!Number.isFinite(at) || !Number.isFinite(end)) return term.status;
  if (at >= end) return "expired";
  return term.status === "expired" ? "active" : term.status;
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface SegmentCoverage {
  coveredSeconds: number;
  uncoveredSeconds: number;
  coveredRanges: TimeRange[];
  uncoveredRanges: TimeRange[];
}

/**
 * Split a settlement segment into the seconds a prepaid term covers and the
 * seconds it does not.
 *
 * The result is exact at second granularity and the two totals always add up
 * to the segment, which is what lets the settlement path bill only the
 * uncovered part — the same second is never both covered and rented.
 */
export function splitSegmentByCoverage(
  segment: TimeRange,
  coverage: TimeRange | null,
): SegmentCoverage {
  const start = Date.parse(segment.start);
  const end = Date.parse(segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("invalid_instant");
  const total = Math.max(0, Math.floor((end - start) / 1000));
  if (total === 0) {
    return { coveredSeconds: 0, uncoveredSeconds: 0, coveredRanges: [], uncoveredRanges: [] };
  }
  if (!coverage) {
    return {
      coveredSeconds: 0,
      uncoveredSeconds: total,
      coveredRanges: [],
      uncoveredRanges: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }],
    };
  }
  const cStart = Math.max(start, Date.parse(coverage.start));
  const cEnd = Math.min(end, Date.parse(coverage.end));
  if (!Number.isFinite(cStart) || !Number.isFinite(cEnd) || cEnd <= cStart) {
    return {
      coveredSeconds: 0,
      uncoveredSeconds: total,
      coveredRanges: [],
      uncoveredRanges: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }],
    };
  }

  const coveredRanges: TimeRange[] = [];
  const uncoveredRanges: TimeRange[] = [];
  if (cStart > start) {
    uncoveredRanges.push({ start: new Date(start).toISOString(), end: new Date(cStart).toISOString() });
  }
  coveredRanges.push({ start: new Date(cStart).toISOString(), end: new Date(cEnd).toISOString() });
  if (cEnd < end) {
    uncoveredRanges.push({ start: new Date(cEnd).toISOString(), end: new Date(end).toISOString() });
  }
  const coveredSeconds = Math.floor((cEnd - cStart) / 1000);
  return {
    coveredSeconds,
    uncoveredSeconds: total - coveredSeconds,
    coveredRanges,
    uncoveredRanges,
  };
}

export interface MonthlyAllowancePeriod {
  /** 'YYYY-MM' in the billing calendar. */
  periodMonth: string;
  /** Clipped to the term: the first month may start mid-month. */
  start: string;
  end: string;
}

/**
 * The calendar months a prepaid window passes through, clipped to the window.
 *
 * A 12-month term that starts on 15 Farvardin yields twelve entries; each entry
 * is a *separate* allowance period, which is what "monthly allowance resets
 * during a prepaid term" means in practice. Nothing here grants an annual
 * allowance.
 */
export function monthlyPeriodsIn(startIso: string, endIso: string): MonthlyAllowancePeriod[] {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const periods: MonthlyAllowancePeriod[] = [];
  let cursor = new Date(start);
  let guard = 0;
  while (cursor.getTime() < end && guard < 240) {
    guard += 1;
    const window = monthWindowAt(cursor.toISOString());
    const periodStart = Math.max(start, window.startUtc.getTime());
    const periodEnd = Math.min(end, window.nextStartUtc.getTime());
    if (periodEnd > periodStart) {
      periods.push({
        periodMonth: periodMonthFor(cursor),
        start: new Date(periodStart).toISOString(),
        end: new Date(periodEnd).toISOString(),
      });
    }
    cursor = new Date(window.nextStartUtc.getTime());
  }
  return periods;
}

/**
 * Does an existing term overlap a candidate window? Two overlapping paid terms
 * for one service would be a double charge, so a purchase must refuse rather
 * than let them sit side by side.
 */
export function termsOverlap(a: TimeRange, b: TimeRange): boolean {
  const aStart = Date.parse(a.start);
  const aEnd = Date.parse(a.end);
  const bStart = Date.parse(b.start);
  const bEnd = Date.parse(b.end);
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * When a coverage window ends, the applicable policy is the ordinary published
 * rental again. This returns the transition instant so a caller can quote the
 * next period from the end of coverage rather than from "now" (which would
 * double-charge the covered remainder).
 */
export function nextRentalStart(coverage: TimeRange | null, atIso: string): string {
  if (!coverage) return atIso;
  const at = Date.parse(atIso);
  const end = Date.parse(coverage.end);
  if (!Number.isFinite(at) || !Number.isFinite(end)) return atIso;
  return end > at ? new Date(end).toISOString() : atIso;
}
