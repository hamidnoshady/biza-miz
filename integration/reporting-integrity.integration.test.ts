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
 *
 * Migration 0212 (saved-report description/version, issue #819 Step 8) is
 * covered here too, against the service the builder actually calls.
 */
import { randomUUID } from "node:crypto";
import { branchScope, BUSINESS_WIDE_SCOPE } from "../src/lib/report-scope";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

/** Loaded after DATABASE_URL points at the scratch database. */
let reportsService: typeof import("../src/lib/reports-service");
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

/**
 * A saved report the widget tables can reference. `config` is written through
 * the service's own shape so the applicability check has something real to read.
 */
async function insertSavedReport(config: Record<string, unknown>, extra: { standardKey?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO saved_reports (business_id, created_by, name, config, is_standard, standard_key)
     VALUES ($1, $2, 'گزارش آزمایشی', $3::jsonb, $4, $5)
     RETURNING id`,
    [businessId, employeeId, JSON.stringify(config), Boolean(extra.standardKey), extra.standardKey ?? null],
  );
  return rows[0].id;
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

  process.env.DATABASE_URL = urlFor(databaseName);
  reportsService = await import("../src/lib/reports-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  // The service layer's pool outlives the raw client; closing the scratch
  // database underneath it would otherwise log an idle-client error.
  await dbLib?.getPool().end().catch(() => {});
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
  await db.query("DELETE FROM saved_reports");
  // These report fixtures include posted balances; remove dependent rows before
  // the business-owned accounts they reference.
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
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

describe("saved reports — description and version (issue #819, Step 8)", () => {
  const config = {
    view: "v_sales_by_day",
    metric: "total",
    aggregation: "sum" as const,
    dimension: "day",
    visualization: "pie" as const,
  };

  it("stores an optional description and starts at version 1", async () => {
    const id = await dbLib.withTenant(businessId, () =>
      reportsService.createSavedReport(businessId, null, "فروش روزانه", config, "پرسش مدیر"),
    );
    const row = await dbLib.withTenant(businessId, () => reportsService.getSavedReport(businessId, id));
    expect(row).toMatchObject({
      name: "فروش روزانه",
      description: "پرسش مدیر",
      version: 1,
      is_standard: false,
    });
    // The visualization lives inside the stored config, so it round-trips too.
    expect((row!.config as { visualization?: string }).visualization).toBe("pie");
  });

  it("leaves the description null when none was given", async () => {
    const id = await dbLib.withTenant(businessId, () =>
      reportsService.createSavedReport(businessId, null, "بی‌توضیح", config),
    );
    const row = await dbLib.withTenant(businessId, () => reportsService.getSavedReport(businessId, id));
    expect(row!.description).toBeNull();
  });

  it("counts every edit as a version, including a rename", async () => {
    const id = await dbLib.withTenant(businessId, () =>
      reportsService.createSavedReport(businessId, null, "نسخه‌دار", config),
    );
    await dbLib.withTenant(businessId, () =>
      reportsService.updateSavedReport(businessId, id, { config: { ...config, metric: "order_count" } }),
    );
    await dbLib.withTenant(businessId, () =>
      reportsService.updateSavedReport(businessId, id, { name: "نسخه‌دار (نام تازه)" }),
    );
    const row = await dbLib.withTenant(businessId, () => reportsService.getSavedReport(businessId, id));
    expect(row!.version).toBe(3);
    expect(row!.name).toBe("نسخه‌دار (نام تازه)");
  });

  it("clears a description on an explicit empty string and refuses an empty patch", async () => {
    const id = await dbLib.withTenant(businessId, () =>
      reportsService.createSavedReport(businessId, null, "با توضیح", config, "بعداً پاک می‌شود"),
    );
    await dbLib.withTenant(businessId, () =>
      reportsService.updateSavedReport(businessId, id, { description: "" }),
    );
    const cleared = await dbLib.withTenant(businessId, () => reportsService.getSavedReport(businessId, id));
    expect(cleared!.description).toBeNull();

    // No fields at all is not an edit: no row touched, no version spent.
    const untouched = await dbLib.withTenant(businessId, () =>
      reportsService.updateSavedReport(businessId, id, {}),
    );
    expect(untouched).toBe(false);
    const after = await dbLib.withTenant(businessId, () => reportsService.getSavedReport(businessId, id));
    expect(after!.version).toBe(2);
  });

  it("refuses to edit or delete the seeded standard reports", async () => {
    // Standard rows are the report catalogue's projection, not the member's
    // document — updateSavedReport and deleteSavedReport both keep them out.
    await db.query(
      `INSERT INTO saved_reports (business_id, name, config, is_standard, standard_key)
       VALUES ($1, 'استاندارد', $2, true, 'daily_sales')`,
      [businessId, JSON.stringify(config)],
    );
    const seeded = await db.query<{ id: string }>(
      "SELECT id FROM saved_reports WHERE business_id = $1 AND standard_key = 'daily_sales'",
      [businessId],
    );
    const id = seeded.rows[0].id;
    expect(
      await dbLib.withTenant(businessId, () => reportsService.updateSavedReport(businessId, id, { name: "خ" })),
    ).toBe(false);
    expect(
      await dbLib.withTenant(businessId, () => reportsService.deleteSavedReport(businessId, id)),
    ).toBe(false);
  });
});

describe("branch isolation of report execution (issue #819)", () => {
  const DAY_CONFIG = {
    view: "v_sales_by_day",
    metric: "total",
    aggregation: "sum" as const,
    dimension: "day",
  };

  it("returns only the branch its location filter names, never a sibling's rows", async () => {
    // Two branches, one sale each, same business day. v_sales_by_day carries
    // location_id, which is what the routes inject from
    // resolveActiveLocation(session) — a body-supplied location never reaches
    // this call (asserted in src/app/api/reports/query/route.test.ts).
    await insertCompletedOrder(mainId, 1, 1_000_000, "2026-08-10T09:00:00Z", [
      { method: "cash", amount: 1_000_000 },
    ]);
    await insertCompletedOrder(otherId, 2, 7_000_000, "2026-08-10T10:00:00Z", [
      { method: "card", amount: 7_000_000 },
    ]);

    const rowsFor = (locationId: string) =>
      dbLib.withTenant(businessId, () =>
        reportsService.runCustomReportQuery(businessId, DAY_CONFIG, branchScope(locationId)),
      );

    const main = await rowsFor(mainId);
    const other = await rowsFor(otherId);
    expect(main.map((row) => Number(row.value))).toEqual([1_000_000]);
    expect(other.map((row) => Number(row.value))).toEqual([7_000_000]);

    // The business-wide figure is a *separate scope*, not the absence of one:
    // it has to be asked for by name and the route that serves it requires
    // `reports.business_wide` (issue #819).
    const consolidated = await dbLib.withTenant(businessId, () =>
      reportsService.runCustomReportQuery(businessId, DAY_CONFIG, BUSINESS_WIDE_SCOPE),
    );
    expect(consolidated.map((row) => Number(row.value))).toEqual([8_000_000]);

    // And the omission that used to produce those same eight million now fails
    // instead: a caller that never resolved a branch has no scope to pass.
    await expect(
      dbLib.withTenant(businessId, () =>
        reportsService.runCustomReportQuery(
          businessId,
          DAY_CONFIG,
          undefined as unknown as Parameters<typeof reportsService.runCustomReportQuery>[2],
        ),
      ),
    ).rejects.toThrow(/missing_report_scope/);
  });

  it("scopes a standard report's raw rows to the named branch", async () => {
    await insertCompletedOrder(mainId, 1, 1_000_000, "2026-08-10T09:00:00Z", [
      { method: "cash", amount: 1_000_000 },
    ]);
    await insertCompletedOrder(otherId, 2, 7_000_000, "2026-08-10T10:00:00Z", [
      { method: "card", amount: 7_000_000 },
    ]);

    const rows = await dbLib.withTenant(businessId, () =>
      reportsService.runStandardReportRows("daily_sales_summary", businessId, branchScope(mainId)),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total)).toBe(1_000_000);
  });

  it("keeps a branch balance sheet balanced while excluding a sibling branch", async () => {
    const accounts = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'نقد', 'asset'), ($1, '4300', 'فروش', 'revenue'),
              ($1, '5900', 'هزینهٔ دیگر', 'expense')
       RETURNING id, code`,
      [businessId],
    );
    const cash = accounts.rows.find((row) => row.code === "1100")!.id;
    const revenue = accounts.rows.find((row) => row.code === "4300")!.id;
    const expense = accounts.rows.find((row) => row.code === "5900")!.id;
    const post = async (locationId: string, entryDate: string, debit: string, credit: string, amount: number) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
         VALUES ($1, $2, $3, 'آزمون تراز شعبه', 'manual') RETURNING id`,
        [businessId, locationId, entryDate],
      );
      const id = rows[0].id;
      await db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
         VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)`,
        [id, debit, credit, amount],
      );
    };
    // One sale and one operating expense in Main, a much larger sale in Other.
    await post(mainId, "2026-08-10", cash, revenue, 1_000_000);
    await post(mainId, "2026-08-11", expense, cash, 200_000);
    await post(otherId, "2026-08-10", cash, revenue, 7_000_000);

    const main = await dbLib.withTenant(businessId, () =>
      reportsService.getBalanceSheet(businessId, "2026-08-31", branchScope(mainId)),
    );
    const other = await dbLib.withTenant(businessId, () =>
      reportsService.getBalanceSheet(businessId, "2026-08-31", branchScope(otherId)),
    );
    const consolidated = await dbLib.withTenant(businessId, () =>
      reportsService.getBalanceSheet(businessId, "2026-08-31", BUSINESS_WIDE_SCOPE),
    );

    expect(main.balanced).toBe(true);
    expect(main.totalAssets).toBe(800_000);
    expect(main.totalEquity).toBe(800_000);
    expect(other.balanced).toBe(true);
    expect(other.totalAssets).toBe(7_000_000);
    expect(consolidated.balanced).toBe(true);
    expect(consolidated.totalAssets).toBe(7_800_000);
  });
});

describe("dashboard widget layouts — the write contract (issue #819)", () => {
  // A config the engine actually accepts: views are keyed by their SQL view
  // name, and the applicability check resolves the metric and dimension against
  // that view's own lists.
  const DAY_CONFIG = {
    view: "v_sales_by_day",
    metric: "total",
    dimension: "day",
    aggregation: "sum",
    visualization: "bar",
  };

  it("keeps both tiles when two pins land at once on an empty dashboard", async () => {
    const first = await insertSavedReport(DAY_CONFIG);
    const second = await insertSavedReport({ ...DAY_CONFIG, metric: "order_count" });

    // The browser used to do this as: GET the layout, append locally, POST the
    // whole array back. Both reads saw an empty grid, so the second POST deleted
    // the first tile. The append now happens server-side, inside a transaction
    // that locks the scope — including the empty case, where there are no rows
    // for FOR UPDATE to hold.
    const [a, b] = await Promise.all([
      reportsService.appendDashboardWidget(businessId, { userId: employeeId }, {
        savedReportId: first,
        chartType: "bar",
        title: "فروش",
        w: 4,
        h: 3,
      }),
      reportsService.appendDashboardWidget(businessId, { userId: employeeId }, {
        savedReportId: second,
        chartType: "line",
        title: "تعداد",
        w: 4,
        h: 3,
      }),
    ]);
    if (!a.ok) throw new Error(`first append failed: ${JSON.stringify(a)}`);
    if (!b.ok) throw new Error(`second append failed: ${JSON.stringify(b)}`);

    const layout = await reportsService.getDashboardWidgets(businessId, employeeId, "manager");
    expect(layout.widgets).toHaveLength(2);
    expect(new Set(layout.widgets.map((w) => w.saved_report_id))).toEqual(new Set([first, second]));
    // Both writes serialized, so the second tile was placed *below* the first
    // rather than on top of it.
    expect(new Set(layout.widgets.map((w) => w.y))).toEqual(new Set([0, 3]));

    // And each write reported the layout it produced, which is what a client
    // sends back on its next write.
    expect(a.revision).not.toBe(b.revision);
    expect([a.revision, b.revision]).toContain(layout.revision);
  });

  it("refuses a stale whole-layout write instead of deleting a newer one", async () => {
    const report = await insertSavedReport(DAY_CONFIG);
    const widget = { savedReportId: report, chartType: "bar" as const, title: null, x: 0, y: 0, w: 4, h: 3 };

    await reportsService.saveDashboardWidgets(businessId, { userId: employeeId }, [widget]);
    const read = await reportsService.getDashboardWidgets(businessId, employeeId, "manager");

    // Tab A saves a drag using the revision it read.
    const accepted = await reportsService.saveDashboardWidgets(
      businessId,
      { userId: employeeId },
      [{ ...widget, x: 4, w: 8 }],
      { ifRevision: read.revision },
    );
    expect(accepted).toEqual({ ok: true, revision: expect.any(String) });

    // Tab B, still open on the older layout, drags something else. Its write
    // must not delete tab A's — it is told its screen is out of date.
    const refused = await reportsService.saveDashboardWidgets(
      businessId,
      { userId: employeeId },
      [{ ...widget, w: 12 }],
      { ifRevision: read.revision },
    );
    expect(refused).toEqual({ ok: false, reason: "layout_changed" });

    const after = await reportsService.getDashboardWidgets(businessId, employeeId, "manager");
    expect(after.revision).toBe(accepted.ok ? accepted.revision : "");
    expect(after.widgets[0].w).toBe(8);
  });

  it("accepts the revision its own append returned", async () => {
    const report = await insertSavedReport(DAY_CONFIG);
    const appended = await reportsService.appendDashboardWidget(businessId, { role: "manager" }, {
      savedReportId: report,
      chartType: "bar",
      title: null,
      w: 4,
      h: 3,
    });
    if (!appended.ok) throw new Error("valid saved report must append successfully");

    // A role default is read by whoever inherits it; the revision has to be the
    // same string for the scope that wrote and the scope that reads. This
    // member has no personal layout of their own, so they inherit the role's.
    const collegialMember = await seedEmployee();
    const layout = await reportsService.getDashboardWidgets(businessId, collegialMember, "manager");
    expect(layout.scope).toBe("role-default");
    expect(layout.revision).toBe(appended.revision);

    const replaced = await reportsService.saveDashboardWidgets(
      businessId,
      { role: "manager" },
      [{ savedReportId: report, chartType: "pie", title: "دوباره", x: 0, y: 0, w: 6, h: 3 }],
      { ifRevision: appended.revision },
    );
    expect(replaced.ok).toBe(true);
  });

  it("keeps a widget whose report the engine can no longer run, and says why", async () => {
    // The scenario the retention rule in `ensureStandardSavedReports` creates:
    // a report stayed in the database across an engine change, and a member's
    // dashboard still points at it. It must be *visible and explained*, not
    // dropped — silently deleting someone's layout is the other half of the bug.
    const retired = await insertSavedReport({ ...DAY_CONFIG, view: "a_view_that_was_removed" });
    const live = await insertSavedReport(DAY_CONFIG);
    await db.query(
      `INSERT INTO dashboard_widgets (business_id, user_id, saved_report_id, chart_type, title, x, y, w, h)
       VALUES ($1, $2, $3, 'bar', NULL, 0, 0, 4, 3), ($1, $2, $4, 'bar', NULL, 0, 3, 4, 3)`,
      [businessId, employeeId, retired, live],
    );

    const layout = await reportsService.getDashboardWidgets(businessId, employeeId, "manager");
    expect(layout.widgets).toHaveLength(2);
    const retiredRow = layout.widgets.find((w) => w.saved_report_id === retired);
    expect(retiredRow?.applicable).toBe(false);
    expect(retiredRow?.applicable_reason).toBe("unknown_view");
    // The healthy widget is untouched and still applicable.
    expect(layout.widgets.find((w) => w.saved_report_id === live)?.applicable).toBe(true);
  });

  it("retains old standard rows but excludes them from another trade's defaults and pin validation", async () => {
    const stale = await insertSavedReport(DAY_CONFIG, { standardKey: "top_selling_items" });
    await db.query("UPDATE businesses SET industry = 'jewelry' WHERE id = $1", [businessId]);

    const ids = await dbLib.withTenant(businessId, () => reportsService.ensureStandardSavedReports(businessId));
    expect(ids.has("top_selling_items")).toBe(false);
    const validation = await dbLib.withTenant(businessId, () =>
      reportsService.savedReportIdsInBusiness(businessId, [stale]),
    );
    expect(validation.owned.has(stale)).toBe(true);
    expect(validation.applicable.has(stale)).toBe(false);

    // The next Owner dashboard seed uses only the current trade's keys. The old
    // row remains for any layout that already references it; it is not blindly
    // deleted or newly pinned into a role default.
    const layout = await dbLib.withTenant(businessId, () =>
      reportsService.getDashboardWidgets(businessId, employeeId, "owner"),
    );
    expect(layout.widgets.some((widget) => widget.saved_report_id === stale)).toBe(false);
    const retained = await db.query<{ id: string }>("SELECT id FROM saved_reports WHERE id = $1", [stale]);
    expect(retained.rows).toEqual([{ id: stale }]);
  });

  it("refuses to append a report that became inapplicable before the locked write", async () => {
    const stale = await insertSavedReport({ ...DAY_CONFIG, view: "a_view_that_was_removed" });
    const appended = await reportsService.appendDashboardWidget(businessId, { userId: employeeId }, {
      savedReportId: stale,
      chartType: "bar",
      title: null,
      w: 4,
      h: 3,
    });
    expect(appended).toEqual({ ok: false, reason: "saved_report_not_applicable" });
  });

  it("preserves an existing inapplicable widget only when the locked layout already contains it", async () => {
    const stale = await insertSavedReport({ ...DAY_CONFIG, view: "a_view_that_was_removed" });
    const widget = { savedReportId: stale, chartType: "bar" as const, title: null, x: 0, y: 0, w: 4, h: 3 };
    const emptyRevision = reportsService.widgetLayoutRevision([]);
    const rejected = await reportsService.saveDashboardWidgets(
      businessId,
      { userId: employeeId },
      [widget],
      { ifRevision: emptyRevision, preserveInapplicableSavedReportIds: [stale] },
    );
    expect(rejected).toEqual({ ok: false, reason: "saved_report_not_applicable" });

    await db.query(
      `INSERT INTO dashboard_widgets (business_id, user_id, saved_report_id, chart_type, title, x, y, w, h)
       VALUES ($1, $2, $3, 'bar', NULL, 0, 0, 4, 3)`,
      [businessId, employeeId, stale],
    );
    const read = await dbLib.withTenant(businessId, () =>
      reportsService.getDashboardWidgets(businessId, employeeId, "manager"),
    );
    const preserved = await reportsService.saveDashboardWidgets(
      businessId,
      { userId: employeeId },
      [widget],
      { ifRevision: read.revision, preserveInapplicableSavedReportIds: [stale] },
    );
    expect(preserved.ok).toBe(true);
    const after = await db.query<{ saved_report_id: string }>(
      "SELECT saved_report_id FROM dashboard_widgets WHERE business_id = $1 AND user_id = $2",
      [businessId, employeeId],
    );
    expect(after.rows.map((row) => row.saved_report_id)).toEqual([stale]);
  });
});
