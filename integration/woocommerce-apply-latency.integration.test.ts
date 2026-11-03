/**
 * Issue #1206 P1 — measured Bizamiz → store apply latency, against a real
 * database.
 *
 * The «p95 ≤ 3 minutes» target may only be reported from deliveries that
 * happened. An outbox row is a desired-state row, re-armed on every change,
 * so `created_at` cannot start the clock; migration 0285 adds `desired_at`
 * (stamped when the current value became owed) and `sent_at` is stamped only
 * after a real apply + ACK. What is proven here:
 *
 *   - the column exists, is NOT NULL, and defaults to now() so every insert
 *     starts its own clock without the caller remembering;
 *   - a re-arming upsert restamps `desired_at` — the latency of a value is
 *     measured from when THAT value became owed, not the row's birthday;
 *   - `applyLatencyByConnection` computes percentiles over recent, truly
 *     measured deliveries only: pre-0285 rows (backfilled to
 *     `desired_at = sent_at`), deliveries older than 30 days, still-pending
 *     rows and other tenants contribute nothing, and a connection with no
 *     measured delivery is absent — never a row of zeros.
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
let outbox: typeof import("../src/lib/integrations/outbox-service");

const biz = { id: "", connectionId: "", idleConnectionId: "" };
const other = { id: "", connectionId: "" };

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

async function seedBusiness(slugPrefix: string): Promise<{ businessId: string; connectionId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Latency Shop', $1, 'accessories') RETURNING id",
    [`${slugPrefix}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const connRow = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
     RETURNING id`,
    [
      businessId,
      locRow.rows[0].id,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret("wh_test", Buffer.from(KEY, "hex")),
    ],
  );
  return { businessId, connectionId: connRow.rows[0].id };
}

beforeAll(async () => {
  databaseName = `pos_woo_latency_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
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
  outbox = await import("../src/lib/integrations/outbox-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const first = await seedBusiness("latency-main");
  biz.id = first.businessId;
  biz.connectionId = first.connectionId;
  // A second connection of the same business that never delivers anything.
  const idle = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, (SELECT id FROM locations WHERE business_id = $1 LIMIT 1), 'Idle store', 'https://idle.example.com', $2, $3, $4, 'toman', true, true, true, true, true)
     RETURNING id`,
    [
      biz.id,
      encryptSecret("ck_idle", Buffer.from(KEY, "hex")),
      encryptSecret("cs_idle", Buffer.from(KEY, "hex")),
      encryptSecret("wh_idle", Buffer.from(KEY, "hex")),
    ],
  );
  biz.idleConnectionId = idle.rows[0].id;

  const second = await seedBusiness("latency-other");
  other.id = second.businessId;
  other.connectionId = second.connectionId;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("migration 0285: desired_at", () => {
  it("adds a NOT NULL desired_at defaulting to now()", async () => {
    const { rows } = await db.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'integration_outbox_events' AND column_name = 'desired_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toContain("now()");
  });

  it("a plain insert starts its own clock", async () => {
    const { rows } = await db.query<{ age: number }>(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
       VALUES ($1, $2, 'price', 'clock-1', '{"regular_price":"100"}'::jsonb)
       RETURNING EXTRACT(EPOCH FROM now() - desired_at) AS age`,
      [biz.id, biz.connectionId],
    );
    expect(Number(rows[0].age)).toBeLessThan(60);
  });

  it("a re-arming upsert restamps desired_at for the new desire", async () => {
    const first = await dbLib!.withTenant(biz.id, () => outbox.enqueueTaxonomySync(biz.id, biz.connectionId));
    expect(first.jobId).toBeTruthy();
    // Age the row into an applied old desire…
    await db.query(
      `UPDATE integration_outbox_events
          SET status = 'sent', sent_at = now() - interval '1 hour', desired_at = now() - interval '2 hours'
        WHERE id = $1`,
      [first.jobId],
    );
    // …then owe the store a fresh read: the clock must restart now.
    const again = await dbLib!.withTenant(biz.id, () => outbox.enqueueTaxonomySync(biz.id, biz.connectionId));
    expect(again.jobId).toBe(first.jobId);
    const { rows } = await db.query<{ age: number; status: string }>(
      `SELECT EXTRACT(EPOCH FROM now() - desired_at) AS age, status
         FROM integration_outbox_events WHERE id = $1`,
      [first.jobId],
    );
    expect(rows[0].status).toBe("pending");
    expect(Number(rows[0].age)).toBeLessThan(60);
  });
});

describe("applyLatencyByConnection (issue #1206 P1)", () => {
  beforeAll(async () => {
    // Four genuinely measured deliveries: 60/120/180/240 seconds of lag.
    const lags = [60, 120, 180, 240];
    for (const [i, lag] of lags.entries()) {
      await db.query(
        `INSERT INTO integration_outbox_events
           (business_id, connection_id, entity_type, remote_id, payload, status, sent_at, desired_at)
         VALUES ($1, $2, 'stock', $3, '{"stock_quantity":3}'::jsonb, 'sent',
                 now() - interval '10 minutes',
                 now() - interval '10 minutes' - make_interval(secs => $4))`,
        [biz.id, biz.connectionId, `lag-${i + 1}`, lag],
      );
    }
    // (a) A pre-0285-shaped row: desire time unrecoverable, backfilled to
    // sent_at. It must not contribute a zero sample.
    await db.query(
      `INSERT INTO integration_outbox_events
         (business_id, connection_id, entity_type, remote_id, payload, status, sent_at, desired_at)
       VALUES ($1, $2, 'stock', 'legacy-1', '{}'::jsonb, 'sent',
               now() - interval '5 minutes', now() - interval '5 minutes')`,
      [biz.id, biz.connectionId],
    );
    // (b) A real measurement, but delivered 40 days ago: outside the window.
    await db.query(
      `INSERT INTO integration_outbox_events
         (business_id, connection_id, entity_type, remote_id, payload, status, sent_at, desired_at)
       VALUES ($1, $2, 'stock', 'old-1', '{}'::jsonb, 'sent',
               now() - interval '40 days', now() - interval '40 days' - interval '300 seconds')`,
      [biz.id, biz.connectionId],
    );
    // (c) Still owed, not delivered: latency is not a fact yet.
    await db.query(
      `INSERT INTO integration_outbox_events
         (business_id, connection_id, entity_type, remote_id, payload, status, desired_at)
       VALUES ($1, $2, 'price', 'waiting-1', '{}'::jsonb, 'pending', now() - interval '3 hours')`,
      [biz.id, biz.connectionId],
    );
    // (d) Another tenant's measured delivery (90s).
    await db.query(
      `INSERT INTO integration_outbox_events
         (business_id, connection_id, entity_type, remote_id, payload, status, sent_at, desired_at)
       VALUES ($1, $2, 'stock', 'other-1', '{}'::jsonb, 'sent',
               now() - interval '1 minute', now() - interval '1 minute' - interval '90 seconds')`,
      [other.id, other.connectionId],
    );
  });

  it("computes percentiles over the measured deliveries only", async () => {
    const map = await dbLib!.withTenant(biz.id, () => outbox.applyLatencyByConnection(biz.id));
    const mine = map.get(biz.connectionId);
    expect(mine).toBeDefined();
    // percentile_cont over [60, 120, 180, 240]: p50 = 150, p95 = 231,
    // p99 = 238.2 → 238, max = 240. The legacy/old/pending rows add nothing.
    expect(mine).toEqual({ samples: 4, p50Seconds: 150, p95Seconds: 231, p99Seconds: 238, maxSeconds: 240 });
  });

  it("a connection with no measured delivery is absent, not zeros", async () => {
    const map = await dbLib!.withTenant(biz.id, () => outbox.applyLatencyByConnection(biz.id));
    expect(map.has(biz.idleConnectionId)).toBe(false);
  });

  it("tenants never see each other's measurements", async () => {
    const mine = await dbLib!.withTenant(biz.id, () => outbox.applyLatencyByConnection(biz.id));
    expect(mine.has(other.connectionId)).toBe(false);
    const theirs = await dbLib!.withTenant(other.id, () => outbox.applyLatencyByConnection(other.id));
    expect(theirs.get(other.connectionId)).toEqual({
      samples: 1,
      p50Seconds: 90,
      p95Seconds: 90,
      p99Seconds: 90,
      maxSeconds: 90,
    });
  });
});
