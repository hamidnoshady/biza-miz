/**
 * Issue #902 §9 item 2 (second half) — delivery over months, not over a week.
 *
 * §6e answered "is *this* campaign arriving, and at which end is it slow" over a
 * seven-day window. That window cannot answer the question an operator asks
 * after a bad month — *was last month worse, and did it get worse gradually or
 * fall off a cliff?* — and the answer is a series, not a row.
 *
 * The data was always there: `message_outbox` keeps every row (nothing prunes
 * it), and `0134`/`0268` already carry the enqueue, acceptance and provider
 * latencies. So this is a query and a shape, not new columns.
 *
 * Four rules, each of which is a way a trend chart lies:
 *
 *   1. **A gap is not a zero.** A bucket with no rows is `hasData: false`, not
 *      eight zeros. Zero says "nothing was delivered"; no data says "nothing was
 *      attempted", and on a chart the second must be a hole — otherwise a quiet
 *      week reads as a collapse, and an operator chases a crisis that did not
 *      happen.
 *   2. **The rate needs a denominator.** `failureRate` is `null` when nothing was
 *      decided, never `0`. A week of no attempts has no failure rate; printing
 *      ۰٪ would be a claim, and a flattering one.
 *   3. **Buckets are Tehran days.** Grouping `created_at` in UTC would split a
 *      business's evening across two days and shift every count for anyone
 *      reading it in Tehran. The SQL groups on the same calendar this module
 *      builds, so the keys match exactly.
 *   4. **Granularity follows the window.** 90 daily points is a readable chart;
 *      365 is not, so long windows roll up to weeks and then months. The caller
 *      may pin one, but the default is a function of the span rather than a
 *      constant that is wrong at one end.
 *
 * Pure: no database import, so the console card (a client component) can format
 * a series without pulling a pool into the browser build.
 */
import { formatJalali, JALALI_MONTHS, toJalali } from "./jalali";
import { toPersianDigits } from "./digits";
import { deliveryHealth, type DeliveryHealth } from "./delivery-health";
import { latencyStats, type LatencyStats } from "./latency-stats";

export type TrendGranularity = "day" | "week" | "month";

/** The calendar every bucket boundary is cut on — the one the business lives in. */
export const TREND_TIME_ZONE = "Asia/Tehran";
export const TREND_DEFAULT_DAYS = 90;
export const TREND_MAX_DAYS = 365;

/** Day for a month or so, week for a quarter, month beyond that. */
export function trendGranularity(days: number): TrendGranularity {
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The Tehran calendar date of an instant, as `YYYY-MM-DD`. */
export function trendDayKey(date: Date, timeZone: string = TREND_TIME_ZONE): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return isoDay(year, month, day);
}

/** The Monday of the ISO week containing a `YYYY-MM-DD` key. */
export function trendWeekKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const at = new Date(Date.UTC(year!, month! - 1, day!));
  // getUTCDay(): 0 = Sunday. An ISO week starts on Monday, so Sunday belongs to
  // the week that began six days earlier.
  const offset = (at.getUTCDay() + 6) % 7;
  at.setUTCDate(at.getUTCDate() - offset);
  return isoDay(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/** The bucket a `YYYY-MM-DD` day key falls in, for a granularity. */
export function trendBucketKey(dayKey: string, granularity: TrendGranularity): string {
  if (granularity === "day") return dayKey;
  if (granularity === "week") return trendWeekKey(dayKey);
  return dayKey.slice(0, 7);
}

export interface TrendBucket {
  /** The key the SQL groups by, and the key a row carries. */
  key: string;
  /** The first instant of the bucket, for a label and for sorting. */
  startIso: string;
  granularity: TrendGranularity;
}

function bucketStartIso(key: string, granularity: TrendGranularity, timeZone: string): string {
  // Midnight Tehran on the bucket's first day. Rather than implement the zone's
  // offset rules a second time, the offset is *measured* from the formatter: take
  // the instant the calendar date and clock read out as UTC, and the difference
  // is the offset at that instant (`tehranMonthWindow` uses the same two-pass
  // trick). Two passes because the offset at the guess can differ from the offset
  // at the answer across a DST-less Tehran year — cheap insurance, since Iran has
  // changed its rules before.
  const [year, month, day] = (granularity === "month" ? `${key}-01` : key).split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  const offsetAt = (utcMs: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const asIfUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return asIfUtc - utcMs;
  };
  const first = target - offsetAt(target);
  const refined = target - offsetAt(first);
  return new Date(refined).toISOString();
}

/**
 * Every bucket the window touches, oldest first — including the empty ones.
 *
 * The window is `days` calendar days back from `now` *inclusive of today*, which
 * is what a reader means by "the last 90 days": today plus the 89 before it.
 */
export function buildTrendBuckets(input: {
  days: number;
  now?: Date;
  granularity?: TrendGranularity;
  timeZone?: string;
}): TrendBucket[] {
  const timeZone = input.timeZone ?? TREND_TIME_ZONE;
  const days = Math.min(Math.max(1, Math.trunc(input.days)), TREND_MAX_DAYS);
  const granularity = input.granularity ?? trendGranularity(days);
  const now = input.now ?? new Date();

  const keys: string[] = [];
  const seen = new Set<string>();
  for (let back = days - 1; back >= 0; back -= 1) {
    const key = trendBucketKey(trendDayKey(new Date(now.getTime() - back * 86_400_000), timeZone), granularity);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys.map((key) => ({ key, startIso: bucketStartIso(key, granularity, timeZone), granularity }));
}

/** One bucket as the SQL returns it: counts plus the raw latency samples. */
export interface TrendBucketRow {
  bucket: string;
  sent: number | string;
  delivered: number | string;
  failed: number | string;
  pending: number | string;
  queue_ms?: (number | string | null)[] | null;
  send_ms?: (number | string | null)[] | null;
}

export interface DeliveryTrendPoint {
  key: string;
  startIso: string;
  /** Short Persian label: «۱۲ مهر», «هفتهٔ ۱۲ مهر», «مهر ۱۴۰۵». */
  label: string;
  /** False when nothing was attempted in the bucket — draw a gap, not a zero. */
  hasData: boolean;
  sent: number;
  delivered: number;
  failed: number;
  /** Attempts that reached an outcome. The denominator of `failureRate`. */
  decided: number;
  pending: number;
  /** `null` when nothing was decided — never `0`. */
  failureRate: number | null;
  health: DeliveryHealth;
  queueLatency: LatencyStats | null;
  sendLatency: LatencyStats | null;
}

function numericArray(values: readonly (string | number | null)[] | null | undefined) {
  return (values ?? []).map((value) => {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  });
}

/** The label a reader sees. Persian digits and the Jalali calendar, always. */
export function trendLabel(startIso: string, granularity: TrendGranularity): string {
  const date = new Date(startIso);
  if (granularity === "week") return `هفتهٔ ${formatJalali(date, { withMonthName: true })}`;
  if (granularity === "day") return formatJalali(date, { withMonthName: true });
  // A month bucket labels itself by month and year only: naming a day would be a
  // statement about the bucket that its contents do not support.
  const { year, month } = zonedParts(date, TREND_TIME_ZONE);
  const { jy, jm } = toJalali(year, month, 1);
  return `${JALALI_MONTHS[jm - 1]} ${toPersianDigits(jy)}`;
}

/**
 * Merge the buckets the window asks for with the rows the database returned.
 *
 * A row whose bucket is not in the window is dropped rather than appended: the
 * window is the reader's question, and a stray bucket from a clock skew would
 * make the chart claim a period it was never asked about.
 */
export function summarizeTrend(
  buckets: readonly TrendBucket[],
  rows: readonly TrendBucketRow[],
): DeliveryTrendPoint[] {
  const byKey = new Map(rows.map((row) => [row.bucket, row]));
  return buckets.map((bucket) => {
    const row = byKey.get(bucket.key);
    const sent = Number(row?.sent ?? 0) || 0;
    const delivered = Number(row?.delivered ?? 0) || 0;
    const failed = Number(row?.failed ?? 0) || 0;
    const pending = Number(row?.pending ?? 0) || 0;
    const decided = sent + delivered + failed;
    const hasData = Boolean(row) && (decided > 0 || pending > 0);
    return {
      key: bucket.key,
      startIso: bucket.startIso,
      label: trendLabel(bucket.startIso, bucket.granularity),
      hasData,
      sent,
      delivered,
      failed,
      decided,
      pending,
      failureRate: decided > 0 ? failed / decided : null,
      health: hasData ? deliveryHealth({ sent, delivered, failed, pending }) : "idle",
      queueLatency: latencyStats(numericArray(row?.queue_ms)),
      sendLatency: latencyStats(numericArray(row?.send_ms)),
    };
  });
}

export interface DeliveryTrendSummary {
  /** Points with data, oldest first. */
  points: DeliveryTrendPoint[];
  /** Buckets touched, including empty ones. */
  buckets: number;
  /** Buckets with at least one attempt or in-flight row. */
  activeBuckets: number;
  sent: number;
  delivered: number;
  failed: number;
  /** Whole-window failure rate, `null` when nothing was decided. */
  failureRate: number | null;
  /** p50/p95 across the whole window, not an average of the buckets' medians. */
  queueLatency: LatencyStats | null;
  sendLatency: LatencyStats | null;
  /** The bucket verdicts with data, most recent first — what changed lately. */
  recentHealth: DeliveryHealth[];
  /** Worst verdict in the window, for a badge: attention > degraded > idle > healthy. */
  worstHealth: DeliveryHealth;
}

const HEALTH_RANK: Record<DeliveryHealth, number> = {
  attention: 3,
  degraded: 2,
  idle: 1,
  healthy: 0,
};

/**
 * The window in one line, for a header or a badge.
 *
 * Latencies are pooled across the window rather than averaged per bucket: an
 * average of medians is not a median, and it weights a two-message week the same
 * as a two-thousand-message one.
 */
export function summarizeTrendWindow(
  points: readonly DeliveryTrendPoint[],
  rows: readonly TrendBucketRow[] = [],
): DeliveryTrendSummary {
  const sent = points.reduce((sum, point) => sum + point.sent, 0);
  const delivered = points.reduce((sum, point) => sum + point.delivered, 0);
  const failed = points.reduce((sum, point) => sum + point.failed, 0);
  const decided = sent + delivered + failed;
  const active = points.filter((point) => point.hasData);
  const worstHealth =
    active.length === 0
      ? "idle"
      : active.reduce<DeliveryHealth>(
          (worst, point) => (HEALTH_RANK[point.health] > HEALTH_RANK[worst] ? point.health : worst),
          "healthy",
        );
  return {
    points: [...points],
    buckets: points.length,
    activeBuckets: active.length,
    sent,
    delivered,
    failed,
    failureRate: decided > 0 ? failed / decided : null,
    queueLatency: latencyStats(rows.flatMap((row) => numericArray(row.queue_ms))),
    sendLatency: latencyStats(rows.flatMap((row) => numericArray(row.send_ms))),
    recentHealth: [...active].reverse().slice(0, 3).map((point) => point.health),
    worstHealth,
  };
}

export const TREND_HEALTH_LABELS: Record<DeliveryHealth, string> = {
  healthy: "سالم",
  degraded: "کاهش کیفیت",
  attention: "نیازمند بررسی",
  idle: "بدون داده",
};

/**
 * A bucket's bar height, 0–100, against the busiest bucket.
 *
 * Relative to the window's own maximum on purpose: absolute counts would make a
 * small business's chart an empty row, and the question here is the shape of the
 * series, not its size. An empty bucket is `null` — the caller draws a gap.
 */
export function trendBarPercent(count: number, max: number): number | null {
  if (max <= 0) return null;
  if (count <= 0) return 0;
  return Math.max(2, Math.round((count / max) * 100));
}
