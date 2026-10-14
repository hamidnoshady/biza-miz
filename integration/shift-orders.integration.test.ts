/**
 * Shift-order review (the reports tab's "سفارش‌های شیفت"), against a real
 * database — shift-orders-service.ts joins orders/order_items and is not unit
 * tested directly, per repo convention; the grouping rule it delegates to is
 * covered by src/lib/shift-orders.test.ts.
 *
 * What the picker promises, and what this pins down:
 *   1. with no shift named, the report is the branch's *current* (newest)
 *      shift — the behaviour that existed before the picker;
 *   2. an earlier shift can be named, and reports its own orders, not the
 *      current one's;
 *   3. `shifts` carries the branch's shifts newest-first, so the dropdown has
 *      options to render and always contains the selected one;
 *   4. a shift belonging to *another branch* reports nothing rather than
 *      leaking that branch's orders — the isolation the route relies on
 *      instead of re-validating the id itself;
 *   5. window edges: an order opened before the shift started, or after it
 *      ended, is not the shift's;
 *   6. an order is reported *whole* — its add-on snapshots by name and price,
 *      its notes and void reasons, its money breakdown, and its payments —
 *      since that is the point of the review, and payments are read by their
 *      own query so an order carrying more than one of them (a refund, or the
 *      re-settlement an amendment writes) cannot fan its lines out.
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
let shiftOrders: typeof import("../src/lib/shift-orders-service");
let dbLib: typeof import("../src/lib/db");

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

/**
 * A user plus its employees row — a shift's employee_id references employees,
 * which shares the users row's id (migration 0042), while the report's
 * employeeName still comes from users.full_name.
 */
async function seedEmployee(): Promise<string> {
  // An active member must carry some credential (users_credentials, migration
  // 0022); the report only ever reads full_name off this row.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, pin_hash)
     VALUES ($1, 'manager', 'شیدا کاشانی', $2, 'x') RETURNING id`,
    [businessId, `cashier-${randomUUID().slice(0, 8)}@example.com`],
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

interface SeedLine {
  name: string;
  quantity?: number;
  unitPrice?: number;
  status?: string;
  note?: string | null;
  voidReason?: string | null;
  modifiers?: { name: string; priceDelta: number }[];
}

/** One order with a single line, opened at `openedAt`. Returns its id. */
async function insertOrder(
  locationId: string,
  openedAt: string,
  opts: {
    orderNumber: number;
    total: number;
    itemName: string;
    quantity?: number;
    unitPrice?: number;
    /** Replaces the single `itemName` line when given — for orders that need add-ons or a void. */
    lines?: SeedLine[];
    money?: {
      subtotal?: number;
      discount?: number;
      discountType?: "percent" | "amount";
      discountValue?: number;
      serviceCharge?: number;
      tax?: number;
      tipAmount?: number;
    };
    guestCount?: number;
    note?: string | null;
    customerId?: string;
    payments?: { method: string; amount: number; reference?: string | null; receivedAt?: string }[];
    /**
     * When the bill was actually settled. Defaults to `openedAt` — most fixtures
     * do not care — but a bill carried across a cash-up is precisely one that
     * closes long after it opened, so that case has to be able to say so.
     */
    closedAt?: string;
  },
): Promise<string> {
  // orders/order_items scope by location_id, not business_id (migration 0001).
  // Lines may only be added while the order is still open (the order_not_open
  // guard, migration 0036), so close it afterwards the way the app does.
  const money = opts.money ?? {};
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at,
                         subtotal, discount, discount_type, discount_value,
                         service_charge, tax, tip_amount, guest_count, note, opened_by, customer_id)
     VALUES ($1, $2, 'dine_in', 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      locationId,
      opts.orderNumber,
      opts.total,
      openedAt,
      money.subtotal ?? 0,
      money.discount ?? 0,
      money.discountType ?? null,
      money.discountValue ?? null,
      money.serviceCharge ?? 0,
      money.tax ?? 0,
      money.tipAmount ?? 0,
      opts.guestCount ?? null,
      opts.note ?? null,
      employeeId,
      opts.customerId ?? null,
    ],
  );
  const orderId = rows[0].id;

  const lines: SeedLine[] = opts.lines ?? [
    { name: opts.itemName, quantity: opts.quantity, unitPrice: opts.unitPrice ?? opts.total },
  ];
  for (const line of lines) {
    const { rows: itemRows } = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, quantity, unit_price, status, note, void_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        locationId,
        orderId,
        line.name,
        line.quantity ?? 1,
        line.unitPrice ?? opts.total,
        line.status ?? "served",
        line.note ?? null,
        line.voidReason ?? null,
      ],
    );
    for (const modifier of line.modifiers ?? []) {
      await db.query(
        `INSERT INTO order_item_modifiers (order_item_id, name_snapshot, price_delta)
         VALUES ($1, $2, $3)`,
        [itemRows[0].id, modifier.name, modifier.priceDelta],
      );
    }
  }

  for (const payment of opts.payments ?? []) {
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, received_at)
       VALUES ($1, $2, $3::payment_method, $4, $5, $6, $7)`,
      [
        locationId,
        orderId,
        payment.method,
        payment.amount,
        payment.reference ?? null,
        employeeId,
        payment.receivedAt ?? openedAt,
      ],
    );
  }

  await db.query(
    "UPDATE orders SET status = 'completed', closed_at = $2, closed_by = $3 WHERE id = $1",
    [orderId, opts.closedAt ?? openedAt, employeeId],
  );
  return orderId;
}

beforeAll(async () => {
  databaseName = `pos_shift_orders_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
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
  // Orders go first, reopened: the order_not_open guard (migration 0036) rejects
  // deleting a closed order's lines, including the cascade from businesses.
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_item_modifiers");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
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

/** Runs `fn` scoped to the business, the way an authenticated request would be. */
function asBusiness<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("getShiftOrdersReport", () => {
  it("shows every order, and says why, for a branch that has never had a shift (audit F18)", async () => {
    await insertOrder(mainId, "2026-08-10T08:00:00Z", { orderNumber: 1, total: 500_000, itemName: "رژ لب" });
    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId));
    expect(report).toMatchObject({ shift: null, scope: "no_shift_recorded", totalCount: 1 });
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([1]);
  });

  it("lists orders opened outside every shift, and marks website orders", async () => {
    await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertOrder(mainId, "2026-08-10T09:00:00Z", { orderNumber: 1, total: 100_000, itemName: "در شیفت" });
    const web = await insertOrder(mainId, "2026-08-10T22:00:00Z", { orderNumber: 2, total: 200_000, itemName: "سفارش سایت" });
    await db.query(
      `INSERT INTO online_order_documents
         (order_id, location_id, source_type, remote_id, occurred_at, occurred_at_source, imported_at,
          lines_subtotal_rial, discount_rial, shipping_rial, fees_rial, tax_rial, total_rial,
          unexplained_difference_rial, breakdown_status)
       VALUES ($1, $2, 'woocommerce_order', '77', '2026-08-10T22:00:00Z', 'remote_paid', now(),
               200000, 0, 0, 0, 0, 200000, 0, 'reconciled')`,
      [web, mainId],
    );

    const unassigned = await asBusiness(() =>
      shiftOrders.getShiftOrdersReport(mainId, { shiftId: null, unassigned: true }),
    );
    expect(unassigned).toMatchObject({ scope: "unassigned", totalCount: 1 });
    expect(unassigned!.orders.map((o) => [o.orderNumber, o.channel])).toEqual([[2, "online"]]);

    const all = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, { shiftId: null }));
    expect(all!.scope).toBe("all_shifts");
    expect(all!.orders.map((o) => [o.orderNumber, o.channel])).toEqual([
      [2, "online"],
      [1, "in_store"],
    ]);
  });

  it("defaults to the branch's current (newest) shift", async () => {
    await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    const current = await insertShift(mainId, "2026-08-11T06:00:00Z", null);

    await insertOrder(mainId, "2026-08-10T08:00:00Z", {
      orderNumber: 1,
      total: 500_000,
      itemName: "چای",
    });
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 2,
      total: 900_000,
      itemName: "اسپرسو",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId));
    expect(report!.scope).toBe("shift");
    expect(report!.shift!.id).toBe(current);
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([2]);
    expect(report!.orders[0]!.lines.map((l) => l.name)).toEqual(["اسپرسو"]);
  });

  /**
   * The bill nobody could settle before the cash-up. It belongs to the shift
   * that opened it — that is the shift that seated the guests and rang the
   * items in — so it stays in that shift's review however much later the money
   * arrives, and the shift that merely took the last payment is not shown a
   * sale it did not make. The orders screen buckets by the same rule
   * (`ORDER_OPENED_IN_WINDOW`), so the two screens cannot disagree.
   */
  it("keeps a bill with the shift that opened it, not the one that settled it", async () => {
    const previous = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    const current = await insertShift(mainId, "2026-08-10T14:00:01Z", null);

    await insertOrder(mainId, "2026-08-10T13:30:00Z", {
      orderNumber: 1,
      total: 500_000,
      itemName: "چای",
      // Settled an hour into the next shift, long after this one was cashed up.
      closedAt: "2026-08-10T15:00:00Z",
    });
    await insertOrder(mainId, "2026-08-10T16:00:00Z", {
      orderNumber: 2,
      total: 900_000,
      itemName: "اسپرسو",
    });

    const [previousReport, currentReport] = await asBusiness(async () => [
      await shiftOrders.getShiftOrdersReport(mainId, previous),
      await shiftOrders.getShiftOrdersReport(mainId, current),
    ]);
    expect(previousReport!.orders.map((o) => o.orderNumber)).toEqual([1]);
    expect(currentReport!.orders.map((o) => o.orderNumber)).toEqual([2]);
  });

  it("reports an earlier shift's own orders when one is named", async () => {
    const earlier = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertShift(mainId, "2026-08-11T06:00:00Z", null);

    await insertOrder(mainId, "2026-08-10T08:00:00Z", {
      orderNumber: 1,
      total: 500_000,
      itemName: "چای",
    });
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 2,
      total: 900_000,
      itemName: "اسپرسو",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, earlier));
    expect(report!.shift.id).toBe(earlier);
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([1]);
  });

  it("carries the branch's shifts newest-first, including the selected one", async () => {
    const older = await insertShift(mainId, "2026-08-09T06:00:00Z", "2026-08-09T14:00:00Z");
    const middle = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    const newest = await insertShift(mainId, "2026-08-11T06:00:00Z", null);

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, older));
    expect(report!.shifts.map((s) => s.id)).toEqual([newest, middle, older]);
    expect(report!.shifts.map((s) => s.id)).toContain(report!.shift.id);
    expect(report!.shifts[0]!.employeeName).toBe("شیدا کاشانی");
    // An open shift keeps a null end — the UI renders that as "در حال انجام".
    expect(report!.shifts[0]!.endedAt).toBeNull();
    expect(report!.shifts[1]!.endedAt).not.toBeNull();
  });

  it("reports nothing for a shift belonging to another branch", async () => {
    await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    // An employee may only have one shift open at a time
    // (idx_employee_shifts_employee_open), so the other branch needs its own.
    const foreign = await insertShift(otherId, "2026-08-11T07:00:00Z", null, await seedEmployee());
    await insertOrder(otherId, "2026-08-11T08:00:00Z", {
      orderNumber: 9,
      total: 900_000,
      itemName: "کاپوچینو",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, foreign));
    expect(report).toBeNull();
  });

  it("excludes orders opened outside the shift's window", async () => {
    const shift = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertOrder(mainId, "2026-08-10T05:59:00Z", {
      orderNumber: 1,
      total: 100_000,
      itemName: "قبل از شیفت",
    });
    await insertOrder(mainId, "2026-08-10T09:00:00Z", {
      orderNumber: 2,
      total: 200_000,
      itemName: "در شیفت",
    });
    await insertOrder(mainId, "2026-08-10T14:01:00Z", {
      orderNumber: 3,
      total: 300_000,
      itemName: "بعد از شیفت",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, shift));
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([2]);
  });

  it("reports a line's add-ons by name and price, with its note and unit price", async () => {
    const shift = await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 1,
      total: 1_300_000,
      itemName: "لاته",
      lines: [
        {
          name: "لاته",
          quantity: 2,
          unitPrice: 600_000,
          note: "کم‌شیر",
          modifiers: [
            { name: "شات اضافه", priceDelta: 50_000 },
            { name: "شیر بادام", priceDelta: 30_000 },
          ],
        },
      ],
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, shift));
    const line = report!.orders[0]!.lines[0]!;
    // Each add-on now carries how many of it the line holds («شات اضافه ×۳»
    // is one row at quantity 3) — plain picks read back as quantity 1.
    expect(line.modifiers).toEqual([
      { name: "شات اضافه", priceDelta: 50_000, quantity: 1 },
      { name: "شیر بادام", priceDelta: 30_000, quantity: 1 },
    ]);
    expect(line.unitPrice).toBe(600_000);
    expect(line.addOnsPerUnit).toBe(80_000);
    // (600_000 + 80_000) × 2
    expect(line.amount).toBe(1_360_000);
    expect(line.note).toBe("کم‌شیر");
    expect(report!.orders[0]!.addOnTotal).toBe(160_000);
  });

  it("keeps a voided line with the reason it was voided, out of the counted totals", async () => {
    const shift = await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 1,
      total: 600_000,
      itemName: "لاته",
      lines: [
        { name: "لاته", quantity: 1, unitPrice: 600_000 },
        {
          name: "کیک",
          quantity: 2,
          unitPrice: 400_000,
          status: "voided",
          voidReason: "اشتباه صندوق‌دار",
          modifiers: [{ name: "خامه", priceDelta: 50_000 }],
        },
      ],
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, shift));
    const order = report!.orders[0]!;
    const voided = order.lines.find((l) => l.voided)!;
    expect(voided.voidReason).toBe("اشتباه صندوق‌دار");
    expect(voided.modifiers.map((m) => m.name)).toEqual(["خامه"]);
    expect(order.itemCount).toBe(1);
    expect(order.addOnTotal).toBe(0);
  });

  it("carries the order's money breakdown and its facts", async () => {
    const shift = await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 1,
      total: 2_040_000,
      itemName: "لاته",
      guestCount: 3,
      note: "تولد",
      money: {
        subtotal: 2_000_000,
        discount: 200_000,
        discountType: "percent",
        discountValue: 10,
        serviceCharge: 100_000,
        tax: 90_000,
        tipAmount: 50_000,
      },
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, shift));
    expect(report!.orders[0]).toMatchObject({
      subtotal: 2_000_000,
      discount: 200_000,
      discountType: "percent",
      discountValue: 10,
      serviceCharge: 100_000,
      tax: 90_000,
      tipAmount: 50_000,
      guestCount: 3,
      note: "تولد",
      openedByName: "شیدا کاشانی",
      closedByName: "شیدا کاشانی",
    });
    expect(report!.orders[0]!.closedAt).not.toBeNull();
  });

  // `uq_payments_one_positive_per_order` (migration 0014, narrowed by 0075)
  // allows only one *live* positive row, so a second payment row is a refund
  // or an amendment's re-settlement — the reason payments are a query of their
  // own rather than a third join.
  it("reports every payment row of an order without duplicating its lines", async () => {
    const shift = await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 1,
      total: 1_000_000,
      itemName: "لاته",
      lines: [
        { name: "لاته", quantity: 1, unitPrice: 600_000 },
        { name: "کیک", quantity: 1, unitPrice: 400_000 },
      ],
      payments: [
        { method: "card", amount: 1_000_000, reference: "TRM-77", receivedAt: "2026-08-11T08:10:00Z" },
        { method: "cash", amount: -400_000, receivedAt: "2026-08-11T08:20:00Z" },
      ],
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, shift));
    const order = report!.orders[0]!;
    expect(order.lines).toHaveLength(2);
    expect(order.payments.map((p) => [p.method, p.amount])).toEqual([
      ["card", 1_000_000],
      ["cash", -400_000],
    ]);
    expect(order.payments[0]!.reference).toBe("TRM-77");
    expect(order.payments[0]!.receivedByName).toBe("شیدا کاشانی");
  });

  it("does not attach a payment made against another shift's order", async () => {
    await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    const current = await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    await insertOrder(mainId, "2026-08-10T08:00:00Z", {
      orderNumber: 1,
      total: 500_000,
      itemName: "چای",
      payments: [{ method: "cash", amount: 500_000 }],
    });
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 2,
      total: 900_000,
      itemName: "اسپرسو",
      payments: [{ method: "card", amount: 900_000 }],
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, current));
    expect(report!.orders).toHaveLength(1);
    expect(report!.orders[0]!.payments.map((p) => p.method)).toEqual(["card"]);
  });

  it("searches all historical shifts by localized order number and intersects date filters", async () => {
    await insertShift(mainId, "2026-01-01T06:00:00Z", "2026-01-01T14:00:00Z");
    await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    await insertOrder(mainId, "2026-01-01T08:00:00Z", { orderNumber: 1835, total: 700_000, itemName: "قدیمی" });
    await insertOrder(mainId, "2026-08-11T08:00:00Z", { orderNumber: 2, total: 900_000, itemName: "جدید" });

    const allDates = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, { shiftId: null, orderNumber: "1835" }));
    expect(allDates!.orders.map((order) => order.orderNumber)).toEqual([1835]);
    expect(allDates!.totalCount).toBe(1);
    expect(allDates!.totalAmount).toBe(700_000);

    const excluded = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, {
      shiftId: null, orderNumber: "1835", dateFrom: "2026-08-01", dateTo: "2026-08-31", timeZone: "Asia/Tehran",
    }));
    expect(excluded!.orders).toEqual([]);
  });

  it("matches partial Persian customer names and keeps summaries and pages filtered", async () => {
    await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    const { rows: customers } = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, location_id, name) VALUES ($1, $2, 'علی رضایی') RETURNING id",
      [businessId, mainId],
    );
    for (let number = 1; number <= 4; number += 1) {
      await insertOrder(mainId, `2026-08-11T0${number + 6}:00:00Z`, {
        orderNumber: number, total: number * 100_000, itemName: "چای",
        customerId: number !== 4 ? customers[0].id : undefined,
      });
    }

    const first = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, {
      shiftId: null, customerQuery: "علي", page: 1, pageSize: 2,
    }));
    const second = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, {
      shiftId: null, customerQuery: "علی", page: 2, pageSize: 2,
    }));
    expect(first!.totalCount).toBe(3);
    expect(first!.totalAmount).toBe(600_000);
    expect(first!.orders.map((order) => order.orderNumber)).toEqual([3, 2]);
    expect(second!.orders.map((order) => order.orderNumber)).toEqual([1]);
    expect([...first!.orders, ...second!.orders].every((order) => order.customerName === "علی رضایی")).toBe(true);
  });

  /**
   * Issue #819: one «جمع» over every status added a voided bill and two open
   * tables to real revenue. The headline is settled sales now, and the rest is
   * kept beside it as context.
   */
  it("splits the headline by status instead of summing open, held and voided into sales", async () => {
    await insertShift(mainId, "2026-08-12T06:00:00Z", null);

    async function insertWithStatus(orderNumber: number, status: string, total: number) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO orders (location_id, order_number, type, status, total, subtotal, opened_at, closed_at, closed_by)
         VALUES ($1, $2, 'dine_in', $3::order_status, $4, $4, $5, $6, $7) RETURNING id`,
        [
          mainId,
          orderNumber,
          status,
          total,
          `2026-08-12T0${orderNumber + 6}:00:00Z`,
          status === "completed" ? `2026-08-12T0${orderNumber + 6}:30:00Z` : null,
          status === "completed" ? employeeId : null,
        ],
      );
      return rows[0].id;
    }

    const completed = await insertWithStatus(1, "completed", 1_000_000);
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, received_by, received_at)
       VALUES ($1, $2, 'cash', 1_000_000, $3, '2026-08-12T07:30:00Z')`,
      [mainId, completed, employeeId],
    );
    await insertWithStatus(2, "open", 500_000);
    await insertWithStatus(3, "held", 300_000);
    await insertWithStatus(4, "voided", 800_000);

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId));
    expect(report!.summary).toEqual({
      matchingCount: 4,
      completedCount: 1,
      completedAmount: 1_000_000,
      openCount: 1,
      openAmount: 500_000,
      heldCount: 1,
      heldAmount: 300_000,
      voidedCount: 1,
      voidedAmount: 800_000,
    });
    // The legacy face-value total still adds every matched order — it is what
    // the export's row total was built from — but no screen calls it «جمع».
    expect(report!.totalAmount).toBe(2_600_000);
    expect(report!.totalCount).toBe(4);
  });
});
