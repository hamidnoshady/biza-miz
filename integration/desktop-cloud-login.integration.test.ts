/** Phase 46 — «ورود با حساب ابری»: single-use codes against PostgreSQL. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let login: typeof import("../src/lib/desktop-cloud-login-service");

function urlFor(database: string) { const url = new URL(rootDatabaseUrl!); url.pathname = `/${database}`; return url.toString(); }
function maintenanceUrl() { const url = new URL(rootDatabaseUrl!); url.pathname = "/postgres"; return url.toString(); }

beforeAll(async () => {
  databaseName = `pos_desktop_login_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect(); await maintenance.query(`CREATE DATABASE "${databaseName}"`); await maintenance.end();
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  login = await import("../src/lib/desktop-cloud-login-service");
  db = new Client({ connectionString: urlFor(databaseName) }); await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end(); await dbLib?.closeDatabasePool().catch(() => {}); process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await maintenance.end();
});

async function business(name: string) {
  const b = await db.query<{ id: string }>("INSERT INTO businesses (name,slug) VALUES ($1,$2) RETURNING id", [name, `${name}-${randomUUID().slice(0, 8)}`]);
  const businessId = b.rows[0].id;
  const location = await db.query<{ id: string }>("INSERT INTO locations (business_id,name) VALUES ($1,'مرکزی') RETURNING id", [businessId]);
  const other = await db.query<{ id: string }>("INSERT INTO locations (business_id,name) VALUES ($1,'شمال') RETURNING id", [businessId]);
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash) VALUES ($1,'owner','مالک',$2,'x') RETURNING id`,
    [businessId, `${randomUUID()}@example.test`],
  );
  const device = await db.query<{ id: string; public_id: string }>(
    `INSERT INTO site_devices (business_id,location_id,display_name,status) VALUES ($1,$2,'صندوق','active') RETURNING id, public_id`,
    [businessId, location.rows[0].id],
  );
  return {
    businessId,
    locationId: location.rows[0].id,
    otherLocationId: other.rows[0].id,
    userId: user.rows[0].id,
    deviceId: device.rows[0].id,
    devicePublicId: device.rows[0].public_id,
  };
}

const state = "s".repeat(43);

describe("desktop cloud login codes", () => {
  it("issues a device code, redeems it once for that install only, then the session code once", async () => {
    const cafe = await business("cafe");
    const issued = await dbLib.withTenant(cafe.businessId, () =>
      login.issueDeviceLoginCode({ ...cafe, state, accessibleLocationIds: [cafe.locationId] }),
    );
    if (!("code" in issued)) throw new Error(issued.error);

    const wrongDevice = await dbLib.withTenant(cafe.businessId, () =>
      login.redeemDeviceLoginCode({ businessId: cafe.businessId, siteDeviceId: randomUUID(), code: issued.code }),
    );
    expect(wrongDevice).toBeNull();

    const redeemed = await dbLib.withTenant(cafe.businessId, () =>
      login.redeemDeviceLoginCode({ businessId: cafe.businessId, siteDeviceId: cafe.deviceId, code: issued.code }),
    );
    expect(redeemed?.userId).toBe(cafe.userId);
    const replay = await dbLib.withTenant(cafe.businessId, () =>
      login.redeemDeviceLoginCode({ businessId: cafe.businessId, siteDeviceId: cafe.deviceId, code: issued.code }),
    );
    expect(replay).toBeNull();

    const member = await dbLib.withTenant(cafe.businessId, () => login.redeemSessionLoginCode(cafe.businessId, redeemed!.sessionCode));
    expect(member).toMatchObject({ userId: cafe.userId, role: "owner" });
    expect(await dbLib.withTenant(cafe.businessId, () => login.redeemSessionLoginCode(cafe.businessId, redeemed!.sessionCode))).toBeNull();

    const stored = await db.query<{ code_hash: string }>("SELECT code_hash FROM desktop_login_codes WHERE business_id=$1", [cafe.businessId]);
    expect(stored.rows.map((row) => row.code_hash)).not.toContain(issued.code);
  });

  it("refuses an install of another business, a branch the member cannot open, and an expired code", async () => {
    const cafe = await business("cafe2");
    const bistro = await business("bistro");
    const foreign = await dbLib.withTenant(cafe.businessId, () =>
      login.issueDeviceLoginCode({ ...cafe, devicePublicId: bistro.devicePublicId, state, accessibleLocationIds: [cafe.locationId] }),
    );
    expect(foreign).toEqual({ error: "device_not_found" });
    const wrongBranch = await dbLib.withTenant(cafe.businessId, () =>
      login.issueDeviceLoginCode({ ...cafe, state, accessibleLocationIds: [cafe.otherLocationId] }),
    );
    expect(wrongBranch).toEqual({ error: "branch_not_allowed" });

    const issued = await dbLib.withTenant(cafe.businessId, () =>
      login.issueDeviceLoginCode({ ...cafe, state, accessibleLocationIds: [cafe.locationId] }),
    );
    if (!("code" in issued)) throw new Error(issued.error);
    await db.query("UPDATE desktop_login_codes SET expires_at = now() - interval '1 second' WHERE business_id=$1", [cafe.businessId]);
    const expired = await dbLib.withTenant(cafe.businessId, () =>
      login.redeemDeviceLoginCode({ businessId: cafe.businessId, siteDeviceId: cafe.deviceId, code: issued.code }),
    );
    expect(expired).toBeNull();
  });
});
