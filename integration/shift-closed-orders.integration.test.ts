/**
 * "Closed this shift" on the orders screen, against a real database — both
 * halves are DB-touching (`branchShiftStartedAt` in shift-service.ts,
 * `listSettledOrdersInWindow` in order-read-service.ts) and so are not unit tested
 * directly, per repo convention.
 *
 * The list is bucketed by when an order was *opened*, not when it was paid, so
 * a bill carried across a cash-up stays with the shift that opened it. Cases 9
 * and 10 below are that rule from both ends; everything before them is the
 * window itself, unchanged.
 *
 * What GET /api/orders?scope=shift promises, and what this pins down:
 *   1. with nobody clocked in the window is still today's business day — the
 *      case that shipped broken, since a business whose staff never clock in
 *      (and an owner, who *cannot*) saw a permanently empty list;
 *   2. a shift that began earlier than today — one that crossed local midnight
 *      — widens the window back to its start instead of truncating at 00:00;
 *   3. a shift that began part-way through today does not narrow it, so a
 *      cashier clocking in at 14:00 still sees the morning's orders;
 *   4. a shift row with no branch of its own still counts for the branch it is
 *      *attributable* to — rows written before openShift recorded a fallback
 *      branch have none, and dropping them is what made the list empty for a
 *      clocked-in cashier. Issue #933 tightened the rule: the row resolves
 *      through `app_shift_attribution_branch` (this employee's home branch
 *      here), never through "NULL belongs to every branch";
 *   5. yesterday's orders are not today's;
 *   6. voided orders are listed alongside completed ones, newest close first,
 *      and open ones are left to the queue;
 *   7. another branch's closed orders are never listed;
 *   8. the shift picker an owner/manager gets: the branch's shifts as options,
 *      one shift's own closed orders bounded by its end, and no foreign
 *      branch's shift among the options;
 *   9. a bill opened before the window and settled inside it is *not* listed —
 *      the new shift is not credited with a sale it did not make;
 *  10. a bill opened inside a shift and settled after that shift ended *is*
 *      listed for it — the other half of the same rule, and the reason the two
 *      cannot be expressed as one bound on `closed_at`.
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

/** Imported after DATABASE_URL is pointed at the scratch DB. */
let orderRead: typeof import("../src/lib/order-read-service");
let shiftService: typeof import("../src/lib/shift-service");
let shiftOrders: typeof import("../src/lib/shift-orders-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let employeeId = "";
let orderNumber = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

/** A user plus its employees row — employee_shifts.employee_id references employees (migration 0042). */
async function seedEmployee(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    // Home branch = Main. Legacy branch-less shifts are attributed through it
    // (issue #933), which is what makes case 4 below meaningful in a
    // two-branch tenant.
    `INSERT INTO users (business_id, role, full_name, email, pin_hash, location_id)
     VALUES ($1, 'cashier', 'نگار سلطانی', $2, 'x', $3) RETURNING id`,
    [businessId, `cashier-${randomUUID().slice(0, 8)}@example.com`, mainId],
  );
  const id = rows[0].id;
  await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2)", [id, businessId]);
  return id;
}

async function insertShift(
  locationId: string,
  startedAt: string,
  endedAt: string | null,
  employee = employeeId,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_shifts
       (employee_id, business_id, location_id, business_date, started_at, ended_at)
     VALUES ($1, $2, $3, $4::timestamptz::date, $4, $5)
     RETURNING id`,
    [employee, businessId, locationId, startedAt, endedAt],
  );
  return rows[0].id;
}

/** One order, closed (or left open when `closedAt` is null) the way the app closes it. */
async function insertOrder(
  locationId: string,
  opts: {
    openedAt: string;
    closedAt?: string | null;
    status?: "open" | "completed" | "voided";
    total?: number;
  },
): Promise<number> {
  orderNumber += 1;
  const number = orderNumber;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
     VALUES ($1, $2, 'dine_in', 'open', $3, $4)
     RETURNING id`,
    [locationId, number, opts.total ?? 500_000, opts.openedAt],
  );
  if (opts.closedAt) {
    await db.query("UPDATE orders SET status = $2, closed_at = $3 WHERE id = $1", [
      rows[0].id,
      opts.status ?? "completed",
      opts.closedAt,
    ]);
  }
  return number;
}

/** The pair the route runs: the branch's window, then what closed inside it. */
async function closedThisShift(locationId: string): Promise<number[]> {
  return dbLib.withTenant(businessId, async () => {
    const { since } = await shiftService.branchClosedOrdersWindow(locationId);
    const rows = await orderRead.listSettledOrdersInWindow(locationId, since);
    return rows.map((row) => Number((row as { order_number: string }).order_number));
  });
}

beforeAll(async () => {
  databaseName = `pos_shift_closed_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  orderRead = await import("../src/lib/order-read-service");
  shiftService = await import("../src/lib/shift-service");
  shiftOrders = await import("../src/lib/shift-orders-service");
  dbLib = await import("../src/lib/db");

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

beforeEach(async () => {
  // Reopened first: the order_not_open guard (migration 0036) rejects deleting a
  // closed order's rows, including the cascade from businesses.
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");
  orderNumber = 0;

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

/** Midnight tonight/last night in the branch's timezone, as the DB computes it. */
async function dayStart(offsetDays = 0): Promise<Date> {
  const { rows } = await db.query<{ at: Date }>(
    `SELECT (date_trunc('day', now() AT TIME ZONE l.timezone) + make_interval(days => $2))
              AT TIME ZONE l.timezone AS at
       FROM locations l WHERE l.id = $1`,
    [mainId, offsetDays],
  );
  return rows[0].at;
}

/** `minutes` after the start of today (negative reaches back into yesterday). */
async function today(minutes: number): Promise<string> {
  const start = await dayStart();
  return new Date(start.getTime() + minutes * 60_000).toISOString();
}

describe("branchClosedOrdersWindow", () => {
  it("falls back to today's business day when nobody is clocked in", async () => {
    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.shiftStartedAt).toBeNull();
    expect(window.since).toBe((await dayStart()).toISOString());
  });

  it("widens to a shift that began before today, so a night shift stays whole", async () => {
    const startedAt = await today(-3 * 60); // 21:00 yesterday
    await insertShift(mainId, startedAt, null);

    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.shiftStartedAt).toBe(new Date(startedAt).toISOString());
    expect(window.since).toBe(new Date(startedAt).toISOString());
  });

  it("is not narrowed by a shift that began part-way through today", async () => {
    const startedAt = await today(9 * 60); // clocked in at 09:00
    await insertShift(mainId, startedAt, null);

    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.shiftStartedAt).toBe(new Date(startedAt).toISOString());
    expect(window.since).toBe((await dayStart()).toISOString());
  });

  it("counts a branch-less open shift attributed to this branch", async () => {
    const startedAt = await today(-2 * 60);
    await db.query(
      `INSERT INTO employee_shifts
         (employee_id, business_id, location_id, business_date, started_at)
       VALUES ($1, $2, NULL, $3::timestamptz::date, $3)`,
      [employeeId, businessId, startedAt],
    );

    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.shiftStartedAt).toBe(new Date(startedAt).toISOString());
  });

  it("ignores a shift that has already ended", async () => {
    await insertShift(mainId, await today(-4 * 60), await today(-60));

    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.shiftStartedAt).toBeNull();
    expect(window.since).toBe((await dayStart()).toISOString());
  });
});

describe("the branch's closed orders", () => {
  it("lists today's even with nobody clocked in", async () => {
    const number = await insertOrder(mainId, {
      openedAt: await today(60),
      closedAt: await today(90),
    });

    expect(await closedThisShift(mainId)).toEqual([number]);
  });

  it("lists what was closed before a mid-day clock-in", async () => {
    const morning = await insertOrder(mainId, {
      openedAt: await today(8 * 60),
      closedAt: await today(9 * 60),
    });
    await insertShift(mainId, await today(14 * 60), null);

    expect(await closedThisShift(mainId)).toEqual([morning]);
  });

  it("keeps a night shift's orders from before local midnight", async () => {
    await insertShift(mainId, await today(-4 * 60), null);
    const lastNight = await insertOrder(mainId, {
      openedAt: await today(-3 * 60),
      closedAt: await today(-2 * 60),
    });

    expect(await closedThisShift(mainId)).toEqual([lastNight]);
  });

  it("excludes yesterday's orders when no shift reaches back that far", async () => {
    await insertOrder(mainId, {
      openedAt: await today(-10 * 60),
      closedAt: await today(-9 * 60),
    });
    const todays = await insertOrder(mainId, {
      openedAt: await today(30),
      closedAt: await today(45),
    });

    expect(await closedThisShift(mainId)).toEqual([todays]);
  });

  it("lists newest close first, keeps voided, and leaves open ones to the queue", async () => {
    const first = await insertOrder(mainId, {
      openedAt: await today(60),
      closedAt: await today(90),
    });
    const voided = await insertOrder(mainId, {
      openedAt: await today(120),
      closedAt: await today(150),
      status: "voided",
    });
    await insertOrder(mainId, { openedAt: await today(180) });

    expect(await closedThisShift(mainId)).toEqual([voided, first]);
  });

  it("never lists another branch's closed orders", async () => {
    await insertOrder(otherId, {
      openedAt: await today(60),
      closedAt: await today(90),
    });

    expect(await closedThisShift(mainId)).toEqual([]);
  });

  /**
   * The carried-over table: last night's bill that nobody could settle before
   * the shift ended, finally paid this morning. It is last night's sale — that
   * shift seated the guests and rang the items in — so this morning's list must
   * not show it, even though the payment landed here. Keyed on `closed_at` it
   * appeared in both, and inflated whichever shift happened to take the money.
   */
  it("leaves a bill opened before the window with the shift that opened it", async () => {
    const carriedOver = await insertOrder(mainId, {
      openedAt: await today(-3 * 60), // 21:00 last night
      closedAt: await today(8 * 60), // settled at 08:00 today
    });
    const todays = await insertOrder(mainId, {
      openedAt: await today(9 * 60),
      closedAt: await today(10 * 60),
    });

    const listed = await closedThisShift(mainId);
    expect(listed).not.toContain(carriedOver);
    expect(listed).toEqual([todays]);
  });

  it("still lists a bill this window opened, however long it sat open", async () => {
    const lingering = await insertOrder(mainId, {
      openedAt: await today(30),
      closedAt: await today(23 * 60),
    });

    expect(await closedThisShift(mainId)).toEqual([lingering]);
  });
});

describe("reviewing one shift (the owner's picker)", () => {
  /** What the route does once a shift id resolves against the branch's options. */
  async function closedDuring(shiftId: string): Promise<number[]> {
    return dbLib.withTenant(businessId, async () => {
      const options = await shiftOrders.listRecentShiftOptions(mainId);
      const shift = options.find((option) => option.id === shiftId);
      if (!shift) return [];
      const rows = await orderRead.listSettledOrdersInWindow(mainId, shift.startedAt, {
        until: shift.endedAt,
      });
      return rows.map((row) => Number((row as { order_number: string }).order_number));
    });
  }

  it("offers the branch's shifts newest first, including a legacy branch-less row attributed to it", async () => {
    const older = await insertShift(mainId, await today(-6 * 60), await today(-5 * 60));
    const startedAt = await today(-2 * 60);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO employee_shifts
         (employee_id, business_id, location_id, business_date, started_at)
       VALUES ($1, $2, NULL, $3::timestamptz::date, $3)
       RETURNING id`,
      [employeeId, businessId, startedAt],
    );

    const options = await dbLib.withTenant(businessId, () =>
      shiftOrders.listRecentShiftOptions(mainId),
    );
    expect(options.map((option) => option.id)).toEqual([rows[0].id, older]);
    expect(options[0].employeeName).toBe("نگار سلطانی");
    expect(options[0].endedAt).toBeNull();
  });

  it("lists a finished shift's own closed orders, bounded by when it ended", async () => {
    const shift = await insertShift(mainId, await today(-6 * 60), await today(-4 * 60));
    await insertOrder(mainId, {
      openedAt: await today(-7 * 60),
      closedAt: await today(-6 * 60 - 1),
    });
    const during = await insertOrder(mainId, {
      openedAt: await today(-6 * 60),
      closedAt: await today(-5 * 60),
    });
    await insertOrder(mainId, {
      openedAt: await today(-4 * 60 + 1),
      closedAt: await today(-3 * 60),
    });

    expect(await closedDuring(shift)).toEqual([during]);
  });

  it("runs a still-open shift up to now rather than cutting it short", async () => {
    const shift = await insertShift(mainId, await today(-2 * 60), null);
    const settled = await insertOrder(mainId, {
      openedAt: await today(-90),
      closedAt: await today(-60),
    });

    expect(await closedDuring(shift)).toEqual([settled]);
  });

  /**
   * The same bill from the previous shift's side — the half that makes the
   * order recoverable rather than merely hidden. Bounding `closed_at` by the
   * shift's end used to drop it from here too, so a bill carried over belonged
   * to no shift's list at all: it vanished from the one that opened it and
   * surfaced under one that never saw the guests.
   */
  it("keeps a bill the shift opened but could not close, settled after it ended", async () => {
    const shift = await insertShift(mainId, await today(-6 * 60), await today(-4 * 60));
    const carriedOver = await insertOrder(mainId, {
      openedAt: await today(-5 * 60),
      closedAt: await today(-60), // long after the shift was cashed up
    });

    expect(await closedDuring(shift)).toEqual([carriedOver]);
  });

  it("does not credit the next shift with the bill the previous one opened", async () => {
    const previous = await insertShift(mainId, await today(-6 * 60), await today(-4 * 60));
    const next = await insertShift(mainId, await today(-4 * 60 + 1), null);
    const carriedOver = await insertOrder(mainId, {
      openedAt: await today(-5 * 60),
      closedAt: await today(-3 * 60), // paid during `next`
    });
    const ownWork = await insertOrder(mainId, {
      openedAt: await today(-2 * 60),
      closedAt: await today(-90),
    });

    expect(await closedDuring(previous)).toEqual([carriedOver]);
    expect(await closedDuring(next)).toEqual([ownWork]);
  });

  it("does not offer — or report on — another branch's shift", async () => {
    const foreign = await insertShift(
      otherId,
      await today(-3 * 60),
      null,
      await seedEmployee(),
    );
    await insertOrder(otherId, {
      openedAt: await today(-2 * 60),
      closedAt: await today(-60),
    });

    const options = await dbLib.withTenant(businessId, () =>
      shiftOrders.listRecentShiftOptions(mainId),
    );
    expect(options.map((option) => option.id)).not.toContain(foreign);
    expect(await closedDuring(foreign)).toEqual([]);
  });
});
