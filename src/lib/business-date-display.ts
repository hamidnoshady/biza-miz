/**
 * How the warehouse register (and every other branch-scoped screen) puts a
 * date and a timestamp on screen without being wrong at the edges.
 *
 * Two different things get called "the date" and they must not be formatted
 * the same way:
 *
 *   * **A business date** (`business_date`, `YYYY-MM-DD`) is a *calendar day*,
 *     not an instant. Parsing it as a `Date` puts it at UTC midnight, and
 *     formatting that in a zone behind UTC (America/*, Atlantic/*) renders the
 *     **previous day** — a receipt posted on the 30th prints as the 29th. The
 *     only correct zone for a date-only value is UTC, and that is what
 *     `formatBusinessDate` pins.
 *   * **A timestamp** (`created_at`, `posted_at`) *is* an instant, and belongs
 *     to a branch. The register already shows instant → business-day
 *     conversion in the branch's zone on the server (`app_business_date`), so
 *     the clock beside it must use the same zone: a Dubai branch's receipt at
 *     09:00 is not Tehran's 08:30. `formatBranchTimestamp` takes the zone the
 *     API returns with each row (`location_timezone`).
 *
 * Both fall back to a visible «—» rather than rendering `Invalid Date` or an
 * empty cell, because a missing value is information ("legacy row") and an
 * empty cell reads as a layout bug.
 */
import { formatJalali } from "./jalali";

/** The platform's fallback zone, used when a row carries no location zone. */
export const DEFAULT_DISPLAY_TIME_ZONE = "Asia/Tehran";

/**
 * A calendar business date (`YYYY-MM-DD`) → Jalali, pinned to UTC so the day
 * can never shift backwards in a negative-offset zone.
 */
export function formatBusinessDate(
  businessDate: string | null | undefined,
  opts: { withMonthName?: boolean } = {},
): string {
  if (!businessDate) return "—";
  const dateOnly = businessDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return "—";
  return formatJalali(dateOnly, { timeZone: "UTC", withMonthName: opts.withMonthName === true });
}

/**
 * An instant (ISO timestamp) → Jalali in the *branch's* zone, optionally with
 * the branch-local clock time.
 */
export function formatBranchTimestamp(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  opts: { withTime?: boolean; withMonthName?: boolean } = {},
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatJalali(date, {
    timeZone: timeZone || DEFAULT_DISPLAY_TIME_ZONE,
    withTime: opts.withTime === true,
    withMonthName: opts.withMonthName === true,
  });
}

/**
 * The register's date cell: the stored business date when there is one, and
 * the posting instant rendered in the branch's zone when a legacy row has
 * none. The server already computes the branch day for `business_date`
 * (`app_business_date`), so this only chooses between two correct answers.
 */
export function formatDocumentDate(
  businessDate: string | null | undefined,
  createdAt: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  if (businessDate) return formatBusinessDate(businessDate);
  return formatBranchTimestamp(createdAt, timeZone);
}

/** The zone label shown next to a branch clock («به وقت Asia/Dubai»). */
export function timeZoneLabel(timeZone: string | null | undefined): string | null {
  const zone = timeZone || DEFAULT_DISPLAY_TIME_ZONE;
  return zone === DEFAULT_DISPLAY_TIME_ZONE ? null : zone;
}
