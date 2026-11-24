/**
 * Durable kitchen dispatch acceptance test against PostgreSQL. It pins the
 * contract shared by POS first-submit and waiter add-items: a retry of the
 * same item-ID set is one job, while a later round containing only its new
 * order-item IDs is a distinct job containing no earlier lines.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
const rootDeploymentRole = process.env.DEPLOYMENT_ROLE;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const databaseName = `kitchen_dispatch_${randomUUID().replaceAll("-", "")}`;
const urlFor = (database: string) => {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
};
const maintenanceUrl = () => urlFor("postgres");
let db: Client;
let dbLib: typeof import("../src/lib/db");
let dispatch: typeof import("../src/lib/kitchen-dispatch");

beforeAll(async () => {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.DEPLOYMENT_ROLE = "site";
  dbLib = await import("../src/lib/db");
  dispatch = await import("../src/lib/kitchen-dispatch");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (rootDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = rootDeploymentRole;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function seedOrder() {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name) VALUES ('Dispatch acceptance') RETURNING id",
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location.rows[0].id;
  const order = await db.query<{ id: string }>(
    "INSERT INTO orders (location_id, order_number, type) VALUES ($1, 1, 'dine_in') RETURNING id",
    [locationId],
  );
  const orderId = order.rows[0].id;
  await db.query(
    "INSERT INTO settings (business_id, key, value) VALUES ($1, 'deployment.profile', '{\"profile\":\"local\"}')",
    [businessId],
  );
  return { businessId, locationId, orderId };
}

describe("transactional kitchen dispatch idempotency", () => {
  it("deduplicates the first print and creates a new-item-only delta print", async () => {
    const { businessId, locationId, orderId } = await seedOrder();
    const firstIds = [randomUUID(), randomUUID()];
    const deltaIds = [randomUUID()];
    const input = { businessId, locationId, orderId };

    async function enqueue(itemIds: string[]) {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const id = await dispatch.enqueueKitchenDispatch(client, { ...input, itemIds });
        await client.query("COMMIT");
        return id;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const firstJob = await enqueue(firstIds);
    const retriedFirstJob = await enqueue([...firstIds].reverse());
    const deltaJob = await enqueue(deltaIds);

    expect(firstJob).toBeTruthy();
    expect(retriedFirstJob).toBe(firstJob);
    expect(deltaJob).toBeTruthy();
    expect(deltaJob).not.toBe(firstJob);

    const { rows } = await db.query<{
      id: string;
      item_ids: string[];
      idempotency_key: string;
      owner_mode: string;
    }>(
      "SELECT id, item_ids, idempotency_key, owner_mode FROM kitchen_dispatch_jobs WHERE order_id=$1 ORDER BY created_at,id",
      [orderId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === firstJob)?.item_ids).toEqual([...firstIds].sort());
    expect(rows.find((row) => row.id === deltaJob)?.item_ids).toEqual(deltaIds);
    expect(rows[0].idempotency_key).toMatch(new RegExp(`^kitchen:${orderId}:`));
    expect(rows[0].idempotency_key).not.toBe(rows[1].idempotency_key);
    expect(rows.every((row) => row.owner_mode === "local_runtime")).toBe(true);
    expect(rows.find((row) => row.id === deltaJob)?.item_ids).not.toEqual(expect.arrayContaining(firstIds));
  });
});

describe("business-day kitchen archival", () => {
  it("archives older queue lines and leaves today's work and other branches in place", async () => {
    const { businessId, locationId, orderId } = await seedOrder();
    const other = await seedOrder();
    const { archivePastKitchenTickets } = await import("../src/lib/kitchen-workflow");
    await db.query(
      "UPDATE locations SET timezone = 'Asia/Tehran', business_day_start_minutes = 360 WHERE id IN ($1, $2)",
      [locationId, other.locationId],
    );
    const { rows: [boundary] } = await db.query<{ cutoff: Date }>(
      "SELECT app_business_day_start(now(), timezone, business_day_start_minutes) AS cutoff FROM locations WHERE id = $1",
      [locationId],
    );
    await db.query(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, status, sent_to_kitchen_at)
       VALUES ($1,$2,'Old sent',100,'sent',$3::timestamptz - interval '1 second'),
              ($1,$2,'Old preparing',100,'preparing',$3::timestamptz - interval '1 day'),
              ($1,$2,'Old ready',100,'ready',$3::timestamptz - interval '60 days'),
              ($1,$2,'Boundary',100,'sent',$3),
              ($4,$5,'Other branch',100,'sent',$3::timestamptz - interval '1 day')`,
      [locationId, orderId, boundary.cutoff, other.locationId, other.orderId],
    );
    await archivePastKitchenTickets(businessId, locationId, db);
    const readLines = () => db.query(
      `SELECT name_snapshot, status, kitchen_archived_at, kitchen_archive_reason FROM order_items
        WHERE order_id IN ($1, $2) ORDER BY name_snapshot`,
      [orderId, other.orderId],
    );
    const { rows } = await readLines();
    expect(rows.map((row) => [row.name_snapshot, row.status, row.kitchen_archive_reason])).toEqual([
      ["Boundary", "sent", null],
      ["Old preparing", "preparing", "business_day"],
      ["Old ready", "ready", "business_day"],
      ["Old sent", "sent", "business_day"],
      ["Other branch", "sent", null],
    ]);
    await archivePastKitchenTickets(businessId, locationId, db);
    expect((await readLines()).rows).toEqual(rows);
    expect((await db.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status).toBe("open");
  });
});
