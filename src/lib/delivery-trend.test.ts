/**
 * Issue #902 §9 item 2 — the long-range delivery trend.
 *
 * These are the four ways a trend chart lies, each pinned:
 *
 *   - a quiet bucket drawn as a zero instead of a gap;
 *   - a failure *rate* printed where there were no attempts to divide by;
 *   - day boundaries cut in UTC, which moves a Tehran evening into tomorrow;
 *   - a window's latency averaged from per-bucket medians, which weights a
 *     two-message week like a two-thousand-message one.
 *
 * Plus the source guards: the tenant query is scoped twice and selects nothing a
 * tenant may not see, and the Superadmin card uses the shared health rule rather
 * than its own copy of it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTrendBuckets,
  summarizeTrend,
  summarizeTrendWindow,
  trendBarPercent,
  trendBucketKey,
  trendDayKey,
  trendGranularity,
  trendLabel,
  trendWeekKey,
  TREND_DEFAULT_DAYS,
  TREND_MAX_DAYS,
  type TrendBucketRow,
} from "./delivery-trend-facts";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

function row(overrides: Partial<TrendBucketRow> = {}): TrendBucketRow {
  return {
    bucket: "2026-10-30",
    sent: 10,
    delivered: 40,
    failed: 0,
    pending: 0,
    queue_ms: [],
    send_ms: [],
    ...overrides,
  };
}

describe("the window decides its own granularity", () => {
  it("uses days for a month, weeks for a quarter, months for a year", () => {
    expect(trendGranularity(7)).toBe("day");
    expect(trendGranularity(31)).toBe("day");
    expect(trendGranularity(32)).toBe("week");
    expect(trendGranularity(90)).toBe("week");
    expect(trendGranularity(121)).toBe("month");
    expect(trendGranularity(TREND_MAX_DAYS)).toBe("month");
  });

  it("builds one contiguous bucket per step, ending today", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const buckets = buildTrendBuckets({ days: 7, now });
    expect(buckets).toHaveLength(7);
    expect(buckets.at(-1)!.key).toBe("2026-10-30");
    expect(buckets[0]!.key).toBe("2026-10-24");
    // Every bucket starts at Tehran midnight, which is 20:30 UTC the day before
    // while Iran is on +03:30.
    expect(buckets[0]!.startIso).toBe("2026-10-23T20:30:00.000Z");
  });

  it("rolls a quarter into whole weeks and a year into whole months", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const weekly = buildTrendBuckets({ days: 90, now });
    expect(weekly[0]!.granularity).toBe("week");
    // Monday starts, and every key is a Monday.
    for (const bucket of weekly) {
      expect(new Date(`${bucket.key}T00:00:00.000Z`).getUTCDay()).toBe(1);
    }
    const monthly = buildTrendBuckets({ days: 365, now });
    expect(monthly[0]!.granularity).toBe("month");
    expect(monthly.every((bucket) => /^\d{4}-\d{2}$/.test(bucket.key))).toBe(true);
    expect(monthly).toHaveLength(13);
  });

  it("cuts the day on the Tehran calendar, not UTC", () => {
    // 21:00 UTC on the 30th is 00:30 on the 31st in Tehran. A report that buckets
    // in UTC would file every Iranian evening under the previous day.
    expect(trendDayKey(new Date("2026-10-30T21:00:00.000Z"))).toBe("2026-10-31");
    expect(trendDayKey(new Date("2026-10-30T19:00:00.000Z"))).toBe("2026-10-30");
  });

  it("starts the week on Monday, so a Sunday belongs to the week before", () => {
    // 2026-10-25 is a Sunday; 2026-10-26 a Monday.
    expect(trendWeekKey("2026-10-25")).toBe("2026-10-19");
    expect(trendWeekKey("2026-10-26")).toBe("2026-10-26");
    expect(trendBucketKey("2026-10-26", "week")).toBe("2026-10-26");
    expect(trendBucketKey("2026-10-26", "month")).toBe("2026-10");
  });

  it("labels buckets in Persian, with a month name and no day for a month bucket", () => {
    const daily = buildTrendBuckets({ days: 3, now: new Date("2026-10-30T12:00:00.000Z") });
    expect(daily.at(-1)!.key).toBe("2026-10-30");
    expect(trendLabel(daily.at(-1)!.startIso, "day")).toMatch(/[۰-۹]+ .+ [۰-۹]+/);
    expect(trendLabel(daily.at(-1)!.startIso, "week")).toMatch(/^هفتهٔ /);
    // A month label is exactly "month year" — no day number anywhere in it.
    expect(trendLabel(daily.at(-1)!.startIso, "month").split(" ")).toHaveLength(2);
    expect(trendLabel(daily.at(-1)!.startIso, "month")).toMatch(/^\S+ [۰-۹]{4}$/);
  });
});

describe("a gap is not a zero", () => {
  it("marks a bucket with no rows as no-data, and gives it no failure rate", () => {
    const buckets = buildTrendBuckets({ days: 2, now: new Date("2026-10-30T12:00:00.000Z") });
    const points = summarizeTrend(buckets, [row({ bucket: "2026-10-30", sent: 5, delivered: 5 })]);

    const quiet = points[0]!;
    expect(quiet.hasData).toBe(false);
    expect(quiet.sent).toBe(0);
    expect(quiet.decided).toBe(0);
    // Not 0%: nothing was attempted, so there is no rate to quote.
    expect(quiet.failureRate).toBeNull();
    expect(quiet.health).toBe("idle");
    expect(quiet.queueLatency).toBeNull();

    expect(points[1]!.hasData).toBe(true);
    expect(points[1]!.failureRate).toBe(0);
  });

  it("treats in-flight rows as data, with no rate and a degraded verdict", () => {
    const buckets = buildTrendBuckets({ days: 1, now: new Date("2026-10-30T12:00:00.000Z") });
    const [point] = summarizeTrend(buckets, [row({ bucket: "2026-10-30", sent: 0, delivered: 0, failed: 0, pending: 4 })]);
    expect(point!.hasData).toBe(true);
    expect(point!.decided).toBe(0);
    expect(point!.failureRate).toBeNull();
    expect(point!.health).toBe("degraded");
  });

  it("computes the failure rate over decided attempts only", () => {
    const buckets = buildTrendBuckets({ days: 1, now: new Date("2026-10-30T12:00:00.000Z") });
    const [point] = summarizeTrend(buckets, [row({ sent: 18, delivered: 0, failed: 2, pending: 30 })]);
    // Pending rows are not failures until they fail.
    expect(point!.failureRate).toBeCloseTo(0.1, 10);
    expect(point!.health).toBe("attention");
  });

  it("ignores a bucket outside the window instead of growing the series", () => {
    const buckets = buildTrendBuckets({ days: 2, now: new Date("2026-10-30T12:00:00.000Z") });
    const points = summarizeTrend(buckets, [row({ bucket: "2026-01-01", sent: 999 })]);
    expect(points).toHaveLength(2);
    expect(points.every((point) => point.sent === 0)).toBe(true);
  });
});

describe("the window summary does not average medians", () => {
  const buckets = buildTrendBuckets({ days: 2, now: new Date("2026-10-30T12:00:00.000Z") });
  const rows: TrendBucketRow[] = [
    // Two quick sends.
    row({ bucket: "2026-10-29", sent: 2, delivered: 0, queue_ms: [100, 120], send_ms: [200, 220] }),
    // Two thousand slow ones.
    row({
      bucket: "2026-10-30",
      sent: 2_000,
      delivered: 0,
      queue_ms: Array.from({ length: 2_000 }, () => 9_000),
      send_ms: Array.from({ length: 2_000 }, () => 5_000),
    }),
  ];

  it("pools every sample in the window", () => {
    const points = summarizeTrend(buckets, rows);
    const summary = summarizeTrendWindow(points, rows);
    // A per-bucket median averaged across buckets would be ~4 550 ms; pooled the
    // median is 9 000, because the busy bucket is 1 000× larger.
    expect(summary.queueLatency!.count).toBe(2_002);
    expect(summary.queueLatency!.p50).toBe(9_000);
    expect(summary.sendLatency!.p50).toBe(5_000);
  });

  it("reports the worst verdict, and the recent ones newest first", () => {
    const points = summarizeTrend(buckets, [
      row({ bucket: "2026-10-29", sent: 10, delivered: 10, failed: 0 }),
      row({ bucket: "2026-10-30", sent: 5, delivered: 0, failed: 5 }),
    ]);
    const summary = summarizeTrendWindow(points);
    expect(summary.worstHealth).toBe("attention");
    expect(summary.recentHealth[0]).toBe("attention");
    expect(summary.recentHealth[1]).toBe("healthy");
    expect(summary.failureRate).toBeCloseTo(5 / 30, 10);
    expect(summary.activeBuckets).toBe(2);
    expect(summary.buckets).toBe(2);
  });

  it("says idle — not healthy — for a window with no attempts at all", () => {
    const summary = summarizeTrendWindow(summarizeTrend(buckets, []));
    expect(summary.worstHealth).toBe("idle");
    expect(summary.failureRate).toBeNull();
    expect(summary.recentHealth).toEqual([]);
    expect(summary.activeBuckets).toBe(0);
  });
});

describe("a bar is a shape, not a scale", () => {
  it("scales to the busiest bucket and keeps the quietest visible", () => {
    expect(trendBarPercent(100, 100)).toBe(100);
    expect(trendBarPercent(50, 100)).toBe(50);
    // One message against a thousand is still drawn: a bar of height 1 px is a
    // fact, a bar of height 0 is a lie.
    expect(trendBarPercent(1, 1_000)).toBe(2);
    expect(trendBarPercent(0, 1_000)).toBe(0);
    expect(trendBarPercent(5, 0)).toBeNull();
  });
});

describe("the queries and the screens agree with these facts", () => {
  it("groups on the Tehran calendar in SQL, at every granularity", () => {
    const service = read("src/lib/delivery-trend.ts");
    expect(service).toMatch(/AT TIME ZONE 'Asia\/Tehran'/);
    expect(service).toMatch(/date_trunc\('week', o\.created_at AT TIME ZONE 'Asia\/Tehran'\)/);
    expect(service).toMatch(/to_char\(o\.created_at AT TIME ZONE 'Asia\/Tehran', 'YYYY-MM'\)/);
  });

  it("scopes the tenant series twice and names no provider field", () => {
    const service = read("src/lib/delivery-trend.ts");
    // The caller names the business AND the query runs in its scope.
    expect(service).toMatch(/withTenant\(businessId, async \(\) => \{/);
    expect(service).toMatch(/WHERE o\.business_id = \$1/);
    // The platform read is the documented bypass, and the only difference.
    expect(service).toMatch(/withoutTenantScope\("platform"/);
    // Nothing a tenant may not see is selected: no provider id, error or cost.
    expect(service).not.toMatch(/provider_message_id|o\.error|provider_cost_rial/);
  });

  // The row set and the bucket grid must describe the same window. Bounding the
  // query on the database clock while `buildTrendBuckets` was given a `now`
  // meant a caller with a fixed anchor (a test, an "as of" view, a backfill
  // report) got buckets for one window and rows for another — the oldest row
  // fell out and the pooled latencies disagreed with the points above them.
  it("anchors the window to the caller's `now`, not the database clock", () => {
    const service = read("src/lib/delivery-trend.ts");
    // Both views, and no bare now() left in either WHERE clause.
    expect(service.match(/o\.created_at >= \$\d::timestamptz/g)).toHaveLength(2);
    expect(service).not.toMatch(/created_at >= now\(\)/);
    expect(service.match(/const anchorIso = \(input\.now \?\? new Date\(\)\)\.toISOString\(\);/g)).toHaveLength(2);
  });

  it("clamps the window to a year, so a caller cannot ask for all time", () => {
    const service = read("src/lib/delivery-trend.ts");
    expect(service).toMatch(/TREND_MAX_DAYS/);
    expect(TREND_DEFAULT_DAYS).toBe(90);
  });

  it("renders both screens from server-computed points, with the shared health rule", () => {
    const card = read("src/app/platform/messaging/managed-accounts-card.tsx");
    // The card used to keep its own copy of the thresholds; the copy is gone.
    expect(card).not.toMatch(/Mirrors `deliveryHealth`/);
    expect(card).toMatch(/from "@\/lib\/delivery-health"/);
    expect(card).toMatch(/deliveryTrend/);
    // And it hard-codes no sample series of its own.
    expect(card).toMatch(/snapshot\.deliveryTrend/);

    const tenant = read("src/app/(app)/growth/messaging-section.tsx");
    expect(tenant).toMatch(/deliveryTrend/);
    expect(tenant).toMatch(/data\.deliveryTrend/);
  });
});
