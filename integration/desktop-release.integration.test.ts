/** Device-authenticated runtime telemetry and release compliance against PostgreSQL. */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let releases: typeof import("../src/lib/desktop-release-service");
let sync: typeof import("../src/lib/server-sync");

function urlFor(database: string) { const url = new URL(rootDatabaseUrl!); url.pathname = `/${database}`; return url.toString(); }
function maintenanceUrl() { const url = new URL(rootDatabaseUrl!); url.pathname = "/postgres"; return url.toString(); }

beforeAll(async () => {
  databaseName = `pos_desktop_release_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect(); await maintenance.query(`CREATE DATABASE "${databaseName}"`); await maintenance.end();
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  releases = await import("../src/lib/desktop-release-service");
  sync = await import("../src/lib/server-sync");
  db = new Client({ connectionString: urlFor(databaseName) }); await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end(); await dbLib?.closeDatabasePool().catch(() => {}); process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await maintenance.end();
});

async function addDevice(businessId: string, locationId: string, name: string, token: string) {
  const device = await db.query<{ id: string }>(
    `INSERT INTO site_devices (business_id,location_id,display_name,status) VALUES ($1,$2,$3,'active') RETURNING id`,
    [businessId, locationId, name],
  );
  await db.query(
    `INSERT INTO site_sync_credentials (site_device_id,business_id,token_hash,state)
     VALUES ($1,$2,$3,'active')`,
    [device.rows[0].id, businessId, createHash("sha256").update(token).digest("hex")],
  );
  return device.rows[0].id;
}

describe("Desktop release telemetry", () => {
  it("stores two installations independently, derives identity from each credential and applies SemVer compliance", async () => {
    const business = await db.query<{ id: string }>("INSERT INTO businesses (name,slug) VALUES ('Fleet Co',$1) RETURNING id", [`fleet-${randomUUID().slice(0, 8)}`]);
    const businessId = business.rows[0].id;
    const location = await db.query<{ id: string }>("INSERT INTO locations (business_id,name) VALUES ($1,'تهران') RETURNING id", [businessId]);
    const firstToken = `POS1_${randomUUID()}_first`; const secondToken = `POS1_${randomUUID()}_second`;
    const firstId = await addDevice(businessId, location.rows[0].id, "صندوق یک", firstToken);
    const secondId = await addDevice(businessId, location.rows[0].id, "صندوق دو", secondToken);

    await db.query(
      `INSERT INTO platform_releases
       (version,build_commit,build_id,channel,status,rollout_state,rollout_percentage,released_at,
        installer_url,installer_sha256,installer_size,manifest_signature,expected_publisher,release_notes)
       VALUES ('1.1.0','6f714578','build-1','stable','published','full',100,now(),
               'https://github.com/example/releases/update.exe',$1,1000,$2,'Business Suite','[]')`,
      ["a".repeat(64), "A".repeat(96)],
    );

    const firstIdentity = await sync.resolveSyncCredential(firstToken);
    const secondIdentity = await sync.resolveSyncCredential(secondToken);
    expect(firstIdentity).toMatchObject({ businessId, siteDeviceId: firstId, locationId: location.rows[0].id });
    expect(secondIdentity).toMatchObject({ businessId, siteDeviceId: secondId, locationId: location.rows[0].id });

    const report = (appVersion: string): import("../src/lib/desktop-release-service").RuntimeStatusReport => ({
      appVersion, commitSha: "1234567", buildId: `build-${appVersion}`, schemaVersion: 187,
      electronVersion: "44.4.3", platform: "win32", releaseChannel: "stable",
      clientCheckedAt: "2026-09-28T08:00:00.000Z", updateState: appVersion === "1.0.5" ? "update_available" : "no_update",
      updateTargetVersion: appVersion === "1.0.5" ? "1.1.0" : null, lastErrorCode: null, lastErrorMessage: null,
    });
    await dbLib.withTenant(businessId, () => releases.reportDeviceRuntimeStatus({ businessId, siteDeviceId: firstId, locationId: location.rows[0].id }, report("1.0.5")));
    await dbLib.withTenant(businessId, () => releases.reportDeviceRuntimeStatus({ businessId, siteDeviceId: secondId, locationId: location.rows[0].id }, report("1.1.0")));

    const fleet = await releases.desktopFleetCompliance();
    expect(fleet.devices).toHaveLength(2);
    expect(fleet.devices.find((device) => device.siteDeviceId === firstId)?.compliance).toBe("update_available");
    expect(fleet.devices.find((device) => device.siteDeviceId === firstId)?.updateEvents[0]).toMatchObject({ state: "update_available", targetVersion: "1.1.0" });
    expect(fleet.devices.find((device) => device.siteDeviceId === secondId)?.compliance).toBe("up_to_date");
    expect(fleet.summary).toMatchObject({ installations: 2, updateAvailable: 1, upToDate: 1 });

    const receipts = await db.query<{ site_device_id: string; business_id: string }>("SELECT site_device_id,business_id FROM site_device_runtime_status ORDER BY site_device_id");
    expect(new Set(receipts.rows.map((row) => row.site_device_id))).toEqual(new Set([firstId, secondId]));
    expect(receipts.rows.every((row) => row.business_id === businessId)).toBe(true);

    await db.query("UPDATE site_devices SET status='revoked',revoked_at=now() WHERE id=$1", [firstId]);
    expect(await sync.resolveSyncCredential(firstToken)).toBeNull();
  });
});
