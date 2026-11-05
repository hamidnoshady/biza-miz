/**
 * Issue #902 §9 item 2 — the long-range delivery trend, against a real database.
 *
 * The pure suite proves the shape: gaps, rates, percentiles. What only Postgres
 * can prove is that the *grouping* matches the shape — the bucket key is
 * computed in SQL on the Tehran calendar, and if that ever drifts from
 * `buildTrendBuckets` the series silently loses rows (a bucket with a key nobody
 * asked for) or invents them.
 *
 * So this file asserts:
 *
 *   1. A send at 21:00 UTC on one day is counted in the *next* Tehran day, and a
 *      send an hour earlier is counted in today's — the off-by-one that would
 *      move every Iranian evening into tomorrow.
 *   2. A bucket with no sends is present and empty, not absent.
 *   3. The tenant series is one business's own traffic, and a business asking for
 *      its own trend never sees another's.
 *   4. Percentiles are pooled across the window, over the outbox's own timestamps
 *      (`0134` queue, `0268` provider) — no new columns, no new table.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let trend: typeof import("../src/lib/delivery-trend");

const alpha = { businessId: "" };
const beta = { businessId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(name: string): Promise<{ businessId: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id };
}

/**
 * One sent row, with the two clocks the report reads. `createdAt` is when it was
 * queued; `sentAt` when the provider accepted it.
 */
async function sendRow(input: {
  businessId: string;
  createdAt: string;
  sentAt: string | null;
  status?: "sent" | "delivered" | "failed" | "queued";
  sendLatencyMs?: number | null;
}): Promise<void> {
  const { rows: campaignRows } = await db.query<{ id: string }>(
    `INSERT INTO message_campaigns (business_id, channel, name, status)
     VALUES ($1, 'sms', 'Campaign', 'sending') RETURNING id`,
    [input.businessId],
  );
  const campaignId = campaignRows[0]!.id;
  const { rows: recipientRows } = await db.query<{ id: string }>(
    `INSERT INTO message_recipients (business_id, campaign_id, channel, address, body)
     VALUES ($1, $2, 'sms', $3, 'سلام') RETURNING id`,
    [input.businessId, campaignId, `+98912${randomUUID().replaceAll("-", "").slice(0, 7)}`],
  );
  await db.query(
    `INSERT INTO message_outbox
       (business_id, recipient_id, campaign_id, status, created_at, sent_at, last_attempt_at, send_latency_ms)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $6::timestamptz, $7)`,
    [
      input.businessId,
      recipientRows[0]!.id,
      campaignId,
      input.status ?? (input.sentAt ? "sent" : "queued"),
      input.createdAt,
      input.sentAt,
      input.sendLatencyMs ?? null,
    ],
  );
}

beforeAll(async () => {
  databaseName = `pos_delivery_trend_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  trend = await import("../src/lib/delivery-trend");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM message_outbox");
  await db.query("DELETE FROM message_recipients");
  await db.query("DELETE FROM message_campaigns");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  Object.assign(beta, await seedBusiness("Beta"));
});

describe("buckets are cut on the Tehran calendar", () => {
  it("files a 21:00 UTC send under the next Tehran day, and 19:00 UTC under today", async () => {
    // Two instants 90 minutes apart, on either side of Tehran midnight (+03:30).
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T19:00:00.000Z",
      sentAt: "2026-10-30T19:00:02.000Z",
    });
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T21:00:00.000Z",
      sentAt: "2026-10-30T21:00:02.000Z",
    });

    const result = await trend.tenantDeliveryTrend(alpha.businessId, {
      days: 3,
      granularity: "day",
      now: new Date("2026-10-31T12:00:00.000Z"),
    });

    const byKey = new Map(result.points.map((point) => [point.key, point]));
    expect(byKey.get("2026-10-30")!.sent).toBe(1);
    expect(byKey.get("2026-10-31")!.sent).toBe(1);
    // A UTC grouping would have put both on the 30th and left the 31st empty.
  });

  it("keeps a bucket with no sends as an empty gap, and gives it no rate", async () => {
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T10:00:00.000Z",
      sentAt: "2026-10-30T10:00:01.000Z",
      sendLatencyMs: 1_000,
    });

    const result = await trend.tenantDeliveryTrend(alpha.businessId, {
      days: 3,
      granularity: "day",
      now: new Date("2026-10-31T12:00:00.000Z"),
    });

    expect(result.buckets).toBe(3);
    expect(result.activeBuckets).toBe(1);
    const quiet = result.points.filter((point) => !point.hasData);
    expect(quiet).toHaveLength(2);
    for (const point of quiet) {
      expect(point.failureRate).toBeNull();
      expect(point.health).toBe("idle");
      expect(point.sent).toBe(0);
    }
    // The window's own rate is over the bucket that had an attempt.
    expect(result.failureRate).toBe(0);
  });

  it("rolls a quarter into weeks, and a week's rows land on its Monday", async () => {
    // Monday 2026-10-26 and Wednesday the 28th: one bucket.
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-26T10:00:00.000Z",
      sentAt: "2026-10-26T10:00:01.000Z",
    });
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-28T10:00:00.000Z",
      sentAt: "2026-10-28T10:00:01.000Z",
    });
    // Sunday the 25th belongs to the week before it.
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-25T10:00:00.000Z",
      sentAt: "2026-10-25T10:00:01.000Z",
    });

    const result = await trend.tenantDeliveryTrend(alpha.businessId, {
      days: 90,
      now: new Date("2026-10-31T12:00:00.000Z"),
    });
    expect(result.granularity).toBe("week");
    const byKey = new Map(result.points.map((point) => [point.key, point]));
    expect(byKey.get("2026-10-26")!.sent).toBe(2);
    expect(byKey.get("2026-10-19")!.sent).toBe(1);
  });
});

describe("the window summary", () => {
  it("pools the two latencies over everything it read", async () => {
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-29T10:00:00.000Z",
      sentAt: "2026-10-29T10:00:02.000Z", // 2 s in the queue
      sendLatencyMs: 400,
    });
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T10:00:00.000Z",
      sentAt: "2026-10-30T10:00:08.000Z", // 8 s in the queue
      sendLatencyMs: 1_200,
    });

    const result = await trend.tenantDeliveryTrend(alpha.businessId, {
      days: 3,
      now: new Date("2026-10-31T12:00:00.000Z"),
    });
    expect(result.queueLatency).toMatchObject({ count: 2, p50: 2_000, p95: 8_000, max: 8_000 });
    expect(result.sendLatency).toMatchObject({ count: 2, p50: 400, p95: 1_200, max: 1_200 });
  });

  it("counts a failure as a decided attempt and reports the rate", async () => {
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T10:00:00.000Z",
      sentAt: "2026-10-30T10:00:01.000Z",
    });
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T10:05:00.000Z",
      sentAt: null,
      status: "failed",
    });

    const result = await trend.tenantDeliveryTrend(alpha.businessId, {
      days: 3,
      now: new Date("2026-10-31T12:00:00.000Z"),
    });
    expect(result.failed).toBe(1);
    expect(result.failureRate).toBeCloseTo(0.5, 10);
    expect(result.worstHealth).toBe("attention");
  });
});

describe("tenancy", () => {
  it("gives each business its own series, and counts the fleet apart", async () => {
    await sendRow({
      businessId: alpha.businessId,
      createdAt: "2026-10-30T10:00:00.000Z",
      sentAt: "2026-10-30T10:00:01.000Z",
    });
    await sendRow({
      businessId: beta.businessId,
      createdAt: "2026-10-30T10:00:00.000Z",
      sentAt: "2026-10-30T10:00:01.000Z",
    });
    await sendRow({
      businessId: beta.businessId,
      createdAt: "2026-10-30T11:00:00.000Z",
      sentAt: "2026-10-30T11:00:01.000Z",
    });

    const own = await trend.tenantDeliveryTrend(alpha.businessId, {
      days: 3,
      now: new Date("2026-10-31T12:00:00.000Z"),
    });
    expect(own.sent).toBe(1);

    const fleet = await trend.getDeliveryTrend({
      days: 3,
      now: new Date("2026-10-31T12:00:00.000Z"),
    });
    expect(fleet.sent).toBe(3);
    // Two businesses were active in the busiest bucket — counted once each, not
    // once per row.
    expect(fleet.businesses).toBe(2);
  });
});
