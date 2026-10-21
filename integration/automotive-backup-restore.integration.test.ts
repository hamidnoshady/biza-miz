/**
 * Issue #839 (Phase 3) — the automotive trade's backup/restore round trip.
 *
 * The repo already has exactly one tenant backup engine: `tenant-export.ts`
 * reads every tenant table through RLS and `tenantDataToSql` replays it into an
 * already-migrated database (`tenant-export.integration.test.ts` proves the
 * mechanism). The requirement for this wave is not a second engine — it is that
 * a dealership's data actually survives that one, and that it comes back with
 * its identity rules, its money and its isolation intact.
 *
 * So this file seeds a real dealership (a car with VIN and chassis, its
 * acquisition and a voided capitalized cost, two price changes, a Media Library
 * link, a reservation with a deposit and its ledger entry, a branch transfer, a
 * sale occurrence and its reversal, a CRM lead's vehicle preference and link —
 * plus the §19 mirror and a queued hold) into one database, exports it as the
 * unprivileged app role, restores it into a second, empty database, and then
 * asserts:
 *
 *   * **identity survives**: the VIN/chassis/stock number are there, and the
 *     partial unique indexes are still doing their job — a second car with the
 *     same VIN is refused by the *restored* database, not merely by the source;
 *   * **money survives with its references**: the reservation's deposit still
 *     points at a journal entry that exists, the frozen sale facts are intact,
 *     and the reversal still names its reason;
 *   * **the §19 tables survive too**: the read-only mirror and the queued hold
 *     travel with the tenant rather than being treated as disposable cache;
 *   * **nothing of anybody else's travels**: a second dealership's car in the
 *     same source database leaves no trace in the export or the restore.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_auto_backup_role";
const APP_PASSWORD = "auto-backup-password";

let sourceDbName: string;
let targetDbName: string;
let source: Client;
let target: Client;

let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let automotive: typeof import("../src/lib/automotive-service");
let reservations: typeof import("../src/lib/automotive-reservation-service");
let leadService: typeof import("../src/lib/automotive-lead-service");
let tenantExport: typeof import("../src/lib/tenant-export");

const dealer = { businessId: "", locationId: "", userId: "", branchId: "" };
const rival = { businessId: "", locationId: "" };
const cars = { reserved: "", transferred: "", sold: "", voidedCost: "", tradeInAcquired: "" };
/** Issue #963 — the live sale occurrence the seeded trade-in link binds to. */
let tradeInSaleId = "";
let mediaAssetId = "";

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

/** One transaction of the dealer's own services, exactly as a request would run them. */
async function inDealerTransaction<T>(businessId: string, work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, async () => {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

beforeAll(async () => {
  sourceDbName = `pos_auto_bak_src_${randomUUID().replaceAll("-", "")}`;
  targetDbName = `pos_auto_bak_dst_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${sourceDbName}"`);
    await maintenance.query(`CREATE DATABASE "${targetDbName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(sourceDbName), quiet: true });
  await runMigrations({ databaseUrl: urlFor(targetDbName), quiet: true });

  // The export filters tenants with RLS, so the pool must be the unprivileged
  // app role — as the superuser this database connects with by default, RLS
  // would be a silent no-op and the isolation assertions below would be vacuous.
  await createAppRole({ databaseUrl: urlFor(sourceDbName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });
  process.env.DATABASE_URL = urlFor(sourceDbName, { name: APP_ROLE, password: APP_PASSWORD });

  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  automotive = await import("../src/lib/automotive-service");
  reservations = await import("../src/lib/automotive-reservation-service");
  leadService = await import("../src/lib/automotive-lead-service");
  tenantExport = await import("../src/lib/tenant-export");

  source = new Client({ connectionString: urlFor(sourceDbName) });
  await source.connect();
  target = new Client({ connectionString: urlFor(targetDbName) });
  await target.connect();

  // ---- the dealership ----------------------------------------------------
  const created = await provisioning.provisionBusiness({
    businessName: "نمایشگاه خودروی نگین",
    ownerName: "مالک",
    email: `owner-${randomUUID()}@example.com`,
    password: "correct-horse",
    subdomain: `autobak${randomUUID().slice(0, 6)}`.toLowerCase(),
    industry: "automotive",
    seedChartOfAccounts: true,
  });
  dealer.businessId = created.businessId;
  dealer.locationId = created.locationId;
  dealer.userId = created.userId;

  // A second branch, so the transfer below has somewhere to go.
  const branch = await dbLib.withTenant(dealer.businessId, () =>
    dbLib.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ دوم') RETURNING id`, [
      dealer.businessId,
    ]),
  );
  dealer.branchId = branch.rows[0].id;

  const customerId = await dbLib.withTenant(dealer.businessId, async () => {
    const { rows } = await dbLib.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone, role, roles)
       VALUES ($1, 'آقای نگینی', '09120000001', 'customer', ARRAY['customer']::text[]) RETURNING id`,
      [dealer.businessId],
    );
    return rows[0].id;
  });

  const create = (overrides: Record<string, unknown>) =>
    inDealerTransaction(dealer.businessId, (client) =>
      automotive.createVehicle(client, {
        businessId: dealer.businessId,
        locationId: dealer.locationId,
        make: "پژو",
        model: "207",
        trim: "پانوراما",
        modelYear: 1403,
        vehicleYearCalendar: "jalali",
        condition: "new",
        askingPriceRial: 900_000_000,
        minimumPriceRial: 800_000_000,
        acquisition: {
          date: "2026-01-10",
          source: "dealer_purchase",
          costRial: 700_000_000,
          settlement: "payable",
        },
        createdBy: dealer.userId,
        ...overrides,
      }),
    );

  const reservedCar = await create({ vin: "WVWZZZ1JZ3W386801", chassisNumber: "CH-801", stockNumber: "N-1" });
  cars.reserved = reservedCar.serialId as string;
  const transferredCar = await create({ vin: "WVWZZZ1JZ3W386802", chassisNumber: "CH-802", stockNumber: "N-2" });
  cars.transferred = transferredCar.serialId as string;
  const soldCar = await create({ vin: "WVWZZZ1JZ3W386803", chassisNumber: "CH-803", stockNumber: "N-3" });
  cars.sold = soldCar.serialId as string;
  const costCar = await create({ vin: "WVWZZZ1JZ3W386804", chassisNumber: "CH-804", stockNumber: "N-4" });
  cars.voidedCost = costCar.serialId as string;

  // Acquisition + capitalized cost + a cost that was voided (void-not-edit).
  await inDealerTransaction(dealer.businessId, async (client) => {
    await automotive.recordVehicleCost(client, {
      businessId: dealer.businessId,
      serialId: cars.reserved,
      locationId: dealer.locationId,
      createdBy: dealer.userId,
      cost: {
        category: "repair",
        posting: "capitalized",
        amountRial: 30_000_000,
        incurredOn: "2026-01-20",
        settlement: "payable",
      },
    });
    const toVoid = await automotive.recordVehicleCost(client, {
      businessId: dealer.businessId,
      serialId: cars.voidedCost,
      locationId: dealer.locationId,
      createdBy: dealer.userId,
      cost: {
        category: "transport",
        posting: "capitalized",
        amountRial: 12_000_000,
        incurredOn: "2026-01-21",
        settlement: "cash",
      },
    });
    await automotive.voidVehicleCost(client, {
      businessId: dealer.businessId,
      serialId: cars.voidedCost,
      locationId: dealer.locationId,
      costId: toVoid.id,
      reason: "اشتباه در مبلغ",
      actorId: dealer.userId,
    });
  });

  // Two price changes, so the append-only price history has intervals to keep.
  await inDealerTransaction(dealer.businessId, async (client) => {
    await automotive.updateVehiclePrice(client, {
      businessId: dealer.businessId,
      serialId: cars.reserved,
      locationId: dealer.locationId,
      askingPriceRial: 880_000_000,
      reason: "تخفیف نمایشگاهی",
    });
    await automotive.updateVehiclePrice(client, {
      businessId: dealer.businessId,
      serialId: cars.reserved,
      locationId: dealer.locationId,
      askingPriceRial: 870_000_000,
    });
  });

  // A shared Media Library asset, linked to one car — the link travels, the
  // bytes stay owned by the shared library.
  mediaAssetId = await dbLib.withTenant(dealer.businessId, async () => {
    const { rows } = await dbLib.query<{ id: string }>(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', 'negah-1.jpg', 'image/jpeg', 2048, $2, $3) RETURNING id`,
      [dealer.businessId, `test/${dealer.businessId}/${randomUUID()}/negah-1.jpg`, "a".repeat(64)],
    );
    return rows[0].id;
  });
  await inDealerTransaction(dealer.businessId, (client) =>
    automotive.attachVehicleMedia(client, {
      businessId: dealer.businessId,
      locationId: dealer.locationId,
      serialId: cars.reserved,
      mediaAssetId,
      category: "photo",
      title: "عکس خودرو",
      actorId: dealer.userId,
    }),
  );

  // A reservation with a deposit: the row, its state, and the ledger entry that
  // makes the deposit a liability rather than revenue.
  await inDealerTransaction(dealer.businessId, (client) =>
    reservations.reserveVehicle(client, {
      businessId: dealer.businessId,
      locationId: dealer.locationId,
      serialId: cars.reserved,
      customerId,
      expiresAt: null,
      expiresAtTime: null,
      depositRial: 5_000_000,
      depositMethod: "cash",
      depositRefundable: true,
      depositNote: "بیعانه",
      note: null,
      actorId: dealer.userId,
    }),
  );

  // A branch transfer in flight, on a car of its own.
  await inDealerTransaction(dealer.businessId, (client) =>
    automotive.startVehicleTransfer(client, {
      businessId: dealer.businessId,
      serialId: cars.transferred,
      fromLocationId: dealer.locationId,
      toLocationId: dealer.branchId,
      note: "انتقال به شعبهٔ دوم",
      actorId: dealer.userId,
    }),
  );

  // The sale occurrence history: one live sale and one reversal, written where
  // the sale service writes them (the occurrences are the durable record even
  // when the invoice is later credited).
  await dbLib.withTenant(dealer.businessId, async () => {
    const saleId = randomUUID();
    tradeInSaleId = saleId;
    await dbLib.query(
      `INSERT INTO automotive_vehicle_sales
         (sale_id, business_id, location_id, serial_id, customer_id, sold_on, acquired_on, stock_number,
          make, model, trim, model_year, condition, sale_price_rial, vat_rate_percent,
          frozen_effective_cost_rial, sale_entry_ids, status)
       VALUES ($1,$2,$3,$4,$5,'2026-02-01','2026-01-01','N-3','پژو','207','پانوراما',1403,'new',
               930000000, 9.00, 700000000, ARRAY[$6::uuid], 'active')`,
      [saleId, dealer.businessId, dealer.locationId, cars.sold, customerId, randomUUID()],
    );
    await dbLib.query(
      `INSERT INTO automotive_vehicle_sales
         (sale_id, business_id, location_id, serial_id, customer_id, sold_on, acquired_on, stock_number,
          make, model, trim, model_year, condition, sale_price_rial, vat_rate_percent,
          frozen_effective_cost_rial, sale_entry_ids, status, reversal_reason, reversal_entry_ids, reversed_at)
       VALUES ($1,$2,$3,$4,$5,'2026-02-02','2026-01-02','N-2','پژو','207','پانوراما',1403,'new',
               910000000, 9.00, 690000000, ARRAY[]::uuid[], 'reversed', 'مشتری انصراف داد', ARRAY[]::uuid[], now())`,
      [randomUUID(), dealer.businessId, dealer.locationId, cars.transferred, customerId],
    );
  });

  // Issue #963 — a trade-in: the handed-in car through the ordinary
  // acquisition path (`source: "trade_in"`, allowance as its purchase
  // cost, settled against 2465), and the link row that binds it to the
  // live sale above with the deal's frozen figures. The link is only as
  // durable as its references, so the round trip has to carry all three
  // rows (sale, both cars) together.
  const tradeInCar = await create({
    make: "سمند",
    model: "سورن",
    condition: "used",
    mileageKm: 120_000,
    vin: "WVWZZZ1JZ3W386805",
    chassisNumber: "CH-805",
    stockNumber: "N-5",
    askingPriceRial: 520_000_000,
    minimumPriceRial: null,
    acquisition: {
      date: "2026-02-01",
      source: "trade_in",
      partyId: customerId,
      costRial: 400_000_000,
      settlement: "trade_in",
    },
  });
  cars.tradeInAcquired = tradeInCar.serialId as string;
  await dbLib.withTenant(dealer.businessId, () =>
    dbLib.query(
      `INSERT INTO automotive_vehicle_trade_ins
         (business_id, location_id, sale_id, sold_serial_id, acquired_serial_id, customer_id,
          allowance_rial, expected_retail_rial, sale_total_rial, deposit_applied_rial,
          trade_in_applied_rial, remainder_payable_rial, difference_due_rial,
          difference_settlement, status)
       VALUES ($1,$2,$3,$4,$5,$6, 400000000, 520000000, 930000000, 0, 400000000, 0, 530000000, 'cash', 'active')`,
      [dealer.businessId, dealer.locationId, tradeInSaleId, cars.sold, cars.tradeInAcquired, customerId],
    ),
  );

  // CRM: a lead's vehicle preference and the link to the car they came to see.
  const leadId = await dbLib.withTenant(dealer.businessId, async () => {
    const { rows } = await dbLib.query<{ id: string }>(
      `INSERT INTO crm_leads (business_id, name, phone, status) VALUES ($1, 'آقای سرنخ', '09120000002', 'new')
       RETURNING id`,
      [dealer.businessId],
    );
    return rows[0].id;
  });
  await inDealerTransaction(dealer.businessId, async (client) => {
    await leadService.saveLeadVehiclePreferences(client, {
      businessId: dealer.businessId,
      leadId,
      make: "پژو",
      model: "207",
      condition: "new",
      budgetToRial: 1_000_000_000,
      actorId: dealer.userId,
    });
    await leadService.linkLeadVehicle(client, {
      businessId: dealer.businessId,
      leadId,
      serialId: cars.reserved,
      locationId: dealer.locationId,
      purpose: "test_drive",
      actorId: dealer.userId,
    });
  });

  // §19: the read-only mirror and one queued hold — a site's own operational
  // record, which a restore must carry rather than treat as disposable cache.
  await dbLib.withTenant(dealer.businessId, () =>
    dbLib.query(
      `INSERT INTO automotive_vehicle_stock_mirror
         (business_id, location_id, serial_id, stock_number, make, model, trim, condition, state,
          vehicle_year_calendar, model_year, vin, chassis_number, acquired_on, asking_price_rial,
          availability, source_version, cloud_updated_at)
       VALUES ($1,$2,$3,'N-1','پژو','207','پانوراما','new','reserved','jalali',1403,
               'WVWZZZ1JZ3W386801','CH801','2026-01-10',870000000,'reserved',1, now())`,
      [dealer.businessId, dealer.locationId, cars.reserved],
    ),
  );
  await dbLib.withTenant(dealer.businessId, () =>
    dbLib.query(
      `INSERT INTO automotive_vehicle_offline_requests
         (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
          deposit_amount_rial, deposit_method, deposit_refundable, expected_version, expected_state, status)
       VALUES ($1,$2,$3,'reserve',$4,'N-1',$5,'آقای نگینی',5000000,'cash',true,1,'in_stock','pending')`,
      [randomUUID(), dealer.businessId, dealer.locationId, cars.reserved, customerId],
    ),
  );

  // ---- the other dealership, in the same source database ------------------
  const other = await provisioning.provisionBusiness({
    businessName: "نمایشگاه خودروی رقیب",
    ownerName: "مالک دیگر",
    email: `rival-${randomUUID()}@example.com`,
    password: "correct-horse",
    subdomain: `autorival${randomUUID().slice(0, 6)}`.toLowerCase(),
    industry: "automotive",
    seedChartOfAccounts: true,
  });
  rival.businessId = other.businessId;
  rival.locationId = other.locationId;
  await inDealerTransaction(other.businessId, (client) =>
    automotive.createVehicle(client, {
      businessId: other.businessId,
      locationId: other.locationId,
      make: "کیا",
      model: "سراتو",
      condition: "used",
      mileageKm: 45_000,
      askingPriceRial: 1_200_000_000,
      vin: "KNALB81ABM5000001",
      chassisNumber: "RIVAL-1",
      stockNumber: "R-1",
      acquisition: { date: "2026-01-05", source: "dealer_purchase", costRial: 900_000_000, settlement: "cash" },
    }),
  );
}, 300_000);

afterAll(async () => {
  await source?.end();
  await target?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${sourceDbName}" WITH (FORCE)`);
    await maintenance.query(`DROP DATABASE IF EXISTS "${targetDbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("an automotive tenant's backup and restore (issue #839 Phase 3)", () => {
  it("exports the trade's rows and none of another dealership's", async () => {
    const tables = await tenantExport.exportTenantData(dealer.businessId);
    const byName = new Map(tables.map((table) => [table.name, table]));

    // The §22 classification's eleven tables all travel with the tenant.
    for (const name of [
      "automotive_vehicle_attributes",
      "automotive_vehicle_costs",
      "automotive_vehicle_price_history",
      "automotive_vehicle_transfers",
      "automotive_vehicle_sales",
      "automotive_vehicle_trade_ins",
      "automotive_vehicle_media",
      "automotive_vehicle_stock_mirror",
      "automotive_vehicle_offline_requests",
      "crm_lead_vehicle_preferences",
      "crm_lead_vehicle_links",
    ]) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.rows.length, name).toBeGreaterThan(0);
    }

    expect(byName.get("automotive_vehicle_attributes")!.rows).toHaveLength(5);
    expect(byName.get("automotive_vehicle_costs")!.rows).toHaveLength(2);
    // Five cars' opening prices plus the two changes made above.
    expect(byName.get("automotive_vehicle_price_history")!.rows).toHaveLength(7);
    expect(byName.get("automotive_vehicle_sales")!.rows).toHaveLength(2);
    expect(byName.get("automotive_vehicle_trade_ins")!.rows).toHaveLength(1);

    // The other dealership's car is nowhere in this export — VIN included.
    const serialized = JSON.stringify(tables);
    expect(serialized).not.toContain("KNALB81ABM5000001");
    expect(serialized).not.toContain(rival.businessId);
    expect(byName.get("businesses")!.rows.map((row) => row.id)).toEqual([dealer.businessId]);
  });

  it("restores into a clean database with identity, money and references intact", async () => {
    const tables = await tenantExport.exportTenantData(dealer.businessId);
    await target.query(tenantExport.tenantDataToSql(tables));

    // Identity: one business, one dealership's worth of cars.
    const { rows: businesses } = await target.query<{ id: string }>("SELECT id FROM businesses");
    expect(businesses.map((row) => row.id)).toEqual([dealer.businessId]);

    const { rows: attributes } = await target.query<{
      serial_id: string;
      vin: string | null;
      chassis_number: string | null;
      stock_number: string;
      purchase_cost_rial: string;
      asking_price_rial: string;
      minimum_price_rial: string | null;
    }>(
      `SELECT serial_id, vin, chassis_number, stock_number, purchase_cost_rial::text, asking_price_rial::text,
              minimum_price_rial::text
         FROM automotive_vehicle_attributes ORDER BY stock_number`,
    );
    expect(attributes).toHaveLength(5);
    expect(attributes[0]).toMatchObject({
      vin: "WVWZZZ1JZ3W386801",
      // The service *normalizes* identity on the way in (ISO 3779 spelling), so
      // the restored chassis reads the same as the source's, not as typed.
      chassis_number: "CH801",
      stock_number: "N-1",
      purchase_cost_rial: "700000000",
      // The two price changes survived, and the floor with them.
      asking_price_rial: "870000000",
      minimum_price_rial: "800000000",
    });

    // The identity rule is a *schema* property of the restored database too: a
    // duplicate VIN is refused there, so a restore cannot quietly weaken it.
    await expect(
      target.query(
        `INSERT INTO automotive_vehicle_attributes
           (serial_id, business_id, location_id, make, model, condition, stock_number, vin, state)
         SELECT gen_random_uuid(), $1, $2, 'پژو', '206', 'new', 'N-9', 'WVWZZZ1JZ3W386801', 'in_stock'`,
        [dealer.businessId, dealer.locationId],
      ),
    ).rejects.toThrow(/uq_automotive_vehicle_vin|duplicate key/);

    // Costs: the live one and the voided one, void-not-edit.
    const { rows: costs } = await target.query<{ status: string; amount_rial: string; void_reason: string | null }>(
      `SELECT status, amount_rial::text, void_reason FROM automotive_vehicle_costs ORDER BY amount_rial`,
    );
    expect(costs).toEqual([
      { status: "void", amount_rial: "12000000", void_reason: "اشتباه در مبلغ" },
      { status: "active", amount_rial: "30000000", void_reason: null },
    ]);

    // Price history, append-only, in order — the whole chain from zero for the
    // car that was repriced twice, and one opening row for each other car.
    const { rows: prices } = await target.query<{
      previous_asking_price_rial: string;
      asking_price_rial: string;
      reason: string | null;
    }>(
      `SELECT previous_asking_price_rial::text, asking_price_rial::text, reason
         FROM automotive_vehicle_price_history
        WHERE serial_id = $1 ORDER BY changed_at`,
      [cars.reserved],
    );
    expect(prices).toEqual([
      { previous_asking_price_rial: "0", asking_price_rial: "900000000", reason: "ثبت اولیه" },
      { previous_asking_price_rial: "900000000", asking_price_rial: "880000000", reason: "تخفیف نمایشگاهی" },
      { previous_asking_price_rial: "880000000", asking_price_rial: "870000000", reason: null },
    ]);
    const { rows: historyCount } = await target.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automotive_vehicle_price_history`,
    );
    expect(Number(historyCount[0].n)).toBe(7);

    // The reservation's deposit still points at a journal entry that exists.
    const { rows: reservationRows } = await target.query<{
      status: string;
      deposit_amount_rial: string;
      deposit_ledger_entry_id: string | null;
    }>(
      `SELECT r.status, r.deposit_amount_rial::text, r.deposit_ledger_entry_id
         FROM serial_reservations r WHERE r.serial_id = $1`,
      [cars.reserved],
    );
    expect(reservationRows).toHaveLength(1);
    expect(reservationRows[0]).toMatchObject({ status: "active", deposit_amount_rial: "5000000" });
    const depositEntryId = reservationRows[0].deposit_ledger_entry_id;
    expect(depositEntryId).toBeTruthy();
    const { rows: entries } = await target.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE id = $1 AND business_id = $2`,
      [depositEntryId, dealer.businessId],
    );
    expect(Number(entries[0].n)).toBe(1);

    // The branch transfer and both sale occurrences (one reversed, with reason).
    const { rows: transfers } = await target.query<{ to_location_id: string; from_location_id: string }>(
      `SELECT to_location_id, from_location_id FROM automotive_vehicle_transfers`,
    );
    expect(transfers).toEqual([{ from_location_id: dealer.locationId, to_location_id: dealer.branchId }]);
    const { rows: sales } = await target.query<{ status: string; reversal_reason: string | null; frozen_effective_cost_rial: string | null }>(
      `SELECT status, reversal_reason, frozen_effective_cost_rial::text FROM automotive_vehicle_sales ORDER BY sold_on`,
    );
    expect(sales).toEqual([
      { status: "active", reversal_reason: null, frozen_effective_cost_rial: "700000000" },
      { status: "reversed", reversal_reason: "مشتری انصراف داد", frozen_effective_cost_rial: "690000000" },
    ]);

    // Issue #963 — the trade-in link came back still pointing at the sale
    // occurrence and both cars, with the deal's figures frozen on it.
    const { rows: tradeIns } = await target.query<{
      sale_id: string;
      sold_serial_id: string;
      acquired_serial_id: string;
      allowance_rial: string;
      trade_in_applied_rial: string;
      difference_due_rial: string;
      status: string;
    }>(
      `SELECT sale_id, sold_serial_id, acquired_serial_id, allowance_rial::text,
              trade_in_applied_rial::text, difference_due_rial::text, status
         FROM automotive_vehicle_trade_ins`,
    );
    expect(tradeIns).toEqual([
      {
        sale_id: tradeInSaleId,
        sold_serial_id: cars.sold,
        acquired_serial_id: cars.tradeInAcquired,
        allowance_rial: "400000000",
        trade_in_applied_rial: "400000000",
        difference_due_rial: "530000000",
        status: "active",
      },
    ]);

    // The Media Library link and its asset (the bytes stay the library's).
    const { rows: media } = await target.query<{ media_asset_id: string; title: string }>(
      `SELECT media_asset_id, title FROM automotive_vehicle_media`,
    );
    expect(media).toEqual([{ media_asset_id: mediaAssetId, title: "عکس خودرو" }]);

    // The CRM relationship, on both halves.
    const { rows: preferences } = await target.query<{ make: string; budget_to_rial: string }>(
      `SELECT make, budget_to_rial::text FROM crm_lead_vehicle_preferences`,
    );
    expect(preferences).toEqual([{ make: "پژو", budget_to_rial: "1000000000" }]);
    const { rows: links } = await target.query<{ serial_id: string; purpose: string }>(
      `SELECT serial_id, purpose FROM crm_lead_vehicle_links`,
    );
    expect(links).toEqual([{ serial_id: cars.reserved, purpose: "test_drive" }]);

    // §19's two tables are tenant data, not cache: the mirror and the queued
    // hold come back with everything else.
    const { rows: mirror } = await target.query<{ serial_id: string; availability: string; vin: string }>(
      `SELECT serial_id, availability, vin FROM automotive_vehicle_stock_mirror`,
    );
    expect(mirror).toEqual([{ serial_id: cars.reserved, availability: "reserved", vin: "WVWZZZ1JZ3W386801" }]);
    const { rows: queued } = await target.query<{ status: string; deposit_amount_rial: string }>(
      `SELECT status, deposit_amount_rial::text FROM automotive_vehicle_offline_requests`,
    );
    expect(queued).toEqual([{ status: "pending", deposit_amount_rial: "5000000" }]);

    // …and the other dealership never existed here.
    const { rows: rivalCars } = await target.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automotive_vehicle_attributes WHERE vin = 'KNALB81ABM5000001'`,
    );
    expect(Number(rivalCars[0].n)).toBe(0);
    const { rows: locationCount } = await target.query<{ n: string }>(`SELECT count(*)::text AS n FROM locations`);
    expect(Number(locationCount[0].n)).toBe(2);
  }, 240_000);
});
