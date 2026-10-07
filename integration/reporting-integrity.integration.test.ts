/**
 * Reporting-integrity integration coverage for issue #819 (Phase B).
 *
 * Two defects in the shift reporting views are pinned here against a real
 * database, because both are SQL-shape bugs that no unit test can see:
 *
 *   1. `v_shift_reconciliation` summed `orders.total` across a LEFT JOIN to
 *      payments, so a split-paid order multiplied its gross by its payment
 *      count. The payment buckets were always right (each is FILTER-guarded to
 *      one method); only the headline inflated.
 *   2. `v_employee_shift_reconciliation` attributed an order to a shift by
 *      `closed_by` + window alone, so an employee clocked in at branch B had
 *      their branch-B orders counted into their branch-A shift whenever the
 *      windows overlapped.
 *
 * Migration 0211 fixes both; this file is what stops them coming back.
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

let businessId = "";
let mainId = "";
let otherId = "";
let employeeId = "";

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

/** A user plus its employees row — a shift's employee_id references employees (migration 0042). */
async function seedEmployee(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, pin_hash)
     VALUES ($1, 'manager', 'شیدا کاشانی', $2, 'x') RETURNING id`,
    [businessId, `cashier-${randomUUID().slice(0, 8)}@example.com`],
  );
  const id = rows[0].id;
  await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2)", [id, businessId]);
  return id;
}

async function insertShift(locationId: string, startedAt: string, endedAt: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_shifts
       (employee_id, business_id, location_id, business_date, started_at, ended_at)
     VALUES ($1, $2, $3, $4::timestamptz::date, $4, $5)
     RETURNING id`,
    [employeeId, businessId, locationId, startedAt, endedAt],
  );
  return rows[0].id;
}

/**
 * A completed order, optionally settled by several payments — the shape a
 * split bill produces.
 */
async function insertCompletedOrder(
  locationId: string,
  orderNumber: number,
  total: number,
  closedAt: string,
  payments: { method: string; amount: number }[],
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, subtotal, opened_at, closed_at, closed_by)
     VALUES ($1, $2, 'dine_in', 'completed', $3, $3, $4::timestamptz - interval '30 minutes', $4, $5)
     RETURNING id`,
    [locationId, orderNumber, total, closedAt, employeeId],
  );
  // Split slices are numbered within one settlement: since 0092 the unique
  // index is (order_id, settlement_seq), so a second live positive row needs
  // its own sequence — exactly what the checkout writes.
  let seq = 0;
  for (const payment of payments) {
    seq += 1;
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, received_by, received_at, settlement_seq)
       VALUES ($1, $2, $3::payment_method, $4, $5, $6, $7)`,
      [locationId, rows[0].id, payment.method, payment.amount, employeeId, closedAt, seq],
    );
  }
  return rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_reporting_integrity_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
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

beforeEach(async () => {
  // order_not_open (migration 0036) rejects deleting a closed order's lines.
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM employee_shifts");
  await db.query("DELETE FROM businesses");

  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Cafe', $1) RETURNING id",
    [`cafe-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;

  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Other')
     RETURNING id, name`,
    [businessId],
  );
  mainId = locations.rows.find((r) => r.name === "Main")!.id;
  otherId = locations.rows.find((r) => r.name === "Other")!.id;

  employeeId = await seedEmployee();
});

describe("v_shift_reconciliation — split payments", () => {
  it("keeps gross_total equal to the order total when a bill is settled by several tenders", async () => {
    await insertCompletedOrder(mainId, 1, 1_000_000, "2026-08-10T09:00:00Z", [
      { method: "cash", amount: 600_000 },
      { method: "card", amount: 400_000 },
    ]);

    const { rows } = await db.query<{
      order_count: string;
      gross_total: string;
      cash_total: string;
      card_total: string;
    }>(
      `SELECT order_count, gross_total, cash_total, card_total
         FROM v_shift_reconciliation WHERE location_id = $1`,
      [mainId],
    );

    // Before 0211 the LEFT JOIN produced two rows and gross_total read
    // 2,000,000 for a 1,000,000 bill — while cash_total + card_total stayed
    // correct at 1,000,000, so the report contradicted itself.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].order_count)).toBe(1);
    expect(Number(rows[0].gross_total)).toBe(1_000_000);
    expect(Number(rows[0].cash_total)).toBe(600_000);
    expect(Number(rows[0].card_total)).toBe(400_000);
  });

  it("sums each method across orders without fanning the gross out", async () => {
    await insertCompletedOrder(mainId, 1, 1_000_000, "2026-08-10T09:00:00Z", [
      { method: "cash", amount: 500_000 },
      { method: "cash", amount: 500_000 },
    ]);
    await insertCompletedOrder(mainId, 2, 2_000_000, "2026-08-10T10:00:00Z", [
      { method: "online", amount: 2_000_000 },
    ]);

    const { rows } = await db.query<{ gross_total: string; cash_total: string; online_total: string }>(
      `SELECT gross_total, cash_total, online_total FROM v_shift_reconciliation WHERE location_id = $1`,
      [mainId],
    );
    expect(Number(rows[0].gross_total)).toBe(3_000_000);
    expect(Number(rows[0].cash_total)).toBe(1_000_000);
    expect(Number(rows[0].online_total)).toBe(2_000_000);
  });
});

describe("v_employee_shift_reconciliation — branch boundary", () => {
  it("does not count an order the same employee closed at another branch", async () => {
    const shiftId = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertCompletedOrder(mainId, 1, 1_000_000, "2026-08-10T09:00:00Z", [
      { method: "cash", amount: 600_000 },
      { method: "card", amount: 400_000 },
    ]);
    // Same employee, same window, different branch — a second till they also
    // worked, or a colleague's shift they covered.
    await insertCompletedOrder(otherId, 2, 5_000_000, "2026-08-10T09:30:00Z", [
      { method: "card", amount: 5_000_000 },
    ]);

    const { rows } = await db.query<{
      shift_id: string;
      order_count: string;
      gross_total: string;
      card_total: string;
    }>(
      `SELECT shift_id, order_count, gross_total, card_total
         FROM v_employee_shift_reconciliation WHERE shift_id = $1`,
      [shiftId],
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].order_count)).toBe(1);
    expect(Number(rows[0].gross_total)).toBe(1_000_000);
    expect(Number(rows[0].card_total)).toBe(400_000);
  });

  it("still counts a split bill once, with its full gross and both tenders", async () => {
    const shiftId = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertCompletedOrder(mainId, 1, 1_000_000, "2026-08-10T09:00:00Z", [
      { method: "cash", amount: 600_000 },
      { method: "card", amount: 400_000 },
    ]);

    const { rows } = await db.query<{ order_count: string; gross_total: string }>(
      `SELECT order_count, gross_total FROM v_employee_shift_reconciliation WHERE shift_id = $1`,
      [shiftId],
    );
    expect(Number(rows[0].order_count)).toBe(1);
    expect(Number(rows[0].gross_total)).toBe(1_000_000);
  });
});
