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

describe("automatic Kitchen clearing", () => {
  it("schedules the entire ticket only after its last line is ready, and keeps expired history when another line arrives", async () => {
    const { businessId, locationId, orderId } = await seedOrder();
    const { scheduleKitchenTicket } = await import("../src/lib/kitchen-workflow");
    await db.query(
      "INSERT INTO settings (business_id, location_id, key, value) VALUES ($1,$2,'kitchen.clearAfterMinutes','5')",
      [businessId, locationId],
    );
    const { rows: [first] } = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, status, ready_at)
       VALUES ($1,$2,'First',100,'ready',now() - interval '10 minutes') RETURNING id`,
      [locationId, orderId],
    );
    const { rows: [last] } = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, status)
       VALUES ($1,$2,'Last',100,'sent') RETURNING id`,
      [locationId, orderId],
    );
    await scheduleKitchenTicket(db, locationId, orderId);
    expect((await db.query("SELECT kitchen_clear_at FROM order_items WHERE id=$1", [first.id])).rows[0].kitchen_clear_at).toBeNull();
    await db.query("UPDATE order_items SET status='ready', ready_at=now() - interval '8 minutes' WHERE id=$1", [last.id]);
    await scheduleKitchenTicket(db, locationId, orderId);
    const { rows: expired } = await db.query<{ kitchen_clear_at: Date }>(
      "SELECT kitchen_clear_at FROM order_items WHERE order_id=$1 AND kitchen_clear_at <= now()",
      [orderId],
    );
    expect(expired).toHaveLength(2);
    expect(expired[0].kitchen_clear_at).toEqual(expired[1].kitchen_clear_at);
    await db.query(
      "INSERT INTO order_items (location_id,order_id,name_snapshot,unit_price,status) VALUES ($1,$2,'New',100,'sent')",
      [locationId, orderId],
    );
    await scheduleKitchenTicket(db, locationId, orderId);
    const { rows } = await db.query(
      "SELECT kitchen_clear_at, status FROM order_items WHERE order_id=$1 ORDER BY name_snapshot",
      [orderId],
    );
    expect(rows.map((row) => row.status)).toEqual(["ready", "ready", "sent"]);
    expect(rows.slice(0, 2).map((row) => row.kitchen_clear_at)).toEqual(expired.map((row) => row.kitchen_clear_at));
    expect(rows[2].kitchen_clear_at).toBeNull();
  });
});
