/**
 * Issue #839 §22 — the automotive classification checked against the real
 * schema, and the pairing it promises not to break.
 *
 * §22 says three things: classify every new entity for the deployment modes, do
 * not put the trade's financial/stock records into generic last-write-wins
 * master-data sync, and *update the replication metadata if new entities are
 * replicated*. The classification itself is in
 * `src/lib/automotive-sync-classification.ts` and asserted without a database in
 * its unit test. What only PostgreSQL can answer:
 *
 *   * **nothing is unclassified**: the sweep takes the schema's own table list
 *     (every `automotive_vehicle_*` table plus the two CRM lead extensions 0213
 *     added) and the guard must find no unclaimed table and no claim without a
 *     table — so a seventh vehicle table cannot arrive without a decision, and a
 *     rename cannot leave the audit describing a table nobody has;
 *   * **no classified table is in the master feed**: the `trg_sync_capture`
 *     trigger that makes a table last-write-wins does not exist on any of them
 *     (the query is proven to detect one by checking a table that *is* caught);
 *   * **the widened industry check accepts the trade and refuses an invention**:
 *     0211 widened `businesses.industry`, and this is the assertion that the
 *     widening is what it claims (a check that still refused `automotive` would
 *     make every other test in this file moot);
 *   * **pairing tells the truth**: an automotive business issues a code, the
 *     snapshot is redeemed and *applied to a second database* — the desktop half
 *     of the platform — and that second database holds the business, its chart
 *     of accounts, and **zero rows in every vehicle table**. The desktop gets no
 *     car, no cost, no price history, no hold, no lead preference: a VIN is a
 *     serial, and a serial never had a second writer.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  automotiveClassifiedTables,
  automotiveCloudOnlyTables,
  automotiveSyncClassificationProblems,
  isAutomotiveTable,
} from "../src/lib/automotive-sync-classification";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let serverDb: string;
let localDb: string;

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

/** `db.ts` caches its pool on globalThis, so switching databases means ending it. */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

async function useDatabase(name: string): Promise<void> {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
}

async function createDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(name), quiet: true });
}

async function dropDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}

let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let pairing: typeof import("../src/lib/pairing-service");
let pairingApply: typeof import("../src/lib/pairing-apply");
let pairingSnapshot: typeof import("../src/lib/pairing-snapshot");
let automotive: typeof import("../src/lib/automotive-service");
let leadService: typeof import("../src/lib/automotive-lead-service");

beforeAll(async () => {
  serverDb = `pos_auto_sync_srv_${randomUUID().replaceAll("-", "")}`;
  localDb = `pos_auto_sync_loc_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(serverDb);
  await createDatabase(localDb);

  await useDatabase(serverDb);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  pairing = await import("../src/lib/pairing-service");
  pairingApply = await import("../src/lib/pairing-apply");
  pairingSnapshot = await import("../src/lib/pairing-snapshot");
  automotive = await import("../src/lib/automotive-service");
  leadService = await import("../src/lib/automotive-lead-service");
}, 300_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(serverDb);
  await dropDatabase(localDb);
});

/** The tables §22's classification covers, asked of the schema rather than of the file. */
async function schemaTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name LIKE 'automotive\\_vehicle\\_%'
             OR table_name IN ('crm_lead_vehicle_preferences', 'crm_lead_vehicle_links'))
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name).filter(isAutomotiveTable);
}

describe("§22's classification against the schema", () => {
  it("covers every automotive table, and claims none the schema does not have", async () => {
    const client = new Client({ connectionString: urlFor(serverDb) });
    await client.connect();
    try {
      const tables = await schemaTables(client);
      // Four vehicle tables in 0212, two lead extensions in 0213.
      expect(tables.length).toBe(6);
      expect(automotiveSyncClassificationProblems(tables)).toEqual({ uncovered: [], unknown: [] });

      // A sanity check on the guard itself: a table the sweep would see and the
      // classification does not know about is reported, not ignored.
      const invented = automotiveSyncClassificationProblems([...tables, "automotive_vehicle_inspections"]);
      expect(invented.uncovered).toEqual(["automotive_vehicle_inspections"]);
      expect(invented.unknown).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("keeps every classified table out of the master-data capture feed", async () => {
    const client = new Client({ connectionString: urlFor(serverDb) });
    await client.connect();
    try {
      const { rows: captured } = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname = 'trg_sync_capture' AND c.relname = ANY($1::text[])`,
        [automotiveCloudOnlyTables()],
      );
      // §22's rule, as a database fact: the trigger that would make a vehicle
      // last-write-wins does not exist on any of these tables.
      expect(captured.map((row) => row.relname)).toEqual([]);

      // …and the query is not vacuously true: the catalogue's own tables do
      // carry it, while the serialized-unit table — the rule a car follows —
      // does not.
      const { rows: masterCaptured } = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname = 'trg_sync_capture'
            AND c.relname IN ('items', 'item_serials') ORDER BY c.relname`,
      );
      expect(masterCaptured.map((row) => row.relname)).toEqual(["items"]);
    } finally {
      await client.end();
    }
  });

  it("accepts `automotive` in the widened industry check and refuses an invented trade", async () => {
    const client = new Client({ connectionString: urlFor(serverDb) });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO businesses (name, slug, industry) VALUES ('نمایشگاه', $1, 'automotive') RETURNING id`,
        [`check-${randomUUID().slice(0, 8)}`],
      );
      expect(rows).toHaveLength(1);
      await client.query(`DELETE FROM businesses WHERE id = $1`, [rows[0].id]);

      await expect(
        client.query(`INSERT INTO businesses (name, slug, industry) VALUES ('x', $1, 'spaceship_dealer')`, [
          `check-${randomUUID().slice(0, 8)}`,
        ]),
      ).rejects.toThrow(/industry/);
    } finally {
      await client.end();
    }
  });

  it("pairs an automotive business onto a desktop database with no vehicle row in it", async () => {
    // ---- the cloud ---------------------------------------------------------
    const created = await provisioning.provisionBusiness({
      businessName: "نمایشگاه خودروی آرین",
      ownerName: "مالک",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      subdomain: `autosync${randomUUID().slice(0, 6)}`.toLowerCase(),
      industry: "automotive",
      seedChartOfAccounts: true,
    });

    // A car acquired through the service (so its cost posts and its item/serial
    // rows exist), a price change, and a lead with car preferences: real rows,
    // so "zero on the laptop" is a claim about data rather than about two
    // equally empty tables. Created through the trade's own services, not by
    // hand-written SQL — the point of the test is the shipped write path.
    const serialId = await dbLib.withTenant(created.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const car = await automotive.createVehicle(client, {
          businessId: created.businessId,
          locationId: created.locationId,
          make: "پژو",
          model: "207",
          trim: "پانوراما",
          modelYear: 1403,
          vehicleYearCalendar: "jalali",
          condition: "new",
          vin: "WVWZZZ1JZ3W386752",
          chassisNumber: "CHASSIS-0001",
          stockNumber: "A-1",
          askingPriceRial: 900_000_000,
          acquisition: {
            date: "2026-01-10",
            source: "dealer_purchase",
            costRial: 700_000_000,
            settlement: "payable",
          },
        });
        await automotive.recordVehicleCost(client, {
          businessId: created.businessId,
          serialId: car.serialId,
          createdBy: created.userId,
          cost: {
            category: "repair",
            posting: "capitalized",
            amountRial: 30_000_000,
            incurredOn: "2026-01-20",
            settlement: "payable",
          },
        });
        await automotive.updateVehiclePrice(client, {
          businessId: created.businessId,
          serialId: car.serialId,
          askingPriceRial: 880_000_000,
        });
        const { rows: leadRows } = await client.query<{ id: string }>(
          `INSERT INTO crm_leads (business_id, name, phone, status)
           VALUES ($1, 'آقای خریدار', '09120000000', 'new') RETURNING id`,
          [created.businessId],
        );
        await leadService.saveLeadVehiclePreferences(client, {
          businessId: created.businessId,
          leadId: leadRows[0].id,
          make: "پژو",
          model: "207",
          condition: "new",
          budgetToRial: 1_000_000_000,
          actorId: created.userId,
        });
        await leadService.linkLeadVehicle(client, {
          businessId: created.businessId,
          leadId: leadRows[0].id,
          serialId: car.serialId,
          purpose: "test_drive",
          actorId: created.userId,
        });
        await client.query("COMMIT");
        return car.serialId as string;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });
    expect(serialId).toBeTruthy();

    const platformAdminId = await dbLib.withoutTenantScope("platform", async () => {
      const { rows } = await dbLib.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, 'x', 'operator') RETURNING id`,
        [`admin-${randomUUID()}@example.com`],
      );
      return rows[0].id;
    });

    const issued = await dbLib.withoutTenantScope("platform", () =>
      pairing.issuePairingCode(created.businessId, platformAdminId, created.locationId),
    );
    if (!("code" in issued)) throw new Error(`pairing code not issued: ${JSON.stringify(issued)}`);

    const installationId = `desktop-installation-${randomUUID()}`;
    const redeemed = await pairing.redeemPairingCode(
      issued.code,
      "127.0.0.1",
      "Windows Business Suite",
      installationId,
    );
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // §22's "tell the truth" half: the snapshot carries the trade, and the
    // coverage copy the operator and the desktop both read names the vehicle
    // stock as cloud-only and promises no automotive event.
    const snapshotBusiness = redeemed.snapshot.business as { industry?: string };
    expect(snapshotBusiness.industry).toBe("automotive");
    const classification = redeemed.snapshot.dataClassification;
    expect(classification.ongoingDomainEvents.some((event) => event.includes("automotive"))).toBe(false);
    expect(classification.centralOnlyData.join(" ")).toContain("Automotive vehicle stock");
    expect(classification.bootstrapMasterData.join(" ")).not.toContain("Automotive vehicle");

    const validation = pairingSnapshot.validateSnapshot(JSON.parse(JSON.stringify(redeemed.snapshot)));
    expect(validation).toMatchObject({ ok: true });

    // ---- the desktop -------------------------------------------------------
    await useDatabase(localDb);
    const applied = await pairingApply.applyPairingSnapshot(
      redeemed.snapshot,
      "https://pos.example.com",
      { pairingSessionId: redeemed.pairingSessionId, installationId },
    );
    expect(applied.businessId).toBe(created.businessId);

    // The snapshot really landed: the business (with the trade it carries) and
    // the chart of accounts are here. The counts below are about the vehicle
    // tables, not about a snapshot that failed half-way.
    const { rows: businessRows } = await dbLib.withoutTenantScope("platform", () =>
      dbLib.query<{ n: string; industry: string }>(
        `SELECT count(*)::text AS n, min(industry) AS industry FROM businesses WHERE id = $1`,
        [created.businessId],
      ),
    );
    expect(Number(businessRows[0].n)).toBe(1);
    expect(businessRows[0].industry).toBe("automotive");
    const { rows: accountRows } = await dbLib.withoutTenantScope("platform", () =>
      dbLib.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounts WHERE business_id = $1`, [
        created.businessId,
      ]),
    );
    expect(Number(accountRows[0].n)).toBeGreaterThan(0);

    // No car crosses, and neither does anything hanging off one — cost, price
    // history, transfer, hold or lead preference. The desktop's till can sell
    // retail goods from the catalogue; the vehicle it cannot hold is the point.
    for (const table of automotiveClassifiedTables()) {
      const { rows } = await dbLib.withoutTenantScope("platform", () =>
        dbLib.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE business_id = $1`, [
          created.businessId,
        ]),
      );
      expect(Number(rows[0].n), table).toBe(0);
    }
    // The catalogue half *does* travel — through the master feed rather than the
    // snapshot — so the paired side has the make/model it needs to name a car
    // once the cloud sends one. Asserted on the source schema rather than here:
    // this database has no master feed running.
    const { rows: masterRows } = await dbLib.withoutTenantScope("platform", () =>
      dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname = 'trg_sync_capture' AND c.relname = 'items'`,
      ),
    );
    expect(Number(masterRows[0].n)).toBe(1);

    // Leaving the pool pointed at the laptop database would break every later
    // test in the file, so the server is restored here.
    await useDatabase(serverDb);
  }, 180_000);
});
