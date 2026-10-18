/**
 * Issue #984 — verified Windows installations for support scoping.
 *
 * A `support_installations` row binds one `site_devices` identity (the
 * canonical verified Windows site identity) to the support surface, with a
 * generation counter for fencing: tokens, requests and sessions name the
 * generation they were issued for, and a revoked installation bumps the
 * generation so outstanding authorizations fail closed. Enrollment here never
 * activates Hybrid transaction sync and never bypasses #974's activation
 * gates — it only scopes support evidence and assistance to this install.
 */
import { query } from "../db";

export type SupportEnrollmentState = "pending" | "active" | "disabled" | "revoked";

export interface SupportInstallation {
  id: string;
  businessId: string;
  locationId: string | null;
  locationName: string | null;
  /** Null for support-only local installs, which have no site_devices row. */
  siteDeviceId: string | null;
  generation: number;
  displayName: string;
  platform: "windows";
  osBuild: string | null;
  mainVersion: string | null;
  companionVersion: string | null;
  schemaCompat: string | null;
  enrollmentState: SupportEnrollmentState;
  /** MeshCentral agent node id reported by the companion; null until linked. */
  meshNodeId: string | null;
  capabilities: Record<string, unknown>;
  lastContactAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstallationRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  location_name: string | null;
  site_device_id: string | null;
  generation: number;
  display_name: string;
  platform: "windows";
  os_build: string | null;
  main_version: string | null;
  companion_version: string | null;
  schema_compat: string | null;
  enrollment_state: SupportEnrollmentState;
  mesh_node_id: string | null;
  capabilities: Record<string, unknown>;
  last_contact_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

const INSTALLATION_SELECT = `
  SELECT i.id::text AS id, i.business_id::text AS business_id,
         i.location_id::text AS location_id, l.name AS location_name,
         i.site_device_id::text AS site_device_id, i.generation,
         i.display_name, i.platform, i.os_build, i.main_version,
         i.companion_version, i.schema_compat, i.enrollment_state, i.mesh_node_id,
         i.capabilities, i.last_contact_at, i.revoked_at, i.created_at, i.updated_at
    FROM support_installations i
    LEFT JOIN locations l ON l.id = i.location_id
`;

function toInstallation(row: InstallationRow): SupportInstallation {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: row.location_name,
    siteDeviceId: row.site_device_id,
    generation: row.generation,
    displayName: row.display_name,
    platform: row.platform,
    osBuild: row.os_build,
    mainVersion: row.main_version,
    companionVersion: row.companion_version,
    schemaCompat: row.schema_compat,
    enrollmentState: row.enrollment_state,
    meshNodeId: row.mesh_node_id,
    capabilities: row.capabilities ?? {},
    lastContactAt: row.last_contact_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every verified installation of a business, newest contact first. */
export async function listInstallations(businessId: string): Promise<SupportInstallation[]> {
  const { rows } = await query<InstallationRow>(
    `${INSTALLATION_SELECT} WHERE i.business_id = $1 ORDER BY i.last_contact_at DESC NULLS LAST, i.created_at DESC`,
    [businessId],
  );
  return rows.map(toInstallation);
}

/** One installation, or null when it is not this business's. */
export async function getInstallation(
  businessId: string,
  installationId: string,
): Promise<SupportInstallation | null> {
  const { rows } = await query<InstallationRow>(
    `${INSTALLATION_SELECT} WHERE i.id = $1::uuid AND i.business_id = $2`,
    [installationId, businessId],
  );
  return rows[0] ? toInstallation(rows[0]) : null;
}

/** The installation bound to a site device, if the business enrolled it. */
export async function getInstallationForSiteDevice(
  businessId: string,
  siteDeviceId: string,
): Promise<SupportInstallation | null> {
  const { rows } = await query<InstallationRow>(
    `${INSTALLATION_SELECT} WHERE i.business_id = $1 AND i.site_device_id = $2::uuid`,
    [businessId, siteDeviceId],
  );
  return rows[0] ? toInstallation(rows[0]) : null;
}

export type EnsureInstallationResult =
  | { ok: true; installation: SupportInstallation; created: boolean }
  | { ok: false; error: "device_not_found" | "device_not_active" };

/**
 * Binds a verified, active site device to the support surface (idempotent:
 * re-enrolling returns the existing row). Only an *active* device enrolls —
 * a disabled/revoked device, or a device id from another business, is
 * refused rather than trusted.
 */
export async function ensureInstallation(
  businessId: string,
  siteDeviceId: string,
  attrs: {
    displayName?: string;
    osBuild?: string | null;
    mainVersion?: string | null;
    companionVersion?: string | null;
    schemaCompat?: string | null;
    capabilities?: Record<string, unknown>;
  } = {},
): Promise<EnsureInstallationResult> {
  const { rows: devices } = await query<{ status: string; location_id: string }>(
    `SELECT status::text AS status, location_id::text AS location_id
       FROM site_devices WHERE id = $1::uuid AND business_id = $2`,
    [siteDeviceId, businessId],
  );
  const device = devices[0];
  if (!device) return { ok: false, error: "device_not_found" };
  if (device.status !== "active") return { ok: false, error: "device_not_active" };

  const existing = await getInstallationForSiteDevice(businessId, siteDeviceId);
  if (existing) return { ok: true, installation: existing, created: false };

  const { rows } = await query<InstallationRow>(
    `INSERT INTO support_installations
       (business_id, location_id, site_device_id, display_name, os_build,
        main_version, companion_version, schema_compat, capabilities, enrollment_state)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'active')
     RETURNING id::text AS id, business_id::text AS business_id,
       location_id::text AS location_id, NULL::text AS location_name,
       site_device_id::text AS site_device_id, generation, display_name,
       platform, os_build, main_version, companion_version, schema_compat,
       enrollment_state, capabilities, last_contact_at, revoked_at, created_at, updated_at`,
    [
      businessId,
      device.location_id,
      siteDeviceId,
      (attrs.displayName ?? "").slice(0, 120),
      attrs.osBuild ?? null,
      attrs.mainVersion ?? null,
      attrs.companionVersion ?? null,
      attrs.schemaCompat ?? null,
      JSON.stringify(attrs.capabilities ?? {}),
    ],
  );
  return { ok: true, installation: toInstallation(rows[0]), created: true };
}

/** Records versions/capabilities observed from a verified companion contact. */
export async function recordInstallationContact(
  businessId: string,
  installationId: string,
  attrs: {
    osBuild?: string | null;
    mainVersion?: string | null;
    companionVersion?: string | null;
    schemaCompat?: string | null;
    /** MeshCentral agent node id — links the installation for remote assist. */
    meshNodeId?: string | null;
    capabilities?: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    `UPDATE support_installations
        SET last_contact_at = now(), updated_at = now(),
            os_build = COALESCE($3, os_build),
            main_version = COALESCE($4, main_version),
            companion_version = COALESCE($5, companion_version),
            schema_compat = COALESCE($6, schema_compat),
            mesh_node_id = COALESCE($7, mesh_node_id),
            -- Capabilities merge shallowly: each contact reports only what
            -- it knows (e.g. the Mesh agent presence probe) and must never
            -- wipe keys reported by other contacts.
            capabilities = CASE WHEN $8::jsonb IS NULL THEN capabilities
              ELSE COALESCE(capabilities, '{}'::jsonb) || $8::jsonb END
      WHERE id = $1::uuid AND business_id = $2`,
    [
      installationId,
      businessId,
      attrs.osBuild ?? null,
      attrs.mainVersion ?? null,
      attrs.companionVersion ?? null,
      attrs.schemaCompat ?? null,
      attrs.meshNodeId ?? null,
      attrs.capabilities ? JSON.stringify(attrs.capabilities) : null,
    ],
  );
}

export type RevokeInstallationResult =
  | { ok: true; alreadyRevoked: boolean }
  | { ok: false; error: "installation_not_found" };

/**
 * Revokes an installation and bumps its generation: outstanding tokens,
 * requests and sessions naming the older generation fail closed on their
 * next check, and every support-device credential is revoked with it.
 * History rows stay for audit.
 */
export async function revokeInstallation(
  businessId: string,
  installationId: string,
): Promise<RevokeInstallationResult> {
  const { rows } = await query<{ enrollment_state: SupportEnrollmentState }>(
    `UPDATE support_installations
        SET enrollment_state = 'revoked', revoked_at = now(),
            generation = generation + 1, updated_at = now()
      WHERE id = $1::uuid AND business_id = $2
      RETURNING enrollment_state`,
    [installationId, businessId],
  );
  if (!rows[0]) return { ok: false, error: "installation_not_found" };
  const { revokeSupportDeviceCredentials } = await import("./device-credentials");
  await revokeSupportDeviceCredentials(businessId, installationId);
  return { ok: true, alreadyRevoked: false };
}

/**
 * Whether an authorization naming `generation` still matches the live
 * installation. Generation drift, a non-active enrollment, or a missing row
 * all fail closed.
 */
export async function installationGenerationValid(
  businessId: string,
  installationId: string,
  generation: number,
): Promise<boolean> {
  const installation = await getInstallation(businessId, installationId);
  if (!installation) return false;
  if (installation.enrollmentState !== "active") return false;
  return installation.generation === generation;
}
