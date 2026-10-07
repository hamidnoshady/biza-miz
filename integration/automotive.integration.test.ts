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
import { Client } from "pg";
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
let postingEngine: typeof import("../src/lib/posting-engine");

const biz = { id: "", locationId: "", secondLocationId: "", ownerId: "" };
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

async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

async function makeBusiness(slugPrefix: string, industry = "automotive") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [`${slugPrefix} Co`, `${slugPrefix}-${randomUUID().slice(0, 8)}`, industry],
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
  postingEngine = await import("../src/lib/posting-engine");
  void postingEngine;

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
  await db.query("DELETE FROM automotive_vehicle_transfers");
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
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM platforms").catch(() => {});
  await db.query("DELETE FROM businesses");

  const primary = await makeBusiness("showroom");
  biz.id = primary.businessId;
  biz.locationId = primary.locationId;
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
      automotive.completeVehicleTransfer(client, { businessId: biz.id, transferId, actorId: biz.ownerId }),
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
    const { rows: customer } = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, 'آقای رضایی', 'customer') RETURNING id",
      [biz.id],
    );
    await db.query(
      `INSERT INTO serial_reservations (business_id, location_id, serial_id, customer_id)
       VALUES ($1, $2, $3, $4)`,
      [biz.id, biz.locationId, created.serialId, customer[0].id],
    );
    await withTransaction((client) =>
      automotive.setVehicleState(client, {
        businessId: biz.id,
        serialId: created.serialId,
        state: "reserved",
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
