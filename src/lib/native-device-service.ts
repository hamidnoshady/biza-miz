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

/** Postgres error code for a unique-constraint violation (node-postgres). */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === UNIQUE_VIOLATION);
}

export class NativeDeviceError extends Error {
  status: number;
  /**
   * Set only for `device_revoked` — the id and current
   * `session_generation` of the row the caller just tried (and failed) to
   * register against. `POST /api/native-devices` uses these to bind the
   * *current* session to that (revoked) device before returning the error,
   * so a revoked installation that keeps retrying registration — or simply
   * never looks at the response body, which the bridge-driven registrar
   * never does — still ends up with its session denied on the very next
   * protected request, instead of staying a normal, fully-authenticated
   * session forever because registration never happened to succeed. See
   * `checkNativeDevice` in auth.ts.
   */
  deviceId?: string;
  sessionGeneration?: number;
  constructor(code: string, status = 400, extra?: { deviceId: string; sessionGeneration: number }) {
    super(code);
    this.status = status;
    if (extra) {
      this.deviceId = extra.deviceId;
      this.sessionGeneration = extra.sessionGeneration;
    }
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
  /**
   * `native_app_devices.session_generation` — not a secret, just the counter
   * `checkNativeDevice` compares a session's stamped generation against (see
   * `SessionPayload.nativeDeviceGeneration`). Exposed on the type mainly so
   * `POST /api/native-devices` can stamp a freshly signed session with it;
   * the admin/self device lists have no particular use for it but there is
   * nothing sensitive about a monotonic counter either.
   */
  sessionGeneration: number;
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
  session_generation: number;
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
    sessionGeneration: row.session_generation,
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

const RETURNING_COLUMNS =
  "id, business_id, user_id, platform, app_environment, app_version_name, app_version_code, " +
  "bridge_version, registered_at, last_seen_at, revoked_at, reactivated_at, session_generation";

/** Bounded retries for the brand-new-installation race `registerNativeDevice` handles below. */
const MAX_REGISTER_ATTEMPTS = 3;

/**
 * Registers (or re-registers) the caller's own Android installation.
 *
 * Idempotent on purpose — the web app calls this after every login and
 * business selection, not only on first launch — but it never revives a
 * revoked row: once an owner/admin has revoked an installation, re-running
 * this same call (even from the same member, even after a fresh login)
 * fails with `device_revoked` until `reactivateNativeDevice` runs. That is
 * the "requires an authorized owner/admin action" half of the owner
 * decision; the "followed by fresh authentication" half is enforced by
 * `session_generation` (see `checkNativeDevice`), not by this function.
 *
 * Retries up to `MAX_REGISTER_ATTEMPTS` times on a unique-constraint
 * violation: two concurrent first-registrations of the same brand-new
 * `installId` both run `SELECT ... FOR UPDATE` before either has inserted
 * anything, so neither finds a row to lock, and both fall into the `INSERT`
 * branch — the loser's `INSERT` fails `native_app_devices_business_install
 * _unique`, not because of a logic bug but because there was nothing to
 * lock yet. Retrying re-runs the `SELECT`, which now finds the winner's
 * committed row and takes the ordinary `UPDATE` (re-register) branch
 * instead — the same observable result the loser would have gotten had its
 * request simply arrived a moment later.
 */
export async function registerNativeDevice(
  businessId: string,
  userId: string,
  input: RegisterNativeDeviceInput,
): Promise<{ device: NativeDevice; created: boolean }> {
  for (let attempt = 1; attempt <= MAX_REGISTER_ATTEMPTS; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: existingRows } = await client.query<{
        id: string;
        user_id: string;
        revoked_at: Date | null;
        session_generation: number;
      }>(
        `SELECT id, user_id, revoked_at, session_generation FROM native_app_devices
          WHERE business_id = $1 AND install_id = $2
          FOR UPDATE`,
        [businessId, input.installId],
      );
      const existing = existingRows[0];

      if (existing?.revoked_at) {
        await client.query("ROLLBACK");
        throw new NativeDeviceError("device_revoked", 409, {
          deviceId: existing.id,
          sessionGeneration: existing.session_generation,
        });
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
            RETURNING ${RETURNING_COLUMNS}`,
          [existing.id, businessId, input.appEnvironment, input.appVersionName, input.appVersionCode, input.bridgeVersion],
        );
        row = rows[0];
      } else {
        created = true;
        try {
          const { rows } = await client.query<NativeDeviceRow>(
            `INSERT INTO native_app_devices
               (business_id, user_id, app_environment, install_id, app_version_name, app_version_code, bridge_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING ${RETURNING_COLUMNS}`,
            [businessId, userId, input.appEnvironment, input.installId, input.appVersionName, input.appVersionCode, input.bridgeVersion],
          );
          row = rows[0];
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          if (isUniqueViolation(err) && attempt < MAX_REGISTER_ATTEMPTS) {
            // `continue` unwinds out of this try block, running the outer
            // `finally` (which releases `client`) without reaching the outer
            // `catch` — no exception was thrown, so the loop simply moves on
            // to a fresh connection and attempt.
            continue;
          }
          throw err;
        }
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
  // Unreachable: every loop iteration either returns, throws, or (on a
  // unique-violation retry) `continue`s — and the last allowed attempt no
  // longer satisfies `attempt < MAX_REGISTER_ATTEMPTS`, so it always throws
  // instead of looping again.
  throw new NativeDeviceError("device_registration_conflict", 409);
}

/** The caller's own registered installations, newest first. */
export async function listNativeDevicesForUser(businessId: string, userId: string): Promise<NativeDevice[]> {
  const { rows } = await query<NativeDeviceRow>(
    `SELECT ${RETURNING_COLUMNS}
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
            d.revoked_at, d.reactivated_at, d.session_generation
       FROM native_app_devices d
       LEFT JOIN users u ON u.id = d.user_id AND u.business_id = d.business_id
      WHERE d.business_id = $1
      ORDER BY d.revoked_at IS NULL DESC, d.registered_at DESC`,
    [businessId],
  );
  return rows.map(toDevice);
}

/**
 * A member revoking their own installation — lost or stolen phone, logging
 * it out everywhere. Bumps `session_generation` for the same reason
 * `reactivateNativeDevice` below does: it is what `checkNativeDevice`
 * actually keys its denial on, not `revoked_at` alone (see migration 0217).
 */
export async function revokeOwnNativeDevice(deviceId: string, businessId: string, userId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `UPDATE native_app_devices
        SET revoked_at = now(), revoked_by = $3, session_generation = session_generation + 1
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
        SET revoked_at = now(), revoked_by = $3, session_generation = session_generation + 1
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [deviceId, businessId, actorId],
  );
  if (!rows[0]) throw new NativeDeviceError("device_not_found", 404);
  await auditNativeDevice(businessId, actorId, "native_device.revoked_admin", deviceId);
}

/**
 * Lets a previously revoked installation register again. Does not, by
 * itself, restore any access: it also bumps `session_generation`, which is
 * what forces the "followed by fresh authentication" half of the owner
 * decision to actually hold — without it, a session JWT minted *before* the
 * device was revoked (one `checkNativeDevice` never got a chance to see
 * mid-revocation, e.g. a backgrounded tab) would start resolving again the
 * moment `revoked_at` goes back to NULL, with no login in between. Bumping
 * the generation here means that stale token's stamped
 * `nativeDeviceGeneration` no longer matches the row no matter what
 * `revoked_at` says, so only a session minted by a *new* call to
 * `registerNativeDevice` — which only a freshly authenticated member can
 * make — resolves again. See migration 0217.
 */
export async function reactivateNativeDevice(deviceId: string, businessId: string, actorId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `UPDATE native_app_devices
        SET revoked_at = NULL, revoked_by = NULL, reactivated_at = now(), reactivated_by = $3,
            session_generation = session_generation + 1
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NOT NULL
      RETURNING id`,
    [deviceId, businessId, actorId],
  );
  if (!rows[0]) throw new NativeDeviceError("device_not_found", 404);
  await auditNativeDevice(businessId, actorId, "native_device.reactivated", deviceId);
}
