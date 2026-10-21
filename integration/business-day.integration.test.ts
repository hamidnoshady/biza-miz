/**
 * The business day (روز کاری) against a real database — the whole point of the
 * feature is a date rule that PostgreSQL evaluates, so nothing here can be
 * usefully unit tested (the arithmetic-free half is business-day.test.ts).
 *
 * What this pins down, using the case that motivated it — a café trading
 * 18:00 → 03:00, business day starting at 18:00:
 *   1. an order rung after local midnight keeps the *previous* date's business
 *      day, so one night's service is one report row instead of two;
 *   2. the reporting views agree with that, since they all derive their date
 *      from the same function;
 *   3. the orders screen's window covers the whole service across midnight,
 *      and does not reset at 00:00 the way the calendar day did;
 *   4. closing the day by hand at 03:00 empties that window immediately, and
 *      the next evening's service starts from zero;
 *   5. a closure expires on its own once the next business day begins, so
 *      nothing has to be cleaned up;
 *   6. reopening undoes a close taken by mistake;
 *   7. closures never move a sale between report rows — the 04:00 order after a
 *      03:00 close is still filed under the business day it was sold in;
 *   8. a branch that has configured no business day behaves exactly as it did
 *      before this feature existed, calendar day and open-shift widening
 *      included;
 *   9. the business day is per branch: configuring one leaves the other alone;
 *  10. `businessToday` — the business-wide date the cross-server rollup and the
 *      AI assistant's default range anchor on — follows the same rule, instead
 *      of the calendar day it used to name;
 *  11. the cash-up ends the night: once the branch's last shift is closed the
 *      live window starts there, so the board is zero for the rest of the day
 *      instead of showing last night's takings until 18:00 comes round — the
 *      bug this feature shipped with — while a cash-up with a colleague still
 *      clocked in is treated as a handover and changes nothing.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { postgresDateToIso } from "../src/lib/jalali";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const TEHRAN = "Asia/Tehran";
/** 18:00 — the business day the example café works to. */
const SIX_PM = 18 * 60;

let databaseName: string;
let db: Client;

let businessDay: typeof import("../src/lib/business-day-service");
let rollup: typeof import("../src/lib/rollup-service");
let orderRead: typeof import("../src/lib/order-read-service");
let shiftService: typeof import("../src/lib/shift-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let ownerId = "";
let orderNumber = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

/** A Tehran wall-clock time as the instant it names — the same conversion the SQL does. */
async function tehran(local: string): Promise<Date> {
  const { rows } = await db.query<{ at: Date }>(
    "SELECT ($1::timestamp AT TIME ZONE $2) AS at",
    [local, TEHRAN],
  );
  return rows[0].at;
}

async function setStart(
  locationId: string,
  startMinutes: number | null,
): Promise<void> {
  await db.query(
    "UPDATE locations SET business_day_start_minutes = $2 WHERE id = $1",
    [locationId, startMinutes],
  );
}

/** A user plus its employees row — employee_shifts.employee_id references employees (migration 0042). */
async function seedEmployee(homeLocationId?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, pin_hash, location_id)
     VALUES ($1, 'cashier', 'صندوق‌دار', $2, 'x', $3) RETURNING id`,
    [businessId, `cashier-${randomUUID().slice(0, 8)}@example.com`, homeLocationId ?? null],
  );
  const id = rows[0].id;
  await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2)", [id, businessId]);
  return id;
}

/** A shift on the branch, already closed unless `endedAt` is null. */
async function insertShift(
  locationId: string | null,
  startedAt: Date,
  endedAt: Date | null,
  homeLocationId?: string,
): Promise<string> {
  const employee = await seedEmployee(homeLocationId);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_shifts
       (employee_id, business_id, location_id, business_date, started_at, ended_at)
     VALUES ($1, $2, $3, $4::timestamptz::date, $4, $5)
     RETURNING id`,
    [employee, businessId, locationId, startedAt, endedAt],
  );
  return rows[0].id;
}

async function insertOrder(
  locationId: string,
  closedAt: Date,
  total = 500_000,
): Promise<number> {
  orderNumber += 1;
  const number = orderNumber;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
     VALUES ($1, $2, 'dine_in', 'open', $3, $4)
     RETURNING id`,
    [locationId, number, total, closedAt],
  );
  await db.query(
    "UPDATE orders SET status = 'completed', closed_at = $2, closed_by = $3 WHERE id = $1",
    [rows[0].id, closedAt, ownerId],
  );
  return number;
}

/** The pair the orders route runs: the branch's window, then what closed inside it. */
async function closedInWindow(locationId: string): Promise<number[]> {
  return dbLib.withTenant(businessId, async () => {
    const { since } = await shiftService.branchClosedOrdersWindow(locationId);
    const rows = await orderRead.listSettledOrdersInWindow(locationId, since);
    return rows.map((row) =>
      Number((row as { order_number: string }).order_number),
    );
  });
}

/** `v_sales_by_day` grouped the way a report reads it: business date → order count. */
async function salesByDay(locationId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ sale_date: Date; order_count: string }>(
    "SELECT sale_date, order_count FROM v_sales_by_day WHERE location_id = $1 ORDER BY sale_date",
    [locationId],
  );
  return Object.fromEntries(
    rows.map((row) => [
      // sale_date is a Postgres `date` — local components, not toISOString()
      // (see postgresDateToIso; toISOString shifts a day on runners east of UTC).
      postgresDateToIso(row.sale_date),
      Number(row.order_count),
    ]),
  );
}

beforeAll(async () => {
  databaseName = `pos_business_day_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  businessDay = await import("../src/lib/business-day-service");
  rollup = await import("../src/lib/rollup-service");
  orderRead = await import("../src/lib/order-read-service");
  shiftService = await import("../src/lib/shift-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
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
    // One statement gives both rows the same created_at, and the "primary
    // branch" is the oldest one; Other is dated a minute later so Main wins the
    // pick every run instead of whichever row the planner returns first.
    `INSERT INTO locations (business_id, name, timezone, created_at)
     VALUES ($1, 'Main', $2, now()), ($1, 'Other', $2, now() + interval '1 minute')
     RETURNING id, name`,
    [businessId, TEHRAN],
  );
  mainId = locations.rows.find((row) => row.name === "Main")!.id;
  otherId = locations.rows.find((row) => row.name === "Other")!.id;

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مالک', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.com`],
  );
  ownerId = owner.rows[0].id;
});

describe("the business-day date rule", () => {
  it("keeps an after-midnight sale on the business day it was sold in", async () => {
    await setStart(mainId, SIX_PM);
    const { rows } = await db.query<{
      evening: Date;
      small_hours: Date;
      next_evening: Date;
    }>(
      `SELECT app_business_date(($1::timestamp AT TIME ZONE $4), $4, $5) AS evening,
              app_business_date(($2::timestamp AT TIME ZONE $4), $4, $5) AS small_hours,
              app_business_date(($3::timestamp AT TIME ZONE $4), $4, $5) AS next_evening`,
      [
        "2026-08-16 20:00",
        "2026-08-17 01:30",
        "2026-08-17 19:00",
        TEHRAN,
        SIX_PM,
      ],
    );
    // node-postgres returns Postgres `date` values as local-midnight Dates, so
    // the calendar date is its local components, not toISOString() (which is a
    // day early on any runner east of UTC — see postgresDateToIso).
    const day = (value: Date) => postgresDateToIso(value);
    expect(day(rows[0].evening)).toBe("2026-08-16");
    expect(day(rows[0].small_hours)).toBe("2026-08-16");
    expect(day(rows[0].next_evening)).toBe("2026-08-17");
  });

  it("is the calendar day, unchanged, for a branch that configured none", async () => {
    const { rows } = await db.query<{ configured: Date; plain: Date }>(
      `SELECT app_business_date(($1::timestamp AT TIME ZONE $2), $2, NULL) AS configured,
              (($1::timestamp AT TIME ZONE $2) AT TIME ZONE $2)::date       AS plain`,
      ["2026-08-17 01:30", TEHRAN],
    );
    expect(postgresDateToIso(rows[0].configured)).toBe(
      postgresDateToIso(rows[0].plain),
    );
  });

  it("files one 18:00→03:00 service as a single row in the reporting views", async () => {
    await setStart(mainId, SIX_PM);
    await insertOrder(mainId, await tehran("2026-08-16 20:00"));
    await insertOrder(mainId, await tehran("2026-08-16 23:45"));
    await insertOrder(mainId, await tehran("2026-08-17 02:30"));
    await insertOrder(mainId, await tehran("2026-08-17 19:00"));

    expect(await salesByDay(mainId)).toEqual({
      "2026-08-16": 3,
      "2026-08-17": 1,
    });
  });

  it("splits that same service in two when no business day is configured", async () => {
    await insertOrder(mainId, await tehran("2026-08-16 20:00"));
    await insertOrder(mainId, await tehran("2026-08-16 23:45"));
    await insertOrder(mainId, await tehran("2026-08-17 02:30"));

    expect(await salesByDay(mainId)).toEqual({
      "2026-08-16": 2,
      "2026-08-17": 1,
    });
  });

  it("re-buckets history when management changes the start time, without moving orders", async () => {
    await insertOrder(mainId, await tehran("2026-08-17 02:30"));
    expect(await salesByDay(mainId)).toEqual({ "2026-08-17": 1 });

    await setStart(mainId, SIX_PM);
    expect(await salesByDay(mainId)).toEqual({ "2026-08-16": 1 });

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) FROM orders",
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("is per branch — configuring one leaves the other on the calendar day", async () => {
    await setStart(mainId, SIX_PM);
    const closedAt = await tehran("2026-08-17 02:30");
    await insertOrder(mainId, closedAt);
    await insertOrder(otherId, closedAt);

    expect(await salesByDay(mainId)).toEqual({ "2026-08-16": 1 });
    expect(await salesByDay(otherId)).toEqual({ "2026-08-17": 1 });
  });
});

describe("the live window the dashboard and orders screen read", () => {
  /**
   * The window is anchored on `now()`, so these exercise it by placing orders
   * relative to the business day currently in progress rather than by freezing
   * a clock the database does not share.
   */
  async function currentWindow(locationId: string) {
    return dbLib.withTenant(businessId, () =>
      businessDay.getBusinessDayStatus(locationId),
    );
  }

  it("reports the day in progress, its bounds, and where counting starts", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;

    expect(status.enabled).toBe(true);
    expect(status.startMinutes).toBe(SIX_PM);
    expect(status.manuallyClosed).toBe(false);
    expect(status.windowStart).toBe(status.scheduledStart);
    expect(
      Date.parse(status.scheduledEnd) - Date.parse(status.scheduledStart),
    ).toBe(24 * 60 * 60 * 1000);
    // now() is inside the day it reports.
    expect(Date.parse(status.scheduledStart)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(status.scheduledEnd)).toBeGreaterThan(Date.now());
  });

  it("keeps the whole service in the orders list across local midnight", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    const dayStart = Date.parse(status.scheduledStart);

    // An order just after the day began, and one "later in the service".
    const early = await insertOrder(mainId, new Date(dayStart + 60_000));
    const later = await insertOrder(
      mainId,
      new Date(dayStart + 2 * 60 * 60 * 1000),
    );
    // One from the previous business day, which must not appear.
    await insertOrder(mainId, new Date(dayStart - 60 * 60 * 1000));

    expect((await closedInWindow(mainId)).sort()).toEqual(
      [early, later].sort(),
    );
  });

  it("empties the window the moment management closes the day", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    await insertOrder(
      mainId,
      new Date(Date.parse(status.scheduledStart) + 60_000),
    );
    expect(await closedInWindow(mainId)).toHaveLength(1);

    const closed = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    expect(closed.manuallyClosed).toBe(true);
    expect(Date.parse(closed.windowStart)).toBeGreaterThan(
      Date.parse(closed.scheduledStart),
    );
    expect(await closedInWindow(mainId)).toEqual([]);
  });

  it("counts what is sold after an early close into the fresh window", async () => {
    await setStart(mainId, SIX_PM);
    const closed = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    const afterClose = await insertOrder(
      mainId,
      new Date(Date.parse(closed.windowStart) + 60_000),
    );

    expect(await closedInWindow(mainId)).toEqual([afterClose]);
  });

  it("still files that post-close sale under the business day it happened in", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    await insertOrder(mainId, new Date(Date.now() + 1_000));

    // Closing the day moves what is on screen, never what a report totals.
    expect(await salesByDay(mainId)).toEqual({ [status.businessDate]: 1 });
  });

  it("refuses a second close, and reopening restores the scheduled start", async () => {
    await setStart(mainId, SIX_PM);
    await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    await expect(
      dbLib.withTenant(businessId, () =>
        businessDay.closeBusinessDay(mainId, businessId, ownerId),
      ),
    ).rejects.toThrow("business_day_already_closed");

    const reopened = await dbLib.withTenant(businessId, () =>
      businessDay.reopenBusinessDay(mainId, businessId, ownerId),
    );
    expect(reopened.manuallyClosed).toBe(false);
    expect(reopened.windowStart).toBe(reopened.scheduledStart);
  });

  it("lets a closure expire on its own once the next business day starts", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    // A close recorded during the *previous* business day: still on file, but
    // it no longer holds the window, so nothing needs cleaning up.
    await db.query(
      `INSERT INTO business_day_closures (business_id, location_id, business_date, closed_at, closed_by)
       VALUES ($1, $2, $3::date - 1, $4::timestamptz - interval '1 day', $5)`,
      [businessId, mainId, status.businessDate, status.scheduledStart, ownerId],
    );

    const now = (await currentWindow(mainId))!;
    expect(now.manuallyClosed).toBe(false);
    expect(now.windowStart).toBe(now.scheduledStart);
    expect(now.lastClosedAt).not.toBeNull();
  });

  it("refuses to close a day for a branch that has configured none", async () => {
    await expect(
      dbLib.withTenant(businessId, () =>
        businessDay.closeBusinessDay(mainId, businessId, ownerId),
      ),
    ).rejects.toThrow("business_day_not_configured");
  });

  it("leaves an unconfigured branch on the calendar day, open shift widening included", async () => {
    const status = (await currentWindow(mainId))!;
    expect(status.enabled).toBe(false);

    // Local midnight, which is what the window used to (and must still) anchor on.
    const { rows } = await db.query<{ at: Date }>(
      "SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS at",
      [TEHRAN],
    );
    expect(status.windowStart).toBe(rows[0].at.toISOString());

    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.since).toBe(rows[0].at.toISOString());
    expect(window.businessDay).toBeNull();
  });
});

describe("the business-wide date other sections anchor on", () => {
  /**
   * `businessToday` is what the cross-server rollup and the AI assistant reach
   * for when they have a business but no particular branch. It used to be the
   * calendar day even where the reporting views it feeds had already moved on
   * to business days, so the two named different days for a third of every
   * night service.
   */
  it("matches the primary branch's own business day", async () => {
    await setStart(mainId, SIX_PM);

    const [wide, branch] = await dbLib.withTenant(businessId, async () => [
      await businessDay.businessToday(businessId),
      await businessDay.getBusinessDayStatus(mainId),
    ]);
    expect(wide).toBe(branch!.businessDate);
  });

  it("is the calendar day for a business that configured none", async () => {
    const { rows } = await db.query<{ today: string }>(
      "SELECT (now() AT TIME ZONE $1)::date::text AS today",
      [TEHRAN],
    );
    const wide = await dbLib.withTenant(businessId, () => businessDay.businessToday(businessId));
    expect(wide).toBe(rows[0].today);
  });

  it("takes the oldest active branch, the same one the rollup takes its timezone from", async () => {
    // Only the *other* branch is configured, so a wrong pick would show up here.
    await setStart(otherId, SIX_PM);
    const { rows } = await db.query<{ today: string }>(
      "SELECT (now() AT TIME ZONE $1)::date::text AS today",
      [TEHRAN],
    );
    const wide = await dbLib.withTenant(businessId, () => businessDay.businessToday(businessId));
    expect(wide).toBe(rows[0].today);
  });

  it("still answers for a business with no active branch at all", async () => {
    await db.query("UPDATE locations SET is_active = false WHERE business_id = $1", [businessId]);
    const wide = await dbLib.withTenant(businessId, () => businessDay.businessToday(businessId));
    expect(wide).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is what the rollup's getBusinessToday now reports", async () => {
    await setStart(mainId, SIX_PM);
    const [wide, rollupToday] = await dbLib.withTenant(businessId, async () => [
      await businessDay.businessToday(businessId),
      await rollup.getBusinessToday(businessId),
    ]);
    expect(rollupToday).toBe(wide);
  });
});

describe("the cash-up is what ends the night", () => {
  /**
   * The bug this feature shipped with, reported from a real deployment: at
   * 11:23 the next morning the dashboard still showed the previous night's
   * eleven orders, because on the clock alone an 18:00→18:00 business day was
   * still running. Nothing about a start time can say "the service is over" —
   * the cashier closing the till can.
   */
  async function status(locationId: string) {
    return dbLib.withTenant(businessId, () => businessDay.getBusinessDayStatus(locationId));
  }

  /**
   * A sale, and the cash-up that came after it, both inside the service that is
   * running right now.
   *
   * Pinning either end to a fixed hour — "a sale an hour into the day", "a
   * cash-up an hour ago" — only holds when the suite happens to run well into
   * the night. Run it between 18:00 and 20:00 Tehran and "an hour ago" lands
   * *before* the sale it is supposed to have followed, which inverts the very
   * ordering these tests are about and fails them for two hours out of every
   * day. Splitting the elapsed part of the day keeps the sequence
   * `day start → sale → cash-up → now` true at every hour of the clock.
   */
  function nightSoFar(dayStart: number): { sale: Date; cashUp: Date } {
    // Clamped only so the two instants stay distinct if the day began
    // milliseconds ago; at any real hour `elapsed` is the whole service.
    const elapsed = Math.max(Date.now() - dayStart, 4);
    return {
      sale: new Date(dayStart + Math.floor(elapsed / 4)),
      cashUp: new Date(dayStart + Math.floor(elapsed / 2)),
    };
  }

  it("zeroes the live window once the branch's last shift is closed", async () => {
    await setStart(mainId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    const { sale, cashUp } = nightSoFar(dayStart);

    await insertOrder(mainId, sale);
    expect(await closedInWindow(mainId)).toHaveLength(1);

    // The cashier works the night and cashes up after that sale.
    await insertShift(mainId, new Date(dayStart), cashUp);

    const after = (await status(mainId))!;
    expect(after.closedBy).toBe("shift");
    expect(after.windowStart).toBe(cashUp.toISOString());
    expect(after.hasOpenShift).toBe(false);
    // The morning after: the board is empty, which is the whole point.
    expect(await closedInWindow(mainId)).toEqual([]);
  });

  it("leaves the night running when a colleague is still clocked in", async () => {
    await setStart(mainId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    const { sale, cashUp } = nightSoFar(dayStart);
    await insertOrder(mainId, sale);

    // A handover: one cashier out, the next already on the floor.
    await insertShift(mainId, new Date(dayStart), cashUp);
    await insertShift(mainId, cashUp, null);

    const after = (await status(mainId))!;
    expect(after.hasOpenShift).toBe(true);
    expect(after.closedBy).toBeNull();
    expect(after.windowStart).toBe(after.scheduledStart);
    expect(await closedInWindow(mainId)).toHaveLength(1);
  });

  it("keeps every pre-cash-up sale in the reports", async () => {
    await setStart(mainId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    const { sale, cashUp } = nightSoFar(dayStart);
    await insertOrder(mainId, sale);
    await insertShift(mainId, new Date(dayStart), cashUp);

    // Zero on screen, untouched in the books: closing the till resets a view,
    // it never moves money between report rows.
    expect(await closedInWindow(mainId)).toEqual([]);
    expect(await salesByDay(mainId)).toEqual({ [open.businessDate]: 1 });
  });

  it("ignores a cash-up from a previous business day", async () => {
    await setStart(mainId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    await insertShift(
      mainId,
      new Date(dayStart - 26 * 60 * 60 * 1000),
      new Date(dayStart - 20 * 60 * 60 * 1000),
    );

    const after = (await status(mainId))!;
    expect(after.closedBy).toBeNull();
    expect(after.windowStart).toBe(after.scheduledStart);
  });

  it("counts a branchless shift homed at this branch (#912 item 7)", async () => {
    await setStart(mainId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    const { cashUp } = nightSoFar(dayStart);
    await insertShift(null, new Date(dayStart), cashUp, mainId);

    const after = (await status(mainId))!;
    expect(after.closedBy).toBe("shift");
    expect(after.windowStart).toBe(cashUp.toISOString());
  });

  it("does not let a branchless shift homed at another branch reset this branch (#912 item 7)", async () => {
    await setStart(mainId, SIX_PM);
    await setStart(otherId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    const { cashUp } = nightSoFar(dayStart);
    await insertShift(null, new Date(dayStart), cashUp, otherId);

    const main = (await status(mainId))!;
    expect(main.closedBy).toBeNull();
    expect(main.lastShiftEndedAt).toBeNull();
    expect(main.windowStart).toBe(main.scheduledStart);

    // …while the branch it is homed at does see its own cash-up.
    const other = (await status(otherId))!;
    expect(other.closedBy).toBe("shift");
    expect(other.windowStart).toBe(cashUp.toISOString());
  });

  it("ignores an unattributable branchless shift in a multi-branch tenant (#912 item 7)", async () => {
    await setStart(mainId, SIX_PM);
    const open = (await status(mainId))!;
    const dayStart = Date.parse(open.scheduledStart);
    const { cashUp } = nightSoFar(dayStart);
    // No home branch and no assignment: in a two-branch business this row
    // cannot be honestly attributed, so it moves no branch's window.
    await insertShift(null, new Date(dayStart), cashUp);

    const after = (await status(mainId))!;
    expect(after.closedBy).toBeNull();
    expect(after.lastShiftEndedAt).toBeNull();
  });

  it("changes nothing for a branch with no business day configured", async () => {
    const open = (await status(mainId))!;
    await insertShift(mainId, new Date(Date.now() - 6 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const after = (await status(mainId))!;
    expect(after.enabled).toBe(false);
    expect(after.closedBy).toBeNull();
    expect(after.windowStart).toBe(open.scheduledStart);
  });
});
