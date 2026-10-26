/**
 * Issue #1077 — the WP/Woo queue retention sweep, against a real database.
 *
 * Proven here: finished rows past 90 days and dead / failed rows past 180 days
 * are deleted; younger rows survive; and `pending`, `processing`, `deferred`,
 * `failed` (still retrying) and `needs_review` rows are NEVER deleted, however
 * old. Each sweep leaves one payload-free summary in the append-only audit log,
 * a second sweep is a no-op, and another business's rows are untouched.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "ab".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let retention: typeof import("../src/lib/integrations/queue-retention");

const NOW = new Date("2026-10-25T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const a = { id: "", connectionId: "" };
const b = { id: "", connectionId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function makeBusiness(label: string): Promise<{ id: string; connectionId: string }> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'accessories') RETURNING id",
    [label, `retention-${randomUUID().slice(0, 8)}`],
  );
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.rows[0].id],
  );
  const conn = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5) RETURNING id`,
    [
      biz.rows[0].id,
      loc.rows[0].id,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret("wh_test", Buffer.from(KEY, "hex")),
    ],
  );
  return { id: biz.rows[0].id, connectionId: conn.rows[0].id };
}

async function outbox(biz: { id: string; connectionId: string }, remoteId: string, status: string, ageDays: number) {
  await db.query(
    `INSERT INTO integration_outbox_events
       (business_id, connection_id, entity_type, remote_id, payload, status, updated_at)
     VALUES ($1, $2, 'stock', $3, '{"stock_quantity":1}'::jsonb, $4, $5)`,
    [biz.id, biz.connectionId, remoteId, status, daysAgo(ageDays)],
  );
}

async function inbox(biz: { id: string; connectionId: string }, deliveryId: string, status: string, ageDays: number) {
  await db.query(
    `INSERT INTO integration_webhook_events
       (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status, created_at)
     VALUES ($1, $2, 'order.created', $3, $3, '{}'::jsonb, $4, $5)`,
    [biz.id, biz.connectionId, deliveryId, status, daysAgo(ageDays)],
  );
}

async function remaining(table: string, biz: { connectionId: string }, column: string): Promise<string[]> {
  const { rows } = await db.query<{ k: string }>(
    `SELECT ${column} AS k FROM ${table} WHERE connection_id = $1 ORDER BY ${column}`,
    [biz.connectionId],
  );
  return rows.map((r) => r.k);
}

beforeAll(async () => {
  databaseName = `pos_wp_retention_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  dbLib = await import("../src/lib/db");
  retention = await import("../src/lib/integrations/queue-retention");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  Object.assign(a, await makeBusiness("Retention A"));
  Object.assign(b, await makeBusiness("Retention B"));

  // Outbox: done rows (90d) — only the old ones go.
  await outbox(a, "sent-old", "sent", 91);
  await outbox(a, "sent-new", "sent", 89);
  await outbox(a, "skipped-old", "skipped", 120);
  await outbox(a, "skipped-new", "skipped", 10);
  // Outbox: dead (180d) — a 120-day-old dead row is still kept.
  await outbox(a, "dead-old", "dead", 181);
  await outbox(a, "dead-mid", "dead", 120);
  // Outbox: statuses that are never swept, however old.
  for (const status of ["pending", "processing", "failed", "needs_review"]) {
    await outbox(a, `${status}-ancient`, status, 400);
  }
  // Inbox: done (90d), failed (180d), and the never-swept statuses.
  await inbox(a, "processed-old", "processed", 100);
  await inbox(a, "processed-new", "processed", 30);
  await inbox(a, "duplicate-old", "duplicate", 95);
  await inbox(a, "failed-old", "failed", 200);
  await inbox(a, "failed-mid", "failed", 100);
  for (const status of ["pending", "deferred"]) {
    await inbox(a, `${status}-ancient`, status, 400);
  }
  // Another business with ancient finished rows: also swept (it is its own
  // tenant), but its rows must never be counted against A.
  await outbox(b, "b-sent-old", "sent", 300);
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("queue retention sweep", () => {
  it("deletes only finished rows past 90 days and dead/failed rows past 180 days", async () => {
    await retention.runQueueRetentionTick(NOW);

    expect(await remaining("integration_outbox_events", a, "remote_id")).toEqual([
      "dead-mid",
      "failed-ancient",
      "needs_review-ancient",
      "pending-ancient",
      "processing-ancient",
      "sent-new",
      "skipped-new",
    ]);
    expect(await remaining("integration_webhook_events", a, "delivery_id")).toEqual([
      "deferred-ancient",
      "failed-mid",
      "pending-ancient",
      "processed-new",
    ]);
  });

  it("sweeps every business, not just the first", async () => {
    expect(await remaining("integration_outbox_events", b, "remote_id")).toEqual([]);
  });

  it("records one payload-free summary per connection in the audit log", async () => {
    const { rows } = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM integration_audit_log
        WHERE connection_id = $1 AND action = 'queue.retention_sweep'`,
      [a.connectionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      outboxDone: 2,
      outboxDead: 1,
      inboxDone: 2,
      inboxFailed: 1,
      doneRetentionDays: 90,
      deadRetentionDays: 180,
    });
    expect(JSON.stringify(rows[0].payload)).not.toContain("stock_quantity");
  });

  it("is a no-op the second time: nothing deleted, no new audit row", async () => {
    await retention.runQueueRetentionTick(NOW);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_audit_log
        WHERE connection_id = $1 AND action = 'queue.retention_sweep'`,
      [a.connectionId],
    );
    expect(rows[0].n).toBe("1");
    expect(await remaining("integration_outbox_events", a, "remote_id")).toHaveLength(7);
  });

  it("works through a backlog larger than one batch", async () => {
    const total = retention.QUEUE_RETENTION_BATCH + 5;
    await db.query(
      `INSERT INTO integration_webhook_events
         (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status, created_at)
       SELECT $1, $2, 'order.created', 'bulk-' || g, 'bulk-' || g, '{}'::jsonb, 'processed', $3
         FROM generate_series(1, $4) AS g`,
      [a.id, a.connectionId, daysAgo(200), total],
    );
    await retention.runQueueRetentionTick(NOW);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_webhook_events WHERE delivery_id LIKE 'bulk-%'`,
    );
    expect(rows[0].n).toBe("0");
  });
});
