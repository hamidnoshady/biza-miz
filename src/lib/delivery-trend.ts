/**
 * Issue #902 §9 item 2 — the long-range delivery trend, read from the outbox.
 *
 * `delivery-trend-facts.ts` owns the shape (buckets, gaps, rates); this file owns
 * the one query behind it, twice: once across every tenant for the Superadmin
 * console, once scoped to a business for its own Growth screen.
 *
 * Two details are load-bearing:
 *
 *   1. **The bucket key is computed in SQL on the Tehran calendar**, with the
 *      same granularity the caller asked for, so the keys line up with the ones
 *      `buildTrendBuckets` produced. Grouping on `created_at` (UTC) would move
 *      each evening's messages into the next day and quietly disagree with every
 *      other figure in the product.
 *   2. **No provider data crosses the tenant boundary.** The query selects
 *      counts and latencies only: no provider message id, no error string, no
 *      wholesale cost. The platform view differs from the tenant view by the
 *      business columns, nothing else.
 *
 * The outbox is never pruned, so a year-long window is a query rather than a new
 * table. The two latency columns come from `0134` (`sent_at - created_at`) and
 * `0268` (`send_latency_ms`).
 */
import { query, withTenant, withoutTenantScope } from "./db";
import {
  buildTrendBuckets,
  summarizeTrend,
  summarizeTrendWindow,
  TREND_DEFAULT_DAYS,
  TREND_MAX_DAYS,
  type DeliveryTrendPoint,
  type DeliveryTrendSummary,
  type TrendBucketRow,
  type TrendGranularity,
} from "./delivery-trend-facts";

export type { DeliveryTrendPoint, DeliveryTrendSummary };

export interface DeliveryTrend extends DeliveryTrendSummary {
  granularity: TrendGranularity;
  /** The window asked for, in days (clamped). */
  days: number;
  /** Businesses represented in the window (platform view only). */
  businesses?: number;
}

function clampDays(days: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(days ?? TREND_DEFAULT_DAYS)), TREND_MAX_DAYS);
}

/**
 * The grouping expression, per granularity.
 *
 * `date_trunc` on a `timestamp without time zone` is exactly "the local calendar
 * the value was rendered in", which is why the zone is applied first: the
 * truncation then happens on Tehran weeks (Monday-start, per ISO) and Tehran
 * months.
 */
function bucketExpression(granularity: TrendGranularity): string {
  if (granularity === "week") {
    return `to_char(date_trunc('week', o.created_at AT TIME ZONE 'Asia/Tehran'), 'YYYY-MM-DD')`;
  }
  if (granularity === "month") {
    return `to_char(o.created_at AT TIME ZONE 'Asia/Tehran', 'YYYY-MM')`;
  }
  return `to_char(o.created_at AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD')`;
}

const AGGREGATES = `
       count(*) FILTER (WHERE o.status = 'sent')      AS sent,
       count(*) FILTER (WHERE o.status = 'delivered') AS delivered,
       count(*) FILTER (WHERE o.status = 'failed')    AS failed,
       count(*) FILTER (WHERE o.status IN ('queued', 'sending')) AS pending,
       array_agg(EXTRACT(EPOCH FROM (o.sent_at - o.created_at)) * 1000)
         FILTER (WHERE o.sent_at IS NOT NULL)        AS queue_ms,
       array_agg(o.send_latency_ms)
         FILTER (WHERE o.send_latency_ms IS NOT NULL) AS send_ms`;

function shape(
  days: number,
  granularity: TrendGranularity,
  buckets: ReturnType<typeof buildTrendBuckets>,
  rows: TrendBucketRow[],
  businesses?: number,
): DeliveryTrend {
  const points: DeliveryTrendPoint[] = summarizeTrend(buckets, rows);
  return {
    ...summarizeTrendWindow(points, rows),
    granularity,
    days,
    ...(businesses === undefined ? {} : { businesses }),
  };
}

/**
 * Every tenant's delivery, bucketed — the Superadmin view.
 *
 * Platform-only: it spans businesses, so it runs under the documented bypass and
 * is served from the Superadmin route.
 */
export async function getDeliveryTrend(input: {
  days?: number;
  granularity?: TrendGranularity;
  now?: Date;
} = {}): Promise<DeliveryTrend> {
  const days = clampDays(input.days);
  const buckets = buildTrendBuckets({
    days,
    granularity: input.granularity,
    now: input.now ?? new Date(),
  });
  const granularity = buckets[0]?.granularity ?? "day";
  // The window's lower bound is anchored to the same instant the bucket grid
  // was built from, not to the database clock. `now()` here disagreed with
  // `buildTrendBuckets(now)`: a caller passing a fixed `now` (a test, a
  // backfill report, a "as of" view) got buckets for its window and rows for
  // a different one, so the oldest row fell out and the pooled latencies
  // disagreed with the points above them.
  const anchorIso = (input.now ?? new Date()).toISOString();

  return withoutTenantScope("platform", async () => {
    const { rows: bucketsWithBusinesses } = await query<TrendBucketRow & Record<string, unknown>>(
      `SELECT ${bucketExpression(granularity)} AS bucket,
              count(DISTINCT o.business_id) AS businesses,
              ${AGGREGATES}
         FROM message_outbox o
        WHERE o.created_at >= $2::timestamptz - ($1::int * interval '1 day')
        GROUP BY bucket
        ORDER BY bucket`,
      [days, anchorIso],
    );
    const rows = bucketsWithBusinesses as (TrendBucketRow & { businesses?: string | number })[];
    // The distinct count is per bucket; the window's is the largest, which is
    // "how many businesses were active in the busiest bucket" rather than a sum
    // that would count one business many times.
    const businesses = rows.reduce((max, row) => Math.max(max, Number(row.businesses) || 0), 0);
    return shape(days, granularity, buckets, rows, businesses);
  });
}

/**
 * One business's own delivery, bucketed — what a tenant may see.
 *
 * Scoped twice, like every tenant report: the caller names the business *and* the
 * query runs inside `withTenant`, so a lost session scope returns an empty series
 * instead of someone else's traffic.
 */
export async function tenantDeliveryTrend(
  businessId: string,
  input: { days?: number; granularity?: TrendGranularity; now?: Date } = {},
): Promise<DeliveryTrend> {
  const days = clampDays(input.days);
  const buckets = buildTrendBuckets({
    days,
    granularity: input.granularity,
    now: input.now ?? new Date(),
  });
  const granularity = buckets[0]?.granularity ?? "day";
  // Same anchor as the platform view, for the same reason: the row set must be
  // the window the buckets describe.
  const anchorIso = (input.now ?? new Date()).toISOString();

  return withTenant(businessId, async () => {
    const { rows: bucketRows } = await query<TrendBucketRow & Record<string, unknown>>(
      `SELECT ${bucketExpression(granularity)} AS bucket,
              ${AGGREGATES}
         FROM message_outbox o
        WHERE o.business_id = $1
          AND o.created_at >= $3::timestamptz - ($2::int * interval '1 day')
        GROUP BY bucket
        ORDER BY bucket`,
      [businessId, days, anchorIso],
    );
    return shape(days, granularity, buckets, bucketRows as TrendBucketRow[]);
  });
}
