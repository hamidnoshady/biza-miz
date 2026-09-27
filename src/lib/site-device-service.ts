/**
 * Owner-facing lifecycle for location-scoped Windows site identities.
 *
 * Device credentials are hash-only. Rotation is deliberately staged: the old
 * credential stays usable during a small grace period, while an encrypted
 * hand-off token is available only to the already-authenticated desktop. The
 * owner never needs to copy a replacement secret and diagnostics never return
 * one.
 */
import { createHash } from "node:crypto";
import { getPool, query } from "./db";
import { generateSyncToken } from "./sync-token";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";

export type SiteDeviceStatus = "pending" | "active" | "disabled" | "revoked";

export interface SiteDeviceView {
  id: string;
  publicId: string;
  locationId: string;
  locationName: string;
  displayName: string;
  status: SiteDeviceStatus;
  createdAt: string;
  /** Successful authentication only — deliberately not presented as sync success. */
  lastSeenAt: string | null;
  revokedAt: string | null;
  credentialRotatedAt: string | null;
  credentialRotationPending: boolean;
  lastSuccessfulPushAt: string | null;
  lastSuccessfulPullAt: string | null;
  lastSyncError: string | null;
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
  credential_rotation_pending: boolean;
  last_successful_push_at: Date | null;
  last_successful_pull_at: Date | null;
  last_sync_error: string | null;
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
    credentialRotationPending: row.credential_rotation_pending,
    lastSuccessfulPushAt: row.last_successful_push_at?.toISOString() ?? null,
    lastSuccessfulPullAt: row.last_successful_pull_at?.toISOString() ?? null,
    lastSyncError: row.last_sync_error,
  };
}

/** Per-device health comes from runs for that device, never a business-wide latest row. */
export async function listSiteDevices(businessId: string): Promise<SiteDeviceView[]> {
  const { rows } = await query<SiteDeviceRow>(
    `SELECT d.id, d.public_id, d.location_id, l.name AS location_name,
            d.display_name, d.status, d.created_at, d.last_seen_at, d.revoked_at,
            credential.latest_rotated_at AS credential_rotated_at,
            COALESCE(credential.has_staged, false) AS credential_rotation_pending,
            runs.last_successful_push_at, runs.last_successful_pull_at, runs.last_sync_error
       FROM site_devices d
       JOIN locations l ON l.id = d.location_id AND l.business_id = d.business_id
       LEFT JOIN LATERAL (
         SELECT max(c.rotated_at) AS latest_rotated_at,
                bool_or(c.state = 'staged' AND c.revoked_at IS NULL) AS has_staged
           FROM site_sync_credentials c
          WHERE c.site_device_id = d.id AND c.business_id = d.business_id
       ) credential ON true
       LEFT JOIN LATERAL (
         SELECT
           max(started_at) FILTER (WHERE direction='push' AND status='ok') AS last_successful_push_at,
           max(started_at) FILTER (WHERE direction='pull' AND status='ok') AS last_successful_pull_at,
           (array_agg(error_code ORDER BY started_at DESC))[1] AS last_sync_error
           FROM sync_runs r WHERE r.business_id=d.business_id AND r.site_device_id=d.id
       ) runs ON true
      WHERE d.business_id = $1
      ORDER BY d.created_at DESC`,
    [businessId],
  );
  return rows.map(toView);
}

export type RotateSiteCredentialResult =
  | { ok: true; device: SiteDeviceView; graceEndsAt: string }
  | { ok: false; error: "device_not_found" | "device_not_active" };

/** Issue a staged credential while keeping the current one valid for 24 hours. */
export async function rotateSiteCredential(
  businessId: string,
  deviceId: string,
  actorId: string | null,
): Promise<RotateSiteCredentialResult> {
  const token = generateSyncToken();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const ciphertext = encryptSecret(token, resolveEncryptionKey(process.env));
  const client = await getPool().connect();
  let graceEndsAt = "";
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: SiteDeviceStatus }>(
      `SELECT status FROM site_devices WHERE id = $1 AND business_id = $2 FOR UPDATE`,
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

    // A second owner click replaces a never-acknowledged staged secret rather
    // than leaving multiple usable hand-offs around.
    await client.query(
      `UPDATE site_sync_credentials SET state='revoked', revoked_at=now(), token_ciphertext=NULL
        WHERE site_device_id=$1 AND business_id=$2 AND state='staged' AND revoked_at IS NULL`,
      [deviceId, businessId],
    );
    const grace = await client.query<{ valid_until: Date }>(
      `UPDATE site_sync_credentials
          SET valid_until = now() + interval '24 hours', rotated_at = now()
        WHERE site_device_id=$1 AND business_id=$2 AND state='active' AND revoked_at IS NULL
        RETURNING valid_until`,
      [deviceId, businessId],
    );
    // A device with no usable primary credential must not get a staged secret
    // that it can never fetch.
    if (!grace.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, error: "device_not_active" };
    }
    graceEndsAt = grace.rows[0].valid_until.toISOString();
    await client.query(
      `INSERT INTO site_sync_credentials
         (site_device_id, business_id, token_hash, token_ciphertext, state)
       VALUES ($1, $2, $3, $4, 'staged')`,
      [deviceId, businessId, tokenHash, ciphertext],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'site_device.credential_rotation_staged', 'site_device', $3, $4)`,
      [businessId, actorId, deviceId, JSON.stringify({ tokenStored: false, graceEndsAt })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const device = (await listSiteDevices(businessId)).find((item) => item.id === deviceId);
  if (!device) return { ok: false, error: "device_not_found" };
  return { ok: true, device, graceEndsAt };
}

/** Returns a staged secret only to the existing active credential, never an owner UI. */
export async function stagedCredentialForDevice(
  businessId: string,
  siteDeviceId: string,
  credentialState: "active" | "staged" | null | undefined,
): Promise<{ token: string } | null> {
  if (credentialState !== "active") return null;
  const { rows } = await query<{ token_ciphertext: string | null }>(
    `SELECT token_ciphertext FROM site_sync_credentials
      WHERE business_id=$1 AND site_device_id=$2 AND state='staged' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [businessId, siteDeviceId],
  );
  const ciphertext = rows[0]?.token_ciphertext;
  return ciphertext ? { token: decryptSecret(ciphertext, resolveEncryptionKey(process.env)) } : null;
}

/** Promote the staged credential and revoke the overlap credential atomically. */
export async function acknowledgeStagedCredential(
  businessId: string,
  siteDeviceId: string,
  credentialId: string | null | undefined,
): Promise<boolean> {
  if (!credentialId) return false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const staged = await client.query<{ id: string }>(
      `SELECT id FROM site_sync_credentials
        WHERE id=$1 AND site_device_id=$2 AND business_id=$3 AND state='staged' AND revoked_at IS NULL
        FOR UPDATE`,
      [credentialId, siteDeviceId, businessId],
    );
    if (!staged.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE site_sync_credentials SET state='revoked', revoked_at=now(), token_ciphertext=NULL
        WHERE site_device_id=$1 AND business_id=$2 AND state='active' AND revoked_at IS NULL`,
      [siteDeviceId, businessId],
    );
    await client.query(
      `UPDATE site_sync_credentials
          SET state='active', acknowledged_at=now(), valid_until=NULL, token_ciphertext=NULL, rotated_at=now()
        WHERE id=$1`,
      [credentialId],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, action, entity, entity_id, payload)
       VALUES ($1, 'site_device.credential_rotation_activated', 'site_device', $2, $3)`,
      [businessId, siteDeviceId, JSON.stringify({ credentialStored: false })],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type RevokeSiteDeviceResult =
  | { ok: true; alreadyRevoked: boolean }
  | { ok: false; error: "device_not_found" };

/** Revoke a device and all of its credentials; historical audit/run rows remain. */
export async function revokeSiteDevice(
  businessId: string,
  deviceId: string,
  actorId: string | null,
): Promise<RevokeSiteDeviceResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: SiteDeviceStatus }>(
      `SELECT status FROM site_devices WHERE id = $1 AND business_id = $2 FOR UPDATE`,
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
      `UPDATE site_devices SET status='revoked', revoked_at=now() WHERE id=$1 AND business_id=$2`,
      [deviceId, businessId],
    );
    await client.query(
      `UPDATE site_sync_credentials SET state='revoked', revoked_at=now(), token_ciphertext=NULL
        WHERE site_device_id=$1 AND business_id=$2 AND revoked_at IS NULL`,
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
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
