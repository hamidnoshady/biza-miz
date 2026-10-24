/**
 * Issue #963 (#839 §9) — the two-sided trade-in, against a real database.
 *
 * What this file proves, in the issue's own terms:
 *
 *   - **one operation, two sides**: A sells, B enters stock `in_stock` in
 *     the branch that took it (serial + attributes + allowance cost +
 *     `source: "trade_in"`), and the difference settles — in one
 *     transaction, so a refused sale leaves no B behind;
 *   - **canonical accounting**: A posts revenue/VAT/COGS by the ordinary
 *     sale rules at its full price, B's acquisition credits 2465 and the
 *     applied allowance debits it back inside the revenue entry, the
 *     difference lands in cash or in receivables, and `payments` records
 *     only today's money (never the car);
 *   - **the link is the audit**: `automotive_vehicle_trade_ins` binds the
 *     sale occurrence to the acquired vehicle with frozen figures;
 *   - **valuation honesty**: B's asking price is its expected retail and
 *     its cost is the allowance, so selling B later freezes COGS at the
 *     allowance;
 *   - **deposits**: A's reservation deposit is applied to the difference
 *     and the hold closes as converted;
 *   - **reversal of both directions, and its refusals**: the whole deal
 *     mirrors back (A `returned`, B archived, every account netting to its
 *     pre-deal figure), a plain sale reversal refuses, and reversing is
 *     refused legibly when B has been sold or has active costs;
 *   - **exactly once**: a retried submission replays, a changed payload
 *     under the same key conflicts, and two concurrent deals for one A
 *     produce exactly one sale, one B and one link;
 *   - **tenant isolation** of the cars, the customer and the link rows;
 *   - **reports**: the allowance appears in profitability and acquisition
 *     reporting as a named subset — inside neither revenue nor a second
 *     acquisitions total.
 *
 * The tenant export/restore half of the round trip is proven in
 * `automotive-backup-restore.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

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
let tradeIns: typeof import("../src/lib/automotive-trade-in-service");
let invoiceService: typeof import("../src/lib/retail-invoice-service");
let reports: typeof import("../src/lib/automotive-reports-service");
let exact: typeof import("../src/lib/inventory-exact");

const biz = { id: "", locationId: "", ownerId: "", customerId: "", otherCustomerId: "" };
const other = { id: "", locationId: "", customerId: "" };

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

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

async function waitUntilBlocked(observer: PoolClient, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ blocked: boolean }>(
      "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked",
      [blockedPid],
    );
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`client ${blockedPid} did not block on the competing trade-in`);
}

/** Debit − credit for one account code in one business. */
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

/** Vehicle A: bought for 700M, on the lot at 1,000M. */
function carAInput(overrides: Partial<Parameters<typeof automotive.createVehicle>[1]> = {}) {
  return {
    businessId: biz.id,
    locationId: biz.locationId,
    make: "پژو",
    model: "207",
    trim: "پانوراما",
    modelYear: 1403,
    vehicleYearCalendar: "jalali" as const,
    condition: "new" as const,
    askingPriceRial: 1_000_000_000,
    acquisition: {
      date: "2026-01-10",
      source: "dealer_purchase" as const,
      costRial: 700_000_000,
      settlement: "payable" as const,
    },
    createdBy: biz.ownerId,
    ...overrides,
  };
}

/** One whole deal at the file's canonical figures: A at 1,000M + 9% VAT; B allowed 400M, to retail at 520M. */
function dealInput(
  soldSerialId: string,
  overrides: Partial<Parameters<typeof tradeIns.executeTradeIn>[1]> = {},
): Parameters<typeof tradeIns.executeTradeIn>[1] {
  return {
    businessId: biz.id,
    locationId: biz.locationId,
    soldSerialId,
    customerId: biz.customerId,
    salePriceRial: 1_000_000_000,
    differenceSettlement: "cash",
    tradeIn: {
      make: "سمند",
      model: "سورن",
      modelYear: 1398,
      vehicleYearCalendar: "jalali",
      mileageKm: 120_000,
      priorOwners: 2,
      plateNumber: "۱۵ ب ۲۳۴ ۵۶",
    },
    allowanceRial: 400_000_000,
    expectedRetailRial: 520_000_000,
    acquisitionDate: "2026-02-01",
    createdBy: biz.ownerId,
    ...overrides,
  };
}

async function makeCarA(overrides: Partial<Parameters<typeof automotive.createVehicle>[1]> = {}) {
  return withTransaction((client) => automotive.createVehicle(client, carAInput(overrides)));
}

async function vehicleRow(serialId: string) {
  const { rows } = await db.query<{
    state: string;
    condition: string;
    location_id: string;
    acquisition_source: string | null;
    acquisition_party_id: string | null;
    purchase_cost_rial: string;
    asking_price_rial: string;
    stock_number: string;
  }>(
    `SELECT state, condition, location_id, acquisition_source, acquisition_party_id,
            purchase_cost_rial::text, asking_price_rial::text, stock_number
       FROM automotive_vehicle_attributes WHERE serial_id = $1`,
    [serialId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  databaseName = `pos_auto_tradein_${randomUUID().replaceAll("-", "")}`;
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
  tradeIns = await import("../src/lib/automotive-trade-in-service");
  invoiceService = await import("../src/lib/retail-invoice-service");
  reports = await import("../src/lib/automotive-reports-service");
  exact = await import("../src/lib/inventory-exact");
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
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("COMMIT");

  await db.query("DELETE FROM automotive_vehicle_trade_ins");
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
  const { rows: ownerRows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name) VALUES ($1, $2, 'owner', 'مالک') RETURNING id`,
    [biz.id, biz.locationId],
  );
  biz.ownerId = ownerRows[0].id;
  const { rows: customerRows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری معاوضه', 'customer') RETURNING id`,
    [biz.id],
  );
  biz.customerId = customerRows[0].id;
  const { rows: otherCustomerRows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری دیگر', 'customer') RETURNING id`,
    [biz.id],
  );
  biz.otherCustomerId = otherCustomerRows[0].id;

  const secondary = await makeBusiness("other");
  other.id = secondary.businessId;
  other.locationId = secondary.locationId;
  const { rows: otherParty } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری رقیب', 'customer') RETURNING id`,
    [other.id],
  );
  other.customerId = otherParty[0].id;
});

describe("the two-sided deal", () => {
  it("sells A, stocks B at its allowance, settles the difference in cash — one transaction", async () => {
    const carA = await makeCarA();
    const result = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));

    // The frozen arithmetic: total 1,090M (1,000M + 9%), allowance 400M
    // applied in full, 690M collected.
    expect(result.replayed).toBe(false);
    expect(result.tradeIn.saleTotalRial).toBe(1_090_000_000);
    expect(result.tradeIn.allowanceRial).toBe(400_000_000);
    expect(result.tradeIn.tradeInAppliedRial).toBe(400_000_000);
    expect(result.tradeIn.remainderPayableRial).toBe(0);
    expect(result.tradeIn.differenceDueRial).toBe(690_000_000);
    expect(result.tradeIn.differenceSettlement).toBe("cash");
    expect(result.tradeIn.status).toBe("active");

    const a = await vehicleRow(carA.serialId);
    expect(a?.state).toBe("sold");
    const b = await vehicleRow(result.acquiredSerialId);
    expect(b).toMatchObject({
      state: "in_stock",
      condition: "used",
      location_id: biz.locationId,
      acquisition_source: "trade_in",
      acquisition_party_id: biz.customerId,
    });
    // Valuation honesty: cost is the allowance; asking is the expected retail.
    expect(Number(b?.purchase_cost_rial)).toBe(400_000_000);
    expect(Number(b?.asking_price_rial)).toBe(520_000_000);

    // Canonical accounting. A at full price; 2465 credited by B's
    // acquisition and debited back by the applied allowance — net zero.
    expect(await accountBalance("4590")).toBe(-1_000_000_000);
    expect(await accountBalance("2200")).toBe(-90_000_000);
    expect(await accountBalance("1100")).toBe(690_000_000);
    expect(await accountBalance("2465")).toBe(0);
    expect(await accountBalance("5194")).toBe(700_000_000);
    // Inventory: +700 (A bought) +400 (B in) −700 (A's COGS) = B's basis.
    expect(await accountBalance("1370")).toBe(400_000_000);

    // The shift reconciles today's money only — the car is not a payment.
    const { rows: payments } = await db.query<{ method: string; amount: string }>(
      "SELECT method::text, amount::text FROM payments WHERE order_id = $1",
      [result.orderId],
    );
    expect(payments).toEqual([{ method: "cash", amount: "690000000" }]);

    // The link answers "which car paid for which car" from either side,
    // and the event went on the audit trail.
    const byId = await dbLib.withTenant(biz.id, () => tradeIns.getTradeIn(biz.id, result.tradeIn.id));
    expect(byId?.soldSerialId).toBe(carA.serialId);
    expect(byId?.acquiredSerialId).toBe(result.acquiredSerialId);
    expect(byId?.saleId).toBe(result.saleId);
    const fromB = await dbLib.withTenant(biz.id, () =>
      tradeIns.listTradeInsForVehicle(biz.id, result.acquiredSerialId),
    );
    expect(fromB.map((deal) => deal.id)).toEqual([result.tradeIn.id]);
    const { rows: events } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM domain_events
        WHERE business_id = $1 AND event_type = 'automotive.trade_in_completed' AND source_id = $2`,
      [biz.id, result.tradeIn.id],
    );
    expect(Number(events[0].count)).toBe(1);
  });

  it("leaves the difference as a receivable when settled on account", async () => {
    const carA = await makeCarA();
    const result = await withTransaction((client) =>
      tradeIns.executeTradeIn(client, dealInput(carA.serialId, { differenceSettlement: "credit" })),
    );
    expect(result.tradeIn.differenceSettlement).toBe("credit");
    expect(await accountBalance("1200")).toBe(690_000_000);
    expect(await accountBalance("1100")).toBe(0);
    const { rows: payments } = await db.query<{ method: string; amount: string }>(
      "SELECT method::text, amount::text FROM payments WHERE order_id = $1",
      [result.orderId],
    );
    expect(payments).toEqual([{ method: "credit", amount: "690000000" }]);
  });

  it("applies A's reservation deposit to the difference and closes the hold as converted", async () => {
    const carA = await makeCarA();
    const hold = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: carA.serialId,
        customerId: biz.customerId,
        depositRial: 90_000_000,
        depositMethod: "cash",
        actorId: biz.ownerId,
      }),
    );
    expect(await accountBalance("2430")).toBe(-90_000_000);

    const result = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));
    expect(result.tradeIn.depositAppliedRial).toBe(90_000_000);
    expect(result.tradeIn.differenceDueRial).toBe(600_000_000);
    expect(await accountBalance("2430")).toBe(0);
    expect(await accountBalance("1100")).toBe(90_000_000 + 600_000_000);

    const { rows } = await db.query<{ status: string; deposit_refund_entry_id: string | null; converted_order_id: string | null }>(
      "SELECT status, deposit_refund_entry_id, converted_order_id FROM serial_reservations WHERE id = $1",
      [hold.id],
    );
    expect(rows[0].status).toBe("converted");
    expect(rows[0].deposit_refund_entry_id).toBeNull();
    expect(rows[0].converted_order_id).toBe(result.orderId);
  });

  it("keeps an allowance larger than the invoice as money owed to the customer", async () => {
    const carA = await makeCarA({ askingPriceRial: 300_000_000 });
    const result = await withTransaction((client) =>
      tradeIns.executeTradeIn(
        client,
        dealInput(carA.serialId, { salePriceRial: 300_000_000, allowanceRial: 500_000_000 }),
      ),
    );
    // Total 327M; the allowance covers it and 173M stays payable on 2465.
    expect(result.tradeIn.tradeInAppliedRial).toBe(327_000_000);
    expect(result.tradeIn.remainderPayableRial).toBe(173_000_000);
    expect(result.tradeIn.differenceDueRial).toBe(0);
    expect(result.tradeIn.differenceSettlement).toBe("none");
    expect(await accountBalance("2465")).toBe(-173_000_000);
    expect(await accountBalance("1100")).toBe(0);
    const { rows: payments } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payments WHERE order_id = $1",
      [result.orderId],
    );
    expect(Number(payments[0].count)).toBe(0);
  });

  it("rolls B back with the sale when the deal is refused after B was created", async () => {
    const carA = await makeCarA({ minimumPriceRial: 1_200_000_000 });
    await expect(
      withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId))),
    ).rejects.toMatchObject({ code: "below_minimum_price" });

    expect((await vehicleRow(carA.serialId))?.state).toBe("in_stock");
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM automotive_vehicle_attributes WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
    const { rows: links } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM automotive_vehicle_trade_ins WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(links[0].count)).toBe(0);
    expect(await accountBalance("2465")).toBe(0);
  });

  it("refuses a handed-in car declared new, and a deal with no customer", async () => {
    const carA = await makeCarA();
    await expect(
      withTransaction((client) =>
        tradeIns.executeTradeIn(client, dealInput(carA.serialId, { tradeIn: { make: "x", model: "y", condition: "new" } })),
      ),
    ).rejects.toMatchObject({ code: "invalid_trade_in" });
    await expect(
      withTransaction((client) =>
        tradeIns.executeTradeIn(client, dealInput(carA.serialId, { customerId: "" })),
      ),
    ).rejects.toMatchObject({ code: "invalid_trade_in" });
    expect((await vehicleRow(carA.serialId))?.state).toBe("in_stock");
  });
});

describe("B is a real, sellable used car", () => {
  it("sells later through the ordinary invoice with COGS frozen at the allowance", async () => {
    const carA = await makeCarA();
    const deal = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));

    const secondSale = await withTransaction((client) =>
      invoiceService.createRetailInvoice(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "automotive",
        customerId: biz.otherCustomerId,
        tenders: [{ method: "cash", amount: exact.rialText("566800000") }],
        lines: [
          { kind: "vehicle", serialId: deal.acquiredSerialId, price: 520_000_000, discount: 0, vatPercent: 9 },
        ],
        createdBy: biz.ownerId,
      }),
    );
    expect(secondSale.total).toBe("566800000");
    expect((await vehicleRow(deal.acquiredSerialId))?.state).toBe("sold");
    const { rows } = await db.query<{ frozen: string }>(
      `SELECT frozen_effective_cost_rial::text AS frozen FROM automotive_vehicle_attributes WHERE serial_id = $1`,
      [deal.acquiredSerialId],
    );
    expect(Number(rows[0].frozen)).toBe(400_000_000);
  });
});

describe("reversal", () => {
  it("unwinds both sides: A returned, B archived, every account back where it was", async () => {
    const carA = await makeCarA();
    const deal = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));

    const reversed = await withTransaction((client) =>
      tradeIns.reverseTradeIn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        tradeInId: deal.tradeIn.id,
        reason: "مشتری از معامله منصرف شد",
        actorId: biz.ownerId,
      }),
    );
    expect(reversed.tradeIn.status).toBe("reversed");
    expect(reversed.tradeIn.reversalReason).toContain("منصرف");
    expect(reversed.reversalEntryIds.length).toBeGreaterThanOrEqual(3);

    expect((await vehicleRow(carA.serialId))?.state).toBe("returned");
    expect((await vehicleRow(deal.acquiredSerialId))?.state).toBe("archived");
    const { rows: orders } = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [
      deal.orderId,
    ]);
    expect(orders[0].status).toBe("voided");
    const { rows: sales } = await db.query<{ status: string }>(
      "SELECT status FROM automotive_vehicle_sales WHERE sale_id = $1",
      [deal.saleId],
    );
    expect(sales[0].status).toBe("reversed");

    expect(await accountBalance("4590")).toBe(0);
    expect(await accountBalance("2200")).toBe(0);
    expect(await accountBalance("1100")).toBe(0);
    expect(await accountBalance("2465")).toBe(0);
    expect(await accountBalance("5194")).toBe(0);
    // A is back on the books at its own cost; B is gone from inventory.
    expect(await accountBalance("1370")).toBe(700_000_000);
  });

  it("refuses a plain sale reversal while a trade-in link is active", async () => {
    const carA = await makeCarA();
    await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));
    await expect(
      withTransaction((client) =>
        vehicleSales.reverseVehicleSale(client, {
          businessId: biz.id,
          serialId: carA.serialId,
          locationId: biz.locationId,
          reason: "برگشت ساده",
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ code: "vehicle_has_trade_in" });
    expect((await vehicleRow(carA.serialId))?.state).toBe("sold");
  });

  it("refuses when B has already been sold, until B's own sale is reversed", async () => {
    const carA = await makeCarA();
    const deal = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));
    await withTransaction((client) =>
      invoiceService.createRetailInvoice(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "automotive",
        customerId: biz.otherCustomerId,
        tenders: [{ method: "cash" }],
        lines: [
          { kind: "vehicle", serialId: deal.acquiredSerialId, price: 520_000_000, discount: 0, vatPercent: 9 },
        ],
        createdBy: biz.ownerId,
      }),
    );
    await expect(
      withTransaction((client) =>
        tradeIns.reverseTradeIn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          tradeInId: deal.tradeIn.id,
          reason: "فسخ",
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ code: "trade_in_vehicle_sold" });
    // The remedy the refusal names: reverse B's sale, then the deal unwinds
    // (B comes back `returned`, which archives exactly like `in_stock`).
    await withTransaction((client) =>
      vehicleSales.reverseVehicleSale(client, {
        businessId: biz.id,
        serialId: deal.acquiredSerialId,
        locationId: biz.locationId,
        reason: "برگشت فروش دوم",
        actorId: biz.ownerId,
      }),
    );
    const reversed = await withTransaction((client) =>
      tradeIns.reverseTradeIn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        tradeInId: deal.tradeIn.id,
        reason: "فسخ کامل",
        actorId: biz.ownerId,
      }),
    );
    expect(reversed.tradeIn.status).toBe("reversed");
  });

  it("refuses while B carries reconditioning costs, and proceeds once they are voided", async () => {
    const carA = await makeCarA();
    const deal = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));
    const cost = await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: deal.acquiredSerialId,
        locationId: biz.locationId,
        cost: {
          category: "paint_body",
          posting: "capitalized",
          amountRial: 25_000_000,
          incurredOn: "2026-02-03",
          settlement: "cash",
        },
        createdBy: biz.ownerId,
      }),
    );
    await expect(
      withTransaction((client) =>
        tradeIns.reverseTradeIn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          tradeInId: deal.tradeIn.id,
          reason: "فسخ",
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ code: "trade_in_vehicle_reconditioned" });

    await withTransaction((client) =>
      automotive.voidVehicleCost(client, {
        businessId: biz.id,
        serialId: deal.acquiredSerialId,
        locationId: biz.locationId,
        costId: cost.id,
        reason: "خودرو به مشتری برمی‌گردد",
        actorId: biz.ownerId,
      }),
    );
    const reversed = await withTransaction((client) =>
      tradeIns.reverseTradeIn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        tradeInId: deal.tradeIn.id,
        reason: "فسخ",
        actorId: biz.ownerId,
      }),
    );
    expect(reversed.tradeIn.status).toBe("reversed");

    // And a second reversal is refused, not repeated.
    await expect(
      withTransaction((client) =>
        tradeIns.reverseTradeIn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          tradeInId: deal.tradeIn.id,
          reason: "دوباره",
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ code: "trade_in_already_reversed" });
  });
});

describe("exactly once", () => {
  it("replays a retried submission and conflicts on a changed one", async () => {
    const carA = await makeCarA();
    const key = `trade-in-${randomUUID()}`;
    const first = await withTransaction((client) =>
      tradeIns.executeTradeIn(client, dealInput(carA.serialId, { clientRequestId: key })),
    );
    const replay = await withTransaction((client) =>
      tradeIns.executeTradeIn(client, dealInput(carA.serialId, { clientRequestId: key })),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.tradeIn.id).toBe(first.tradeIn.id);
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.orderNumber).toBe(first.orderNumber);

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM automotive_vehicle_attributes WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(2);

    await expect(
      withTransaction((client) =>
        tradeIns.executeTradeIn(
          client,
          dealInput(carA.serialId, { clientRequestId: key, allowanceRial: 410_000_000 }),
        ),
      ),
    ).rejects.toMatchObject({ code: "request_conflict" });
  });

  it("lets exactly one of two concurrent deals for the same A commit", async () => {
    const carA = await makeCarA();
    const [observer, first, second] = await Promise.all([
      dbLib.getPool().connect(),
      dbLib.getPool().connect(),
      dbLib.getPool().connect(),
    ]);
    let firstInTransaction = false;
    let secondInTransaction = false;
    try {
      await first.query("BEGIN");
      firstInTransaction = true;
      const winner = await tradeIns.executeTradeIn(first, dealInput(carA.serialId));

      await second.query("BEGIN");
      secondInTransaction = true;
      const secondPid = await backendPid(second);
      // A distinct B (its own stock number), so the race is decided by A's
      // sold-once lock and not by B's identity indexes.
      const loser = tradeIns.executeTradeIn(
        second,
        dealInput(carA.serialId, {
          customerId: biz.otherCustomerId,
          tradeIn: { make: "دنا", model: "پلاس", stockNumber: "TI-RACE-2", mileageKm: 80_000 },
        }),
      );
      void loser.catch(() => {});
      await waitUntilBlocked(observer, secondPid);
      await first.query("COMMIT");
      firstInTransaction = false;
      await expect(loser).rejects.toMatchObject({ code: "vehicle_already_sold" });
      await second.query("ROLLBACK");
      secondInTransaction = false;

      expect((await vehicleRow(carA.serialId))?.state).toBe("sold");
      expect((await vehicleRow(winner.acquiredSerialId))?.state).toBe("in_stock");
      const { rows } = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM automotive_vehicle_attributes WHERE business_id = $1",
        [biz.id],
      );
      expect(Number(rows[0].count)).toBe(2);
      const { rows: links } = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM automotive_vehicle_trade_ins WHERE business_id = $1",
        [biz.id],
      );
      expect(Number(links[0].count)).toBe(1);
      expect(await accountBalance("2465")).toBe(0);
    } finally {
      if (firstInTransaction) await first.query("ROLLBACK").catch(() => {});
      if (secondInTransaction) await second.query("ROLLBACK").catch(() => {});
      observer.release();
      first.release();
      second.release();
    }
  }, 30_000);
});

describe("tenant isolation", () => {
  it("never sells, reads or acquires across a business boundary", async () => {
    const carA = await makeCarA();
    const deal = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));

    // The other tenant cannot read the deal from either side.
    expect(await dbLib.withTenant(other.id, () => tradeIns.getTradeIn(other.id, deal.tradeIn.id))).toBeNull();
    expect(await dbLib.withTenant(other.id, () => tradeIns.listTradeInsForVehicle(other.id, carA.serialId))).toEqual([]);

    // A customer from the other tenant is not this deal's counterparty.
    const carA2 = await makeCarA({ stockNumber: "A-2" });
    await expect(
      withTransaction((client) =>
        tradeIns.executeTradeIn(client, dealInput(carA2.serialId, { customerId: other.customerId })),
      ),
    ).rejects.toMatchObject({ code: "customer_not_found" });
    expect((await vehicleRow(carA2.serialId))?.state).toBe("in_stock");

    // The other tenant cannot reverse what it cannot see.
    await expect(
      withTransaction((client) =>
        tradeIns.reverseTradeIn(client, {
          businessId: other.id,
          locationId: other.locationId,
          tradeInId: deal.tradeIn.id,
          reason: "تلاش بیگانه",
        }),
      ),
    ).rejects.toMatchObject({ code: "trade_in_not_found" });
  });
});

describe("reports", () => {
  it("shows the allowance in profitability and acquisitions without double counting", async () => {
    const carA = await makeCarA();
    const deal = await withTransaction((client) => tradeIns.executeTradeIn(client, dealInput(carA.serialId)));

    const sales = await reports.vehicleSalesReport(biz.id, { dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    expect(sales.rows).toHaveLength(1);
    const row = sales.rows[0];
    // A's economics are untouched by how the customer paid: full price in,
    // A's own frozen cost out.
    expect(row.revenueRial).toBe(1_000_000_000);
    expect(row.grossProfitRial).toBe(300_000_000);
    expect(row.tradeInId).toBe(deal.tradeIn.id);
    expect(row.tradeInAllowanceRial).toBe(400_000_000);
    expect(row.tradeInAppliedRial).toBe(400_000_000);
    expect(row.tradeInAcquiredStockNumber).toBe(deal.acquiredStockNumber);
    expect(sales.summary.revenueRial).toBe(1_000_000_000);
    expect(sales.summary.tradeInCount).toBe(1);
    expect(sales.summary.tradeInAllowanceTotalRial).toBe(400_000_000);
    // Both cars were acquired in the window (700M + the 400M allowance),
    // and the trade-in pair is a subset of that one total.
    expect(sales.summary.acquisitions).toEqual({
      count: 2,
      costRial: 1_100_000_000,
      tradeInCount: 1,
      tradeInCostRial: 400_000_000,
    });

    const inventory = await reports.vehicleInventoryReport(biz.id, { today: "2026-03-01" });
    expect(inventory.rows).toHaveLength(1);
    expect(inventory.rows[0].serialId).toBe(deal.acquiredSerialId);
    expect(inventory.rows[0].acquisitionSource).toBe("trade_in");
    expect(inventory.rows[0].acquisitionCostRial).toBe(400_000_000);
    expect(inventory.rows[0].potentialMarginRial).toBe(120_000_000);
    expect(inventory.summary.tradeInCount).toBe(1);
    expect(inventory.summary.acquisitionTradeInCostRial).toBe(400_000_000);
    expect(inventory.summary.totalAcquisitionCostRial).toBe(400_000_000);
  });
});
