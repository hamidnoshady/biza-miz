/**
 * Issue #839 Wave 2 — vehicle stock, acquisition and costs, against a real
 * database.
 *
 * What this file proves, in the issue's own terms:
 *
 *   - a car is `items` (the model) + `item_serials` (the physical unit) +
 *     `automotive_vehicle_attributes` (its 1:1 automotive record), with the
 *     stock number as the unit's serial number;
 *   - acquiring one posts Debit «موجودی خودرو» 1370 / Credit what settled it,
 *     and opening stock posts against the opening-balance equity instead of
 *     inventing a purchase;
 *   - §5's capitalize-or-period decision changes what the car's *effective*
 *     cost is, and a void reverses the entry it actually posted;
 *   - §6's price change writes history and never touches a cost;
 *   - identity is unique per business (a second car cannot claim a VIN);
 *   - §11's transfer moves the car, its catalogue row and its state, and a
 *     sold car refuses to move;
 *   - one business cannot see another's cars.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Industry } from "../src/lib/industries";

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
let invoiceVoid: typeof import("../src/lib/retail-invoice-void-service");
let invoiceService: typeof import("../src/lib/retail-invoice-service");
let postingEngine: typeof import("../src/lib/posting-engine");
let exact: typeof import("../src/lib/inventory-exact");
let leads: typeof import("../src/lib/automotive-lead-service");
let platform: typeof import("../src/lib/platform-service");
let industryGuard: typeof import("../src/lib/industry-guard");
let mediaService: typeof import("../src/lib/media-service");

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
  throw new Error(`client ${blockedPid} did not block on the competing vehicle sale`);
}

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

async function makeBusiness(slugPrefix: string, industry: Industry = "automotive") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [`${slugPrefix} Co`, `${slugPrefix}-${randomUUID().slice(0, 8)}`, industry],
  );
  const businessId = rows[0].id;
  const { rows: locRows } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  // The chart follows the industry asked for. Seeding automotive regardless was
  // invisible while every caller wanted automotive; the upgrade test below needs
  // a tenant that really is a café, down to its ledger.
  await withTransaction((client) => provisioning.seedChartOfAccounts(client, businessId, industry));
  return { businessId, locationId: locRows[0].id };
}

async function makeMediaAsset(businessId: string, kind: "image" | "video" | "document" = "image") {
  const mimeType = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "application/pdf";
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
     VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id`,
    [businessId, kind, `${randomUUID().slice(0, 8)}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "pdf"}`, mimeType, `test/${randomUUID()}`, randomUUID().replaceAll("-", "").padEnd(64, "0")],
  );
  return { id: rows[0].id, kind };
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

beforeAll(async () => {
  databaseName = `pos_automotive_${randomUUID().replaceAll("-", "")}`;

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
  invoiceVoid = await import("../src/lib/retail-invoice-void-service");
  invoiceService = await import("../src/lib/retail-invoice-service");
  postingEngine = await import("../src/lib/posting-engine");
  void postingEngine;
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
  // A completed invoice's lines are immutable (guard_order_item_mutation,
  // migration 0014) — which is the point of the sale path borrowing `orders`,
  // and which the sale tests below assert. Between tests we take the same
  // transaction-local escape hatch the confirmed factory reset takes
  // (migration 0036), the way integration/retail-invoice.integration.test.ts
  // does, rather than weakening the guard for everyone.
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
  await db.query("DELETE FROM serial_warranties");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM media_assets");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM platforms").catch(() => {});
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
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری رزرو', 'customer') RETURNING id`,
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
});

describe("vehicle stock", () => {
  it("registers a car as a model catalogue row plus a serialized unit plus its own record", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, {
        ...carInput({ vin: "WBA1A345678901234", stockNumber: "1403-001" }),
        condition: "used",
        mileageKm: 45_000,
        priorOwners: 1,
      }),
    );

    const { rows: itemRows } = await db.query<{ id: string; name: string; tracking: string }>(
      "SELECT id, name, tracking FROM items WHERE location_id = $1",
      [biz.locationId],
    );
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0].tracking).toBe("serial");
    expect(itemRows[0].name).toBe("پژو 207 پانوراما 1403");

    const { rows: serialRows } = await db.query<{ serial_number: string; unit_cost: string; status: string }>(
      "SELECT serial_number, unit_cost::text AS unit_cost, status FROM item_serials",
    );
    expect(serialRows[0].serial_number).toBe("1403-001");
    expect(serialRows[0].unit_cost).toBe("700000000");
    expect(serialRows[0].status).toBe("in_stock");

    const vehicle = await automotive.getVehicle(biz.id, created.serialId);
    expect(vehicle?.state).toBe("in_stock");
    expect(vehicle?.condition).toBe("used");
    expect(vehicle?.mileageKm).toBe(45_000);
    expect(vehicle?.effectiveCostRial).toBe(700_000_000);
    expect(vehicle?.vin).toBe("WBA1A345678901234");
  });

  it("updates vehicle detail facts without corrupting tenant scope, and records identity edits", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, {
        ...carInput({ stockNumber: "IDENTITY-1", vin: "WBA1A345678901234" }),
        condition: "used",
        mileageKm: 56_000,
        priorOwners: 1,
      }),
    );

    const updated = await withTransaction((client) =>
      automotive.updateVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: created.serialId,
        vin: "1HGCM82633A004352",
        chassisNumber: "irx-987654321",
        mileageKm: 75_321,
        priorOwners: 2,
        plateNumber: "۲۱ب۱۲۳ ایران ۱۱",
        bodyConditionNotes: "درِ سمت راننده رنگ‌شده است",
        actorId: biz.ownerId,
      }),
    );

    expect(updated).toMatchObject({
      serialId: created.serialId,
      locationId: biz.locationId,
      vin: "1HGCM82633A004352",
      chassisNumber: "IRX987654321",
      mileageKm: 75_321,
      priorOwners: 2,
      plateNumber: "۲۱ب۱۲۳ ایران ۱۱",
      bodyConditionNotes: "درِ سمت راننده رنگ‌شده است",
    });
    await expect(automotive.getVehicle(other.id, created.serialId)).resolves.toBeNull();

    const { rows: scopedRows } = await db.query<{
      business_id: string;
      location_id: string;
      vin: string;
      chassis_number: string;
      mileage_km: number;
    }>(
      `SELECT business_id, location_id, vin, chassis_number, mileage_km
         FROM automotive_vehicle_attributes WHERE serial_id = $1`,
      [created.serialId],
    );
    expect(scopedRows).toEqual([{
      business_id: biz.id,
      location_id: biz.locationId,
      vin: "1HGCM82633A004352",
      chassis_number: "IRX987654321",
      mileage_km: 75_321,
    }]);

    const { rows: events } = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events
        WHERE business_id = $1 AND location_id = $2
          AND event_type = 'automotive.vehicle_identity_changed'
          AND source_id = $3`,
      [biz.id, biz.locationId, created.serialId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      serialId: created.serialId,
      stockNumber: created.stockNumber,
      changes: {
        vin: { from: "WBA1A345678901234", to: "1HGCM82633A004352" },
        chassisNumber: { from: null, to: "IRX987654321" },
      },
    });
  });

  it("reuses one catalogue row for a second car of the same model", async () => {
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "1" })));
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "2" })));

    const { rows } = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM items");
    expect(rows[0].count).toBe("1");
    const { rows: serialRows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM item_serials",
    );
    expect(serialRows[0].count).toBe("2");
  });

  it("never issues a stock number that is already taken, gap or no gap", async () => {
    // «1», «2», «4» — a lot with a gap — and then a car whose number a human
    // typed as «ویژه». The next blank one reaches the generator's fallback, and
    // the old `count(*) + 1` answered «4»: already on a car, so the unique index
    // rejected a car whose stock number the user had deliberately left blank
    // («duplicate vehicle identity» for a field nobody filled in).
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "1" })));
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "2" })));
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "4" })));
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "ویژه" })));

    const auto = await withTransaction((client) => automotive.createVehicle(client, carInput()));
    expect(auto.stockNumber).toBe("5");

    // And the next blank one carries on from there rather than repeating «5».
    const second = await withTransaction((client) => automotive.createVehicle(client, carInput()));
    expect(second.stockNumber).toBe("6");
  });

  it("continues the numbering a human typed, including its zero padding", async () => {
    await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "1403-007" })));
    const auto = await withTransaction((client) => automotive.createVehicle(client, carInput()));
    expect(auto.stockNumber).toBe("1403-008");
  });

  it("refuses a second car claiming the same VIN, case-insensitively", async () => {
    await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "A", vin: "WBAABCDEFGHJK1234" })),
    );
    await expect(
      withTransaction((client) =>
        automotive.createVehicle(client, carInput({ stockNumber: "B", vin: "wbaabcdefghjk1234" })),
      ),
    ).rejects.toThrow();
  });

  it("refuses a used-car fact on a new car rather than letting the report lie", async () => {
    await expect(
      withTransaction((client) =>
        automotive.createVehicle(client, carInput({ condition: "new", mileageKm: 12_000 })),
      ),
    ).rejects.toThrow(/کارکرد/);
  });

  it("registers a draft when the acquisition is not known yet", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ acquisition: null, askingPriceRial: 0 })),
    );
    expect(created.state).toBe("draft");
    expect(await accountBalance("1370")).toBe(0);
  });
});

describe("acquisition and cost accounting", () => {
  it("posts the purchase against what settled it", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "S-1" })),
    );
    expect(created.effectiveCostRial).toBe(700_000_000);

    expect(await accountBalance("1370")).toBe(700_000_000);
    expect(await accountBalance("2100")).toBe(-700_000_000);

    const { rows } = await db.query<{ event_type: string; entry_id: string | null }>(
      "SELECT event_type, entry_id FROM domain_events ORDER BY created_at",
    );
    expect(rows.map((r) => r.event_type)).toContain("automotive.vehicle_acquired");
    expect(rows.every((r) => r.entry_id !== null)).toBe(true);
  });

  it("posts opening stock against the opening-balance equity, not a purchase", async () => {
    await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "OPEN-1",
          acquisition: {
            date: "2026-01-01",
            source: "opening_stock",
            costRial: 500_000_000,
            settlement: "opening_equity",
          },
        }),
      ),
    );
    expect(await accountBalance("1370")).toBe(500_000_000);
    expect(await accountBalance("3900")).toBe(-500_000_000);
    expect(await accountBalance("2100")).toBe(0);
  });

  it("capitalizes or expenses a vehicle cost by its own explicit choice, and voids by reversing", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "S-2" })),
    );

    const capitalized = await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: created.serialId,
        locationId: biz.locationId,
        cost: {
          category: "paint_body",
          posting: "capitalized",
          amountRial: 30_000_000,
          incurredOn: "2026-01-15",
          settlement: "cash",
        },
      }),
    );
    expect(capitalized.effectiveCostRial).toBe(730_000_000);
    expect(await accountBalance("1370")).toBe(730_000_000);
    expect(await accountBalance("1100")).toBe(-30_000_000);

    await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: created.serialId,
        locationId: biz.locationId,
        cost: {
          category: "advertising",
          posting: "period_expense",
          amountRial: 5_000_000,
          incurredOn: "2026-01-16",
          settlement: "payable",
        },
      }),
    );
    // A period cost is reconditioning overhead: it never becomes part of the car.
    expect(await accountBalance("5195")).toBe(5_000_000);
    expect(await accountBalance("1370")).toBe(730_000_000);

    const vehicle = await automotive.getVehicle(biz.id, created.serialId);
    expect(vehicle?.effectiveCostRial).toBe(730_000_000);
    expect(vehicle?.periodExpenseRial).toBe(5_000_000);

    await withTransaction((client) =>
      automotive.voidVehicleCost(client, {
        businessId: biz.id,
        serialId: created.serialId,
        locationId: biz.locationId,
        costId: capitalized.id,
        reason: "اشتباه در ثبت",
        actorId: biz.ownerId,
      }),
    );

    // The void reverses the entry it actually posted, and the car's basis drops
    // back — the row stays, voided, for the audit trail.
    expect(await accountBalance("1370")).toBe(700_000_000);
    expect(await accountBalance("1100")).toBe(0);
    const after = await automotive.getVehicle(biz.id, created.serialId);
    expect(after?.effectiveCostRial).toBe(700_000_000);
    expect(after?.costs.find((c) => c.id === capitalized.id)?.status).toBe("void");
  });

  it("keeps a period expense off the car's effective cost but on the period report", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "S-3" })),
    );
    await withTransaction((client) =>
      automotive.recordVehicleCost(client, {
        businessId: biz.id,
        serialId: created.serialId,
        locationId: biz.locationId,
        cost: {
          category: "detailing",
          posting: "period_expense",
          amountRial: 2_000_000,
          incurredOn: "2026-01-20",
          settlement: "cash",
        },
      }),
    );
    const vehicle = await automotive.getVehicle(biz.id, created.serialId);
    expect((vehicle?.purchaseCostRial ?? 0) + (vehicle?.capitalizedCostRial ?? 0)).toBe(vehicle?.effectiveCostRial);
    expect(await accountBalance("5195")).toBe(2_000_000);
  });
});

describe("pricing", () => {
  it("records price history and never touches the cost", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "P-1", askingPriceRial: 900_000_000 })),
    );

    const change = await withTransaction((client) =>
      automotive.updateVehiclePrice(client, {
        businessId: biz.id,
        serialId: created.serialId,
        locationId: biz.locationId,
        askingPriceRial: 850_000_000,
        minimumPriceRial: 800_000_000,
        reason: "تخفیف پایان فصل",
      }),
    );
    expect(change.previousAskingPriceRial).toBe(900_000_000);
    expect(change.askingPriceRial).toBe(850_000_000);

    const vehicle = await automotive.getVehicle(biz.id, created.serialId);
    expect(vehicle?.askingPriceRial).toBe(850_000_000);
    expect(vehicle?.minimumPriceRial).toBe(800_000_000);
    // The whole point of the split: a price cut leaves the car's basis alone.
    expect(vehicle?.effectiveCostRial).toBe(700_000_000);
    expect(vehicle?.purchaseCostRial).toBe(700_000_000);

    const history = await automotive.listVehiclePriceHistory(biz.id, created.serialId);
    expect(history).toHaveLength(2);
    expect(history[0].reason).toBe("تخفیف پایان فصل");
    expect(history[1].previousAskingPriceRial).toBe(0);

    expect(await accountBalance("1370")).toBe(700_000_000);
  });

  it("enforces the recorded floor unless the caller holds the override", async () => {
    const floor = automotive.checkVehicleSalePrice({
      priceRial: 750_000_000,
      minimumPriceRial: 800_000_000,
      overrideAllowed: false,
    });
    expect(floor.allowed).toBe(false);
    expect(floor.shortfallRial).toBe(50_000_000);
    expect(
      automotive.checkVehicleSalePrice({
        priceRial: 750_000_000,
        minimumPriceRial: 800_000_000,
        overrideAllowed: true,
      }).allowed,
    ).toBe(true);
  });
});

describe("the stock list and dashboard numbers", () => {
  it("filters, searches and summarises the lot", async () => {
    await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({ stockNumber: "L-1", vin: "WBA1A2B3C4D5E6F70", askingPriceRial: 900_000_000 }),
      ),
    );
    await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({
          stockNumber: "L-2",
          make: "کیا",
          model: "سراتو",
          trim: null,
          condition: "used",
          mileageKm: 80_000,
          priorOwners: 2,
          askingPriceRial: 1_500_000_000,
          acquisition: {
            date: "2026-01-05",
            source: "trade_in",
            costRial: 1_100_000_000,
            settlement: "trade_in",
          },
        }),
      ),
    );

    const all = await automotive.listVehicles({ businessId: biz.id });
    expect(all.total).toBe(2);

    const byCondition = await automotive.listVehicles({ businessId: biz.id, condition: "used" });
    expect(byCondition.vehicles.map((v) => v.stockNumber)).toEqual(["L-2"]);

    const bySearch = await automotive.listVehicles({ businessId: biz.id, search: "wba1a" });
    expect(bySearch.vehicles.map((v) => v.stockNumber)).toEqual(["L-1"]);

    const byPrice = await automotive.listVehicles({ businessId: biz.id, maxPriceRial: 1_000_000_000 });
    expect(byPrice.vehicles.map((v) => v.stockNumber)).toEqual(["L-1"]);

    const summary = await automotive.summarizeVehicles(biz.id, { onDate: "2026-02-01" });
    expect(summary.inStock).toBe(2);
    expect(summary.stockValueRial).toBe(1_800_000_000);
    expect(summary.askingValueRial).toBe(2_400_000_000);
    expect(summary.averageAgeDays).toBeGreaterThan(0);
    expect(summary.slowCount + summary.deadCount).toBeGreaterThanOrEqual(0);

    const otherBranch = await automotive.listVehicles({
      businessId: biz.id,
      locationId: biz.secondLocationId,
    });
    expect(otherBranch.total).toBe(0);
  });

  it("fails closed for an empty branch set and confines multi-branch reads to explicit ids", async () => {
    const home = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "B-1" })),
    );
    const remote = await withTransaction((client) =>
      automotive.createVehicle(
        client,
        carInput({ stockNumber: "B-2", locationId: biz.secondLocationId }),
      ),
    );

    const permitted = await automotive.listVehicles({
      businessId: biz.id,
      locationIds: [biz.secondLocationId],
    });
    expect(permitted.vehicles.map(({ serialId }) => serialId)).toEqual([remote.serialId]);
    expect(permitted.total).toBe(1);

    const none = await automotive.listVehicles({ businessId: biz.id, locationIds: [] });
    expect(none).toEqual({ vehicles: [], total: 0 });

    const summary = await automotive.summarizeVehicles(biz.id, {
      locationIds: [biz.locationId],
      onDate: "2026-02-01",
    });
    expect(summary.inStock).toBe(1);
    expect((await automotive.getVehicle(biz.id, home.serialId))?.locationId).toBe(biz.locationId);
  });
});

describe("branch transfers", () => {
  it("moves the car, its catalogue row and its state, and refuses a sold car", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "T-1" })),
    );

    const { transferId } = await withTransaction((client) =>
      automotive.startVehicleTransfer(client, {
        businessId: biz.id,
        fromLocationId: biz.locationId,
        toLocationId: biz.secondLocationId,
        serialId: created.serialId,
      }),
    );
    expect((await automotive.getVehicle(biz.id, created.serialId))?.state).toBe("transferred");

    // A second concurrent transfer of the same car is structurally impossible.
    await expect(
      withTransaction((client) =>
        automotive.startVehicleTransfer(client, {
          businessId: biz.id,
          fromLocationId: biz.locationId,
          toLocationId: biz.secondLocationId,
          serialId: created.serialId,
        }),
      ),
    ).rejects.toThrow();

    await withTransaction((client) =>
      automotive.completeVehicleTransfer(client, { businessId: biz.id, transferId, locationId: biz.secondLocationId, actorId: biz.ownerId }),
    );
    const moved = await automotive.getVehicle(biz.id, created.serialId);
    expect(moved?.locationId).toBe(biz.secondLocationId);
    expect(moved?.state).toBe("in_stock");

    const { rows } = await db.query<{ location_id: string }>(
      "SELECT location_id FROM items WHERE id = $1",
      [moved!.itemId],
    );
    expect(rows[0].location_id).toBe(biz.secondLocationId);

    const transfers = await automotive.listVehicleTransfers(biz.id, { serialId: created.serialId });
    expect(transfers[0].status).toBe("completed");
  });

  it("refuses to move a car that is on hold for a customer", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "T-2" })),
    );
    await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: created.serialId,
        customerId: biz.customerId,
        actorId: biz.ownerId,
      }),
    );

    await expect(
      withTransaction((client) =>
        automotive.startVehicleTransfer(client, {
          businessId: biz.id,
          fromLocationId: biz.locationId,
          toLocationId: biz.secondLocationId,
          serialId: created.serialId,
        }),
      ),
    ).rejects.toThrow(/رزرو/);
  });
});

describe("vehicle media links", () => {
  it("links canonical media idempotently, counts its usage, and enforces tenant and branch scope", async () => {
    const vehicle = await withTransaction((client) => automotive.createVehicle(client, carInput({ stockNumber: "MEDIA-1" })));
    const asset = await makeMediaAsset(biz.id, "image");
    const foreignAsset = await makeMediaAsset(other.id, "document");

    const first = await withTransaction((client) => automotive.attachVehicleMedia(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      serialId: vehicle.serialId,
      mediaAssetId: asset.id,
      category: "photo",
      title: "تصویر نمای خودرو",
      actorId: biz.ownerId,
    }));
    expect(first).toMatchObject({ mediaAssetId: asset.id, mediaKind: "image", title: "تصویر نمای خودرو" });

    const updated = await withTransaction((client) => automotive.attachVehicleMedia(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      serialId: vehicle.serialId,
      mediaAssetId: asset.id,
      category: "inspection",
      title: "گزارش تصویری بازرسی",
      description: "نمای سمت راست",
      actorId: biz.ownerId,
    }));
    expect(updated.id).toBe(first.id);
    expect(updated).toMatchObject({ category: "inspection", title: "گزارش تصویری بازرسی", description: "نمای سمت راست" });
    expect(await automotive.listVehicleMedia(biz.id, vehicle.serialId, undefined, { locationIds: [biz.locationId] })).toHaveLength(1);
    expect(await automotive.listVehicleMedia(biz.id, vehicle.serialId, undefined, { locationIds: [biz.secondLocationId] })).toEqual([]);

    expect(await mediaService.mediaAssetUsedByVehicleInLocations(asset.id, biz.id, [biz.locationId])).toBe(true);
    expect(await mediaService.mediaAssetUsedByVehicleInLocations(asset.id, biz.id, [biz.secondLocationId])).toBe(false);
    expect(await mediaService.mediaAssetUsedByVehicleInLocations(asset.id, other.id, [other.locationId])).toBe(false);
    const usage = await mediaService.getMediaAssetUsage(asset.id);
    expect(usage.vehicles).toEqual([{ id: vehicle.serialId, name: expect.stringContaining("MEDIA-1") }]);
    expect(mediaService.mediaAssetUsageIsEmpty(usage)).toBe(false);

    await expect(withTransaction((client) => automotive.attachVehicleMedia(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      serialId: vehicle.serialId,
      mediaAssetId: foreignAsset.id,
      category: "invoice",
      title: "فاکتور خرید متعلق به کسب‌وکار دیگر",
    }))).rejects.toMatchObject({ code: "media_not_found" });

    expect(await withTransaction((client) => automotive.detachVehicleMedia(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      serialId: vehicle.serialId,
      mediaAssetId: asset.id,
      actorId: biz.ownerId,
    }))).toBe(true);
    expect(await mediaService.mediaAssetUsedByVehicleInLocations(asset.id, biz.id, [biz.locationId])).toBe(false);
    expect(mediaService.mediaAssetUsageIsEmpty(await mediaService.getMediaAssetUsage(asset.id))).toBe(true);
    const { rows: originalAsset } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM media_assets WHERE business_id = $1 AND id = $2",
      [biz.id, asset.id],
    );
    expect(originalAsset[0].count).toBe("1");
  });
});

describe("tenant isolation", () => {
  it("keeps one business's cars out of another's list and detail", async () => {
    const mine = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "ISO-1" })),
    );

    const theirs = await automotive.listVehicles({ businessId: other.id });
    expect(theirs.total).toBe(0);

    // The service is tenant-scoped by `business_id` on every read: naming the
    // other tenant's business with this serial id finds nothing.
    expect(await automotive.getVehicle(other.id, mine.serialId)).toBeNull();
  });
});

/* ===========================================================================
 * Wave 3 — reservations and the deposit they carry
 * =========================================================================== */

/**
 * The hold's own money: Debit cash/bank, Credit the shared customer-advance
 * liability (2430). It is the one number in this file that is *not* revenue,
 * and the test says so explicitly — a deposit counted as income is how a
 * dealership's VAT return and its gross profit both go wrong at once.
 */
async function depositBalance(businessId = biz.id): Promise<number> {
  const row = await accountBalance("2430", businessId);
  // `|| 0` so a settled liability reads as 0 rather than JavaScript's -0.
  return -row || 0; // a liability's balance is its credit side
}

describe("reservations and deposits", () => {
  it("takes a hold with a deposit, posts it as a customer advance, and parks the car", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-1" })),
    );

    const result = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: created.serialId,
        customerId: biz.customerId,
        expiresAt: "2026-03-01",
        expiresAtTime: "18:00",
        depositRial: 50_000_000,
        depositMethod: "cash",
        depositRefundable: true,
        actorId: biz.ownerId,
      }),
    );
    expect(result.depositEntryId).toBeTruthy();

    // The car is on hold, in both places that say so (the automotive record and
    // the shared serial status the generic stock paths read).
    const held = await automotive.getVehicle(biz.id, created.serialId);
    expect(held?.state).toBe("reserved");
    const { rows: serialRows } = await db.query<{ status: string }>(
      "SELECT status FROM item_serials WHERE id = $1",
      [created.serialId],
    );
    expect(serialRows[0].status).toBe("reserved");

    // The money: cash in, customer advance out — and nothing to the revenue or
    // VAT accounts.
    expect(await accountBalance("1100")).toBe(50_000_000);
    expect(await depositBalance()).toBe(50_000_000);
    expect(await accountBalance("4590")).toBe(0);
    expect(await accountBalance("2200")).toBe(0);

    const reservation = await reservations.getVehicleReservation(biz.id, result.id);
    expect(reservation).toMatchObject({
      status: "active",
      expiresAt: "2026-03-01",
      expiresAtTime: "18:00:00",
      depositRial: 50_000_000,
      depositMethod: "cash",
      depositRefundable: true,
    });
    // The detail carries the car and the customer a person would name it by.
    expect(reservation?.stockNumber).toBe("R-1");
    expect(reservation?.customerName).toBe("مشتری رزرو");
  });

  it("refuses a second active hold on the same car", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-2" })),
    );
    await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: created.serialId,
        customerId: biz.customerId,
        actorId: biz.ownerId,
      }),
    );

    // The service refuses (the car is `reserved`), and 0202's partial unique
    // index is behind it: even a write that bypassed the check cannot leave two
    // live holds on one car.
    await expect(
      withTransaction((client) =>
        reservations.reserveVehicle(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          serialId: created.serialId,
          customerId: biz.otherCustomerId,
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toThrow(/رزرو/);
  });

  it("refuses a deposit with no method, and a customer who is not a customer", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-3" })),
    );

    await expect(
      withTransaction((client) =>
        reservations.reserveVehicle(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          serialId: created.serialId,
          customerId: biz.customerId,
          depositRial: 10_000_000,
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toThrow(/روش دریافت/);

    await expect(
      withTransaction((client) =>
        reservations.reserveVehicle(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          serialId: created.serialId,
          customerId: randomUUID(), // a well-formed id for somebody who is not ours
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toThrow(/مشتری یافت نشد/);
  });

  it("refunds a refundable deposit on release and keeps a non-refundable one", async () => {
    const refundable = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-4" })),
    );
    const kept = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-5" })),
    );

    const first = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: refundable.serialId,
        customerId: biz.customerId,
        depositRial: 20_000_000,
        depositMethod: "cash",
        depositRefundable: true,
        actorId: biz.ownerId,
      }),
    );
    const second = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: kept.serialId,
        customerId: biz.customerId,
        depositRial: 30_000_000,
        depositMethod: "card",
        depositRefundable: false,
        actorId: biz.ownerId,
      }),
    );

    const released = await withTransaction((client) =>
      reservations.releaseVehicleReservation(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        reservationId: first.id,
        reason: "مشتری منصرف شد",
        actorId: biz.ownerId,
      }),
    );
    expect(released.refundedEntryId).toBeTruthy();

    // Refundable: the money leaves again, the liability goes back to zero, and
    // the car is on the shelf — the release also recorded its reason.
    expect(await accountBalance("1100")).toBe(0);
    expect(await depositBalance()).toBe(30_000_000);
    const freed = await automotive.getVehicle(biz.id, refundable.serialId);
    expect(freed?.state).toBe("in_stock");
    const afterFirst = await reservations.getVehicleReservation(biz.id, first.id);
    expect(afterFirst).toMatchObject({ status: "released", releaseReason: "مشتری منصرف شد" });

    // Non-refundable: the hold closes, the car is freed, and the advance stays
    // exactly where it is — that is what the counter promised the customer.
    const secondRelease = await withTransaction((client) =>
      reservations.releaseVehicleReservation(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        reservationId: second.id,
        reason: "مهلت تمام شد",
        actorId: biz.ownerId,
      }),
    );
    expect(secondRelease.refundedEntryId).toBeNull();
    expect(await depositBalance()).toBe(30_000_000);
    expect((await automotive.getVehicle(biz.id, kept.serialId))?.state).toBe("in_stock");

    // Releasing twice is refused rather than silently repeating the refund.
    await expect(
      withTransaction((client) =>
        reservations.releaseVehicleReservation(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          reservationId: first.id,
          reason: "دوباره",
          actorId: biz.ownerId,
        }),
      ),
    ).rejects.toThrow(/بسته شده/);
  });

  it("expires at the entered local time and refunds a refundable deposit exactly once", async () => {
    await db.query("UPDATE locations SET timezone = 'America/New_York' WHERE id = $1", [biz.locationId]);
    const { rows: localTimes } = await db.query<{
      past_date: string;
      past_time: string;
      future_date: string;
      future_time: string;
    }>(
      `WITH local AS (
         SELECT clock_timestamp() AT TIME ZONE timezone AS current_local
           FROM locations WHERE id = $1
       )
       SELECT (current_local - interval '5 minutes')::date::text AS past_date,
              to_char(current_local - interval '5 minutes', 'HH24:MI:SS') AS past_time,
              (current_local + interval '10 minutes')::date::text AS future_date,
              to_char(current_local + interval '10 minutes', 'HH24:MI:SS') AS future_time
         FROM local`,
      [biz.locationId],
    );
    // Reserve the future hold first: reserving another vehicle runs expiry for
    // the branch, so creating the past-due hold last lets this assertion prove
    // the explicit expiry command rather than its idempotent preflight.
    const futureCar = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-TIME-FUTURE" })),
    );
    const futureHold = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: futureCar.serialId,
        customerId: biz.customerId,
        expiresAt: localTimes[0].future_date,
        expiresAtTime: localTimes[0].future_time,
        actorId: biz.ownerId,
      }),
    );

    const expiredCar = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-TIME-PAST" })),
    );
    const expiringHold = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: expiredCar.serialId,
        customerId: biz.customerId,
        expiresAt: localTimes[0].past_date,
        expiresAtTime: localTimes[0].past_time,
        depositRial: 12_000_000,
        depositMethod: "cash",
        depositRefundable: true,
        actorId: biz.ownerId,
      }),
    );
    expect(await accountBalance("1100")).toBe(12_000_000);
    expect(await depositBalance()).toBe(12_000_000);

    const count = await withTransaction((client) =>
      reservations.expireVehicleReservations(client, { businessId: biz.id, locationId: biz.locationId }),
    );
    expect(count).toBe(1);
    expect((await reservations.getVehicleReservation(biz.id, expiringHold.id))?.status).toBe("expired");
    expect((await reservations.getVehicleReservation(biz.id, futureHold.id))?.status).toBe("active");
    expect((await automotive.getVehicle(biz.id, expiredCar.serialId))?.state).toBe("in_stock");
    expect((await automotive.getVehicle(biz.id, futureCar.serialId))?.state).toBe("reserved");
    expect(await accountBalance("1100")).toBe(0);
    expect(await depositBalance()).toBe(0);
    const { rows: refundRows } = await db.query<{ deposit_refund_entry_id: string | null }>(
      "SELECT deposit_refund_entry_id FROM serial_reservations WHERE id = $1",
      [expiringHold.id],
    );
    expect(refundRows[0].deposit_refund_entry_id).toBeTruthy();
  });

  it("expires a hold on read once its business day has passed", async () => {
    const created = await withTransaction((client) =>
      automotive.createVehicle(client, carInput({ stockNumber: "R-6" })),
    );
    const hold = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: created.serialId,
        customerId: biz.customerId,
        expiresAt: "2020-01-01",
        actorId: biz.ownerId,
      }),
    );

    // No cron: the sweep runs when somebody looks, and it runs inside the
    // caller's transaction.
    const expired = await withTransaction((client) =>
      reservations.expireVehicleReservations(client, { businessId: biz.id, locationId: biz.locationId }),
    );
    expect(expired).toBe(1);

    const after = await reservations.getVehicleReservation(biz.id, hold.id);
    expect(after?.status).toBe("expired");
    expect((await automotive.getVehicle(biz.id, created.serialId))?.state).toBe("in_stock");

    // A hold with no expiry is "until released" and never lapses.
    const open = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: created.serialId,
        customerId: biz.customerId,
        actorId: biz.ownerId,
      }),
    );
    expect(
      await withTransaction((client) =>
        reservations.expireVehicleReservations(client, { businessId: biz.id, locationId: biz.locationId }),
      ),
    ).toBe(0);
    expect((await reservations.getVehicleReservation(biz.id, open.id))?.status).toBe("active");
  });
});

/* ===========================================================================
 * Wave 4 — selling the exact car, through the ordinary retail invoice
 * =========================================================================== */

async function sellThroughInvoice(input: {
  serialId: string;
  price: number;
  discount?: number;
  vatPercent: number;
  /** `null` sends no tender; `"open"` sends one tender with no amount, which takes whatever is left. */
  tenderAmount: number | null | "open";
  customerId?: string | null;
  tenderMethod?: "cash" | "bank" | "credit";
}) {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const invoice = await invoiceService.createRetailInvoice(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "automotive",
      customerId: input.customerId ?? null,
      tenders:
        input.tenderAmount == null
          ? []
          : input.tenderAmount === "open"
            ? [{ method: input.tenderMethod ?? "cash" }]
            : [{ method: input.tenderMethod ?? "cash", amount: exact.rialText(String(input.tenderAmount)) }],
      lines: [
        {
          kind: "vehicle",
          serialId: input.serialId,
          price: input.price,
          discount: input.discount ?? 0,
          vatPercent: input.vatPercent,
        },
      ],
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

/** A car with a base cost and one capitalized reconditioning cost on top. */
async function carReadyToSell(stockNumber: string, purchase = 700_000_000, capitalized = 30_000_000) {
  const created = await withTransaction((client) =>
    automotive.createVehicle(client, carInput({ stockNumber, acquisition: {
      date: "2026-01-10",
      source: "dealer_purchase" as const,
      costRial: purchase,
      settlement: "payable" as const,
    } })),
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
          incurredOn: "2026-01-20",
          settlement: "payable",
        },
      }),
    );
  }
  return created;
}

describe("selling the exact car", () => {
  it("posts revenue and COGS at the frozen effective cost, and names the vehicle on the line", async () => {
    const car = await carReadyToSell("S-1");
    // 900,000,000 + 9% VAT = 981,000,000 — the whole invoice paid in cash.
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
    });

    expect(invoice.total).toBe("981000000");
    expect(await accountBalance("1100")).toBe(981_000_000);
    expect(await accountBalance("4590")).toBe(-900_000_000);
    expect(await accountBalance("2200")).toBe(-81_000_000);

    // COGS is the effective cost — the purchase plus the capitalized
    // reconditioning — and it leaves vehicle inventory, not the generic one.
    expect(await accountBalance("5194")).toBe(730_000_000);
    // 700,000,000 acquisition + 30,000,000 capitalized − 730,000,000 COGS: the
    // car has left vehicle inventory, and the generic inventory account was
    // never involved.
    expect(await accountBalance("1370")).toBe(0);
    expect(await accountBalance("1300")).toBe(0);

    const sold = await automotive.getVehicle(biz.id, car.serialId);
    expect(sold?.state).toBe("sold");
    expect(sold?.soldCustomerId).toBeNull();
    const { rows: frozen } = await db.query<{
      sale_price_rial: string;
      frozen_effective_cost_rial: string;
      sold_on: string;
      sold_order_id: string | null;
      sold_order_item_id: string | null;
    }>(
      `SELECT sale_price_rial::text, frozen_effective_cost_rial::text, sold_on::text,
              sold_order_id, sold_order_item_id
         FROM automotive_vehicle_attributes WHERE serial_id = $1`,
      [car.serialId],
    );
    expect(frozen[0]).toMatchObject({
      sale_price_rial: "981000000",
      frozen_effective_cost_rial: "730000000",
      sold_order_id: invoice.orderId,
    });
    expect(frozen[0].sold_order_item_id).toBeTruthy();

    // The line identifies the exact car, in the snapshot a reprint reads.
    const { rows: snapshot } = await db.query<{ retail_snapshot: Record<string, unknown> }>(
      "SELECT retail_snapshot FROM order_items WHERE order_id = $1",
      [invoice.orderId],
    );
    expect(snapshot[0].retail_snapshot).toMatchObject({
      kind: "vehicle",
      stockNumber: "S-1",
      frozenEffectiveCost: "730000000",
    });
  });

  it("refuses a second sale of the same car", async () => {
    const car = await carReadyToSell("S-2", 700_000_000, 0);
    await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
    });

    // One physical car, one sale: the second invoice refuses before it posts.
    await expect(
      sellThroughInvoice({
        serialId: car.serialId,
        price: 900_000_000,
        vatPercent: 9,
        tenderAmount: 981_000_000,
      }),
    ).rejects.toThrow(/فروخته شده/);

    expect(await accountBalance("4590")).toBe(-900_000_000);
  });

  it("serializes simultaneous invoice attempts and posts exactly one vehicle sale", async () => {
    const car = await carReadyToSell("S-RACE", 700_000_000, 0);
    const [first, second, observer] = await Promise.all([
      dbLib.getPool().connect(),
      dbLib.getPool().connect(),
      dbLib.getPool().connect(),
    ]);
    let firstInTransaction = false;
    let secondInTransaction = false;
    const saleInput = {
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "automotive" as const,
      customerId: null,
      tenders: [{ method: "cash" as const, amount: exact.rialText("981000000") }],
      lines: [{ kind: "vehicle" as const, serialId: car.serialId, price: 900_000_000, discount: 0, vatPercent: 9 }],
    };

    try {
      await first.query("BEGIN");
      firstInTransaction = true;
      const winningInvoice = await invoiceService.createRetailInvoice(first, saleInput);

      await second.query("BEGIN");
      secondInTransaction = true;
      const secondPid = await backendPid(second);
      const competingInvoice = invoiceService.createRetailInvoice(second, saleInput);
      // The loser can reject the instant the winner commits — while the
      // assertions below are still awaiting the COMMIT round-trip — and Node
      // reports a rejection with no handler yet as unhandled. Observe it from
      // birth; the later .rejects assertion still sees the original failure.
      void competingInvoice.catch(() => {});
      // The second invoice has reached the same unit while the first sale is
      // uncommitted. Prove it is blocked by PostgreSQL before releasing the
      // winner, rather than relying on two requests that happened to run one
      // after another in the test scheduler.
      await waitUntilBlocked(observer, secondPid);
      await first.query("COMMIT");
      firstInTransaction = false;
      await expect(competingInvoice).rejects.toThrow(/فروخته شده/);
      await second.query("ROLLBACK");
      secondInTransaction = false;

      expect(winningInvoice.total).toBe("981000000");
      expect(await accountBalance("4590")).toBe(-900_000_000);
      expect(await accountBalance("2200")).toBe(-81_000_000);
      expect(await accountBalance("5194")).toBe(700_000_000);

      const { rows: occurrences } = await db.query<{ sale_id: string; status: string }>(
        "SELECT sale_id, status FROM automotive_vehicle_sales WHERE business_id = $1 AND serial_id = $2",
        [biz.id, car.serialId],
      );
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].status).toBe("active");

      const { rows: lines } = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM order_items WHERE retail_snapshot->>'serialId' = $1",
        [car.serialId],
      );
      expect(lines[0].count).toBe("1");
    } finally {
      if (firstInTransaction) await first.query("ROLLBACK").catch(() => {});
      if (secondInTransaction) await second.query("ROLLBACK").catch(() => {});
      first.release();
      second.release();
      observer.release();
    }
  });

  it("applies the customer's reservation deposit instead of collecting it twice", async () => {
    const car = await carReadyToSell("S-3", 700_000_000, 0);
    const hold = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: car.serialId,
        customerId: biz.customerId,
        depositRial: 50_000_000,
        depositMethod: "cash",
        actorId: biz.ownerId,
      }),
    );
    expect(await depositBalance()).toBe(50_000_000);

    // Invoice total 981,000,000 less the 50,000,000 already in hand: the
    // customer pays 931,000,000 today.
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 931_000_000,
      customerId: biz.customerId,
    });

    // All the money the customer actually paid: 50,000,000 at the reservation
    // counter and 931,000,000 today. The advance is cleared, not re-earned —
    // 2430 is back to zero and revenue is the car's price, not a riyal more.
    expect(await accountBalance("1100")).toBe(981_000_000);
    expect(await depositBalance()).toBe(0);
    expect(await accountBalance("4590")).toBe(-900_000_000);
    expect(await accountBalance("2200")).toBe(-81_000_000);
    // Revenue 900m + VAT 81m = tenders 931m + deposit 50m: the entry balances,
    // and the deposit is a liability released, never income.
    expect(await accountBalance("5194")).toBe(700_000_000);

    // Today's cash, not the reservation counter's: the payments row records
    // what was actually collected against this invoice.
    const { rows: payments } = await db.query<{ amount: string }>(
      "SELECT amount::text FROM payments WHERE order_id = $1",
      [invoice.orderId],
    );
    expect(payments.map((row) => row.amount)).toEqual(["931000000"]);

    // The hold closed as *converted* by this sale, and names the invoice.
    const closed = await reservations.getVehicleReservation(biz.id, hold.id);
    expect(closed?.status).toBe("converted");
    const { rows: converted } = await db.query<{ converted_order_id: string }>(
      "SELECT converted_order_id FROM serial_reservations WHERE id = $1",
      [hold.id],
    );
    expect(converted[0].converted_order_id).toBe(invoice.orderId);
  });

  it("checks out a fully prepaid vehicle with no zero-value tender", async () => {
    const car = await carReadyToSell("S-3-PREPAID", 700_000_000, 0);
    const hold = await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: car.serialId,
        customerId: biz.customerId,
        depositRial: 981_000_000,
        depositMethod: "cash",
        actorId: biz.ownerId,
      }),
    );

    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 0, // the caller's rate is ignored; tax.config is 9%.
      tenderAmount: null,
      customerId: biz.customerId,
    });

    expect(invoice.total).toBe("981000000");
    expect(await accountBalance("1100")).toBe(981_000_000);
    expect(await depositBalance()).toBe(0);
    expect(await accountBalance("4590")).toBe(-900_000_000);
    expect(await accountBalance("2200")).toBe(-81_000_000);
    const { rows: payments } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payments WHERE order_id = $1",
      [invoice.orderId],
    );
    expect(payments[0].count).toBe("0");
    expect((await reservations.getVehicleReservation(biz.id, hold.id))?.status).toBe("converted");
  });

  it("refuses a sale to a customer the live hold does not name", async () => {
    const car = await carReadyToSell("S-4", 700_000_000, 0);
    await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: car.serialId,
        customerId: biz.customerId,
        actorId: biz.ownerId,
      }),
    );

    await expect(
      sellThroughInvoice({
        serialId: car.serialId,
        price: 900_000_000,
        vatPercent: 9,
        tenderAmount: 981_000_000,
        customerId: biz.otherCustomerId,
      }),
    ).rejects.toThrow(/رزرو شده است/);

    // Nothing posted for a sale that was refused.
    expect(await accountBalance("4590")).toBe(0);
    expect((await automotive.getVehicle(biz.id, car.serialId))?.state).toBe("reserved");
  });

  it("reverses a sale to `returned` at the frozen cost, not at today's cost", async () => {
    const car = await carReadyToSell("S-5", 700_000_000, 0);
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
    });
    expect(await accountBalance("1370")).toBe(0);

    // A sold car refuses a new cost — the money belongs to the *returned*
    // car's next life, not to the unit that has already been accounted for.
    await expect(
      withTransaction((client) =>
        automotive.recordVehicleCost(client, {
          businessId: biz.id,
          serialId: car.serialId,
          locationId: biz.locationId,
          createdBy: biz.ownerId,
          cost: {
            category: "detailing",
            posting: "capitalized",
            amountRial: 5_000_000,
            incurredOn: "2026-02-01",
            settlement: "payable",
          },
        }),
      ),
    ).rejects.toThrow(/فروخته شده/);

    const reversal = await withTransaction((client) =>
      vehicleSales.reverseVehicleSale(client, {
        businessId: biz.id,
        serialId: car.serialId,
        locationId: biz.locationId,
        reason: "فسخ فروش",
        actorId: biz.ownerId,
      }),
    );
    // Two entries: the sale posted two (revenue, then COGS at the frozen cost)
    // and both are mirrored — the invoice recorded which entries belong to this
    // line, so the reversal undoes exactly those.
    expect(reversal.reversalEntryIds).toHaveLength(2);

    // The money is back with the customer and nothing of the sale survives in
    // the books; inventory carries the car again at the frozen 700,000,000.
    expect(await accountBalance("1100")).toBe(0);
    expect(await accountBalance("4590")).toBe(0);
    expect(await accountBalance("2200")).toBe(0);
    expect(await accountBalance("1370")).toBe(700_000_000);
    expect(await accountBalance("5194")).toBe(0);
    const returned = await automotive.getVehicle(biz.id, car.serialId);
    expect(returned?.state).toBe("returned");

    // Current-sale facts are cleared so the unique sold-line guard cannot
    // strand the returned unit. The immutable occurrence retains exactly what
    // was reversed, including the frozen basis and mirror-entry ids.
    const { rows: cleared } = await db.query<{
      sold_order_item_id: string | null;
      sold_customer_id: string | null;
      sold_on: string | null;
      sale_price_rial: string | null;
      frozen_effective_cost_rial: string | null;
      sold_by: string | null;
    }>(
      `SELECT sold_order_item_id, sold_customer_id, sold_on::text AS sold_on,
              sale_price_rial::text AS sale_price_rial,
              frozen_effective_cost_rial::text AS frozen_effective_cost_rial, sold_by
         FROM automotive_vehicle_attributes WHERE business_id = $1 AND serial_id = $2`,
      [biz.id, car.serialId],
    );
    expect(cleared[0]).toEqual({
      sold_order_item_id: null,
      sold_customer_id: null,
      sold_on: null,
      sale_price_rial: null,
      frozen_effective_cost_rial: null,
      sold_by: null,
    });
    const { rows: saleHistory } = await db.query<{
      status: string;
      order_id: string;
      sale_price_rial: string;
      frozen_effective_cost_rial: string;
      reversal_reason: string;
      reversal_entry_ids: string[];
    }>(
      `SELECT status, order_id, sale_price_rial::text AS sale_price_rial,
              frozen_effective_cost_rial::text AS frozen_effective_cost_rial,
              reversal_reason, reversal_entry_ids
         FROM automotive_vehicle_sales WHERE business_id = $1 AND serial_id = $2`,
      [biz.id, car.serialId],
    );
    expect(saleHistory[0]).toMatchObject({
      status: "reversed",
      order_id: invoice.orderId,
      sale_price_rial: "981000000",
      frozen_effective_cost_rial: "700000000",
      reversal_reason: "فسخ فروش",
    });
    expect(saleHistory[0].reversal_entry_ids).toHaveLength(2);

    const { rows: events } = await db.query<{ payload: { reason?: string; saleId?: string } }>(
      `SELECT payload FROM domain_events
        WHERE business_id = $1 AND event_type = 'automotive.sale_reversed'`,
      [biz.id],
    );
    expect(events[0].payload.reason).toBe("فسخ فروش");
    expect(invoice.orderId).toBeTruthy();

    await withTransaction((client) =>
      automotive.relistReturnedVehicle(client, {
        businessId: biz.id,
        serialId: car.serialId,
        locationId: biz.locationId,
        reason: "بازرسی و تأیید آماده‌بودن برای فروش",
        actorId: biz.ownerId,
      }),
    );
    expect((await automotive.getVehicle(biz.id, car.serialId))?.state).toBe("in_stock");
    const resale = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 0,
      tenderAmount: 981_000_000,
    });
    expect(resale.orderId).not.toBe(invoice.orderId);
    expect((await automotive.getVehicle(biz.id, car.serialId))?.state).toBe("sold");
    const { rows: occurrences } = await db.query<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM automotive_vehicle_sales
        WHERE business_id = $1 AND serial_id = $2 ORDER BY created_at`,
      [biz.id, car.serialId],
    );
    expect(occurrences).toEqual([
      { status: "reversed", order_id: invoice.orderId },
      { status: "active", order_id: resale.orderId },
    ]);
  });

  it("records only the balance when an open tender settles a car with a deposit", async () => {
    const car = await carReadyToSell("S-3-OPEN", 700_000_000, 0);
    await withTransaction((client) =>
      reservations.reserveVehicle(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: car.serialId,
        customerId: biz.customerId,
        depositRial: 50_000_000,
        depositMethod: "cash",
        actorId: biz.ownerId,
      }),
    );
    // No amount typed: the tender takes the balance, which is the 981,000,000
    // total less the 50,000,000 already held, never the whole total again.
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: "open",
      customerId: biz.customerId,
    });
    const { rows: payments } = await db.query<{ amount: string }>(
      "SELECT amount::text FROM payments WHERE order_id = $1",
      [invoice.orderId],
    );
    expect(payments.map((row) => row.amount)).toEqual(["931000000"]);
    expect(await accountBalance("1100")).toBe(981_000_000);
    expect(await depositBalance()).toBe(0);
  });

  it("voids the invoice with the car, so the order and its payments are undone too", async () => {
    const car = await carReadyToSell("S-5-VOID", 700_000_000, 0);
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
    });
    await withTransaction((client) =>
      vehicleSales.reverseVehicleSale(client, {
        businessId: biz.id,
        serialId: car.serialId,
        locationId: biz.locationId,
        reason: "فسخ فروش",
        actorId: biz.ownerId,
      }),
    );
    const { rows: orders } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM orders WHERE id = $1",
      [invoice.orderId],
    );
    expect(orders[0].status).toBe("voided");
    const { rows: paid } = await db.query<{ total: string }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM payments WHERE order_id = $1",
      [invoice.orderId],
    );
    expect(paid[0].total).toBe("0");
    const { rows: amendments } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM order_amendments WHERE order_id = $1",
      [invoice.orderId],
    );
    expect(amendments[0].count).toBe("1");
    expect(await accountBalance("1100")).toBe(0);
    expect(await accountBalance("1370")).toBe(700_000_000);
    expect((await automotive.getVehicle(biz.id, car.serialId))?.state).toBe("returned");
  });

  it("refuses to void a car invoice through the generic invoice void", async () => {
    const car = await carReadyToSell("S-5-GENERIC", 700_000_000, 0);
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      vatPercent: 9,
      tenderAmount: 981_000_000,
    });
    await expect(
      withTransaction((client) =>
        invoiceVoid.voidRetailInvoice(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          orderId: invoice.orderId,
          actorId: biz.ownerId,
          reason: "اشتباه",
        }),
      ),
    ).rejects.toThrow(/برگشت فروش/);
    // Nothing moved: the car is still sold and the sale is still in the books.
    expect((await automotive.getVehicle(biz.id, car.serialId))?.state).toBe("sold");
    expect(await accountBalance("4590")).toBe(-900_000_000);
  });

  it("reads a vehicle line's sale back from the invoice, vehicle named", async () => {
    const car = await carReadyToSell("S-6", 700_000_000, 0);
    const invoice = await sellThroughInvoice({
      serialId: car.serialId,
      price: 900_000_000,
      discount: 20_000_000,
      vatPercent: 9,
      tenderAmount: 959_200_000, // (900,000,000 − 20,000,000) × 1.09
    });

    // The discount is in the document and in the books (net revenue), and the
    // VAT follows the discounted price — never a hard-coded rate anywhere.
    expect(invoice.discount).toBe("20000000");
    expect(invoice.total).toBe("959200000");
    expect(await accountBalance("4590")).toBe(-880_000_000);
    expect(await accountBalance("2200")).toBe(-79_200_000);

    const { rows: itemRows } = await db.query<{
      name_snapshot: string;
      retail_snapshot: { kind: string; vin: string | null };
    }>("SELECT name_snapshot, retail_snapshot FROM order_items WHERE order_id = $1", [invoice.orderId]);
    expect(itemRows[0].name_snapshot).toContain("S-6");
    expect(itemRows[0].retail_snapshot.kind).toBe("vehicle");
  });
});

/* ===========================================================================
 * Wave 5 — the CRM half: what a lead wants, and which cars they were shown
 * ===========================================================================
 *
 * The lead itself is the CRM's (0157), and these tests deliberately do not
 * exercise it: they pin down only the two tables migration 0213 added — the
 * typed preferences that turn "wants a used 207 up to 800 million" into a
 * query, and the record of which exact stock number was shown to whom.
 *
 * The load-bearing test here is the match: it is the one thing a text note
 * cannot do, and it is what the salesperson uses the tab for.
 */

/** A lead with nothing said about cars yet — the CRM's own table, not ours. */
async function makeLead(name: string, status = "new"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_leads (business_id, name, phone, status) VALUES ($1, $2, '09120000000', $3) RETURNING id`,
    [biz.id, name, status],
  );
  return rows[0].id;
}

/** A stocked car described only as much as a match cares about. */
async function stockedCar(input: {
  stockNumber: string;
  make: string;
  model: string;
  condition: "new" | "used";
  modelYear: number;
  askingPriceRial: number;
}) {
  return withTransaction((client) =>
    automotive.createVehicle(
      client,
      carInput({
        stockNumber: input.stockNumber,
        make: input.make,
        model: input.model,
        condition: input.condition,
        modelYear: input.modelYear,
        askingPriceRial: input.askingPriceRial,
      }),
    ),
  );
}

beforeAll(async () => {
  leads = await import("../src/lib/automotive-lead-service");
  platform = await import("../src/lib/platform-service");
  industryGuard = await import("../src/lib/industry-guard");
  mediaService = await import("../src/lib/media-service");
});

describe("what a lead is looking for", () => {
  it("matches the lot by the typed ranges, not by a note", async () => {
    const leadId = await makeLead("آقای رضایی");
    await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, {
        businessId: biz.id,
        leadId,
        make: "پژو",
        model: "207",
        condition: "used",
        modelYearFrom: 1398,
        modelYearTo: 1401,
        budgetToRial: 800_000_000,
        tradeIn: true,
        tradeInDescription: "پراید ۱۳۹۵",
        actorId: biz.ownerId,
      }),
    );

    const fits = await stockedCar({
      stockNumber: "L-1",
      make: "پژو",
      model: "207",
      condition: "used",
      modelYear: 1400,
      askingPriceRial: 750_000_000,
    });
    // A new one: the customer asked for a used car.
    const tooNew = await stockedCar({
      stockNumber: "L-2",
      make: "پژو",
      model: "207",
      condition: "new",
      modelYear: 1400,
      askingPriceRial: 750_000_000,
    });
    // Over the ceiling. Only the ceiling is compared: a customer whose budget
    // *starts* above a car's price is a different conversation.
    const tooDear = await stockedCar({
      stockNumber: "L-3",
      make: "پژو",
      model: "207",
      condition: "used",
      modelYear: 1400,
      askingPriceRial: 900_000_000,
    });
    // Older than asked for.
    const tooOld = await stockedCar({
      stockNumber: "L-4",
      make: "پژو",
      model: "207",
      condition: "used",
      modelYear: 1395,
      askingPriceRial: 700_000_000,
    });
    // A different make entirely.
    const otherMake = await stockedCar({
      stockNumber: "L-5",
      make: "کیا",
      model: "سراتو",
      condition: "used",
      modelYear: 1400,
      askingPriceRial: 700_000_000,
    });

    const matched = await leads.listLeadsInterestedInVehicle(biz.id, fits.serialId);
    expect(matched.map((row) => row.leadId)).toEqual([leadId]);
    expect(matched[0].budgetToRial).toBe(800_000_000);
    // Nothing has been linked yet, so there is no reason recorded — the lead
    // matched on what they asked for, not on what they were shown.
    expect(matched[0].bestPurpose).toBeNull();

    for (const car of [tooNew, tooDear, tooOld, otherMake]) {
      expect(await leads.listLeadsInterestedInVehicle(biz.id, car.serialId)).toEqual([]);
    }
  });

  it("drops leads the dealership has closed out, and never crosses tenants", async () => {
    const gone = await makeLead("سرنخ رد‌شده", "unqualified");
    await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, { businessId: biz.id, leadId: gone, condition: "any" }),
    );

    const car = await stockedCar({
      stockNumber: "L-6",
      make: "تویوتا",
      model: "کرولا",
      condition: "used",
      modelYear: 1402,
      askingPriceRial: 1_200_000_000,
    });
    const ids = (await leads.listLeadsInterestedInVehicle(biz.id, car.serialId)).map((row) => row.leadId);
    expect(ids).not.toContain(gone);
    // A blank preference matches anything, so the *other* tenant's read of the
    // same car — which is not even their car — finds nothing at all.
    expect(await leads.listLeadsInterestedInVehicle(other.id, car.serialId)).toEqual([]);
  });

  it("accepts a preference with no car named, and refuses a range typed backwards", async () => {
    const leadId = await makeLead("خانم موسوی");
    // "Something automatic under a billion" is a real lead: nothing is required
    // except that the lead exists.
    const preferences = await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, { businessId: biz.id, leadId, notes: "خودکار" }),
    );
    expect(preferences.condition).toBe("any");
    expect(preferences.make).toBeNull();

    await expect(
      withTransaction((client) =>
        leads.saveLeadVehiclePreferences(client, {
          businessId: biz.id,
          leadId,
          budgetFromRial: 900_000_000,
          budgetToRial: 800_000_000,
        }),
      ),
    ).rejects.toThrow(/برعکس/);

    // A trade-in interest with nothing said about the customer's car is not a
    // record — the acquisition cannot be valued from it.
    await expect(
      withTransaction((client) =>
        leads.saveLeadVehiclePreferences(client, { businessId: biz.id, leadId, tradeIn: true }),
      ),
    ).rejects.toThrow(/معاوضه/);
  });

  it("keeps a recorded test-drive request when an unrelated field is saved", async () => {
    const leadId = await makeLead("آقای کاظمی");
    await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, {
        businessId: biz.id,
        leadId,
        testDriveRequestedAt: "2026-02-01T09:30:00.000Z",
      }),
    );

    const after = await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, { businessId: biz.id, leadId, notes: "دوباره تماس بگیرد" }),
    );
    expect(after.testDriveRequestedAt).toContain("2026-02-01");
    expect(after.notes).toBe("دوباره تماس بگیرد");

    // Present-and-null is what *clears* it — an omission preserves.
    const cleared = await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, { businessId: biz.id, leadId, testDriveRequestedAt: null }),
    );
    expect(cleared.testDriveRequestedAt).toBeNull();
  });
});

describe("cars shown to a lead", () => {
  it("includes a linked lead without a preferences row and excludes leads with neither link nor preferences", async () => {
    const linkedLeadId = await makeLead("آقای نوری");
    const unlinkedLeadId = await makeLead("خانم احمدی");
    const car = await stockedCar({
      stockNumber: "L-7",
      make: "بی‌ام‌و",
      model: "320i",
      condition: "used",
      modelYear: 1399,
      askingPriceRial: 3_500_000_000,
    });

    // The dealership has not recorded a preference or shown the car to either
    // lead, so neither is a match yet.
    expect(await leads.listLeadsInterestedInVehicle(biz.id, car.serialId)).toEqual([]);

    await withTransaction((client) =>
      leads.linkLeadVehicle(client, {
        businessId: biz.id,
        leadId: linkedLeadId,
        serialId: car.serialId,
        locationId: biz.locationId,
        actorId: biz.ownerId,
      }),
    );
    // Shown again — this time a test drive. One fact, updated, not two rows.
    await withTransaction((client) =>
      leads.linkLeadVehicle(client, {
        businessId: biz.id,
        leadId: linkedLeadId,
        serialId: car.serialId,
        locationId: biz.locationId,
        purpose: "test_drive",
        actorId: biz.ownerId,
      }),
    );

    const profile = await leads.getLeadVehicleProfile(biz.id, linkedLeadId);
    expect(profile).not.toBeNull();
    expect(profile!.links).toHaveLength(1);
    expect(profile!.links[0].purpose).toBe("test_drive");
    expect(profile!.links[0].stockNumber).toBe("L-7");
    expect(profile!.links[0].displayName).toContain("320i");

    // The link is now the reason the lead ranks first for that car.
    const matched = await leads.listLeadsInterestedInVehicle(biz.id, car.serialId);
    expect(matched.map((lead) => lead.leadId)).toEqual([linkedLeadId]);
    expect(matched[0].bestPurpose).toBe("test_drive");
    expect(matched.map((lead) => lead.leadId)).not.toContain(unlinkedLeadId);

    expect(
      await withTransaction((client) =>
        leads.unlinkLeadVehicle(client, {
          businessId: biz.id,
          leadId: linkedLeadId,
          serialId: car.serialId,
          locationId: biz.locationId,
        }),
      ),
    ).toBe(true);
    expect((await leads.getLeadVehicleProfile(biz.id, linkedLeadId))!.links).toEqual([]);
  });

  it("refuses a link to another tenant's lead or another tenant's car", async () => {
    const leadId = await makeLead("آقای سلطانی");
    const car = await stockedCar({
      stockNumber: "L-8",
      make: "هیوندای",
      model: "توسان",
      condition: "used",
      modelYear: 1401,
      askingPriceRial: 2_000_000_000,
    });

    // My car, their lead id: the lead is re-checked against the active tenant.
    await expect(
      withTransaction((client) =>
        leads.linkLeadVehicle(client, { businessId: other.id, leadId, serialId: car.serialId, locationId: other.locationId }),
      ),
    ).rejects.toThrow(/سرنخ/);

    // My lead, a car that is not in my business.
    await expect(
      withTransaction((client) =>
        leads.linkLeadVehicle(client, {
          businessId: biz.id,
          leadId,
          serialId: "00000000-0000-0000-0000-000000000000",
          locationId: biz.locationId,
        }),
      ),
    ).rejects.toThrow(/خودرو/);
  });

  it("does not read another tenant's lead preferences", async () => {
    const leadId = await makeLead("آقای مهدوی");
    await withTransaction((client) =>
      leads.saveLeadVehiclePreferences(client, { businessId: biz.id, leadId, make: "رنو", model: "تلیسمان" }),
    );

    expect(await leads.getLeadVehicleProfile(other.id, leadId)).toBeNull();

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_lead_vehicle_preferences
        WHERE lead_id = $1 AND business_id <> $2`,
      [leadId, biz.id],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});

/* ===========================================================================
 * Wave 6 — an existing tenant is never reinterpreted
 * ===========================================================================
 *
 * The acceptance criterion for #839 is not "a dealership works"; it is that
 * nothing that already works changes. A trade switch is the dangerous moment:
 * the operator sees a warning built from `industryDataCounts`, the change is
 * audited with the `from` value (route-level), the chart of accounts is topped
 * up additively — and *nothing* the old trade stored is renamed, moved or read
 * as something else. The switch may not conjure a car out of a latte either,
 * which is what the zero counts after the switch assert.
 */

describe("switching an existing tenant to the automotive trade", () => {
  it("adds the trade's accounts, warns with real counts, and invents no vehicle", async () => {
    const cafe = await makeBusiness("cafe", "food_service");

    // The warning the operator confirms against: real numbers, read from the
    // tables a switch would leave behind — zeros for a tenant that has not
    // traded yet, which is the honest answer rather than a reassuring one.
    const before = await platform.industryDataCounts(cafe.businessId);
    expect(before).toEqual({ menuItems: 0, industryItems: 0, orders: 0, journalEntries: 0 });

    // A café's ledger has no vehicle inventory account; that is what makes the
    // switch meaningful rather than cosmetic.
    const { rows: accountsBefore } = await db.query<{ code: string }>(
      `SELECT code FROM accounts WHERE business_id = $1 AND code IN ('1370', '1375', '5195')`,
      [cafe.businessId],
    );
    expect(accountsBefore).toEqual([]);

    // The trade gate, before the switch: the automotive manager is not a screen
    // a café is served with an empty version of — it is refused.
    const asSession = (businessId: string) =>
      ({ businessId, sub: biz.ownerId, role: "owner" }) as unknown as Parameters<
        typeof industryGuard.requireIndustryForApi
      >[0];
    expect((await industryGuard.requireIndustryForApi(asSession(cafe.businessId), "automotive"))?.status).toBe(403);

    const result = await platform.changeBusinessIndustry(cafe.businessId, "automotive");
    expect(result).not.toBeNull();
    expect(result!.business.industry).toBe("automotive");
    // Exactly the codes the automotive template needed and the café lacked.
    for (const code of ["1370", "1375", "5195"]) {
      expect(result!.seededAccountCodes, `automotive account ${code}`).toContain(code);
    }

    // The re-seed is additive: the café's own accounts are still there, with
    // their names, and only the new trade's missing codes were added. This is
    // the property the whole switch is exposed on.
    const { rows: keptRows } = await db.query<{ code: string; name: string }>(
      `SELECT code, name FROM accounts WHERE business_id = $1 AND code IN ('1300', '5100') ORDER BY code`,
      [cafe.businessId],
    );
    expect(keptRows.map((row) => row.code)).toEqual(["1300", "5100"]);

    // Nothing the tenant already held became something else: same counts, and
    // no vehicle row exists to have "found" the café's inventory.
    expect(await platform.industryDataCounts(cafe.businessId)).toEqual(before);
    const { rows: vehicleRows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automotive_vehicle_attributes WHERE business_id = $1`,
      [cafe.businessId],
    );
    expect(Number(vehicleRows[0].n)).toBe(0);

    // …and the same gate now admits it, because it reads the *current* industry
    // rather than a cached one. (Switching back would be a second audited change;
    // one direction is enough to prove it is not cached.)
    expect(await industryGuard.requireIndustryForApi(asSession(cafe.businessId), "automotive")).toBeNull();
  });
});
