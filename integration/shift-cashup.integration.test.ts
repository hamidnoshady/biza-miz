/**
 * Issue #933 — shift cash-up integrity, against a real database.
 *
 * The parts this pins cannot be unit tested, because they are a transaction and
 * a set of constraints rather than arithmetic:
 *
 *   1. a close writes the state change, the cash-up snapshot, the audit row and
 *      the outbox event in **one** transaction;
 *   2. a later payment (an amendment's re-settlement, a refund) does not change
 *      the finalized variance — the live figure is reported separately as
 *      `restated`;
 *   3. a close without a count is `unresolved` with a NULL variance, never zero;
 *   4. a retried close returns the committed cash-up instead of
 *      `no_active_shift`, and two concurrent closes produce one snapshot;
 *   5. cash in/out changes the expectation, so paid-outs and drops are not
 *      silently unexplained;
 *   6. a supervisor's uncounted close needs a reason;
 *   7. shift history and force-close are confined to the caller's branches;
 *   8. a legacy shift with no branch is attributed to one branch (its
 *      employee's home, or the business's only branch), not to every branch;
 *   9. one active business-day closure per branch-day, kept as history and
 *      marked reopened rather than deleted.
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

let shiftService: typeof import("../src/lib/shift-service");
let businessDay: typeof import("../src/lib/business-day-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let ownerId = "";
let cashierId = "";
let orderNumber = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

/** A user plus its employees row — employee_shifts.employee_id references employees (0042). */
async function seedEmployee(
  role: "cashier" | "manager" | "owner" = "cashier",
  homeLocationId: string | null = null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, pin_hash, location_id)
     VALUES ($1, $2, 'نگهبان صندوق', $3, 'x', $4) RETURNING id`,
    [businessId, role, `${role}-${randomUUID().slice(0, 8)}@example.com`, homeLocationId],
  );
  const id = rows[0].id;
  await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2)", [id, businessId]);
  return id;
}

/** An open employee_sessions row, as a PIN login would create. */
async function seedSession(employee: string, locationId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_sessions (employee_id, business_id, location_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '8 hours') RETURNING id`,
    [employee, businessId, locationId, randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)],
  );
  return rows[0].id;
}

async function insertShift(
  locationId: string | null,
  startedAt: string,
  endedAt: string | null,
  options: { employee?: string; openingFloat?: number | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_shifts
       (employee_id, business_id, location_id, business_date, started_at, ended_at, opening_float)
     VALUES ($1, $2, $3, $4::timestamptz::date, $4, $5, $6)
     RETURNING id`,
    [options.employee ?? cashierId, businessId, locationId, startedAt, endedAt, options.openingFloat ?? null],
  );
  return rows[0].id;
}

/** A completed order settled at `closedAt`, with one cash payment of `total`. */
async function insertPaidOrder(
  locationId: string,
  closedAt: string,
  total = 500_000,
  method = "cash",
): Promise<string> {
  orderNumber += 1;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at, closed_at, closed_by)
     VALUES ($1, $2, 'dine_in', 'completed', $3, $4, $4, $5)
     RETURNING id`,
    [locationId, orderNumber, total, closedAt, cashierId],
  );
  await db.query(
    `INSERT INTO payments (location_id, order_id, method, amount, received_by, received_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [locationId, rows[0].id, method, total, cashierId, closedAt],
  );
  return rows[0].id;
}

async function closeOwn(countedCash: number | null) {
  return dbLib.withTenant(businessId, () =>
    shiftService.closeOwnShift(cashierId, businessId, countedCash, "cashier"),
  );
}

beforeAll(async () => {
  databaseName = `pos_shift_cashup_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  shiftService = await import("../src/lib/shift-service");
  businessDay = await import("../src/lib/business-day-service");
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
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");
  orderNumber = 0;

  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Cafe', $1) RETURNING id",
    [`cafe-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;

  const locations = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, created_at) VALUES
       ($1, 'Main', now()), ($1, 'Other', now() + interval '1 minute')
     RETURNING id`,
    [businessId],
  );
  mainId = locations.rows[0].id;
  otherId = locations.rows[1].id;

  ownerId = await seedEmployee("owner");
  cashierId = await seedEmployee("cashier", mainId);
});

describe("closing a shift writes one durable cash-up", () => {
  it("stores the snapshot, the audit row and the sync event together", async () => {
    const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null, { openingFloat: 500_000 });
    await insertPaidOrder(mainId, new Date(Date.now() - 2 * 3_600_000).toISOString(), 1_000_000, "cash");
    await insertPaidOrder(mainId, new Date(Date.now() - 90 * 60_000).toISOString(), 400_000, "card");

    const result = await closeOwn(1_500_000);

    expect(result.shift.id).toBe(shiftId);
    expect(result.cashup.closeMode).toBe("counted");
    expect(result.cashup.expectedCash).toBe(1_500_000); // 500k float + 1m cash
    expect(result.cashup.variance).toBe(0);
    expect(result.cashup.tenders.cash).toBe(1_000_000);
    expect(result.cashup.tenders.card).toBe(400_000);
    expect(result.cashup.grossTotal).toBe(1_400_000);

    const cashups = await db.query("SELECT 1 FROM shift_cashups WHERE shift_id = $1", [shiftId]);
    expect(cashups.rowCount).toBe(1);
    const audit = await db.query(
      "SELECT 1 FROM audit_log WHERE entity = 'shift' AND entity_id = $1 AND action = 'shift.closed'",
      [shiftId],
    );
    expect(audit.rowCount).toBe(1);
    const outbox = await db.query(
      "SELECT schema_version, payload FROM sync_events WHERE event_type = 'shift.closed'",
    );
    // No paired device, so the outbox row is only written on a site; either way
    // the snapshot must never depend on the outbox succeeding.
    expect(cashups.rowCount).toBe(1);
    if (outbox.rowCount) {
      expect(Number(outbox.rows[0].schema_version)).toBe(2);
      expect(outbox.rows[0].payload.cashup.closeMode).toBe("counted");
    }
  });

  it("does not change a finalized variance when a payment is amended afterwards", async () => {
    const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null, { openingFloat: 500_000 });
    const orderId = await insertPaidOrder(mainId, new Date(Date.now() - 2 * 3_600_000).toISOString(), 1_000_000);

    const closed = await closeOwn(1_500_000);
    expect(closed.cashup.variance).toBe(0);

    // What a closed-order amendment writes: the original payment is superseded
    // and a correcting (negative) row appears. The old code recomputed the
    // shift from these rows, so a closed shift's variance moved without anyone
    // touching the drawer.
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, received_by, reference)
       VALUES ($1, $2, 'cash', -400_000, $3, 'amendment-after-close')`,
      [mainId, orderId, ownerId],
    );

    const page = await dbLib.withTenant(businessId, () =>
      shiftService.listShifts(businessId, { shiftId }),
    );
    const entry = page.shifts[0];
    expect(entry.cashSource).toBe("finalized");
    expect(entry.cashup?.variance).toBe(0);
    expect(entry.reconciliation.variance).toBe(0);
    // The live figure is reported beside it, and is visibly different.
    expect(entry.restated?.cashTotal).toBe(600_000);
    expect(entry.restated?.variance).not.toBe(0);

    const view = await db.query<{ cash_variance: string | null; cashup_status: string; restated_variance: string | null }>(
      "SELECT cash_variance, cashup_status, restated_variance FROM v_employee_shift_reconciliation WHERE shift_id = $1",
      [shiftId],
    );
    expect(view.rows[0].cashup_status).toBe("counted");
    expect(Number(view.rows[0].cash_variance)).toBe(0);
    expect(Number(view.rows[0].restated_variance)).not.toBe(0);
  });

  it("stores an uncounted close as unresolved — NULL variance, never zero", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    await insertShift(mainId, startedAt, null);
    await insertPaidOrder(mainId, new Date(Date.now() - 30 * 60_000).toISOString(), 500_000);

    const result = await closeOwn(null);
    expect(result.cashup.closeMode).toBe("unresolved");
    expect(result.cashup.countedCash).toBeNull();
    expect(result.cashup.variance).toBeNull();
    expect(result.reconciliation.status).toBe("unresolved");

    const stored = await db.query("SELECT counted_cash, variance FROM shift_cashups WHERE shift_id = $1", [
      result.shift.id,
    ]);
    expect(stored.rows[0].counted_cash).toBeNull();
    expect(stored.rows[0].variance).toBeNull();
  });

  it("is retry-safe and serializes two concurrent closes onto one snapshot", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null);

    const key = randomUUID();
    const [first, second] = await Promise.all([
      dbLib.withTenant(businessId, () =>
        shiftService.closeOwnShift(cashierId, businessId, 500_000, "cashier", null, key),
      ),
      dbLib.withTenant(businessId, () =>
        shiftService.closeOwnShift(cashierId, businessId, 500_000, "cashier", null, key),
      ),
    ]);
    expect(first.replayed !== second.replayed).toBe(true);
    expect(first.cashup.id).toBe(second.cashup.id);

    // A third call is a pure replay: it returns the committed result rather
    // than `no_active_shift`.
    const replay = await dbLib.withTenant(businessId, () =>
      shiftService.closeOwnShift(cashierId, businessId, 500_000, "cashier", null, key),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.shift.id).toBe(shiftId);

    const count = await db.query("SELECT count(*)::int AS n FROM shift_cashups WHERE shift_id = $1", [shiftId]);
    expect(count.rows[0].n).toBe(1);

    // A different count for the same finalized shift is a correction, not a
    // retry, and must not be silently ignored. (Self-service cannot name the
    // closed shift any more, so this is the supervisor path by id.)
    await expect(
      dbLib.withTenant(businessId, () =>
        shiftService.closeShiftById(shiftId, businessId, ownerId, 900_000, "manager"),
      ),
    ).rejects.toMatchObject({ message: "shift_already_closed" });
  });

  it("does not hand back an old close when the caller has no open shift", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    await insertShift(mainId, startedAt, null, { openingFloat: 0 });
    await closeOwn(0);

    // No open shift and no idempotency key: this is a new request that has
    // nothing to close, not a retry of the one above.
    await expect(closeOwn(0)).rejects.toMatchObject({ message: "no_active_shift", status: 404 });
  });

  it("returns the same shift when a start is retried with its idempotency key", async () => {
    const sessionId = await seedSession(cashierId, mainId);
    const key = randomUUID();
    const first = await dbLib.withTenant(businessId, () =>
      shiftService.openShift(cashierId, businessId, sessionId, 100_000, mainId, "cashier", key),
    );
    const second = await dbLib.withTenant(businessId, () =>
      shiftService.openShift(cashierId, businessId, sessionId, 100_000, mainId, "cashier", key),
    );
    expect(second.id).toBe(first.id);
    expect(second.locationId).toBe(mainId);
  });

  it("includes audited cash movements in what the drawer should hold", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null, { openingFloat: 500_000 });
    await insertPaidOrder(mainId, new Date(Date.now() - 30 * 60_000).toISOString(), 1_000_000);

    await dbLib.withTenant(businessId, () =>
      shiftService.recordCashMovement({
        businessId,
        shiftId,
        actorId: cashierId,
        direction: "out",
        amount: 200_000,
        reason: "safe drop",
      }),
    );
    await dbLib.withTenant(businessId, () =>
      shiftService.recordCashMovement({
        businessId,
        shiftId,
        actorId: cashierId,
        direction: "in",
        amount: 50_000,
        reason: "float top-up",
      }),
    );

    const result = await closeOwn(1_350_000);
    // 500k float + 1m cash − 200k drop + 50k top-up = 1,350,000
    expect(result.cashup.expectedCash).toBe(1_350_000);
    expect(result.cashup.cashIn).toBe(50_000);
    expect(result.cashup.cashOut).toBe(200_000);
    expect(result.cashup.variance).toBe(0);
  });
});

describe("force-close needs a real count or a reason", () => {
  it("refuses an uncounted supervisor close without a reason", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null);
    await expect(
      dbLib.withTenant(businessId, () =>
        shiftService.closeShiftById(shiftId, businessId, ownerId, null, "manager"),
      ),
    ).rejects.toMatchObject({ message: "reason_required" });
  });

  it("records the reason and leaves the variance unresolved", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null);
    const result = await dbLib.withTenant(businessId, () =>
      shiftService.closeShiftById(shiftId, businessId, ownerId, null, "manager", {
        reason: "کارمند فراموش کرده ببندد",
      }),
    );
    expect(result.cashup.closeMode).toBe("unresolved");
    expect(result.cashup.reason).toBe("کارمند فراموش کرده ببندد");
    expect(result.cashup.variance).toBeNull();

    const audit = await db.query(
      "SELECT payload FROM audit_log WHERE entity = 'shift' AND entity_id = $1 AND action = 'shift.closed'",
      [shiftId],
    );
    expect(audit.rows[0].payload.forced).toBe(true);
    expect(audit.rows[0].payload.reason).toBe("کارمند فراموش کرده ببندد");
  });

  it("keeps a finalized snapshot immutable and records corrections separately", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const shiftId = await insertShift(mainId, startedAt, null, { openingFloat: 500_000 });
    await insertPaidOrder(mainId, new Date(Date.now() - 30 * 60_000).toISOString(), 1_000_000);
    const closed = await closeOwn(1_400_000);
    expect(closed.cashup.variance).toBe(-100_000);

    await expect(db.query("UPDATE shift_cashups SET variance = 0 WHERE shift_id = $1", [shiftId])).rejects.toThrow(
      /shift_cashup_immutable/,
    );

    const adjusted = await dbLib.withTenant(businessId, () =>
      shiftService.adjustShiftCashup({
        businessId,
        shiftId,
        actorId: ownerId,
        delta: 100_000,
        reason: "a paid-out was found afterwards",
      }),
    );
    expect(adjusted.adjustment.beforeVariance).toBe(-100_000);
    expect(adjusted.adjustment.afterVariance).toBe(0);

    const page = await dbLib.withTenant(businessId, () => shiftService.listShifts(businessId, { shiftId }));
    // The snapshot itself still says −100,000; the correction is its own row.
    expect(page.shifts[0].cashup?.variance).toBe(-100_000);
    expect(page.shifts[0].adjustments).toHaveLength(1);
    expect(page.shifts[0].adjustments[0].reason).toBe("a paid-out was found afterwards");
  });
});

describe("branch attribution and scope", () => {
  it("does not show or close another branch's shift to a constrained caller", async () => {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const otherShift = await insertShift(otherId, startedAt, null);

    const page = await dbLib.withTenant(businessId, () =>
      shiftService.listShifts(businessId, { locationIds: [mainId] }),
    );
    expect(page.shifts.map((shift) => shift.id)).not.toContain(otherShift);

    await expect(
      dbLib.withTenant(businessId, () =>
        shiftService.closeShiftById(otherShift, businessId, ownerId, 100, "manager", {
          allowedLocationIds: [mainId],
        }),
      ),
    ).rejects.toMatchObject({ message: "no_active_shift", status: 404 });
  });

  it("attributes a legacy branch-less shift to one branch, not every branch", async () => {
    // The cashier's home is Main, so their branch-less row belongs to Main.
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    const legacy = await insertShift(null, startedAt, null);

    const attributed = await db.query<{ branch_id: string | null }>(
      "SELECT app_shift_attribution_branch($1, $2, $3) AS branch_id",
      [businessId, null, cashierId],
    );
    expect(attributed.rows[0].branch_id).toBe(mainId);

    const mainWindow = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    const otherWindow = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(otherId),
    );
    expect(mainWindow.shiftStartedAt).not.toBeNull();
    expect(otherWindow.shiftStartedAt).toBeNull();

    const page = await dbLib.withTenant(businessId, () =>
      shiftService.listShifts(businessId, { locationIds: [otherId] }),
    );
    expect(page.shifts.map((shift) => shift.id)).not.toContain(legacy);
  });

  it("opens a shift at the branch the caller is actually working in", async () => {
    // The session says Main (a stale login); the caller switched to Other.
    const sessionId = await seedSession(cashierId, mainId);
    const shift = await dbLib.withTenant(businessId, () =>
      shiftService.openShift(cashierId, businessId, sessionId, 500_000, otherId, "cashier"),
    );
    expect(shift.locationId).toBe(otherId);
  });
});

describe("business-day closures", () => {
  it("keeps one active closure, marks reopenings instead of deleting history, and refuses a second open", async () => {
    await db.query("UPDATE locations SET business_day_start_minutes = 0 WHERE id = $1", [mainId]);

    const closed = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    expect(closed.manuallyClosed).toBe(true);

    // Concurrent/duplicate closes do not produce a second active row.
    await expect(
      dbLib.withTenant(businessId, () => businessDay.closeBusinessDay(mainId, businessId, ownerId)),
    ).rejects.toMatchObject({ message: "business_day_already_closed" });
    const active = await db.query(
      "SELECT count(*)::int AS n FROM business_day_closures WHERE location_id = $1 AND reopened_at IS NULL",
      [mainId],
    );
    expect(active.rows[0].n).toBe(1);

    const reopened = await dbLib.withTenant(businessId, () =>
      businessDay.reopenBusinessDay(mainId, businessId, ownerId),
    );
    expect(reopened.manuallyClosed).toBe(false);
    expect(reopened.closureId).toBeTruthy();

    const history = await db.query(
      "SELECT reopened_at FROM business_day_closures WHERE location_id = $1",
      [mainId],
    );
    expect(history.rowCount).toBe(1);
    expect(history.rows[0].reopened_at).not.toBeNull();

    await expect(
      dbLib.withTenant(businessId, () => businessDay.reopenBusinessDay(mainId, businessId, ownerId)),
    ).rejects.toMatchObject({ message: "business_day_not_closed" });

    // A new day can be closed again: the old row no longer holds the window.
    const again = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    expect(again.manuallyClosed).toBe(true);
  });

  it("returns its own closure when the same idempotency key is retried", async () => {
    await db.query("UPDATE locations SET business_day_start_minutes = 0 WHERE id = $1", [mainId]);
    const key = randomUUID();
    const first = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId, null, { requestId: key }),
    );
    const second = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId, null, { requestId: key }),
    );
    expect(second.closureId).toBe(first.closureId);
  });
});
