/**
 * Owner-facing management of location-scoped Windows site identities.
 *
 * Pairing creates the identity and its first hash-only credential. This module
 * provides the lifecycle that a production credential needs afterwards:
 * listing, one-time rotation, and irreversible revocation. Plaintext tokens
 * exist only in the rotation response and are never written to the database or
 * audit log.
 */
import { createHash } from "node:crypto";
import { getPool, query } from "./db";
import { generateSyncToken } from "./sync-token";

export type SiteDeviceStatus = "pending" | "active" | "disabled" | "revoked";

export interface SiteDeviceView {
  id: string;
  publicId: string;
  locationId: string;
  locationName: string;
  displayName: string;
  status: SiteDeviceStatus;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  credentialRotatedAt: string | null;
}

type SiteDeviceRow = {
  id: string;
  public_id: string;
  location_id: string;
  location_name: string;
  display_name: string;
  status: SiteDeviceStatus;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  credential_rotated_at: Date | null;
};

function toView(row: SiteDeviceRow): SiteDeviceView {
  return {
    id: row.id,
    publicId: row.public_id,
    locationId: row.location_id,
    locationName: row.location_name,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    credentialRotatedAt: row.credential_rotated_at?.toISOString() ?? null,
  };
}

export async function listSiteDevices(businessId: string): Promise<SiteDeviceView[]> {
  const { rows } = await query<SiteDeviceRow>(
    `SELECT d.id, d.public_id, d.location_id, l.name AS location_name,
            d.display_name, d.status, d.created_at, d.last_seen_at, d.revoked_at,
            c.rotated_at AS credential_rotated_at
       FROM site_devices d
       JOIN locations l ON l.id = d.location_id AND l.business_id = d.business_id
       LEFT JOIN site_sync_credentials c
         ON c.site_device_id = d.id AND c.business_id = d.business_id
      WHERE d.business_id = $1
      ORDER BY d.created_at DESC`,
    [businessId],
  );
  return rows.map(toView);
}

export type RotateSiteCredentialResult =
  | { ok: true; token: string; device: SiteDeviceView }
  | { ok: false; error: "device_not_found" | "device_not_active" };

/**
 * Replace a site's credential atomically. The old hash stops resolving as soon
 * as this transaction commits. The returned token cannot be recovered later.
 */
export async function rotateSiteCredential(
  businessId: string,
  deviceId: string,
  actorId: string | null,
): Promise<RotateSiteCredentialResult> {
  const token = generateSyncToken();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: SiteDeviceStatus }>(
      `SELECT status
         FROM site_devices
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [deviceId, businessId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, error: "device_not_found" };
    }
    if (locked.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return { ok: false, error: "device_not_active" };
    }

    await client.query(
      `INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (site_device_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, rotated_at = now()`,
      [deviceId, businessId, tokenHash],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'site_device.credential_rotated', 'site_device', $3, $4)`,
      [businessId, actorId, deviceId, JSON.stringify({ tokenStored: false })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const device = (await listSiteDevices(businessId)).find((item) => item.id === deviceId);
  if (!device) return { ok: false, error: "device_not_found" };
  return { ok: true, token, device };
}

export type RevokeSiteDeviceResult =
  | { ok: true; alreadyRevoked: boolean }
  | { ok: false; error: "device_not_found" };

/**
 * Irreversibly revoke a site and remove its credential hash. Existing bearer
 * tokens fail on the next request; historical device/event rows remain for
 * auditability.
 */
export async function revokeSiteDevice(
  businessId: string,
  deviceId: string,
  actorId: string | null,
): Promise<RevokeSiteDeviceResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: SiteDeviceStatus }>(
      `SELECT status
         FROM site_devices
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [deviceId, businessId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, error: "device_not_found" };
    }
    if (locked.rows[0].status === "revoked") {
      await client.query("ROLLBACK");
      return { ok: true, alreadyRevoked: true };
    }

    await client.query(
      `UPDATE site_devices
          SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND business_id = $2`,
      [deviceId, businessId],
    );
    await client.query(
      `DELETE FROM site_sync_credentials
        WHERE site_device_id = $1 AND business_id = $2`,
      [deviceId, businessId],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id)
       VALUES ($1, $2, 'site_device.revoked', 'site_device', $3)`,
      [businessId, actorId, deviceId],
    );
    await client.query("COMMIT");
    return { ok: true, alreadyRevoked: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
