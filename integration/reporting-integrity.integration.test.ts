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
let reportFilterOptionsService: typeof import("../src/lib/report-filter-options-service");
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
  reportFilterOptionsService = await import("../src/lib/report-filter-options-service");
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

describe("report filter option scope (issue #819)", () => {
  it("returns only the authorized branch's entities and refuses cross-business location ids", async () => {
    await db.query(
      `INSERT INTO menu_categories (location_id, name)
       VALUES ($1, 'Main beverages'), ($2, 'Other branch meals')`,
      [mainId, otherId],
    );
    const otherBusiness = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Filter Business', $1) RETURNING id",
      [`filter-${randomUUID().slice(0, 8)}`],
    );
    const foreignLocation = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Foreign') RETURNING id",
      [otherBusiness.rows[0].id],
    );
    await db.query("INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Foreign category')", [foreignLocation.rows[0].id]);

    const mainOptions = await dbLib.withTenant(businessId, () =>
      reportFilterOptionsService.reportFilterOptions(businessId, mainId, "v_menu_item_performance"),
    );
    expect(mainOptions.category).toEqual([{ value: expect.any(String), label: "Main beverages" }]);

    const otherBranchOptions = await dbLib.withTenant(businessId, () =>
      reportFilterOptionsService.reportFilterOptions(businessId, otherId, "v_menu_item_performance"),
    );
    expect(otherBranchOptions.category).toEqual([{ value: expect.any(String), label: "Other branch meals" }]);

    const foreignOptions = await dbLib.withTenant(businessId, () =>
      reportFilterOptionsService.reportFilterOptions(businessId, foreignLocation.rows[0].id, "v_menu_item_performance"),
    );
    expect(foreignOptions.category).toEqual([]);
  });
});

describe("dashboard widget layouts — revision, inheritance and isolation (issue #819)", () => {
  const DAY_CONFIG = {
    view: "v_sales_by_day",
    metric: "total",
    dimension: "day",
    aggregation: "sum",
    visualization: "bar",
  };
  const managerTarget = { role: "manager" as const };
  const personalTarget = (userId: string) => ({ userId, role: "manager" as const });

  const readPersonal = (userId: string) => dbLib.withTenant(businessId, () =>
    reportsService.getDashboardWidgets(businessId, userId, "manager"),
  );
  const readRole = () => dbLib.withTenant(businessId, () =>
    reportsService.getRoleDashboardWidgets(businessId, "manager"),
  );
  const append = (target: { role: "manager" } | { userId: string; role: "manager" }, savedReportId: string, title: string) =>
    dbLib.withTenant(businessId, () => reportsService.appendDashboardWidget(businessId, target, {
      savedReportId,
      chartType: "bar",
      title,
      w: 4,
      h: 3,
    }));

  async function waitForAdvisoryLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await db.query<{ waiters: number }>(
        `SELECT count(*)::int AS waiters
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE '%pg_advisory_xact_lock%'`,
      );
      if (rows[0].waiters >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${expected} advisory-lock contenders`);
  }

  async function holdWidgetScopeLock(key: string): Promise<{ release: () => Promise<void>; client: Client }> {
    const client = new Client({ connectionString: urlFor(databaseName) });
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    return {
      client,
      release: async () => {
        await client.query("COMMIT");
        await client.end();
      },
    };
  }

  it("atomically transitions an inherited layout, preserves the role default, and treats empty as an override", async () => {
    const roleReport = await insertSavedReport(DAY_CONFIG);
    const laterRoleReport = await insertSavedReport({ ...DAY_CONFIG, metric: "order_count" });
    const seededDefault = await append(managerTarget, roleReport, "پیش‌فرض نقش");
    if (!seededDefault.ok) throw new Error(`role append failed: ${JSON.stringify(seededDefault)}`);
    const roleBefore = await readRole();

    const memberId = await seedEmployee();
    const legacyPersonalState = await db.query(
      "SELECT 1 FROM dashboard_widget_layout_state WHERE business_id = $1 AND user_id = $2",
      [businessId, memberId],
    );
    expect(legacyPersonalState.rowCount).toBe(0);
    const inherited = await readPersonal(memberId);
    expect(inherited.scope).toBe("role-default");
    expect(inherited.widgets.map((widget) => widget.saved_report_id)).toEqual([roleReport]);
    expect(inherited.precondition).toEqual({
      source: { scope: "role-default", revision: roleBefore.precondition.source.revision },
      target: { scope: "personal", revision: null },
    });

    const firstEdit = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      personalTarget(memberId),
      [{
        savedReportId: roleReport,
        chartType: "line",
        title: "ویرایش شخصی",
        x: 2,
        y: 0,
        w: 4,
        h: 3,
      }],
      inherited.precondition,
    ));
    expect(firstEdit.ok).toBe(true);
    if (!firstEdit.ok) throw new Error(`first personal edit failed: ${firstEdit.reason}`);
    expect(firstEdit.precondition).toEqual({
      source: { scope: "personal", revision: firstEdit.revision },
      target: { scope: "personal", revision: firstEdit.revision },
    });

    const roleAfterFirstEdit = await readRole();
    expect(roleAfterFirstEdit.precondition).toEqual(roleBefore.precondition);
    expect(roleAfterFirstEdit.widgets.map((widget) => widget.saved_report_id)).toEqual([roleReport]);
    const personalAfterFirstEdit = await readPersonal(memberId);
    expect(personalAfterFirstEdit.scope).toBe("personal");
    expect(personalAfterFirstEdit.widgets[0]).toMatchObject({ x: 2, chart_type: "line" });

    // A later edit uses the fresh personal revision, not the inherited role
    // revision, and may intentionally create an empty personal override.
    const laterEdit = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      personalTarget(memberId),
      [],
      personalAfterFirstEdit.precondition,
    ));
    expect(laterEdit.ok).toBe(true);
    if (!laterEdit.ok) throw new Error(`later personal edit failed: ${laterEdit.reason}`);
    const personalEmpty = await readPersonal(memberId);
    expect(personalEmpty.scope).toBe("personal");
    expect(personalEmpty.widgets).toEqual([]);
    expect(personalEmpty.precondition.source.revision).toBe(laterEdit.revision);

    // Changing the role default later must not repopulate that explicit empty
    // personal layout.
    const roleAppend = await append(managerTarget, laterRoleReport, "افزوده به پیش‌فرض");
    expect(roleAppend.ok).toBe(true);
    const roleAfterAppend = await readRole();
    expect(roleAfterAppend.widgets).toHaveLength(2);
    const stillEmpty = await readPersonal(memberId);
    expect(stillEmpty.scope).toBe("personal");
    expect(stillEmpty.widgets).toEqual([]);
  });

  it("allows exactly one of two contending inherited first edits under a deterministic lock barrier", async () => {
    const report = await insertSavedReport(DAY_CONFIG);
    const roleAppend = await append(managerTarget, report, "پیش‌فرض");
    if (!roleAppend.ok) throw new Error("valid role report must append");
    const roleBefore = await readRole();
    const memberId = await seedEmployee();
    const inherited = await readPersonal(memberId);
    expect(inherited.precondition.target.revision).toBeNull();

    const barrier = await holdWidgetScopeLock(`${businessId}:user:${memberId}`);
    let released = false;
    try {
      const attempt = (x: number) => dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
        businessId,
        personalTarget(memberId),
        [{ savedReportId: report, chartType: "bar", title: `ویرایش ${x}`, x, y: 0, w: 4, h: 3 }],
        inherited.precondition,
      ));
      const first = attempt(0);
      const second = attempt(4);
      // The holder makes the contention deterministic: both writes have
      // reached an actual PostgreSQL advisory-lock wait before release.
      await waitForAdvisoryLockWaiters(2);
      await barrier.release();
      released = true;
      const results = await Promise.all([first, second]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "layout_changed" }]);
      const personal = await readPersonal(memberId);
      expect(personal.scope).toBe("personal");
      expect([0, 4]).toContain(personal.widgets[0].x);
      const roleAfter = await readRole();
      expect(roleAfter.precondition).toEqual(roleBefore.precondition);
      expect(roleAfter.widgets.map((widget) => widget.saved_report_id)).toEqual([report]);
    } finally {
      if (!released) {
        await barrier.client.query("ROLLBACK").catch(() => {});
        await barrier.client.end().catch(() => {});
      }
    }
  });

  it("serializes concurrent append pins to an empty layout without losing either widget", async () => {
    const first = await insertSavedReport(DAY_CONFIG);
    const second = await insertSavedReport({ ...DAY_CONFIG, metric: "order_count" });
    const memberId = await seedEmployee();
    // Ensure the role source exists, while leaving this user's personal target absent.
    const inherited = await readPersonal(memberId);
    expect(inherited.scope).toBe("role-default");

    const barrier = await holdWidgetScopeLock(`${businessId}:user:${memberId}`);
    let released = false;
    try {
      const one = append(personalTarget(memberId), first, "فروش");
      const two = append(personalTarget(memberId), second, "تعداد");
      await waitForAdvisoryLockWaiters(2);
      await barrier.release();
      released = true;
      const [a, b] = await Promise.all([one, two]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error("both valid concurrent pins must append");

      const layout = await readPersonal(memberId);
      expect(layout.scope).toBe("personal");
      expect(layout.widgets).toHaveLength(2);
      expect(new Set(layout.widgets.map((widget) => widget.saved_report_id))).toEqual(new Set([first, second]));
      expect(new Set(layout.widgets.map((widget) => widget.y))).toEqual(new Set([0, 3]));
      expect(a.revision).not.toBe(b.revision);
      expect([a.revision, b.revision]).toContain(layout.precondition.target.revision);
    } finally {
      if (!released) {
        await barrier.client.query("ROLLBACK").catch(() => {});
        await barrier.client.end().catch(() => {});
      }
    }
  });

  it("rejects a stale personal source revision rather than deleting a newer layout", async () => {
    const first = await insertSavedReport(DAY_CONFIG);
    const second = await insertSavedReport({ ...DAY_CONFIG, metric: "order_count" });
    const a = await append(personalTarget(employeeId), first, "نخست");
    const b = await append(personalTarget(employeeId), second, "دوم");
    expect(a.ok && b.ok).toBe(true);
    const read = await readPersonal(employeeId);
    expect(read.scope).toBe("personal");

    const accepted = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      personalTarget(employeeId),
      read.widgets.map((widget, index) => ({
        savedReportId: widget.saved_report_id,
        chartType: widget.chart_type,
        title: widget.title,
        x: index === 0 ? 2 : 0,
        y: widget.y,
        w: widget.w,
        h: widget.h,
      })),
      read.precondition,
    ));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("first revision-checked replacement must succeed");

    const stale = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      personalTarget(employeeId),
      [],
      read.precondition,
    ));
    expect(stale).toEqual({ ok: false, reason: "layout_changed" });
    const after = await readPersonal(employeeId);
    expect(after.precondition.target.revision).toBe(accepted.revision);
    expect(after.widgets[0].x).toBe(2);
  });

  it("requires source and target revisions to replace a role default", async () => {
    const report = await insertSavedReport(DAY_CONFIG);
    const appended = await append(managerTarget, report, "پیش‌فرض مدیر");
    if (!appended.ok) throw new Error("valid role report must append");
    const read = await readRole();
    const replacement = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      managerTarget,
      [{ savedReportId: report, chartType: "pie", title: "نمودار تازه", x: 0, y: 0, w: 6, h: 3 }],
      read.precondition,
    ));
    expect(replacement.ok).toBe(true);
    const stale = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      managerTarget,
      [],
      read.precondition,
    ));
    expect(stale).toEqual({ ok: false, reason: "layout_changed" });
  });

  it("adopts non-empty pre-revision personal rows instead of mistaking them for inheritance", async () => {
    const personalReport = await insertSavedReport(DAY_CONFIG);
    const roleReport = await insertSavedReport({ ...DAY_CONFIG, metric: "order_count" });
    const roleAppend = await append(managerTarget, roleReport, "پیش‌فرض نقش");
    expect(roleAppend.ok).toBe(true);
    const legacyMember = await seedEmployee();
    await db.query(
      `INSERT INTO dashboard_widgets (business_id, user_id, saved_report_id, chart_type, title, x, y, w, h)
       VALUES ($1, $2, $3, 'bar', 'چیدمان قدیمی', 0, 0, 4, 3)`,
      [businessId, legacyMember, personalReport],
    );

    const layout = await readPersonal(legacyMember);
    expect(layout.scope).toBe("personal");
    expect(layout.widgets.map((widget) => widget.saved_report_id)).toEqual([personalReport]);
    expect(layout.precondition.source.scope).toBe("personal");
    const state = await db.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM dashboard_widget_layout_state WHERE business_id = $1 AND user_id = $2",
      [businessId, legacyMember],
    );
    expect(state.rows).toHaveLength(1);
  });

  it("keeps a widget whose report is now obsolete, with a reason, and only preserves it when it was in the source", async () => {
    const retired = await insertSavedReport({ ...DAY_CONFIG, view: "a_view_that_was_removed" });
    const live = await insertSavedReport(DAY_CONFIG);
    await db.query(
      `INSERT INTO dashboard_widgets (business_id, user_id, saved_report_id, chart_type, title, x, y, w, h)
       VALUES ($1, $2, $3, 'bar', NULL, 0, 0, 4, 3), ($1, $2, $4, 'bar', NULL, 0, 3, 4, 3)`,
      [businessId, employeeId, retired, live],
    );

    const read = await readPersonal(employeeId);
    expect(read.widgets).toHaveLength(2);
    const retiredRow = read.widgets.find((widget) => widget.saved_report_id === retired);
    expect(retiredRow).toMatchObject({ applicable: false, applicable_reason: "unknown_view" });
    expect(read.widgets.find((widget) => widget.saved_report_id === live)?.applicable).toBe(true);

    const staleNew = await insertSavedReport({ ...DAY_CONFIG, view: "another_retired_view" });
    const rejected = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      personalTarget(employeeId),
      [{ savedReportId: staleNew, chartType: "bar", title: null, x: 0, y: 0, w: 4, h: 3 }],
      read.precondition,
      { preserveInapplicableSavedReportIds: [staleNew] },
    ));
    expect(rejected).toEqual({ ok: false, reason: "saved_report_not_applicable" });

    const preserved = await dbLib.withTenant(businessId, () => reportsService.saveDashboardWidgets(
      businessId,
      personalTarget(employeeId),
      [{ savedReportId: retired, chartType: "bar", title: null, x: 0, y: 0, w: 4, h: 3 }],
      read.precondition,
      { preserveInapplicableSavedReportIds: [retired] },
    ));
    expect(preserved.ok).toBe(true);
  });

  it("keeps old standard reports but excludes them from another trade's defaults and pin validation", async () => {
    const stale = await insertSavedReport(DAY_CONFIG, { standardKey: "top_selling_items" });
    await db.query("UPDATE businesses SET industry = 'jewelry' WHERE id = $1", [businessId]);

    const ids = await dbLib.withTenant(businessId, () => reportsService.ensureStandardSavedReports(businessId));
    expect(ids.has("top_selling_items")).toBe(false);
    const validation = await dbLib.withTenant(businessId, () => reportsService.savedReportIdsInBusiness(businessId, [stale]));
    expect(validation.owned.has(stale)).toBe(true);
    expect(validation.applicable.has(stale)).toBe(false);

    const layout = await dbLib.withTenant(businessId, () => reportsService.getDashboardWidgets(businessId, employeeId, "owner"));
    expect(layout.widgets.some((widget) => widget.saved_report_id === stale)).toBe(false);
    const retained = await db.query<{ id: string }>("SELECT id FROM saved_reports WHERE id = $1", [stale]);
    expect(retained.rows).toEqual([{ id: stale }]);
  });

  it("rejects cross-business widget/layout references at the database boundary", async () => {
    const otherBusiness = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Cafe', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherBusinessId = otherBusiness.rows[0].id;
    const otherUser = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, pin_hash)
       VALUES ($1, 'manager', 'کاربر دیگر', $2, 'x') RETURNING id`,
      [otherBusinessId, `other-${randomUUID().slice(0, 8)}@example.com`],
    );
    const otherReport = await db.query<{ id: string }>(
      `INSERT INTO saved_reports (business_id, name, config, is_standard)
       VALUES ($1, 'گزارش دیگر', $2::jsonb, false) RETURNING id`,
      [otherBusinessId, JSON.stringify(DAY_CONFIG)],
    );

    await expect(db.query(
      `INSERT INTO dashboard_widgets (business_id, user_id, saved_report_id, chart_type, title, x, y, w, h)
       VALUES ($1, $2, $3, 'bar', NULL, 0, 0, 4, 3)`,
      [businessId, employeeId, otherReport.rows[0].id],
    )).rejects.toMatchObject({ code: "23503" });

    await expect(db.query(
      `INSERT INTO dashboard_widget_layout_state (business_id, user_id, role)
       VALUES ($1, $2, NULL)`,
      [businessId, otherUser.rows[0].id],
    )).rejects.toMatchObject({ code: "23503" });
  });
});
