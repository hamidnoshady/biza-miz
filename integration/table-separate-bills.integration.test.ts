/**
 * Two friends at one table, two separate bills — against a real database.
 *
 * The till now lets a cashier pick an *occupied* table (see `listSelectableTables`
 * in src/lib/pos-selection.ts, and «مهمان جدید روی این میز» on an order's
 * detail), because a second order on a seated table is a friend who wants their
 * own invoice. Nothing in the schema changed for that: `ensureSessionForTable`
 * joins the table's existing open session, so the *visit* stays one session
 * while each `orders` row stays one bill.
 *
 * What this pins down:
 *   1. a second dine-in order on a seated table is accepted, gets its own
 *      order number and its own total, and shares the table's one session;
 *   2. settling one bill leaves the other open — "fully separated" means the
 *      friend's order is untouched by their neighbour's payment;
 *   3. a table that `createOrder` genuinely refuses (cleaning / out of service)
 *      is still refused, and leaves no order behind.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let orderMutations: typeof import("../src/lib/order-mutations");
let orderReads: typeof import("../src/lib/order-read-service");
let tableSessionService: typeof import("../src/lib/table-session-service");

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

interface Shop {
  businessId: string;
  locationId: string;
  menuItemId: string;
  tableId: string;
}

async function createShop(): Promise<Shop> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Split Test ${randomUUID().slice(0, 6)}`, `split-test-${randomUUID().slice(0, 8)}`],
  );
  const businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'چای') RETURNING id",
    [locationId],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'چای کوچک', 600000) RETURNING id",
    [locationId, category.rows[0].id],
  );
  const table = await db.query<{ id: string }>(
    "INSERT INTO dining_tables (location_id, name, capacity) VALUES ($1, 'میز ۱', 4) RETURNING id",
    [locationId],
  );
  return { businessId, locationId, menuItemId: item.rows[0].id, tableId: table.rows[0].id };
}

function dineIn(shop: Shop, quantity: number) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "dine_in",
      tableId: shop.tableId,
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity }],
      openedBy: null,
    }),
  );
}

beforeAll(async () => {
  databaseName = `pos_splitbills_${randomUUID().replaceAll("-", "")}`;

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
  orderMutations = await import("../src/lib/order-mutations");
  orderReads = await import("../src/lib/order-read-service");
  tableSessionService = await import("../src/lib/table-session-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

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

describe("a second order on an occupied table", () => {
  it("is its own bill on the table's one session", async () => {
    const shop = await createShop();

    const first = await dineIn(shop, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The first order seated the table; the friend arrives to a 'seated' one.
    const seated = await db.query<{ status: string }>(
      "SELECT status FROM dining_tables WHERE id = $1",
      [shop.tableId],
    );
    expect(seated.rows[0].status).toBe("seated");

    const second = await dineIn(shop, 3);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.id).not.toBe(first.data.id);

    const { rows } = await db.query<{
      id: string;
      order_number: string;
      table_session_id: string;
      total: string;
    }>(
      "SELECT id, order_number, table_session_id, total FROM orders WHERE table_id = $1 ORDER BY opened_at",
      [shop.tableId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].table_session_id).toBe(rows[1].table_session_id);
    expect(rows[0].order_number).not.toBe(rows[1].order_number);
    expect(Number(rows[0].total)).toBe(600_000);
    expect(Number(rows[1].total)).toBe(1_800_000);

    // One visit, not two: a second session on the same table would break the
    // table map and the session bill.
    const sessions = await db.query<{ count: string }>(
      "SELECT count(*) FROM table_sessions WHERE location_id = $1 AND status = 'open'",
      [shop.locationId],
    );
    expect(Number(sessions.rows[0].count)).toBe(1);
  });

  it("settles on its own, leaving the neighbour's bill open", async () => {
    const shop = await createShop();
    const mine = await dineIn(shop, 1);
    const theirs = await dineIn(shop, 2);
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [
      mine.data.id,
    ]);

    const open = await dbLib.withTenant(shop.businessId, () =>
      orderReads.listOrders(shop.locationId, { status: "open" }),
    );
    expect(open.map((o) => o.id)).toEqual([theirs.data.id]);
  });

  it("still refuses a table that is being cleaned", async () => {
    const shop = await createShop();
    await db.query("UPDATE dining_tables SET status = 'cleaning' WHERE id = $1", [shop.tableId]);

    const result = await dineIn(shop, 1);
    expect(result).toMatchObject({ ok: false, error: "table_unavailable", status: 409 });

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) FROM orders WHERE location_id = $1",
      [shop.locationId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("supports Table 5 with open orders A & B then C, and paying, voiding, or moving A leaves B, C, and manual table status unchanged", async () => {
    const shop = await createShop();
    await db.query("UPDATE dining_tables SET name = 'میز ۵' WHERE id = $1", [shop.tableId]);
    const table6Res = await db.query<{ id: string }>(
      "INSERT INTO dining_tables (location_id, name, capacity) VALUES ($1, 'میز ۶', 4) RETURNING id",
      [shop.locationId],
    );
    const table6Id = table6Res.rows[0].id;

    // 1. Create open orders A and B on Table 5, then create order C on Table 5
    const orderA = await dineIn(shop, 1);
    const orderB = await dineIn(shop, 2);
    const orderC = await dineIn(shop, 3);
    expect(orderA.ok && orderB.ok && orderC.ok).toBe(true);
    if (!orderA.ok || !orderB.ok || !orderC.ok) return;

    expect(new Set([orderA.data.id, orderB.data.id, orderC.data.id]).size).toBe(3);

    // 2. Move Order A to Table 6 — Orders B & C and Table 5 manual status stay unchanged
    await dbLib.withTenant(shop.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const table6SessionId = await tableSessionService.ensureSessionForTable(
          client,
          shop.locationId,
          table6Id,
          null,
          null,
        );
        await client.query(
          "UPDATE orders SET table_id = $2, table_session_id = $3 WHERE id = $1",
          [orderA.data.id, table6Id, table6SessionId],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    const afterMove = await db.query<{
      id: string;
      table_id: string;
      status: string;
      total: string;
    }>(
      "SELECT id, table_id, status::text AS status, total::text FROM orders WHERE id = ANY($1::uuid[])",
      [[orderA.data.id, orderB.data.id, orderC.data.id]],
    );
    const byIdAfterMove = new Map(afterMove.rows.map((r) => [r.id, r]));
    expect(byIdAfterMove.get(orderA.data.id)?.table_id).toBe(table6Id);
    expect(byIdAfterMove.get(orderB.data.id)).toMatchObject({
      table_id: shop.tableId,
      status: "open",
      total: "1200000",
    });
    expect(byIdAfterMove.get(orderC.data.id)).toMatchObject({
      table_id: shop.tableId,
      status: "open",
      total: "1800000",
    });
    const table5StatusAfterMove = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM dining_tables WHERE id = $1",
      [shop.tableId],
    );
    expect(table5StatusAfterMove.rows[0].status).toBe("seated");

    // Move Order A back to Table 5 and pay/settle Order A
    await db.query("UPDATE orders SET table_id = $2 WHERE id = $1", [orderA.data.id, shop.tableId]);
    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [
      orderA.data.id,
    ]);
    await dbLib.withTenant(shop.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await tableSessionService.releaseTableAfterOrderSettled(
          client,
          shop.locationId,
          orderA.data.id,
          null,
        );
      } finally {
        client.release();
      }
    });

    const afterPayA = await db.query<{ id: string; status: string; total: string }>(
      "SELECT id, status::text AS status, total::text FROM orders WHERE id = ANY($1::uuid[])",
      [[orderA.data.id, orderB.data.id, orderC.data.id]],
    );
    const byIdAfterPay = new Map(afterPayA.rows.map((r) => [r.id, r]));
    expect(byIdAfterPay.get(orderA.data.id)?.status).toBe("completed");
    expect(byIdAfterPay.get(orderB.data.id)).toMatchObject({ status: "open", total: "1200000" });
    expect(byIdAfterPay.get(orderC.data.id)).toMatchObject({ status: "open", total: "1800000" });
    const table5StatusAfterPay = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM dining_tables WHERE id = $1",
      [shop.tableId],
    );
    expect(table5StatusAfterPay.rows[0].status).toBe("seated");

    // Void Order A (or another order on Table 5) — Orders B & C and manual table status stay unchanged
    const orderD = await dineIn(shop, 1);
    expect(orderD.ok).toBe(true);
    if (!orderD.ok) return;
    await db.query("UPDATE orders SET status = 'voided', closed_at = now() WHERE id = $1", [
      orderD.data.id,
    ]);
    await dbLib.withTenant(shop.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await tableSessionService.releaseTableAfterOrderSettled(
          client,
          shop.locationId,
          orderD.data.id,
          null,
        );
      } finally {
        client.release();
      }
    });

    const afterVoid = await db.query<{ id: string; status: string }>(
      "SELECT id, status::text AS status FROM orders WHERE id = ANY($1::uuid[])",
      [[orderB.data.id, orderC.data.id, orderD.data.id]],
    );
    const byIdAfterVoid = new Map(afterVoid.rows.map((r) => [r.id, r]));
    expect(byIdAfterVoid.get(orderD.data.id)?.status).toBe("voided");
    expect(byIdAfterVoid.get(orderB.data.id)?.status).toBe("open");
    expect(byIdAfterVoid.get(orderC.data.id)?.status).toBe("open");
    const table5StatusAfterVoid = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM dining_tables WHERE id = $1",
      [shop.tableId],
    );
    expect(table5StatusAfterVoid.rows[0].status).toBe("seated");
  });

  it("keeps a seated reservation 'seated' when one of two open orders is paid, and completes it when the visit session closes", async () => {
    const shop = await createShop();

    const reservationRes = await db.query<{ id: string }>(
      `INSERT INTO reservations (location_id, table_id, customer_name, party_size, reserved_at, duration_minutes, status)
       VALUES ($1, $2, 'خانم رضایی', 4, now(), 90, 'booked')
       RETURNING id`,
      [shop.locationId, shop.tableId],
    );
    const reservationId = reservationRes.rows[0].id;

    // Seat the reservation via openSession
    let sessionId = "";
    await dbLib.withTenant(shop.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const opened = await tableSessionService.openSession(client, {
          locationId: shop.locationId,
          tableIds: [shop.tableId],
          partySize: 4,
          guestName: "خانم رضایی",
          reservationId,
          openedBy: null,
        });
        sessionId = opened.id;
        await client.query(
          "UPDATE reservations SET status = 'seated', seated_session_id = $2 WHERE id = $1",
          [reservationId, sessionId],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    const firstOrder = await dineIn(shop, 1);
    const secondOrder = await dineIn(shop, 2);
    expect(firstOrder.ok && secondOrder.ok).toBe(true);
    if (!firstOrder.ok || !secondOrder.ok) return;

    // Pay the first order while the second order remains open
    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [
      firstOrder.data.id,
    ]);
    await dbLib.withTenant(shop.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await tableSessionService.releaseTableAfterOrderSettled(
          client,
          shop.locationId,
          firstOrder.data.id,
          null,
        );
      } finally {
        client.release();
      }
    });

    const resAfterFirstPaid = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM reservations WHERE id = $1",
      [reservationId],
    );
    expect(resAfterFirstPaid.rows[0].status).toBe("seated");

    // Close the visit session -> reservation transitions to 'completed'
    await dbLib.withTenant(shop.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await tableSessionService.releaseSessionWithoutOrders(
          client,
          shop.locationId,
          sessionId,
          null,
          { nextTableStatus: "cleaning" },
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    const resAfterVisitClosed = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM reservations WHERE id = $1",
      [reservationId],
    );
    expect(resAfterVisitClosed.rows[0].status).toBe("completed");
  });
});
