/**
 * Android device registry lifecycle against the real schema (issue #884).
 *
 * Mirrors device-binding.integration.test.ts: this keeps the owner
 * decisions honest against RLS and real constraints, not just mocked
 * queries — idempotent re-registration, a revoked installation refusing to
 * come back by itself, tenant isolation, self vs. business-wide scoping,
 * reactivation, and the audit trail every revocation/reactivation leaves.
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
let nativeDevices: typeof import("../src/lib/native-device-service");

const alpha = { businessId: "", ownerId: "", managerId: "" };
const beta = { businessId: "", ownerId: "" };

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

async function seedBusiness(name: string, slug: string) {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = business.rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, password_hash)
     VALUES ($1, 'owner', $2, 'test') RETURNING id`,
    [businessId, `${name} مالک`],
  );
  const manager = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, password_hash)
     VALUES ($1, 'manager', $2, 'test') RETURNING id`,
    [businessId, `${name} مدیر`],
  );
  return { businessId, ownerId: owner.rows[0].id, managerId: manager.rows[0].id };
}

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

function registration(overrides: Partial<Parameters<typeof nativeDevices.registerNativeDevice>[2]> = {}) {
  return {
    installId: `install-${randomUUID()}`,
    appEnvironment: "production" as const,
    appVersionName: "1.0.0",
    appVersionCode: 1,
    bridgeVersion: 2,
    ...overrides,
  };
}

beforeAll(async () => {
  databaseName = `native_device_registry_${randomUUID().replaceAll("-", "")}`;
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
  nativeDevices = await import("../src/lib/native-device-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool().catch(() => {});
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
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("آلفا", `alpha-${randomUUID().slice(0, 8)}`));
  Object.assign(beta, await seedBusiness("بتا", `beta-${randomUUID().slice(0, 8)}`));
});

describe("native device registry lifecycle", () => {
  it("registers once, re-registers idempotently as a heartbeat, and only audits the first registration", async () => {
    const input = registration();
    const first = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );
    expect(first.created).toBe(true);
    expect(first.device.revokedAt).toBeNull();

    const second = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, {
        ...input,
        appVersionName: "1.1.0",
        appVersionCode: 2,
      }),
    );
    expect(second.created).toBe(false);
    expect(second.device.id).toBe(first.device.id);
    expect(second.device.appVersionName).toBe("1.1.0");

    const rows = await db.query("SELECT id FROM native_app_devices WHERE business_id = $1", [alpha.businessId]);
    expect(rows.rows).toHaveLength(1);

    const audit = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id = $1 AND entity_id = $2 ORDER BY id",
      [alpha.businessId, first.device.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["native_device.registered"]);
  });

  it("never lets a revoked installation reactivate itself by registering again", async () => {
    const input = registration();
    const { device } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );
    await asBusiness(alpha.businessId, () =>
      nativeDevices.revokeOwnNativeDevice(device.id, alpha.businessId, alpha.ownerId),
    );

    await expect(
      asBusiness(alpha.businessId, () => nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input)),
    ).rejects.toMatchObject({ message: "device_revoked", status: 409 });

    // Logging in again (a second attempt with the same installId) must not silently revive it.
    await expect(
      asBusiness(alpha.businessId, () =>
        nativeDevices.registerNativeDevice(alpha.businessId, alpha.managerId, input),
      ),
    ).rejects.toMatchObject({ message: "device_revoked", status: 409 });

    const row = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM native_app_devices WHERE id = $1",
      [device.id],
    );
    expect(row.rows[0].revoked_at).not.toBeNull();
  });

  it("refuses to silently reassign a shared installation to a different member", async () => {
    const input = registration();
    await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        nativeDevices.registerNativeDevice(alpha.businessId, alpha.managerId, input),
      ),
    ).rejects.toMatchObject({ message: "device_registered_to_another_user", status: 409 });
  });

  it("isolates tenants: another business's registration, list, revoke and reactivate never touch this one", async () => {
    const input = registration();
    const { device } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );

    const betaList = await asBusiness(beta.businessId, () =>
      nativeDevices.listNativeDevicesForBusiness(beta.businessId),
    );
    expect(betaList).toHaveLength(0);

    await expect(
      asBusiness(beta.businessId, () => nativeDevices.revokeNativeDeviceAsAdmin(device.id, beta.businessId, beta.ownerId)),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });

    await expect(
      asBusiness(beta.businessId, () =>
        nativeDevices.reactivateNativeDevice(device.id, beta.businessId, beta.ownerId),
      ),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });

    const stillActive = await asBusiness(alpha.businessId, () =>
      nativeDevices.listNativeDevicesForBusiness(alpha.businessId),
    );
    expect(stillActive[0]).toMatchObject({ id: device.id, revokedAt: null });
  });

  it("scopes a plain member's own list and self-revoke to their own installations, distinct from the business-wide admin view", async () => {
    const ownerDevice = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, registration()),
    );
    const managerDevice = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.managerId, registration()),
    );

    const ownerSelf = await asBusiness(alpha.businessId, () =>
      nativeDevices.listNativeDevicesForUser(alpha.businessId, alpha.ownerId),
    );
    expect(ownerSelf.map((d) => d.id)).toEqual([ownerDevice.device.id]);

    const managerSelf = await asBusiness(alpha.businessId, () =>
      nativeDevices.listNativeDevicesForUser(alpha.businessId, alpha.managerId),
    );
    expect(managerSelf.map((d) => d.id)).toEqual([managerDevice.device.id]);

    // A plain member revoking their own device never reaches somebody else's.
    await expect(
      asBusiness(alpha.businessId, () =>
        nativeDevices.revokeOwnNativeDevice(ownerDevice.device.id, alpha.businessId, alpha.managerId),
      ),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });

    const businessWide = await asBusiness(alpha.businessId, () =>
      nativeDevices.listNativeDevicesForBusiness(alpha.businessId),
    );
    expect(businessWide.map((d) => d.id).sort()).toEqual(
      [ownerDevice.device.id, managerDevice.device.id].sort(),
    );
  });

  it("lets an owner/admin revoke and reactivate any device in the business, with an audit row for each", async () => {
    const { device } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.managerId, registration()),
    );

    await asBusiness(alpha.businessId, () =>
      nativeDevices.revokeNativeDeviceAsAdmin(device.id, alpha.businessId, alpha.ownerId),
    );
    const revoked = await db.query<{ revoked_at: Date | null; revoked_by: string | null }>(
      "SELECT revoked_at, revoked_by FROM native_app_devices WHERE id = $1",
      [device.id],
    );
    expect(revoked.rows[0].revoked_at).not.toBeNull();
    expect(revoked.rows[0].revoked_by).toBe(alpha.ownerId);

    // Revoking again is a no-op failure, not a second audit row.
    await expect(
      asBusiness(alpha.businessId, () =>
        nativeDevices.revokeNativeDeviceAsAdmin(device.id, alpha.businessId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });

    await asBusiness(alpha.businessId, () =>
      nativeDevices.reactivateNativeDevice(device.id, alpha.businessId, alpha.ownerId),
    );
    const reactivated = await db.query<{ revoked_at: Date | null; reactivated_by: string | null }>(
      "SELECT revoked_at, reactivated_by FROM native_app_devices WHERE id = $1",
      [device.id],
    );
    expect(reactivated.rows[0].revoked_at).toBeNull();
    expect(reactivated.rows[0].reactivated_by).toBe(alpha.ownerId);

    // Reactivating an already-active device is a no-op failure too.
    await expect(
      asBusiness(alpha.businessId, () =>
        nativeDevices.reactivateNativeDevice(device.id, alpha.businessId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });

    const audit = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id = $1 AND entity_id = $2 ORDER BY id",
      [alpha.businessId, device.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "native_device.registered",
      "native_device.revoked_admin",
      "native_device.reactivated",
    ]);
  });
});
