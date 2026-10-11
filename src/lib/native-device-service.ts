/**
 * Issue #884 — the Android app's device registry: the DB-touching half (not
 * unit-tested directly, per repo convention — see device-service.ts's and
 * employee-service.ts's headers for why; integration/native-device-registry
 * .integration.test.ts covers it against the real schema).
 *
 * A "registered device" is one Android installation, identified by the UUID
 * `TwaLauncherActivity` generates once and keeps in app-private storage. It
 * is never a login credential — nothing is authorised by presenting an
 * `installId` alone, the caller must already hold an authenticated session
 * (`POST /api/native-devices`, requireMember) — so registering it is purely
 * bookkeeping: which installations exist, who they belong to, and whether
 * they are still allowed to keep using the session that registered them.
 *
 * Revocation's enforcement is not here — it lives in `checkNativeDevice`
 * (auth.ts), which re-reads `revoked_at` on every request a bound session
 * makes. This module only ever flips that column and writes the audit trail;
 * it never tries to reach the device, because it might be offline when
 * revoked (ISSUE_884_PLAN.md's offline-limitation decision).
 */
import { getPool, query } from "./db";

export class NativeDeviceError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export type NativeAppEnvironment = "development" | "staging" | "production";

export interface NativeDevice {
  id: string;
  businessId: string;
  userId: string;
  /** The member's display name, for the business-wide admin list. */
  userName: string | null;
  platform: "android";
  appEnvironment: NativeAppEnvironment;
  appVersionName: string;
  appVersionCode: number;
  bridgeVersion: number;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  reactivatedAt: string | null;
}

interface NativeDeviceRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  user_id: string;
  user_name?: string | null;
  platform: "android";
  app_environment: NativeAppEnvironment;
  app_version_name: string;
  app_version_code: number;
  bridge_version: number;
  registered_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  reactivated_at: Date | null;
}

function toDevice(row: NativeDeviceRow): NativeDevice {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    platform: row.platform,
    appEnvironment: row.app_environment,
    appVersionName: row.app_version_name,
    appVersionCode: row.app_version_code,
    bridgeVersion: row.bridge_version,
    registeredAt: row.registered_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    reactivatedAt: row.reactivated_at ? row.reactivated_at.toISOString() : null,
  };
}

async function auditNativeDevice(
  businessId: string,
  actorId: string | null,
  action: string,
  deviceId: string,
  payload?: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'native_device', $4, $5)`,
    [businessId, actorId, action, deviceId, JSON.stringify(payload ?? null)],
  );
}

export interface RegisterNativeDeviceInput {
  installId: string;
  appEnvironment: NativeAppEnvironment;
  appVersionName: string;
  appVersionCode: number;
  bridgeVersion: number;
}

/**
 * Registers (or re-registers) the caller's own Android installation.
 *
 * Idempotent on purpose — the web app calls this after every login and
 * business selection, not only on first launch — but it never revives a
 * revoked row: once an owner/admin has revoked an installation, re-running
 * this same call (even from the same member, even after a fresh login)
 * fails with `device_revoked` until `reactivateNativeDevice` runs. That is
 * the "requires an authorized owner/admin action" half of the owner
 * decision; the "followed by fresh authentication" half falls out for free,
 * because revocation already invalidated whatever session this installation
 * was using (see `checkNativeDevice`), so nothing can call this again until
 * the member signs in again.
 */
export async function registerNativeDevice(
  businessId: string,
  userId: string,
  input: RegisterNativeDeviceInput,
): Promise<{ device: NativeDevice; created: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{ id: string; user_id: string; revoked_at: Date | null }>(
      `SELECT id, user_id, revoked_at FROM native_app_devices
        WHERE business_id = $1 AND install_id = $2
        FOR UPDATE`,
      [businessId, input.installId],
    );
    const existing = existingRows[0];

    if (existing?.revoked_at) {
      await client.query("ROLLBACK");
      throw new NativeDeviceError("device_revoked", 409);
    }

    // A different member registering the same installation is never treated
    // as a silent ownership transfer — an owner/admin revoking the current
    // registration first (an explicit, audited act) is how a shared device
    // changes hands.
    if (existing && existing.user_id !== userId) {
      await client.query("ROLLBACK");
      throw new NativeDeviceError("device_registered_to_another_user", 409);
    }

    let row: NativeDeviceRow;
    let created: boolean;
    if (existing) {
      created = false;
      const { rows } = await client.query<NativeDeviceRow>(
        `UPDATE native_app_devices
            SET app_environment = $3, app_version_name = $4, app_version_code = $5,
                bridge_version = $6, last_seen_at = now()
          WHERE id = $1 AND business_id = $2
          RETURNING id, business_id, user_id, platform, app_environment, app_version_name,
                    app_version_code, bridge_version, registered_at, last_seen_at, revoked_at,
                    reactivated_at`,
        [existing.id, businessId, input.appEnvironment, input.appVersionName, input.appVersionCode, input.bridgeVersion],
      );
      row = rows[0];
    } else {
      created = true;
      const { rows } = await client.query<NativeDeviceRow>(
        `INSERT INTO native_app_devices
           (business_id, user_id, app_environment, install_id, app_version_name, app_version_code, bridge_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, business_id, user_id, platform, app_environment, app_version_name,
                   app_version_code, bridge_version, registered_at, last_seen_at, revoked_at,
                   reactivated_at`,
        [businessId, userId, input.appEnvironment, input.installId, input.appVersionName, input.appVersionCode, input.bridgeVersion],
      );
      row = rows[0];
    }

    if (created) {
      await client.query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'native_device.registered', 'native_device', $3, $4)`,
        [businessId, userId, row.id, JSON.stringify({ appEnvironment: input.appEnvironment })],
      );
    }
    await client.query("COMMIT");
    return { device: toDevice({ ...row, user_name: null }), created };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The caller's own registered installations, newest first. */
export async function listNativeDevicesForUser(businessId: string, userId: string): Promise<NativeDevice[]> {
  const { rows } = await query<NativeDeviceRow>(
    `SELECT id, business_id, user_id, platform, app_environment, app_version_name, app_version_code,
            bridge_version, registered_at, last_seen_at, revoked_at, reactivated_at
       FROM native_app_devices
      WHERE business_id = $1 AND user_id = $2
      ORDER BY revoked_at IS NULL DESC, registered_at DESC`,
    [businessId, userId],
  );
  return rows.map((row) => toDevice({ ...row, user_name: null }));
}

/** Every registered installation across the business, for the device-management admin list. */
export async function listNativeDevicesForBusiness(businessId: string): Promise<NativeDevice[]> {
  const { rows } = await query<NativeDeviceRow>(
    `SELECT d.id, d.business_id, d.user_id, u.full_name AS user_name, d.platform, d.app_environment,
            d.app_version_name, d.app_version_code, d.bridge_version, d.registered_at, d.last_seen_at,
            d.revoked_at, d.reactivated_at
       FROM native_app_devices d
       LEFT JOIN users u ON u.id = d.user_id AND u.business_id = d.business_id
      WHERE d.business_id = $1
      ORDER BY d.revoked_at IS NULL DESC, d.registered_at DESC`,
    [businessId],
  );
  return rows.map(toDevice);
}

/** A member revoking their own installation — lost or stolen phone, logging it out everywhere. */
export async function revokeOwnNativeDevice(deviceId: string, businessId: string, userId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `UPDATE native_app_devices
        SET revoked_at = now(), revoked_by = $3
      WHERE id = $1 AND business_id = $2 AND user_id = $3 AND revoked_at IS NULL
      RETURNING id`,
    [deviceId, businessId, userId],
  );
  if (!rows[0]) throw new NativeDeviceError("device_not_found", 404);
  await auditNativeDevice(businessId, userId, "native_device.revoked_self", deviceId);
}

/** An owner/admin revoking any installation in the business (`native_devices.manage`). */
export async function revokeNativeDeviceAsAdmin(deviceId: string, businessId: string, actorId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `UPDATE native_app_devices
        SET revoked_at = now(), revoked_by = $3
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [deviceId, businessId, actorId],
  );
  if (!rows[0]) throw new NativeDeviceError("device_not_found", 404);
  await auditNativeDevice(businessId, actorId, "native_device.revoked_admin", deviceId);
}

/**
 * Lets a previously revoked installation register again. Does not, by
 * itself, restore any access: the session that was bound to this row was
 * already invalidated the moment it was revoked (`checkNativeDevice`), so
 * the member must sign in again and the app must call `registerNativeDevice`
 * again before this installation can do anything — the "followed by fresh
 * authentication" half of the owner decision.
 */
export async function reactivateNativeDevice(deviceId: string, businessId: string, actorId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `UPDATE native_app_devices
        SET revoked_at = NULL, revoked_by = NULL, reactivated_at = now(), reactivated_by = $3
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NOT NULL
      RETURNING id`,
    [deviceId, businessId, actorId],
  );
  if (!rows[0]) throw new NativeDeviceError("device_not_found", 404);
  await auditNativeDevice(businessId, actorId, "native_device.reactivated", deviceId);
}
