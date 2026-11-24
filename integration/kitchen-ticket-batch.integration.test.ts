/**
 * Ticket-wide kitchen fulfillment against real PostgreSQL.
 *
 * Proves the properties the KDS depends on and a mocked unit cannot:
 * two terminals racing the same ticket serialize through the order/line locks,
 * a retried batch is idempotent, served/voided/pending lines are never
 * advanced, a cancelled (voided) order is refused, and the ready transition
 * still writes `ready_at` and one order-state audit event for the whole batch.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_kitchen_batch_test_role";
const APP_PASSWORD = "kitchen-batch-test-password";
const rootDeploymentRole = process.env.DEPLOYMENT_ROLE;
const databaseName = `kitchen_batch_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/kitchen-item-transition");

beforeAll(async () => {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  // A site deployment is the path that writes the order-state audit outbox.
  process.env.DEPLOYMENT_ROLE = "site";
  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/kitchen-item-transition");

  // Raw seeding/assertions use the superuser connection, like the other
  // integration files, so fixtures for a test can be created without a
  // tenant scope.
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

let seedCounter = 0;

async function seedOrder(
  items: Array<{ status: "pending" | "sent" | "preparing" | "ready" | "served" | "voided"; name?: string }>,
  orderStatus: "open" | "held" | "completed" | "voided" = "open",
): Promise<{
  businessId: string;
  locationId: string;
  orderId: string;
  itemIds: string[];
}> {
  seedCounter += 1;
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name) VALUES ($1) RETURNING id",
    [`Kitchen batch ${seedCounter}`],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location.rows[0].id;
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status)
     VALUES ($1, $2, 'dine_in', 'open') RETURNING id`,
    [locationId, seedCounter],
  );
  const orderId = order.rows[0].id;
  const itemIds: string[] = [];
  for (const item of items) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO order_items
         (location_id, order_id, name_snapshot, unit_price, quantity, status, sent_to_kitchen_at)
       VALUES ($1, $2, $3, 1000, 1, $4, now()) RETURNING id`,
      [locationId, orderId, item.name ?? `Line ${itemIds.length + 1}`, item.status],
    );
    itemIds.push(row.rows[0].id);
  }
  if (orderStatus !== "open") {
    // Seed the lines first: the order-item guard refuses new lines on an
    // already-closed order.
    await db.query("UPDATE orders SET status = $2 WHERE id = $1", [orderId, orderStatus]);
  }
  return { businessId, locationId, orderId, itemIds };
}

const batchInput = (fixture: Awaited<ReturnType<typeof seedOrder>>) => ({
  businessId: fixture.businessId,
  locationId: fixture.locationId,
  orderId: fixture.orderId,
  mayBumpKitchen: true,
  actorUserId: randomUUID(),
});

async function statuses(orderId: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ id: string; status: string }>(
    "SELECT id, status::text FROM order_items WHERE order_id = $1",
    [orderId],
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

afterEach(async () => {
  // Reopen first: the order-item financial guard refuses INSERT/DELETE and
  // void transitions on a closed order, and the cancelled-order test leaves
  // one voided by design.
  await db.query("UPDATE orders SET status = 'open' WHERE status <> 'open'");
  await db.query("DELETE FROM sync_events");
  await db.query("DELETE FROM order_item_modifiers");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");
});

describe("transitionKitchenTicketBatch", () => {
  it("serializes two terminals racing the same start-all request", async () => {
    const fixture = await seedOrder([{ status: "sent" }, { status: "sent" }]);
    const input = { ...batchInput(fixture), to: "preparing" as const };

    const [first, second] = await Promise.all([
      service.transitionKitchenTicketBatch(input),
      service.transitionKitchenTicketBatch(input),
    ]);

    expect(first.kind).toBe("processed");
    expect(second.kind).toBe("processed");
    const applied = [...first.appliedItemIds, ...second.appliedItemIds].sort();
    expect(applied).toEqual([...fixture.itemIds].sort());
    expect(first.summary.applied + second.summary.applied).toBe(2);
    expect(first.summary.alreadyApplied + second.summary.alreadyApplied).toBe(2);
    expect(Object.values(await statuses(fixture.orderId)).sort()).toEqual(["preparing", "preparing"]);
  });

  it("treats a retried batch as already applied and never advances twice", async () => {
    const fixture = await seedOrder([{ status: "sent" }, { status: "sent" }]);
    const input = { ...batchInput(fixture), to: "preparing" as const };

    const first = await service.transitionKitchenTicketBatch(input);
    const retry = await service.transitionKitchenTicketBatch(input);

    expect(first.summary).toMatchObject({ applied: 2, alreadyApplied: 0 });
    expect(retry.summary).toMatchObject({ applied: 0, alreadyApplied: 2 });
    expect(retry.appliedItemIds).toEqual([]);
    expect(Object.values(await statuses(fixture.orderId)).sort()).toEqual(["preparing", "preparing"]);
  });

  it("never advances served, voided or completed lines and reports them per item", async () => {
    const fixture = await seedOrder([
      { status: "sent" },
      { status: "preparing" },
      { status: "served" },
      { status: "voided" },
    ]);

    const first = await service.transitionKitchenTicketBatch({
      ...batchInput(fixture),
      to: "preparing",
    });
    expect(first.summary).toMatchObject({
      applied: 1,
      alreadyApplied: 1,
      conflict: 0,
      ineligible: 2,
    });
    expect(await statuses(fixture.orderId)).toEqual({
      [fixture.itemIds[0]]: "preparing",
      [fixture.itemIds[1]]: "preparing",
      [fixture.itemIds[2]]: "served",
      [fixture.itemIds[3]]: "voided",
    });

    const second = await service.transitionKitchenTicketBatch({
      ...batchInput(fixture),
      to: "ready",
    });
    expect(second.summary).toMatchObject({
      applied: 2,
      conflict: 0,
      ineligible: 2,
    });
    expect(await statuses(fixture.orderId)).toEqual({
      [fixture.itemIds[0]]: "ready",
      [fixture.itemIds[1]]: "ready",
      [fixture.itemIds[2]]: "served",
      [fixture.itemIds[3]]: "voided",
    });

    const { rows: readyRows } = await db.query<{ id: string; ready_at: string | null }>(
      "SELECT id, ready_at FROM order_items WHERE order_id = $1",
      [fixture.orderId],
    );
    const readyById = Object.fromEntries(readyRows.map((row) => [row.id, row.ready_at]));
    expect(readyById[fixture.itemIds[0]]).not.toBeNull();
    expect(readyById[fixture.itemIds[1]]).not.toBeNull();
    expect(readyById[fixture.itemIds[2]]).toBeNull();
    expect(readyById[fixture.itemIds[3]]).toBeNull();
  });

  it("honours a line subset and reports a requested line that is not on the ticket", async () => {
    const fixture = await seedOrder([{ status: "preparing" }, { status: "served" }]);

    const result = await service.transitionKitchenTicketBatch({
      ...batchInput(fixture),
      to: "ready",
      itemIds: [fixture.itemIds[0], fixture.itemIds[1], randomUUID()],
    });

    expect(result.summary).toMatchObject({ applied: 1, ineligible: 1, missing: 1 });
    expect(await statuses(fixture.orderId)).toEqual({
      [fixture.itemIds[0]]: "ready",
      [fixture.itemIds[1]]: "served",
    });
  });

  it("refuses a cancelled order without touching its lines", async () => {
    const fixture = await seedOrder([{ status: "sent" }], "voided");
    const result = await service.transitionKitchenTicketBatch({
      ...batchInput(fixture),
      to: "preparing",
    });

    expect(result.kind).toBe("missing_order");
    expect(result.appliedItemIds).toEqual([]);
    expect(await statuses(fixture.orderId)).toEqual({ [fixture.itemIds[0]]: "sent" });
  });

  it("writes one order-state audit event and ready_at for the whole batch", async () => {
    const fixture = await seedOrder([{ status: "preparing" }, { status: "preparing" }]);
    const actorUserId = randomUUID();

    const result = await service.transitionKitchenTicketBatch({
      ...batchInput(fixture),
      to: "ready",
      actorUserId,
      syncActor: { userId: actorUserId, role: "kitchen" },
    });

    expect(result.summary.applied).toBe(2);
    const { rows } = await db.query<{ event_type: string; count: string }>(
      `SELECT event_type, COUNT(*)::text AS count
         FROM sync_events
        WHERE location_id = $1 AND event_type = 'order.state.synced'
        GROUP BY event_type`,
      [fixture.locationId],
    );
    expect(rows).toEqual([{ event_type: "order.state.synced", count: "1" }]);
    const { rows: readyRows } = await db.query<{ ready_at: string | null }>(
      "SELECT ready_at FROM order_items WHERE order_id = $1",
      [fixture.orderId],
    );
    expect(readyRows.every((row) => row.ready_at !== null)).toBe(true);
  });
});
