/**
 * Issue #839 §14/#15/#23 — the dealership's three reports, against a real
 * database.
 *
 * `automotive-reports.ts` states the arithmetic and is unit-tested; this file
 * proves the *reads* underneath it (`automotive-reports-service.ts`) hand that
 * arithmetic the numbers it needs, and that those numbers agree with the books
 * and with the rows the other automotive services actually wrote. Nothing here
 * inserts a vehicle, a cost, a hold or a sale by hand: every fixture goes
 * through `createVehicle`, `recordVehicleCost`, `reserveVehicle`,
 * `releaseVehicleReservation`, the retail-invoice sale and `reverseVehicleSale`
 * — so a report that drifts from what the product stores fails here rather than
 * in a showroom.
 *
 * What it pins, in the issue's own terms:
 *
 *   - §14/§15 «موجودی و ارزش‌گذاری خودرو»: the acquisition price, the money
 *     capitalised onto the car and the money merely expensed stay three separate
 *     totals; the effective cost is acquisition + capitalised; potential margin
 *     is the asking price against that cost; aging counts from the acquisition
 *     date; and what has left the lot (sold, archived) is not stock.
 *   - §14/§15 «فروش و سودآوری خودرو»: revenue is the ledger's net — the invoice
 *     total less the VAT actually posted to 2200 — COGS is the frozen effective
 *     cost, and the report's own totals equal the accounts they came from. A
 *     reversed sale stays in the period, visibly reversed, at its frozen cost.
 *   - §14/§15 «رزروها و بیعانه‌ها»: a deposit is money *held* (credit 2430),
 *     never revenue, and a refund is only counted when its entry exists.
 *   - §15's delivery path: all three run through `runStandardReport` under an
 *     authorized branch scope, and belong to the automotive trade alone.
 *   - §20/§22: the tables these reports read carry row-level security that
 *     binds even a role whose predicate names the wrong tenant.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { rialText } from "../src/lib/inventory-exact";
import { branchScope } from "../src/lib/report-scope";
import { reportShape, standardReportsFor } from "../src/lib/reports";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let automotive: typeof import("../src/lib/automotive-service");
let reservations: typeof import("../src/lib/automotive-reservation-service");
let vehicleSales: typeof import("../src/lib/automotive-sales-service");
let invoiceService: typeof import("../src/lib/retail-invoice-service");
let reports: typeof import("../src/lib/automotive-reports-service");
let standardReports: typeof import("../src/lib/standard-report-service");

const biz = { id: "", locationId: "", secondLocationId: "", ownerId: "", customerId: "", otherCustomerId: "" };
const other = { id: "", locationId: "" };

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

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Independent date arithmetic, deliberately *not* the production helper: a test
 * that asserts the report equals `daysInStock(...)` would still pass if that
 * helper were wrong for both.
 */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** A hold that expires `days` from the branch's own business day — always live. */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Debit minus credit for one account — the shape every ledger cross-check below uses. */
async function accountBalance(code: string, businessId = biz.id): Promise<number> {
  const { rows } = await db.query<{ debit: string; credit: string }>(
    `SELECT coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.business_id = $1 AND a.code = $2`,
    [businessId, code],
  );
  return Number(rows[0].debit) - Number(rows[0].credit);
}

/** The books' customer-advance liability, read the way the report reads it. */
async function depositLiability(businessId = biz.id): Promise<number> {
  return -(await accountBalance("2430", businessId)) || 0;
}

/** The branch's own business day — the value `sellVehicle` stamps on a sale. */
async function businessDay(locationId = biz.locationId): Promise<string> {
  const { rows } = await db.query<{ today: string }>(
    `SELECT app_business_date(now(), coalesce(timezone, 'Asia/Tehran'), business_day_start_minutes)::text AS today
       FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0].today;
}

async function makeBusiness(slugPrefix: string) {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'automotive') RETURNING id",
    [`${slugPrefix} Co`, `${slugPrefix}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = rows[0].id;
  const { rows: locRows } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  await withTransaction((client) => provisioning.seedChartOfAccounts(client, businessId, "automotive"));
  return { businessId, locationId: locRows[0].id };
}

/** A minimal but complete car, so each test states only what it is testing. */
function carInput(overrides: Partial<Parameters<typeof automotive.createVehicle>[1]> = {}) {
  return {
    businessId: biz.id,
    locationId: biz.locationId,
    make: "پژو",
    model: "207",
    trim: "پانوراما",
    modelYear: 1403,
    vehicleYearCalendar: "jalali" as const,
    condition: "new" as const,
    askingPriceRial: 900_000_000,
    acquisition: {
      date: "2026-01-10",
      source: "dealer_purchase" as const,
      costRial: 700_000_000,
      settlement: "payable" as const,
    },
    ...overrides,
  };
}

/** A car with a base cost and one capitalised reconditioning cost on top. */
async function carReadyToSell(
  stockNumber: string,
  purchase = 700_000_000,
  capitalized = 30_000_000,
  overrides: Partial<Parameters<typeof automotive.createVehicle>[1]> = {},
) {
  const created = await withTransaction((client) =>
    automotive.createVehicle(
      client,
      carInput({
        stockNumber,
        acquisition: { date: "2025-01-10", source: "dealer_purchase", costRial: purchase, settlement: "payable" },
        ...overrides,
      }),
    ),
  );
  if (capitalized > 0) {
    await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: created.serialId,
        locationId: biz.locationId,
        createdBy: biz.ownerId,
        cost: {
          category: "repair",
          posting: "capitalized",
          amountRial: capitalized,
          incurredOn: "2025-01-20",
          settlement: "payable",
        },
      }),
    );
  }
  return created;
}

async function sellThroughInvoice(input: {
  serialId: string;
  price: number;
  vatPercent: number;
  tenderAmount: number;
  customerId?: string | null;
  createdBy?: string | null;
  /** Defaults to the primary business — the scoping tests sell at another branch/tenant. */
  businessId?: string;
  locationId?: string;
}) {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const invoice = await invoiceService.createRetailInvoice(client, {
      businessId: input.businessId ?? biz.id,
      locationId: input.locationId ?? biz.locationId,
      industry: "automotive",
      customerId: input.customerId ?? null,
      createdBy: input.createdBy ?? null,
      tenders: [{ method: "cash", amount: rialText(String(input.tenderAmount)) }],
      lines: [{ kind: "vehicle", serialId: input.serialId, price: input.price, vatPercent: input.vatPercent }],
    });
    await client.query("COMMIT");
    return invoice;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function reserve(input: {
  serialId: string;
  depositRial?: number;
  depositRefundable?: boolean;
  expiresAt?: string;
  expiresAtTime?: string;
  locationId?: string;
}) {
  return withTransaction((client) =>
    reservations.reserveVehicle(client, {
      businessId: biz.id,
      locationId: input.locationId ?? biz.locationId,
      serialId: input.serialId,
      customerId: biz.customerId,
      expiresAt: input.expiresAt,
      expiresAtTime: input.expiresAtTime,
      depositRial: input.depositRial,
      depositMethod: input.depositRial == null ? undefined : "cash",
      depositRefundable: input.depositRefundable,
      actorId: biz.ownerId,
    }),
  );
}

beforeAll(async () => {
  databaseName = `pos_automotive_reports_${randomUUID().replaceAll("-", "")}`;

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
  provisioning = await import("../src/lib/business-provisioning");
  automotive = await import("../src/lib/automotive-service");
  reservations = await import("../src/lib/automotive-reservation-service");
  vehicleSales = await import("../src/lib/automotive-sales-service");
  invoiceService = await import("../src/lib/retail-invoice-service");
  reports = await import("../src/lib/automotive-reports-service");
  standardReports = await import("../src/lib/standard-report-service");

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
  // A completed invoice's lines are immutable (guard_order_item_mutation,
  // migration 0014) — the same transaction-local escape hatch the other retail
  // and automotive suites use between tests, rather than weakening the guard.
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("COMMIT");

  await db.query("DELETE FROM automotive_vehicle_transfers");
  await db.query("DELETE FROM automotive_vehicle_sales");
  await db.query("DELETE FROM automotive_vehicle_price_history");
  await db.query("DELETE FROM automotive_vehicle_costs");
  await db.query("DELETE FROM automotive_vehicle_attributes");
  await db.query("DELETE FROM serial_reservations");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const primary = await makeBusiness("showroom");
  biz.id = primary.businessId;
  biz.locationId = primary.locationId;
  await db.query(
    `INSERT INTO settings (business_id, key, value) VALUES ($1, 'tax.config', '{"defaultRate":9}'::jsonb)`,
    [biz.id],
  );
  const { rows: secondLoc } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Branch 2') RETURNING id",
    [biz.id],
  );
  biz.secondLocationId = secondLoc[0].id;
  const { rows: ownerRows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name) VALUES ($1, $2, 'owner', 'مالک') RETURNING id`,
    [biz.id, biz.locationId],
  );
  biz.ownerId = ownerRows[0].id;
  const { rows: customerRows } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری رزرو', 'customer') RETURNING id",
    [biz.id],
  );
  biz.customerId = customerRows[0].id;
  const { rows: otherCustomerRows } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری دیگر', 'customer') RETURNING id",
    [biz.id],
  );
  biz.otherCustomerId = otherCustomerRows[0].id;

  const secondary = await makeBusiness("other");
  other.id = secondary.businessId;
  other.locationId = secondary.locationId;
});

describe("stock valuation report", () => {
  it("keeps acquisition, capitalised and expensed money apart, and values the lot from them", async () => {
    // «V-1»: a new car with one capitalised repair on top of its purchase.
    const v1 = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "V-1", askingPriceRial: 900_000_000 })),
    );
    await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: v1.serialId,
        locationId: biz.locationId,
        createdBy: biz.ownerId,
        cost: {
          category: "repair",
          posting: "capitalized",
          amountRial: 30_000_000,
          incurredOn: "2026-01-20",
          settlement: "payable",
        },
      }),
    );

    // «V-2»: an old used car whose prep money was expensed, not capitalised —
    // it therefore belongs in the period total and NOT in the car's basis.
    const v2 = await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "V-2",
          condition: "used",
          mileageKm: 180_000,
          priorOwners: 3,
          askingPriceRial: 500_000_000,
          acquisition: { date: "2025-06-01", source: "trade_in", costRial: 400_000_000, settlement: "payable" },
        }),
      ),
    );
    await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: v2.serialId,
        locationId: biz.locationId,
        createdBy: biz.ownerId,
        cost: {
          category: "other",
          posting: "period_expense",
          amountRial: 5_000_000,
          incurredOn: "2026-02-05",
          settlement: "cash",
        },
      }),
    );

    // «V-3»: on hold for a customer — still stock, and the report says so.
    const v3 = await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "V-3",
          condition: "used",
          mileageKm: 40_000,
          askingPriceRial: 380_000_000,
          acquisition: { date: "2026-02-20", source: "dealer_purchase", costRial: 300_000_000, settlement: "payable" },
        }),
      ),
    );
    await reserve({ serialId: v3.serialId, depositRial: 20_000_000, depositRefundable: true, expiresAt: "2026-03-20" });

    const report = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01" });
    expect(report.today).toBe("2026-03-01");
    // Oldest acquisition first: the register reads as a lot's own history.
    expect(report.rows.map((row) => row.stockNumber)).toEqual(["V-2", "V-1", "V-3"]);

    const byStock = new Map(report.rows.map((row) => [row.stockNumber, row]));
    const row1 = byStock.get("V-1")!;
    expect(row1).toMatchObject({
      condition: "new",
      state: "in_stock",
      acquiredOn: "2026-01-10",
      acquisitionCostRial: 700_000_000,
      capitalizedCostRial: 30_000_000,
      periodExpenseRial: 0,
      effectiveCostRial: 730_000_000,
      askingPriceRial: 900_000_000,
      potentialMarginRial: 170_000_000,
      ageBucket: "fresh",
    });
    expect(row1.daysInStock).toBe(daysBetween("2026-01-10", "2026-03-01"));

    const row2 = byStock.get("V-2")!;
    // The 5,000,000 prep was expensed: it is reported, and it did not enter the
    // basis — 400,000,000, not 405,000,000.
    expect(row2).toMatchObject({
      condition: "used",
      acquisitionCostRial: 400_000_000,
      capitalizedCostRial: 0,
      periodExpenseRial: 5_000_000,
      effectiveCostRial: 400_000_000,
      potentialMarginRial: 100_000_000,
      ageBucket: "dead",
    });
    expect(row2.daysInStock).toBe(daysBetween("2025-06-01", "2026-03-01"));

    const row3 = byStock.get("V-3")!;
    expect(row3.state).toBe("reserved");
    expect(row3.effectiveCostRial).toBe(300_000_000);

    const summary = report.summary;
    expect(summary).toMatchObject({
      count: 3,
      newCount: 1,
      usedCount: 2,
      inStockCount: 2,
      reservedCount: 1,
      totalAcquisitionCostRial: 1_400_000_000,
      totalCapitalizedCostRial: 30_000_000,
      totalPeriodExpenseRial: 5_000_000,
      totalEffectiveCostRial: 1_430_000_000,
      totalAskingPriceRial: 1_780_000_000,
      totalPotentialMarginRial: 350_000_000,
      slowCount: 0,
      deadCount: 1,
    });
    // A car acquired 2025-06-01 is 273 days old on 2026-03-01 — the bucket
    // boundary (90) is the domain's, and the average is the average of exactly
    // these three cars.
    expect(summary.averageAgeDays).toBe(
      Math.round((daysBetween("2026-01-10", "2026-03-01") + daysBetween("2025-06-01", "2026-03-01") + daysBetween("2026-02-20", "2026-03-01")) / 3),
    );
    expect(summary.ageBuckets.map(({ bucket, count }) => [bucket, count])).toEqual([
      ["fresh", 2],
      ["slow", 0],
      ["dead", 1],
    ]);
    expect(summary.byBranch).toEqual([
      { locationId: biz.locationId, locationName: "Main", count: 3, effectiveCostRial: 1_430_000_000, askingPriceRial: 1_780_000_000 },
    ]);
  });

  it("reports what is still on the lot, and shows the archive only when it is asked for", async () => {
    const kept = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "K-1", askingPriceRial: 900_000_000 })),
    );
    const archived = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "A-1", askingPriceRial: 600_000_000 })),
    );
    await withTransaction((client) =>
      automotive.archiveVehicle(client, {
        businessId: biz.id,
        serialId: archived.serialId,
        locationId: biz.locationId,
        reason: "خودرو به انبار دیگری منتقل شد",
        actorId: biz.ownerId,
      }),
    );

    const sold = await carReadyToSell("S-1", 500_000_000, 0);
    await sellThroughInvoice({ serialId: sold.serialId, price: 700_000_000, vatPercent: 9, tenderAmount: 763_000_000 });

    const onHand = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01" });
    expect(onHand.rows.map((row) => row.stockNumber)).toEqual([kept.stockNumber]);
    expect(onHand.summary.count).toBe(1);

    // `includeArchived` is the reconciliation view for what left the lot *by
    // being written off* — a sold car left by being sold, and is the sales
    // report's business, so it stays out of stock either way.
    const withArchive = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01", includeArchived: true });
    expect(withArchive.rows.map((row) => row.stockNumber)).toEqual(["A-1", "K-1"]);
    expect(withArchive.rows.find((row) => row.stockNumber === "A-1")?.state).toBe("archived");
    expect(withArchive.summary.count).toBe(2);
  });

  it("scopes the lot to one branch, and never to another tenant", async () => {
    await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "MAIN-1", askingPriceRial: 900_000_000 })),
    );
    await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "SITE-1",
          locationId: biz.secondLocationId,
          askingPriceRial: 800_000_000,
        }),
      ),
    );
    await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "THEIRS-1",
          businessId: other.id,
          locationId: other.locationId,
          askingPriceRial: 700_000_000,
        }),
      ),
    );

    const allBranches = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01" });
    expect(allBranches.rows.map((row) => row.stockNumber)).toEqual(["MAIN-1", "SITE-1"]);
    expect(allBranches.summary.byBranch.map((branch) => branch.count)).toEqual([1, 1]);

    const mainOnly = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01", locationId: biz.locationId });
    expect(mainOnly.rows.map((row) => row.stockNumber)).toEqual(["MAIN-1"]);

    const siteOnly = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01", locationId: biz.secondLocationId });
    expect(siteOnly.rows.map((row) => row.stockNumber)).toEqual(["SITE-1"]);

    // The other dealership's lot is not ours, in either direction.
    const theirs = await reports.vehicleInventoryReport(other.id, { today: "2026-03-01" });
    expect(theirs.rows.map((row) => row.stockNumber)).toEqual(["THEIRS-1"]);
    expect(theirs.summary.totalEffectiveCostRial).toBe(700_000_000);
    expect(theirs.rows.some((row) => row.stockNumber === "MAIN-1")).toBe(false);
    expect(allBranches.rows.some((row) => row.stockNumber === "THEIRS-1")).toBe(false);
  });
});

describe("sales and profitability report", () => {
  it("ties the period's revenue, its COGS and its profit to the ledger they came from", async () => {
    const soldOn = await businessDay();
    const v1 = await carReadyToSell("S-1", 700_000_000, 30_000_000);
    // 900,000,000 + 9% VAT = 981,000,000 — cost 730,000,000, profit 170,000,000.
    await sellThroughInvoice({
      serialId: v1.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
      createdBy: biz.ownerId,
    });
    // A second car — another model, and with no recorded salesperson: it must
    // still be counted, and it must show up in the breakdown as its own bucket.
    const v2 = await carReadyToSell("S-2", 400_000_000, 0, { model: "کوییک", trim: null, modelYear: 1402 });
    await sellThroughInvoice({ serialId: v2.serialId, price: 500_000_000, vatPercent: 9, tenderAmount: 545_000_000 });
    // A car bought and still on the lot in the same period: §14's «خرید و فروش دوره».
    await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "B-1",
          askingPriceRial: 600_000_000,
          acquisition: { date: soldOn, source: "dealer_purchase", costRial: 450_000_000, settlement: "payable" },
        }),
      ),
    );

    const report = await reports.vehicleSalesReport(biz.id, { dateFrom: soldOn, dateTo: soldOn });
    expect(report.dateFrom).toBe(soldOn);
    expect(report.dateTo).toBe(soldOn);
    expect(report.rows.map((row) => row.stockNumber)).toEqual(["S-1", "S-2"]);

    const byStock = new Map(report.rows.map((row) => [row.stockNumber, row]));
    const row1 = byStock.get("S-1")!;
    expect(row1).toMatchObject({
      condition: "new",
      soldOn,
      // The invoice total, VAT included — what the customer paid.
      salePriceRial: 981_000_000,
      // …less the VAT the entry actually posted: the revenue the ledger credited.
      revenueRial: 900_000_000,
      effectiveCostRial: 730_000_000,
      grossProfitRial: 170_000_000,
      marginPercent: 18.9,
      salespersonId: biz.ownerId,
      salespersonName: "مالک",
      locationId: biz.locationId,
      reversed: false,
    });
    // The car was acquired 2025-01-10 — long before the row that reports it was
    // written — so a "days to sale" that counted from `created_at` would be a
    // small number instead of this one.
    expect(row1.daysToSale).toBe(daysBetween("2025-01-10", soldOn));
    expect(row1.daysToSale).toBeGreaterThan(200);

    const row2 = byStock.get("S-2")!;
    expect(row2).toMatchObject({
      revenueRial: 500_000_000,
      effectiveCostRial: 400_000_000,
      grossProfitRial: 100_000_000,
      marginPercent: 20,
      salespersonId: null,
      salespersonName: null,
      reversed: false,
    });

    const summary = report.summary;
    expect(summary).toMatchObject({
      unitsSold: 2,
      revenueGrossRial: 1_526_000_000,
      revenueRial: 1_400_000_000,
      cogsRial: 1_130_000_000,
      grossProfitRial: 270_000_000,
      averageMarginPercent: 19.3,
      reversedCount: 0,
    });
    expect(summary.averageDaysToSale).toBe(
      Math.round((row1.daysToSale! + row2.daysToSale!) / 2),
    );
    // «خرید و فروش دوره»: the one car bought in this period, at its purchase cost.
    expect(summary.acquisitions).toEqual({ count: 1, costRial: 450_000_000, tradeInCount: 0, tradeInCostRial: 0 });

    // The report and the books are the same numbers: net revenue is the credit
    // on 4590, COGS is the debit on 5194, and the difference between the invoice
    // totals and the revenue is exactly the VAT the entries charged to 2200.
    expect(summary.revenueRial).toBe(-(await accountBalance("4590")));
    expect(summary.grossProfitRial).toBe(-(await accountBalance("4590")) - (await accountBalance("5194")));
    expect(summary.revenueGrossRial - summary.revenueRial).toBe(-(await accountBalance("2200")));

    // Grouping: the named seller first (best profit), the unnamed sale visible
    // as its own bucket rather than dropped.
    expect(summary.bySalesperson.map((group) => [group.label, group.units, group.grossProfitRial])).toEqual([
      ["مالک", 1, 170_000_000],
      ["بدون فروشندهٔ ثبت‌شده", 1, 100_000_000],
    ]);
    expect(summary.byMakeModel).toHaveLength(2);
    expect(summary.byMakeModel[0].grossProfitRial).toBeGreaterThan(summary.byMakeModel[1].grossProfitRial);

    // A range that ends before the sale reports nothing — and says so with
    // zeros and a null margin rather than a divide-by-zero.
    const before = await reports.vehicleSalesReport(biz.id, { dateFrom: "2020-01-01", dateTo: "2020-12-31" });
    expect(before.rows).toEqual([]);
    expect(before.summary).toMatchObject({
      unitsSold: 0,
      revenueRial: 0,
      cogsRial: 0,
      grossProfitRial: 0,
      averageMarginPercent: null,
      averageDaysToSale: null,
      acquisitions: { count: 0, costRial: 0 },
    });
  });

  it("keeps a reversed sale in the period, visibly reversed, at its frozen cost", async () => {
    const soldOn = await businessDay();
    const car = await carReadyToSell("R-1", 700_000_000, 30_000_000);
    await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
      createdBy: biz.ownerId,
    });

    await withTransaction((client) =>
      vehicleSales.reverseVehicleSale(client, {
        businessId: biz.id,
        serialId: car.serialId,
        locationId: biz.locationId,
        reason: "انصراف مشتری و برگشت وجه",
        actorId: biz.ownerId,
      }),
    );
    // A car returned and put back on the lot costs money to prepare again — the
    // closed sale must keep reporting the basis it was sold on.
    await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: car.serialId,
        locationId: biz.locationId,
        createdBy: biz.ownerId,
        cost: {
          category: "repair",
          posting: "capitalized",
          amountRial: 12_000_000,
          incurredOn: "2026-03-02",
          settlement: "payable",
        },
      }),
    );

    const report = await reports.vehicleSalesReport(biz.id, { dateFrom: soldOn, dateTo: soldOn });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      stockNumber: "R-1",
      reversed: true,
      revenueRial: 900_000_000,
      // 700,000,000 + 30,000,000 frozen at the sale — not today's 742,000,000.
      effectiveCostRial: 730_000_000,
      grossProfitRial: 170_000_000,
    });
    // «۳ فروش و ۱ برگشت» never silently reads as «۲ فروش».
    expect(report.summary).toMatchObject({ unitsSold: 1, reversedCount: 1, cogsRial: 730_000_000 });

    const { rows } = await db.query<{ status: string; reversal_entry_ids: string[] }>(
      "SELECT status, reversal_entry_ids FROM automotive_vehicle_sales WHERE business_id = $1 AND serial_id = $2",
      [biz.id, car.serialId],
    );
    expect(rows[0].status).toBe("reversed");
    expect(rows[0].reversal_entry_ids.length).toBeGreaterThan(0);
  });

  it("scopes the period to one branch and to one tenant", async () => {
    const soldOn = await businessDay();
    // A car at the second branch, sold by an invoice in that branch...
    const siteCar = await carReadyToSell("SB-2", 200_000_000, 0, { locationId: biz.secondLocationId });
    await sellThroughInvoice({
      serialId: siteCar.serialId,
      price: 300_000_000,
      vatPercent: 9,
      tenderAmount: 327_000_000,
      locationId: biz.secondLocationId,
    });
    // ...and one at the primary branch.
    const mainCar = await carReadyToSell("SB-1", 300_000_000, 0);
    await sellThroughInvoice({ serialId: mainCar.serialId, price: 400_000_000, vatPercent: 9, tenderAmount: 436_000_000 });

    // The other dealership's own car and sale, on the same day.
    await db.query(
      `INSERT INTO settings (business_id, key, value) VALUES ($1, 'tax.config', '{"defaultRate":9}'::jsonb)`,
      [other.id],
    );
    const theirCar = await carReadyToSell("SB-3", 100_000_000, 0, { businessId: other.id, locationId: other.locationId });
    await sellThroughInvoice({
      serialId: theirCar.serialId,
      price: 150_000_000,
      vatPercent: 9,
      tenderAmount: 163_500_000,
      businessId: other.id,
      locationId: other.locationId,
    });

    // Both of ours, each with the branch that sold it — and neither of theirs.
    const allBranches = await reports.vehicleSalesReport(biz.id, { dateFrom: soldOn, dateTo: soldOn });
    expect(allBranches.rows.map((row) => [row.stockNumber, row.locationName])).toEqual([
      ["SB-1", "Main"],
      ["SB-2", "Branch 2"],
    ]);
    expect(allBranches.summary).toMatchObject({
      unitsSold: 2,
      revenueGrossRial: 763_000_000,
      revenueRial: 700_000_000,
      cogsRial: 500_000_000,
      grossProfitRial: 200_000_000,
    });
    expect(allBranches.summary.revenueGrossRial - allBranches.summary.revenueRial).toBe(-(await accountBalance("2200")));
    expect(allBranches.rows.some((row) => row.stockNumber === "SB-3")).toBe(false);

    // One branch is one branch: `locationId` narrows both the rows and the money.
    const mainOnly = await reports.vehicleSalesReport(biz.id, { dateFrom: soldOn, dateTo: soldOn, locationId: biz.locationId });
    expect(mainOnly.rows.map((row) => row.stockNumber)).toEqual(["SB-1"]);
    expect(mainOnly.summary).toMatchObject({
      unitsSold: 1,
      revenueRial: 400_000_000,
      cogsRial: 300_000_000,
      grossProfitRial: 100_000_000,
    });

    const siteOnly = await reports.vehicleSalesReport(biz.id, {
      dateFrom: soldOn,
      dateTo: soldOn,
      locationId: biz.secondLocationId,
    });
    expect(siteOnly.rows.map((row) => row.stockNumber)).toEqual(["SB-2"]);
    expect(siteOnly.summary).toMatchObject({ unitsSold: 1, revenueRial: 300_000_000, cogsRial: 200_000_000 });

    // The other dealership's report is theirs alone — and ties to their books.
    const theirs = await reports.vehicleSalesReport(other.id, { dateFrom: soldOn, dateTo: soldOn });
    expect(theirs.rows.map((row) => row.stockNumber)).toEqual(["SB-3"]);
    expect(theirs.summary).toMatchObject({ unitsSold: 1, revenueRial: 150_000_000, cogsRial: 100_000_000, grossProfitRial: 50_000_000 });
    expect(theirs.summary.revenueRial).toBe(-(await accountBalance("4590", other.id)));
  });
});

describe("reservations and deposits report", () => {
  it("reports a deposit as money held — a liability — never as revenue", async () => {
    // The report is read as of the branch's own business day, and the holds are
    // planted relative to it — a hold that had already lapsed would be expired
    // by the counter's own read, which is a different test's subject.
    const today = await businessDay();

    // Two live holds: one refundable, one not. «H-1» lapses in two days, which
    // is the list the counter rings the customer about.
    const h1 = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "H-1", askingPriceRial: 380_000_000 })),
    );
    const hold1 = await reserve({
      serialId: h1.serialId,
      depositRial: 50_000_000,
      depositRefundable: true,
      expiresAt: addDays(today, 2),
      expiresAtTime: "18:00",
    });
    const h2 = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "H-2", askingPriceRial: 300_000_000 })),
    );
    await reserve({ serialId: h2.serialId, depositRial: 20_000_000, depositRefundable: false });

    // A hold released with the deposit handed back, and one converted by a sale.
    const h3 = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "H-3", askingPriceRial: 320_000_000 })),
    );
    const hold3 = await reserve({ serialId: h3.serialId, depositRial: 30_000_000, depositRefundable: true });
    await withTransaction((client) =>
      reservations.releaseVehicleReservation(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        reservationId: hold3.id,
        reason: "انصراف مشتری",
        refund: true,
        actorId: biz.ownerId,
      }),
    );

    const h4 = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "H-4", askingPriceRial: 400_000_000 })),
    );
    const hold4 = await reserve({
      serialId: h4.serialId,
      depositRial: 40_000_000,
      depositRefundable: true,
      expiresAt: addDays(today, 30),
    });
    expect(hold4.depositEntryId).toBeTruthy();
    // 400,000,000 + 9% VAT = 436,000,000, less the 40,000,000 already in hand.
    await sellThroughInvoice({
      serialId: h4.serialId,
      price: 400_000_000,
      vatPercent: 9,
      tenderAmount: 396_000_000,
      customerId: biz.customerId,
      createdBy: biz.ownerId,
    });

    // The hold's age is the age of the *hold* — not of the car it holds, and not
    // of its expiry. Backdate this row's own creation and the register has to
    // follow it: a report that aged holds from `expires_at`, or from the
    // vehicle's acquisition date, would answer something else entirely (0, or
    // several hundred days) instead of the 30 written here.
    const takenOn = addDays(today, -30);
    await db.query(`UPDATE serial_reservations SET created_at = ($2::date + time '12:00') WHERE id = $1`, [
      hold1.id,
      takenOn,
    ]);

    const report = await reports.vehicleReservationReport(biz.id, { today });
    expect(report.today).toBe(today);
    // Live holds first — the register is a worklist before it is a history.
    expect(report.rows.slice(0, 2).map((row) => row.status)).toEqual(["active", "active"]);
    expect(report.rows.map((row) => row.status).sort()).toEqual(["active", "active", "converted", "released"]);

    const byStock = new Map(report.rows.map((row) => [row.stockNumber, row]));
    expect(byStock.get("H-1")).toMatchObject({
      status: "active",
      customerName: "مشتری رزرو",
      depositRial: 50_000_000,
      depositMethod: "cash",
      depositRefundable: true,
      depositRefundedRial: 0,
      expiresAt: addDays(today, 2),
      expiresAtTime: "18:00:00",
      locationName: "Main",
      releaseReason: null,
      ageDays: 30,
    });
    expect(byStock.get("H-1")!.createdAt).toContain(takenOn);
    // The refund is the amount that actually went back, with its entry.
    expect(byStock.get("H-3")).toMatchObject({ status: "released", depositRefundedRial: 30_000_000, releaseReason: "انصراف مشتری" });
    // The converted hold was closed by the sale, not refunded.
    expect(byStock.get("H-4")).toMatchObject({ status: "converted", depositRefundedRial: 0 });

    const summary = report.summary;
    expect(summary).toMatchObject({
      total: 4,
      activeCount: 2,
      convertedCount: 1,
      releasedCount: 1,
      expiredCount: 0,
      // Only live holds hold money, and the non-refundable part is named: a
      // cancellation keeps exactly that.
      depositHeldRial: 70_000_000,
      nonRefundableHeldRial: 20_000_000,
      // H-3's 30,000,000 came back; the converted hold's deposit was applied to
      // an invoice instead, which is not a refund.
      depositRefundedRial: 30_000_000,
      expiringSoonCount: 1,
    });

    // The number the report calls «جمع بیعانه» is the customer-advance liability
    // on the books — and not a riyal of the period's revenue. Only the one sale
    // is revenue, and its VAT is the 9% the invoice charged.
    expect(summary.depositHeldRial).toBe(await depositLiability());
    expect(-(await accountBalance("4590"))).toBe(400_000_000);
    expect(-(await accountBalance("2200"))).toBe(36_000_000);
  });

  it("never reports another branch's or another tenant's holds", async () => {
    const mine = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "MINE-1", askingPriceRial: 380_000_000 })),
    );
    await reserve({ serialId: mine.serialId, depositRial: 10_000_000, depositRefundable: true });

    const siteCar = await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({ stockNumber: "SITE-HOLD-1", locationId: biz.secondLocationId, askingPriceRial: 300_000_000 }),
      ),
    );
    await reserve({ serialId: siteCar.serialId, depositRial: 15_000_000, depositRefundable: true, locationId: biz.secondLocationId });

    const otherCar = await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({ stockNumber: "THEIRS-HOLD-1", businessId: other.id, locationId: other.locationId, askingPriceRial: 200_000_000 }),
      ),
    );
    // A customer of *their* business: a hold is a customer's money, and the
    // other tenant's deposit must be counted on their side of the wall.
    const { rows: theirCustomer } = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری نمایشگاه دیگر', 'customer') RETURNING id",
      [other.id],
    );
    await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: other.id,
        locationId: other.locationId,
        serialId: otherCar.serialId,
        customerId: theirCustomer[0].id,
        depositRial: 25_000_000,
        depositMethod: "cash",
        actorId: biz.ownerId,
      }),
    );

    const all = await reports.vehicleReservationReport(biz.id, { today: "2026-03-01" });
    expect([...all.rows.map((row) => row.stockNumber)].sort()).toEqual(["MINE-1", "SITE-HOLD-1"]);
    expect(all.summary.depositHeldRial).toBe(25_000_000);

    const mainOnly = await reports.vehicleReservationReport(biz.id, { today: "2026-03-01", locationId: biz.locationId });
    expect(mainOnly.rows.map((row) => row.stockNumber)).toEqual(["MINE-1"]);
    expect(mainOnly.summary.depositHeldRial).toBe(10_000_000);

    const theirs = await reports.vehicleReservationReport(other.id, { today: "2026-03-01" });
    expect(theirs.rows.map((row) => row.stockNumber)).toEqual(["THEIRS-HOLD-1"]);
    expect(theirs.summary.depositHeldRial).toBe(25_000_000);
    expect(theirs.summary.depositHeldRial).toBe(await depositLiability(other.id));
  });
});

describe("through the standard-report dispatcher", () => {
  it("runs all three under an authorized branch scope, and only for the automotive trade", async () => {
    const soldOn = await businessDay();
    const car = await carReadyToSell("D-1", 700_000_000, 0);
    await sellThroughInvoice({ serialId: car.serialId, price: 900_000_000, vatPercent: 9, tenderAmount: 981_000_000 });
    const holdCar = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "D-2", askingPriceRial: 500_000_000 })),
    );
    await reserve({ serialId: holdCar.serialId, depositRial: 25_000_000, depositRefundable: true });

    const definitions = standardReportsFor("automotive");
    const shapeOf = (key: string) => reportShape(definitions.find((def) => def.key === key)!);
    expect(shapeOf("vehicle_stock_valuation")).toBe("vehicle_inventory");
    expect(shapeOf("vehicle_sales_profitability")).toBe("vehicle_sales");
    expect(shapeOf("vehicle_reservations")).toBe("vehicle_reservations");

    const scope = branchScope(biz.locationId);
    const inventory = await standardReports.runStandardReport(biz.id, "automotive", definitions.find((d) => d.key === "vehicle_stock_valuation")!, { scope });
    expect(inventory.report).toMatchObject({ today: expect.any(String) });
    expect((inventory.report as { rows: unknown[] }).rows).toHaveLength(1);

    const sales = await standardReports.runStandardReport(biz.id, "automotive", definitions.find((d) => d.key === "vehicle_sales_profitability")!, {
      scope,
      dateFrom: soldOn,
      dateTo: soldOn,
    });
    expect((sales.report as { summary: { unitsSold: number } }).summary.unitsSold).toBe(1);

    const holds = await standardReports.runStandardReport(biz.id, "automotive", definitions.find((d) => d.key === "vehicle_reservations")!, { scope });
    expect((holds.report as { summary: { depositHeldRial: number } }).summary.depositHeldRial).toBe(25_000_000);

    // The same lookup the route performs: another trade's catalogue does not
    // contain them, so an automotive key on a café answers 404 exactly as an
    // invented one does.
    const keys = (industry: Parameters<typeof standardReportsFor>[0]) => standardReportsFor(industry).map((def) => def.key);
    expect(keys("food_service")).not.toContain("vehicle_stock_valuation");
    expect(keys("food_service")).not.toContain("vehicle_sales_profitability");
    expect(keys("food_service")).not.toContain("vehicle_reservations");
    expect(keys("automotive")).toEqual(expect.arrayContaining(["vehicle_stock_valuation", "vehicle_sales_profitability", "vehicle_reservations"]));
  });
});

describe("the reports' own tables are tenant-isolated", () => {
  it("binds a non-bypass role even when its predicate names the other tenant", async () => {
    // Every table these reports read, plus the rest of the automotive set: RLS
    // enabled *and* forced, with a tenant policy on each.
    const { rows: tables } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              coalesce((SELECT string_agg(p.policyname, ',') FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = c.relname), '') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('automotive_vehicle_attributes', 'automotive_vehicle_costs',
                            'automotive_vehicle_price_history', 'automotive_vehicle_transfers',
                            'automotive_vehicle_sales', 'automotive_vehicle_media',
                            'automotive_vehicle_stock_mirror', 'automotive_vehicle_offline_requests',
                            'crm_lead_vehicle_preferences', 'crm_lead_vehicle_links',
                            'serial_reservations')
        ORDER BY c.relname`,
    );
    expect(tables.map((row) => row.relname)).toHaveLength(11);
    for (const table of tables) {
      expect(table, table.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(table.policies, table.relname).toContain("tenant_isolation");
    }

    const mine = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "RLS-1", askingPriceRial: 900_000_000 })),
    );
    await reserve({ serialId: mine.serialId, depositRial: 10_000_000, depositRefundable: true });
    const theirs = await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({ stockNumber: "RLS-2", businessId: other.id, locationId: other.locationId, askingPriceRial: 800_000_000 }),
      ),
    );

    const role = `report_reader_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await db.query(`SET ROLE ${role}`);
    await db.query("SELECT set_config('app.business_id', $1, false)", [biz.id]);
    try {
      // Scoped to us, the wrong predicate still shows nothing that is not ours…
      const wrongPredicate = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM automotive_vehicle_attributes WHERE business_id = $1",
        [other.id],
      );
      expect(wrongPredicate.rows[0].count).toBe("0");
      const otherHolds = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM serial_reservations WHERE business_id = $1",
        [other.id],
      );
      expect(otherHolds.rows[0].count).toBe("0");
      // …while our own rows are exactly what we put there.
      const ours = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM automotive_vehicle_attributes WHERE business_id = $1",
        [biz.id],
      );
      expect(ours.rows[0].count).toBe("1");
    } finally {
      await db.query("RESET ROLE");
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
    }

    // Both tenants' rows are really there: the block above was RLS, not an
    // empty fixture.
    const { rows: both } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM automotive_vehicle_attributes WHERE serial_id = ANY($1::uuid[])",
      [[mine.serialId, theirs.serialId]],
    );
    expect(both[0].count).toBe("2");
  });
});
