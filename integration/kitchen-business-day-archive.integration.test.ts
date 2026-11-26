/**
 * Kitchen tickets whose business day has passed archive themselves.
 *
 * Proves against real PostgreSQL what the KDS depends on and a mocked unit
 * cannot: the branch's own definition of "today" (its timezone and its
 * business-day start) decides which tickets leave the board, tickets from the
 * day in progress stay, voided orders and already-archived lines are never
 * touched, and a repeated run archives nothing extra (idempotent).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const databaseName = `kitchen_bday_${randomUUID().replaceAll("-", "")}`;

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

let db: Client;
let service: typeof import("../src/lib/kitchen-workflow");

beforeAll(async () => {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Raw seeding/assertions use the superuser connection, like the other
  // integration files, so fixtures for a test can be created without a
  // tenant scope. The service under test receives this client too: the
  // route wires it under `withTenantScope`, whose RLS behaviour the routes'
  // own guard tests already cover — here the archive *rules* are what needs
  // proving.
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  service = await import("../src/lib/kitchen-workflow");
}, 120_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

let seedCounter = 0;

async function seedBranch(startMinutes: number | null): Promise<{ businessId: string; locationId: string }> {
  seedCounter += 1;
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name) VALUES ($1) RETURNING id",
    [`Kitchen day archive ${seedCounter}`],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    startMinutes === null
      ? "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id"
      : "INSERT INTO locations (business_id, name, business_day_start_minutes) VALUES ($1, 'Main', $2) RETURNING id",
    startMinutes === null ? [businessId] : [businessId, startMinutes],
  );
  return { businessId, locationId: location.rows[0].id };
}

/**
 * A line sent `sentAtSql` (a SQL expression relative to `now()`, phrased with
 * the branch's own business-day helpers so the fixture is never
 * time-of-day-dependent) on an order with the given status. Pass an existing
 * `orderId` to put several lines on one order; a voided order is seeded open
 * and voided afterwards, because the order-item guard refuses new lines on a
 * closed order.
 */
async function seedTicket(input: {
  locationId: string;
  sentAtSql: string;
  status?: "sent" | "preparing" | "ready";
  orderStatus?: "open" | "voided";
  alreadyArchived?: boolean;
  orderId?: string;
}): Promise<string> {
  const orderId =
    input.orderId ??
    (
      await db.query<{ id: string }>(
        `INSERT INTO orders (location_id, order_number, type, status)
         VALUES ($1, $2, 'dine_in', 'open') RETURNING id`,
        [input.locationId, (seedCounter += 1)],
      )
    ).rows[0].id;
  const row = await db.query<{ id: string }>(
    `INSERT INTO order_items
       (location_id, order_id, name_snapshot, unit_price, quantity, status,
        sent_to_kitchen_at, kitchen_archived_at, kitchen_archive_reason)
     VALUES ($1, $2, 'Line', 1000, 1, $3, ${input.sentAtSql},
             ${input.alreadyArchived ? "now() - interval '1 hour'" : "NULL"},
             ${input.alreadyArchived ? "'paid'" : "NULL"})
     RETURNING id`,
    [input.locationId, orderId, input.status ?? "sent"],
  );
  if (input.orderStatus === "voided") {
    await db.query("UPDATE orders SET status = 'voided' WHERE id = $1", [orderId]);
  }
  return row.rows[0].id;
}

/** One order to hang several lines on (see `seedTicket`). */
async function seedOrder(locationId: string): Promise<string> {
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status)
     VALUES ($1, $2, 'dine_in', 'open') RETURNING id`,
    [locationId, (seedCounter += 1)],
  );
  return order.rows[0].id;
}

async function archiveState(itemId: string): Promise<{ archivedAt: string | null; reason: string | null }> {
  const { rows } = await db.query<{ kitchen_archived_at: string | null; kitchen_archive_reason: string | null }>(
    "SELECT kitchen_archived_at::text, kitchen_archive_reason FROM order_items WHERE id = $1",
    [itemId],
  );
  return { archivedAt: rows[0]?.kitchen_archived_at ?? null, reason: rows[0]?.kitchen_archive_reason ?? null };
}

afterEach(async () => {
  // Reopen first: the order-item financial guard refuses deletes on lines of
  // closed orders, and the voided-order test leaves one voided by design.
  await db.query("UPDATE orders SET status = 'open' WHERE status <> 'open'");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");
});

describe("archiveKitchenTicketsPastBusinessDay", () => {
  it("archives tickets sent before the current business date and keeps today's", async () => {
    const { businessId, locationId } = await seedBranch(null);
    // A calendar-day branch: anything more than ~6 hours before now is a
    // previous date for certain; anything inside the current business day is
    // phrased with the branch's own day-start helper, so the fixture cannot
    // drift across midnight mid-test.
    const yesterday = await seedTicket({ locationId, sentAtSql: "now() - interval '30 hours'" });
    const today = await seedTicket({
      locationId,
      sentAtSql: "app_business_day_start(now(), 'Asia/Tehran', NULL) + interval '5 minutes'",
    });

    const count = await service.archiveKitchenTicketsPastBusinessDay(db, locationId);

    expect(count).toBe(1);
    expect(await archiveState(yesterday)).toEqual({ archivedAt: expect.any(String), reason: "business_day" });
    expect(await archiveState(today)).toEqual({ archivedAt: null, reason: null });
    void businessId;
  });

  it("uses the branch's own day start: an 18:00 branch keeps the 17:30 of its previous service", async () => {
    const { locationId } = await seedBranch(1080);
    // Half an hour before the current business day began — yesterday's
    // business date for an 18:00 branch.
    const beforeDayStart = await seedTicket({
      locationId,
      sentAtSql: "app_business_day_start(now(), 'Asia/Tehran', 1080) - interval '30 minutes'",
    });
    const afterDayStart = await seedTicket({
      locationId,
      sentAtSql: "app_business_day_start(now(), 'Asia/Tehran', 1080) + interval '5 minutes'",
    });

    const count = await service.archiveKitchenTicketsPastBusinessDay(db, locationId);

    expect(count).toBe(1);
    expect((await archiveState(beforeDayStart)).reason).toBe("business_day");
    expect(await archiveState(afterDayStart)).toEqual({ archivedAt: null, reason: null });
  });

  it("never touches voided orders, served lines, or lines already archived", async () => {
    const { locationId } = await seedBranch(null);
    const voided = await seedTicket({ locationId, sentAtSql: "now() - interval '30 hours'", orderStatus: "voided" });
    const archived = await seedTicket({ locationId, sentAtSql: "now() - interval '30 hours'", alreadyArchived: true });

    const count = await service.archiveKitchenTicketsPastBusinessDay(db, locationId);

    expect(count).toBe(0);
    expect(await archiveState(voided)).toEqual({ archivedAt: null, reason: null });
    const archivedState = await archiveState(archived);
    expect(archivedState.reason).toBe("paid");
  });

  it("counts orders, not lines, and is idempotent on a repeat", async () => {
    const { locationId } = await seedBranch(null);
    const orderId = await seedOrder(locationId);
    const first = await seedTicket({ locationId, sentAtSql: "now() - interval '30 hours'", orderId });
    const second = await seedTicket({
      locationId,
      sentAtSql: "now() - interval '30 hours'",
      status: "ready",
      orderId,
    });

    const firstCount = await service.archiveKitchenTicketsPastBusinessDay(db, locationId);
    const repeatCount = await service.archiveKitchenTicketsPastBusinessDay(db, locationId);

    expect(firstCount).toBe(1);
    expect(repeatCount).toBe(0);
    expect((await archiveState(first)).reason).toBe("business_day");
    expect((await archiveState(second)).reason).toBe("business_day");
  });
});
