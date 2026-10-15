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
let authLib: typeof import("../src/lib/auth");

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

/** A tenant session bound to a device, signed the way `POST /api/native-devices` signs one. */
async function signDeviceSession(
  businessId: string,
  userId: string,
  deviceId: string,
  nativeDeviceGeneration: number,
): Promise<string> {
  return authLib.signSession({
    sub: userId,
    role: "owner",
    businessId,
    locationId: null,
    fullName: "test",
    nativeDeviceId: deviceId,
    nativeDeviceGeneration,
  });
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
  authLib = await import("../src/lib/auth");
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

  it("denies a session minted before revocation even after the device is reactivated (fresh authentication required)", async () => {
    const { device: registered } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, registration()),
    );
    const staleToken = await signDeviceSession(
      alpha.businessId,
      alpha.ownerId,
      registered.id,
      registered.sessionGeneration,
    );

    // Before revocation, the token this registration minted resolves normally.
    const beforeRevoke = await asBusiness(alpha.businessId, () => authLib.resolveSessionFromToken(staleToken));
    expect(beforeRevoke?.sub).toBe(alpha.ownerId);

    await asBusiness(alpha.businessId, () =>
      nativeDevices.revokeNativeDeviceAsAdmin(registered.id, alpha.businessId, alpha.ownerId),
    );
    expect(await asBusiness(alpha.businessId, () => authLib.resolveSessionFromToken(staleToken))).toBeNull();

    await asBusiness(alpha.businessId, () =>
      nativeDevices.reactivateNativeDevice(registered.id, alpha.businessId, alpha.ownerId),
    );
    // The bug this guards against: checking only `revoked_at` would let this
    // exact pre-revocation token resolve again the moment it goes back to
    // NULL, with no login in between. `session_generation` was bumped by
    // both the revoke and the reactivate, so the stale token's stamped
    // generation no longer matches and it must still be denied.
    expect(await asBusiness(alpha.businessId, () => authLib.resolveSessionFromToken(staleToken))).toBeNull();

    // Only a *new* registration call — which only a freshly authenticated
    // member can make — mints a token that resolves again.
    const { device: reregistered } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, registration()),
    );
    const freshToken = await signDeviceSession(
      alpha.businessId,
      alpha.ownerId,
      reregistered.id,
      reregistered.sessionGeneration,
    );
    const afterFreshRegistration = await asBusiness(alpha.businessId, () =>
      authLib.resolveSessionFromToken(freshToken),
    );
    expect(afterFreshRegistration?.sub).toBe(alpha.ownerId);
  });

  it("a device_revoked registration attempt carries the device identity needed to bind and deny the caller's current session", async () => {
    const input = registration();
    const { device: revokable } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );
    await asBusiness(alpha.businessId, () =>
      nativeDevices.revokeOwnNativeDevice(revokable.id, alpha.businessId, alpha.ownerId),
    );

    let caught: unknown;
    try {
      await asBusiness(alpha.businessId, () =>
        nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      message: "device_revoked",
      status: 409,
      deviceId: revokable.id,
    });
    const generation = (caught as { sessionGeneration: number }).sessionGeneration;
    expect(typeof generation).toBe("number");

    // Binding a session to exactly what the error carried denies it — proving
    // the fields `POST /api/native-devices` uses to bind a failed caller's
    // session are the right ones, not just present.
    const boundToken = await signDeviceSession(alpha.businessId, alpha.ownerId, revokable.id, generation);
    expect(await asBusiness(alpha.businessId, () => authLib.resolveSessionFromToken(boundToken))).toBeNull();
  });

  it("resolves two concurrent first-registrations of the same brand-new installation into exactly one device row", async () => {
    const input = registration();
    const results = await Promise.all([
      asBusiness(alpha.businessId, () => nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input)),
      asBusiness(alpha.businessId, () => nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input)),
    ]);

    // Neither concurrent call throws a raw unique-constraint violation —
    // both resolve to the same row, one as the creator and one as a
    // heartbeat re-registration.
    expect(results[0].device.id).toBe(results[1].device.id);
    expect(results.filter((r) => r.created).length).toBe(1);

    const rows = await db.query("SELECT id FROM native_app_devices WHERE business_id = $1 AND install_id = $2", [
      alpha.businessId,
      input.installId,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it("persists v3 push/biometric/caller-id/sync capabilities and clears sensitive auth/push state on sign-out and revocation", async () => {
    const input = {
      ...registration(),
      pushToken: "fcm:alpha-owner-token-1234567890",
      pushProvider: "fcm" as const,
      pushChannels: ["orders_high", "approvals"],
      capabilities: ["barcode", "biometric", "caller_id"],
      biometricEnabled: true,
      biometricVerified: true,
      callerIdRoleHeld: true,
      syncedNow: true,
    };

    const { device } = await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );
    expect(device.hasPushToken).toBe(true);
    expect(device.pushProvider).toBe("fcm");
    expect(device.biometricEnabled).toBe(true);
    expect(device.biometricVerifiedAt).not.toBeNull();
    expect(device.callerIdRoleHeld).toBe(true);
    expect(device.lastSyncAt).not.toBeNull();

    // Sign-out clears the push token and biometric verification timestamp and bumps session_generation
    const tokenBeforeSignOut = await signDeviceSession(
      alpha.businessId,
      alpha.ownerId,
      device.id,
      device.sessionGeneration,
    );
    expect(await asBusiness(alpha.businessId, () => authLib.resolveSessionFromToken(tokenBeforeSignOut))).not.toBeNull();

    await asBusiness(alpha.businessId, () =>
      nativeDevices.clearNativeDeviceAuthStateOnSignOut(device.id, alpha.businessId, alpha.ownerId),
    );

    expect(await asBusiness(alpha.businessId, () => authLib.resolveSessionFromToken(tokenBeforeSignOut))).toBeNull();

    const afterSignOut = await asBusiness(alpha.businessId, () =>
      nativeDevices.listNativeDevicesForUser(alpha.businessId, alpha.ownerId),
    );
    expect(afterSignOut[0]).toMatchObject({
      id: device.id,
      hasPushToken: false,
      pushProvider: null,
      biometricEnabled: true,
      biometricVerifiedAt: null,
    });

    // Re-register push token, then revoke -> push token and biometricEnabled are both cleared
    await asBusiness(alpha.businessId, () =>
      nativeDevices.registerNativeDevice(alpha.businessId, alpha.ownerId, input),
    );
    await asBusiness(alpha.businessId, () =>
      nativeDevices.revokeOwnNativeDevice(device.id, alpha.businessId, alpha.ownerId),
    );

    const afterRevoke = await asBusiness(alpha.businessId, () =>
      nativeDevices.listNativeDevicesForUser(alpha.businessId, alpha.ownerId),
    );
    expect(afterRevoke[0]).toMatchObject({
      id: device.id,
      hasPushToken: false,
      pushProvider: null,
      biometricEnabled: false,
      biometricVerifiedAt: null,
    });
  });
});
