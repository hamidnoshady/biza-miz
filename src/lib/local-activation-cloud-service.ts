/**
 * Issue #974 — Cloud-side control plane for Full Offline (`local`) desktop
 * installations:
 *   - One-time `OFL1-XXXX-XXXX-XXXX` enrollment token issuance & revocation
 *   - Crash-safe, idempotent two-phase installation enrollment & acknowledgement
 *   - Scoped `LOC1-…` installation bearer authentication & staged 24h rotation
 *   - Cloud-authoritative business metadata/policy/entitlement bundle & Ed25519 lease
 *   - Online-only authenticated Support tickets & Bug Reports (never enabling Hybrid sync)
 */
import { createHash } from "node:crypto";
import { query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";
import {
  LOCAL_ACTIVATION_PROTOCOL_VERSION,
  redactLocalSupportDiagnostics,
  redactSensitiveText,
  type ConfirmedCloudDenialCode,
} from "./local-activation-contract";
import {
  generateLocalEnrollmentCode,
  generateLocalInstallationToken,
  hashLocalEnrollmentCode,
  hashLocalInstallationToken,
  LOCAL_ENROLLMENT_CODE_TTL_HOURS,
  LOCAL_ENROLLMENT_SESSION_TTL_MINUTES,
  signOfflineLease,
  type SignedOfflineLease,
} from "./local-activation-crypto";
import { SETTING_KEYS } from "./settings";
import {
  isMemberSettableStatus,
  isTicketCategory,
  isTicketPriority,
} from "./support-tickets";

/** Online presence window for Full Offline outbound polls (seconds). */
export const LOCAL_INSTALLATION_ONLINE_WINDOW_MS = 45_000;

export interface LocalEnrollmentCodeSummary {
  id: string;
  locationId: string;
  locationName: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state:
    | "valid"
    | "code_pending_activation"
    | "code_expired"
    | "code_already_redeemed"
    | "code_revoked";
}

export interface LocalInstallationView {
  id: string;
  publicId: string;
  locationId: string;
  locationName: string;
  installationIdMasked: string;
  displayName: string;
  status: "pending" | "active" | "disabled" | "revoked";
  onlineNow: boolean;
  appVersion: string | null;
  schemaVersion: string | null;
  lastSeenAt: string | null;
  lastValidatedAt: string | null;
  credentialRotatedAt: string | null;
  credentialRotationPending: boolean;
  offlineLeaseDays: number | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CloudAuthoritativeBusinessBundle {
  protocol: typeof LOCAL_ACTIVATION_PROTOCOL_VERSION;
  businessId: string;
  name: string;
  slug: string;
  subdomain: string;
  industry: string;
  status: string;
  plan: string;
  supportAccessPolicy: string;
  location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
  };
  features: Array<{ flagKey: string; enabled: boolean }>;
  appAvailability: Array<{ appKey: string; state: string; note: string | null }>;
  policy: {
    policyVersion: number;
    entitlementVersion: number;
    enforceOfflineLease: boolean;
    offlineLeaseDays: number | null;
    minSupportedVersion: string | null;
    requireExplicitLocalOwnerSupportApproval: boolean;
  };
  profileMetadata: Record<string, unknown>;
  revision: string;
  digest: string;
}

function maskInstallationId(raw: string): string {
  const clean = raw.trim();
  if (clean.length <= 10) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

export async function listLocalEnrollmentCodes(
  businessId: string,
): Promise<LocalEnrollmentCodeSummary[]> {
  const { rows } = await query<{
    id: string;
    location_id: string;
    location_name: string;
    expires_at: Date;
    redeemed_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
    has_pending_session: boolean;
  }>(
    `SELECT c.id, c.location_id, l.name AS location_name,
            c.expires_at, c.redeemed_at, c.revoked_at, c.created_at,
            EXISTS (
              SELECT 1 FROM local_installations li
               JOIN local_installation_credentials cr
                 ON cr.local_installation_id = li.id AND cr.business_id = li.business_id
              WHERE li.enrollment_code_id = c.id
                AND li.business_id = c.business_id
                AND cr.state = 'pending'
                AND cr.revoked_at IS NULL
                AND (cr.session_expires_at IS NULL OR cr.session_expires_at > now())
            ) AS has_pending_session
       FROM local_enrollment_codes c
       JOIN locations l ON l.id = c.location_id AND l.business_id = c.business_id
      WHERE c.business_id = $1
      ORDER BY c.created_at DESC
      LIMIT 25`,
    [businessId],
  );
  const now = Date.now();
  return rows.map((row) => {
    let state: LocalEnrollmentCodeSummary["state"] = "valid";
    if (row.redeemed_at) state = "code_already_redeemed";
    else if (row.revoked_at) state = "code_revoked";
    else if (row.expires_at.getTime() <= now) state = "code_expired";
    else if (row.has_pending_session) state = "code_pending_activation";
    return {
      id: row.id,
      locationId: row.location_id,
      locationName: row.location_name,
      expiresAt: row.expires_at.toISOString(),
      redeemedAt: row.redeemed_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      state,
    };
  });
}

export async function issueLocalEnrollmentCode(
  businessId: string,
  locationId: string,
  actor: { userId?: string | null; adminId?: string | null } = {},
): Promise<
  | { ok: true; code: string; summary: LocalEnrollmentCodeSummary }
  | { ok: false; error: "invalid_location" }
> {
  const code = generateLocalEnrollmentCode();
  const codeHash = hashLocalEnrollmentCode(code);
  return withTenantTransaction(businessId, async () => {
    const loc = await query<{ id: string; name: string }>(
      `SELECT id, name FROM locations WHERE id = $1 AND business_id = $2`,
      [locationId, businessId],
    );
    if (!loc.rows[0]) return { ok: false, error: "invalid_location" } as const;

    // Revoke any unredeemed live token for the same branch before issuing a replacement.
    await query(
      `UPDATE local_enrollment_codes
          SET revoked_at = now()
        WHERE business_id = $1 AND location_id = $2
          AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [businessId, locationId],
    );

    const { rows } = await query<{
      id: string;
      expires_at: Date;
      created_at: Date;
    }>(
      `INSERT INTO local_enrollment_codes
         (business_id, location_id, code_hash, issued_by_user_id, issued_by_admin_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6::int || ' hours')::interval)
       RETURNING id, expires_at, created_at`,
      [
        businessId,
        locationId,
        codeHash,
        actor.userId ?? null,
        actor.adminId ?? null,
        LOCAL_ENROLLMENT_CODE_TTL_HOURS,
      ],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_activation.code_issued', 'local_enrollment_code', $3, $4)`,
      [
        businessId,
        actor.userId ?? null,
        rows[0].id,
        JSON.stringify({
          locationId,
          issuedByAdminId: actor.adminId ?? null,
          ttlHours: LOCAL_ENROLLMENT_CODE_TTL_HOURS,
        }),
      ],
    );
    return {
      ok: true,
      code,
      summary: {
        id: rows[0].id,
        locationId,
        locationName: loc.rows[0].name,
        expiresAt: rows[0].expires_at.toISOString(),
        redeemedAt: null,
        revokedAt: null,
        createdAt: rows[0].created_at.toISOString(),
        state: "valid",
      },
    } as const;
  });
}

export async function revokeLocalEnrollmentCode(
  businessId: string,
  codeId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE local_enrollment_codes
        SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`,
    [codeId, businessId],
  );
  return Boolean(rowCount);
}

export async function listLocalInstallations(
  businessId: string,
): Promise<LocalInstallationView[]> {
  const { rows } = await query<{
    id: string;
    public_id: string;
    location_id: string;
    location_name: string;
    installation_id: string;
    display_name: string;
    status: "pending" | "active" | "disabled" | "revoked";
    app_version: string | null;
    schema_version: string | null;
    last_seen_at: Date | null;
    last_validated_at: Date | null;
    offline_lease_days: number | null;
    revoked_at: Date | null;
    created_at: Date;
    credential_rotated_at: Date | null;
    credential_rotation_pending: boolean;
  }>(
    `SELECT d.id, d.public_id, d.location_id, l.name AS location_name,
            d.installation_id, d.display_name, d.status, d.app_version, d.schema_version,
            d.last_seen_at, d.last_validated_at, d.offline_lease_days, d.revoked_at, d.created_at,
            cred.latest_rotated_at AS credential_rotated_at,
            COALESCE(cred.has_staged, false) AS credential_rotation_pending
       FROM local_installations d
       JOIN locations l ON l.id = d.location_id AND l.business_id = d.business_id
       LEFT JOIN LATERAL (
         SELECT max(c.rotated_at) AS latest_rotated_at,
                bool_or(c.state = 'staged' AND c.revoked_at IS NULL) AS has_staged
           FROM local_installation_credentials c
          WHERE c.local_installation_id = d.id AND c.business_id = d.business_id
       ) cred ON true
      WHERE d.business_id = $1
      ORDER BY d.created_at DESC`,
    [businessId],
  );
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    locationId: row.location_id,
    locationName: row.location_name,
    installationIdMasked: maskInstallationId(row.installation_id),
    displayName: row.display_name,
    status: row.status,
    onlineNow:
      row.status === "active" &&
      row.last_seen_at !== null &&
      now - row.last_seen_at.getTime() <= LOCAL_INSTALLATION_ONLINE_WINDOW_MS,
    appVersion: row.app_version,
    schemaVersion: row.schema_version,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    lastValidatedAt: row.last_validated_at?.toISOString() ?? null,
    credentialRotatedAt: row.credential_rotated_at?.toISOString() ?? null,
    credentialRotationPending: row.credential_rotation_pending,
    offlineLeaseDays: row.offline_lease_days,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function rotateLocalInstallationCredential(
  businessId: string,
  localInstallationId: string,
  actorUserId: string | null,
): Promise<
  | { ok: true; graceEndsAt: string }
  | { ok: false; error: "device_not_found" | "device_not_active" }
> {
  const token = generateLocalInstallationToken();
  const tokenHash = hashLocalInstallationToken(token);
  const ciphertext = encryptSecret(token, resolveEncryptionKey(process.env));
  return withTenantTransaction(businessId, async () => {
    const locked = await query<{ status: string }>(
      `SELECT status FROM local_installations WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [localInstallationId, businessId],
    );
    if (!locked.rows[0]) return { ok: false, error: "device_not_found" } as const;
    if (locked.rows[0].status !== "active") {
      return { ok: false, error: "device_not_active" } as const;
    }

    await query(
      `UPDATE local_installation_credentials
          SET state = 'revoked', revoked_at = now(), token_ciphertext = NULL
        WHERE local_installation_id = $1 AND business_id = $2
          AND state = 'staged' AND revoked_at IS NULL`,
      [localInstallationId, businessId],
    );
    const grace = await query<{ valid_until: Date }>(
      `UPDATE local_installation_credentials
          SET valid_until = now() + interval '24 hours', rotated_at = now()
        WHERE local_installation_id = $1 AND business_id = $2
          AND state = 'active' AND revoked_at IS NULL
        RETURNING valid_until`,
      [localInstallationId, businessId],
    );
    if (!grace.rows[0]) return { ok: false, error: "device_not_active" } as const;

    await query(
      `INSERT INTO local_installation_credentials
         (local_installation_id, business_id, token_hash, token_ciphertext, state)
       VALUES ($1, $2, $3, $4, 'staged')`,
      [localInstallationId, businessId, tokenHash, ciphertext],
    );
    const graceEndsAt = grace.rows[0].valid_until.toISOString();
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_activation.credential_rotation_staged', 'local_installation', $3, $4)`,
      [businessId, actorUserId, localInstallationId, JSON.stringify({ graceEndsAt })],
    );
    return { ok: true, graceEndsAt } as const;
  });
}

export async function revokeLocalInstallation(
  businessId: string,
  localInstallationId: string,
  actorUserId: string | null,
  reason = "revoked_by_admin_or_owner",
): Promise<{ ok: true; alreadyRevoked: boolean } | { ok: false; error: "device_not_found" }> {
  return withTenantTransaction(businessId, async () => {
    const found = await query<{ status: string }>(
      `SELECT status FROM local_installations WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [localInstallationId, businessId],
    );
    if (!found.rows[0]) return { ok: false, error: "device_not_found" } as const;
    const alreadyRevoked = found.rows[0].status === "revoked";
    await query(
      `UPDATE local_installation_credentials
          SET state = 'revoked', revoked_at = COALESCE(revoked_at, now()), token_ciphertext = NULL
        WHERE local_installation_id = $1 AND business_id = $2 AND revoked_at IS NULL`,
      [localInstallationId, businessId],
    );
    await query(
      `UPDATE local_installations
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
              revoked_reason = $3, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [localInstallationId, businessId, reason],
    );
    // Terminate any open remote support session for this installation immediately.
    await query(
      `UPDATE local_support_sessions
          SET state = 'revoked', ended_at = now(), end_reason = 'installation_revoked', updated_at = now()
        WHERE local_installation_id = $1 AND business_id = $2
          AND state IN ('pending_owner_consent', 'active', 'paused_disconnected')`,
      [localInstallationId, businessId],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_activation.installation_revoked', 'local_installation', $3, $4)`,
      [businessId, actorUserId, localInstallationId, JSON.stringify({ alreadyRevoked, reason })],
    );
    return { ok: true, alreadyRevoked } as const;
  });
}

export async function buildCloudAuthoritativeBusinessBundle(
  businessId: string,
  locationId: string,
  offlineLeaseDays?: number | null,
): Promise<CloudAuthoritativeBusinessBundle | null> {
  const [bizRes, locRes, featRes, appRes, profileSettingRes] = await Promise.all([
    query<{
      id: string;
      name: string;
      slug: string;
      subdomain: string;
      industry: string;
      status: string;
      plan: string;
      support_access_policy: string;
      updated_at: Date;
    }>(
      `SELECT id, name, slug::text AS slug, subdomain::text AS subdomain,
              industry, status::text AS status, plan, support_access_policy, updated_at
         FROM businesses WHERE id = $1`,
      [businessId],
    ),
    query<{
      id: string;
      name: string;
      address: string | null;
      phone: string | null;
    }>(
      `SELECT id, name, address, phone FROM locations WHERE id = $1 AND business_id = $2`,
      [locationId, businessId],
    ),
    query<{ flag_key: string; enabled: boolean }>(
      `SELECT flag_key, enabled FROM business_features WHERE business_id = $1 ORDER BY flag_key`,
      [businessId],
    ),
    query<{ app_key: string; state: string; note: string | null }>(
      `SELECT app_key, state, note FROM business_app_availability WHERE business_id = $1 ORDER BY app_key`,
      [businessId],
    ),
    query<{ value: Record<string, unknown> }>(
      `SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
      [businessId, SETTING_KEYS.localCloudBusinessProfile],
    ),
  ]);

  const biz = bizRes.rows[0];
  const loc = locRes.rows[0];
  if (!biz || !loc) return null;

  const features = featRes.rows.map((r) => ({ flagKey: r.flag_key, enabled: r.enabled }));
  const appAvailability = appRes.rows.map((r) => ({
    appKey: r.app_key,
    state: r.state,
    note: r.note,
  }));
  const profileMetadata = profileSettingRes.rows[0]?.value ?? {};
  const leaseDays = offlineLeaseDays ?? null;
  const policy = {
    policyVersion: 1,
    entitlementVersion: 1,
    enforceOfflineLease: leaseDays !== null && leaseDays > 0,
    offlineLeaseDays: leaseDays,
    minSupportedVersion: null,
    requireExplicitLocalOwnerSupportApproval: true,
  };

  const digestInput = JSON.stringify({
    name: biz.name,
    slug: biz.slug,
    subdomain: biz.subdomain,
    industry: biz.industry,
    status: biz.status,
    plan: biz.plan,
    supportAccessPolicy: biz.support_access_policy,
    location: loc,
    features,
    appAvailability,
    policy,
    profileMetadata,
  });
  const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
  const revision = `${biz.updated_at.toISOString()}:${digest.slice(0, 12)}`;

  return {
    protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
    businessId: biz.id,
    name: biz.name,
    slug: biz.slug,
    subdomain: biz.subdomain,
    industry: biz.industry,
    status: biz.status,
    plan: biz.plan,
    supportAccessPolicy: biz.support_access_policy,
    location: loc,
    features,
    appAvailability,
    policy,
    profileMetadata,
    revision,
    digest,
  };
}

function mapBusinessStatusDenial(status: string): ConfirmedCloudDenialCode | null {
  if (status === "active") return null;
  if (status === "suspended") return "business_suspended";
  if (status === "archived") return "business_archived";
  return "business_disabled";
}

export type CloudEnrollmentCheckResult =
  | {
      ok: true;
      businessBundle: CloudAuthoritativeBusinessBundle;
    }
  | {
      ok: false;
      httpStatus: number;
      code:
        | "code_not_found"
        | "code_expired"
        | "code_revoked"
        | "code_already_redeemed"
        | ConfirmedCloudDenialCode;
    };

export async function verifyLocalEnrollmentTokenOnCloud(input: {
  code: string;
  installationId: string;
  expectedBusinessId?: string | null;
}): Promise<CloudEnrollmentCheckResult> {
  const codeHash = hashLocalEnrollmentCode(input.code);
  const installationId = input.installationId.trim();

  const resolved = await withoutTenantScope("local-activation-enroll", async () => {
    const [codeRow, existingBinding] = await Promise.all([
      query<{
        id: string;
        business_id: string;
        location_id: string;
        expires_at: Date;
        redeemed_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at
           FROM local_enrollment_codes WHERE code_hash = $1`,
        [codeHash],
      ),
      query<{ business_id: string }>(
        `SELECT business_id FROM local_installations
          WHERE installation_id = $1 AND status <> 'revoked' LIMIT 1`,
        [installationId],
      ),
    ]);
    return { code: codeRow.rows[0] ?? null, bound: existingBinding.rows[0] ?? null };
  });

  if (!resolved.code) {
    return { ok: false, httpStatus: 404, code: "code_not_found" };
  }
  if (
    resolved.bound &&
    resolved.bound.business_id !== resolved.code.business_id
  ) {
    return { ok: false, httpStatus: 403, code: "installation_mismatch" };
  }
  if (
    input.expectedBusinessId &&
    input.expectedBusinessId.trim() !== resolved.code.business_id
  ) {
    return { ok: false, httpStatus: 403, code: "business_mismatch" };
  }
  if (resolved.code.revoked_at) {
    return { ok: false, httpStatus: 410, code: "code_revoked" };
  }
  if (resolved.code.expires_at.getTime() <= Date.now()) {
    return { ok: false, httpStatus: 410, code: "code_expired" };
  }

  return withTenant(resolved.code.business_id, async () => {
    if (resolved.code!.redeemed_at) {
      return { ok: false, httpStatus: 409, code: "code_already_redeemed" } as const;
    }
    const bundle = await buildCloudAuthoritativeBusinessBundle(
      resolved.code!.business_id,
      resolved.code!.location_id,
    );
    if (!bundle) {
      return { ok: false, httpStatus: 404, code: "code_not_found" } as const;
    }
    const statusDenial = mapBusinessStatusDenial(bundle.status);
    if (statusDenial) {
      return { ok: false, httpStatus: 403, code: statusDenial } as const;
    }
    return { ok: true, businessBundle: bundle } as const;
  });
}

export type CloudEnrollCommitResult =
  | {
      ok: true;
      protocol: typeof LOCAL_ACTIVATION_PROTOCOL_VERSION;
      installationPublicId: string;
      credentialId: string;
      token: string;
      lease: SignedOfflineLease;
      businessBundle: CloudAuthoritativeBusinessBundle;
      resumed: boolean;
    }
  | {
      ok: false;
      httpStatus: number;
      code:
        | "code_not_found"
        | "code_expired"
        | "code_revoked"
        | "code_already_redeemed"
        | ConfirmedCloudDenialCode;
    };

export async function enrollLocalInstallationOnCloud(input: {
  code: string;
  installationId: string;
  deviceName?: string | null;
  appVersion?: string | null;
  schemaVersion?: string | null;
  clientIp?: string | null;
  expectedBusinessId?: string | null;
}): Promise<CloudEnrollCommitResult> {
  const codeHash = hashLocalEnrollmentCode(input.code);
  const installationId = input.installationId.trim();
  const displayName =
    (input.deviceName?.trim() || "Windows Bizamiz (Full Offline)").slice(0, 120);

  const preflight = await withoutTenantScope("local-activation-enroll", async () => {
    const [codeRow, existingBinding] = await Promise.all([
      query<{ id: string; business_id: string }>(
        `SELECT id, business_id FROM local_enrollment_codes WHERE code_hash = $1`,
        [codeHash],
      ),
      query<{ id: string; business_id: string }>(
        `SELECT id, business_id FROM local_installations
          WHERE installation_id = $1 AND status <> 'revoked' LIMIT 1`,
        [installationId],
      ),
    ]);
    return { code: codeRow.rows[0] ?? null, bound: existingBinding.rows[0] ?? null };
  });

  if (!preflight.code) {
    return { ok: false, httpStatus: 404, code: "code_not_found" };
  }
  if (preflight.bound && preflight.bound.business_id !== preflight.code.business_id) {
    return { ok: false, httpStatus: 403, code: "installation_mismatch" };
  }
  if (input.expectedBusinessId && input.expectedBusinessId.trim() !== preflight.code.business_id) {
    return { ok: false, httpStatus: 403, code: "business_mismatch" };
  }

  return withTenantTransaction(preflight.code.business_id, async () => {
    const lockedCode = await query<{
      id: string;
      business_id: string;
      location_id: string;
      expires_at: Date;
      redeemed_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at
         FROM local_enrollment_codes
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [preflight.code!.id, preflight.code!.business_id],
    );
    const code = lockedCode.rows[0];
    if (!code) return { ok: false, httpStatus: 404, code: "code_not_found" } as const;
    if (code.revoked_at) return { ok: false, httpStatus: 410, code: "code_revoked" } as const;
    if (code.expires_at.getTime() <= Date.now()) {
      return { ok: false, httpStatus: 410, code: "code_expired" } as const;
    }

    const bundle = await buildCloudAuthoritativeBusinessBundle(
      code.business_id,
      code.location_id,
    );
    if (!bundle) return { ok: false, httpStatus: 404, code: "code_not_found" } as const;
    const statusDenial = mapBusinessStatusDenial(bundle.status);
    if (statusDenial) {
      return { ok: false, httpStatus: 403, code: statusDenial } as const;
    }

    // Crash-safe idempotency: if THIS exact installation already has a live pending
    // session for this code, return its staged credential without burning the code!
    const existingPending = await query<{
      inst_id: string;
      public_id: string;
      offline_lease_days: number | null;
      cred_id: string;
      token_ciphertext: string | null;
    }>(
      `SELECT i.id AS inst_id, i.public_id, i.offline_lease_days,
              c.id AS cred_id, c.token_ciphertext
         FROM local_installations i
         JOIN local_installation_credentials c
           ON c.local_installation_id = i.id AND c.business_id = i.business_id
        WHERE i.business_id = $1
          AND i.enrollment_code_id = $2
          AND i.installation_id = $3
          AND c.state = 'pending'
          AND c.revoked_at IS NULL
          AND (c.session_expires_at IS NULL OR c.session_expires_at > now())
        LIMIT 1`,
      [code.business_id, code.id, installationId],
    );

    if (existingPending.rows[0]?.token_ciphertext) {
      try {
        const plainToken = decryptSecret(
          existingPending.rows[0].token_ciphertext,
          resolveEncryptionKey(process.env),
        );
        const leaseDays = existingPending.rows[0].offline_lease_days;
        const freshBundle =
          (await buildCloudAuthoritativeBusinessBundle(
            code.business_id,
            code.location_id,
            leaseDays,
          )) ?? bundle;
        const lease = signOfflineLease({
          installationId,
          cloudBusinessId: code.business_id,
          leaseDays,
          enforceOfflineLease: leaseDays !== null && leaseDays > 0,
        });
        return {
          ok: true,
          protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
          installationPublicId: existingPending.rows[0].public_id,
          credentialId: existingPending.rows[0].cred_id,
          token: plainToken,
          lease,
          businessBundle: freshBundle,
          resumed: true,
        } as const;
      } catch {
        // Fall through to mint a fresh pending credential if key rotated.
      }
    }

    if (code.redeemed_at) {
      return { ok: false, httpStatus: 409, code: "code_already_redeemed" } as const;
    }

    // Check if another installation has an active pending reservation on this code.
    const otherPending = await query<{ id: string }>(
      `SELECT i.id
         FROM local_installations i
         JOIN local_installation_credentials c
           ON c.local_installation_id = i.id AND c.business_id = i.business_id
        WHERE i.business_id = $1
          AND i.enrollment_code_id = $2
          AND i.installation_id <> $3
          AND c.state = 'pending'
          AND c.revoked_at IS NULL
          AND c.session_expires_at > now()
        LIMIT 1`,
      [code.business_id, code.id, installationId],
    );
    if (otherPending.rows[0]) {
      return { ok: false, httpStatus: 409, code: "code_already_redeemed" } as const;
    }

    // Reuse existing installation row for the same (business_id, installation_id)
    // during credential repair / re-enrollment, or create a new one.
    const existingInst = await query<{
      id: string;
      public_id: string;
      offline_lease_days: number | null;
    }>(
      `SELECT id, public_id, offline_lease_days
         FROM local_installations
        WHERE business_id = $1 AND installation_id = $2
        ORDER BY (status <> 'revoked') DESC, created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [code.business_id, installationId],
    );

    let localInstallationId: string;
    let publicId: string;
    let leaseDays: number | null = null;

    if (existingInst.rows[0]) {
      localInstallationId = existingInst.rows[0].id;
      publicId = existingInst.rows[0].public_id;
      leaseDays = existingInst.rows[0].offline_lease_days;
      await query(
        `UPDATE local_installations
            SET location_id = $3,
                display_name = $4,
                status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending' END,
                enrollment_code_id = $5,
                app_version = COALESCE($6, app_version),
                schema_version = COALESCE($7, schema_version),
                revoked_at = NULL,
                revoked_reason = NULL,
                last_seen_at = now(),
                updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [
          localInstallationId,
          code.business_id,
          code.location_id,
          displayName,
          code.id,
          input.appVersion ?? null,
          input.schemaVersion ?? null,
        ],
      );
      // Clean up any stale pending credentials before staging the new one.
      await query(
        `UPDATE local_installation_credentials
            SET state = 'revoked', revoked_at = now(), token_ciphertext = NULL
          WHERE local_installation_id = $1 AND business_id = $2
            AND state = 'pending' AND revoked_at IS NULL`,
        [localInstallationId, code.business_id],
      );
    } else {
      const inserted = await query<{
        id: string;
        public_id: string;
        offline_lease_days: number | null;
      }>(
        `INSERT INTO local_installations
           (business_id, location_id, installation_id, display_name, status,
            enrollment_code_id, app_version, schema_version, last_seen_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, now())
         RETURNING id, public_id, offline_lease_days`,
        [
          code.business_id,
          code.location_id,
          installationId,
          displayName,
          code.id,
          input.appVersion ?? null,
          input.schemaVersion ?? null,
        ],
      );
      localInstallationId = inserted.rows[0].id;
      publicId = inserted.rows[0].public_id;
      leaseDays = inserted.rows[0].offline_lease_days;
    }

    const plainToken = generateLocalInstallationToken();
    const tokenHash = hashLocalInstallationToken(plainToken);
    const tokenCiphertext = encryptSecret(plainToken, resolveEncryptionKey(process.env));

    const credRow = await query<{ id: string }>(
      `INSERT INTO local_installation_credentials
         (local_installation_id, business_id, token_hash, token_ciphertext, state, session_expires_at)
       VALUES ($1, $2, $3, $4, 'pending', now() + ($5::int || ' minutes')::interval)
       RETURNING id`,
      [
        localInstallationId,
        code.business_id,
        tokenHash,
        tokenCiphertext,
        LOCAL_ENROLLMENT_SESSION_TTL_MINUTES,
      ],
    );

    if (input.clientIp) {
      await query(
        `UPDATE local_enrollment_codes SET redeemed_ip = $2 WHERE id = $1 AND business_id = $3`,
        [code.id, input.clientIp, code.business_id],
      );
    }

    const finalBundle =
      (await buildCloudAuthoritativeBusinessBundle(
        code.business_id,
        code.location_id,
        leaseDays,
      )) ?? bundle;
    const lease = signOfflineLease({
      installationId,
      cloudBusinessId: code.business_id,
      leaseDays,
      enforceOfflineLease: leaseDays !== null && leaseDays > 0,
    });

    return {
      ok: true,
      protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
      installationPublicId: publicId,
      credentialId: credRow.rows[0].id,
      token: plainToken,
      lease,
      businessBundle: finalBundle,
      resumed: false,
    } as const;
  });
}

export interface AuthenticatedLocalInstallation {
  businessId: string;
  locationId: string;
  localInstallationId: string;
  publicId: string;
  installationId: string;
  displayName: string;
  credentialId: string;
  credentialState: "pending" | "active" | "staged";
  offlineLeaseDays: number | null;
}

export type LocalBearerAuthResult =
  | { ok: true; installation: AuthenticatedLocalInstallation }
  | { ok: false; httpStatus: 401 | 403; code: ConfirmedCloudDenialCode };

export async function authenticateLocalInstallationBearer(
  rawToken: string,
  presentedInstallationId: string,
): Promise<LocalBearerAuthResult> {
  const token = rawToken.trim();
  const installationId = presentedInstallationId.trim();
  if (!token || !installationId) {
    return { ok: false, httpStatus: 401, code: "credential_invalid" };
  }
  const tokenHash = hashLocalInstallationToken(token);

  const lookup = await withoutTenantScope("local-activation-device-auth", async () => {
    const { rows } = await query<{
      cred_id: string;
      cred_state: "pending" | "active" | "staged" | "revoked";
      cred_revoked_at: Date | null;
      valid_until: Date | null;
      inst_id: string;
      public_id: string;
      business_id: string;
      location_id: string;
      bound_installation_id: string;
      display_name: string;
      inst_status: "pending" | "active" | "disabled" | "revoked";
      enrollment_code_id: string | null;
      offline_lease_days: number | null;
      biz_status: string;
    }>(
      `SELECT c.id AS cred_id, c.state AS cred_state, c.revoked_at AS cred_revoked_at, c.valid_until,
              i.id AS inst_id, i.public_id, i.business_id, i.location_id,
              i.installation_id AS bound_installation_id, i.display_name,
              i.status AS inst_status, i.enrollment_code_id, i.offline_lease_days,
              b.status::text AS biz_status
         FROM local_installation_credentials c
         JOIN local_installations i
           ON i.id = c.local_installation_id AND i.business_id = c.business_id
         JOIN businesses b ON b.id = c.business_id
        WHERE c.token_hash = $1
        LIMIT 1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  });

  if (!lookup) {
    return { ok: false, httpStatus: 401, code: "credential_invalid" };
  }
  if (lookup.bound_installation_id !== installationId) {
    return { ok: false, httpStatus: 403, code: "installation_mismatch" };
  }
  if (lookup.inst_status === "revoked") {
    return { ok: false, httpStatus: 403, code: "device_revoked" };
  }
  if (lookup.inst_status === "disabled") {
    return { ok: false, httpStatus: 403, code: "device_disabled" };
  }
  if (
    lookup.cred_state === "revoked" ||
    lookup.cred_revoked_at !== null ||
    (lookup.valid_until !== null && lookup.valid_until.getTime() <= Date.now())
  ) {
    return { ok: false, httpStatus: 401, code: "credential_revoked" };
  }
  const bizDenial = mapBusinessStatusDenial(lookup.biz_status);
  if (bizDenial) {
    return { ok: false, httpStatus: 403, code: bizDenial };
  }

  // Self-healing acknowledgement: if a pending credential is presented by its
  // bound installation, promote it atomically and mark the enrollment code spent.
  if (lookup.cred_state === "pending" || lookup.inst_status === "pending") {
    await withTenantTransaction(lookup.business_id, async () => {
      // Revoke older active credentials for this installation (e.g. during token replacement).
      await query(
        `UPDATE local_installation_credentials
            SET state = 'revoked', revoked_at = now(), token_ciphertext = NULL
          WHERE local_installation_id = $1 AND business_id = $2
            AND id <> $3 AND state IN ('active', 'pending') AND revoked_at IS NULL`,
        [lookup.inst_id, lookup.business_id, lookup.cred_id],
      );
      await query(
        `UPDATE local_installation_credentials
            SET state = 'active', acknowledged_at = COALESCE(acknowledged_at, now()),
                token_ciphertext = NULL
          WHERE id = $1 AND business_id = $2`,
        [lookup.cred_id, lookup.business_id],
      );
      await query(
        `UPDATE local_installations
            SET status = 'active', last_seen_at = now(), updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [lookup.inst_id, lookup.business_id],
      );
      if (lookup.enrollment_code_id) {
        await query(
          `UPDATE local_enrollment_codes
              SET redeemed_at = COALESCE(redeemed_at, now())
            WHERE id = $1 AND business_id = $2`,
          [lookup.enrollment_code_id, lookup.business_id],
        );
      }
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_activation.enrolled', 'local_installation', $2, $3)`,
        [
          lookup.business_id,
          lookup.inst_id,
          JSON.stringify({ publicId: lookup.public_id }),
        ],
      );
    });
  }

  return {
    ok: true,
    installation: {
      businessId: lookup.business_id,
      locationId: lookup.location_id,
      localInstallationId: lookup.inst_id,
      publicId: lookup.public_id,
      installationId: lookup.bound_installation_id,
      displayName: lookup.display_name,
      credentialId: lookup.cred_id,
      credentialState: lookup.cred_state === "pending" ? "active" : lookup.cred_state,
      offlineLeaseDays: lookup.offline_lease_days,
    },
  };
}

export async function acknowledgeLocalEnrollmentOnCloud(input: {
  token: string;
  installationId: string;
}): Promise<
  | { ok: true; protocol: typeof LOCAL_ACTIVATION_PROTOCOL_VERSION; publicId: string }
  | { ok: false; httpStatus: 401 | 403; code: ConfirmedCloudDenialCode }
> {
  const auth = await authenticateLocalInstallationBearer(input.token, input.installationId);
  if (!auth.ok) return auth;
  return {
    ok: true,
    protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
    publicId: auth.installation.publicId,
  };
}

export async function validateLocalInstallationOnCloud(input: {
  token: string;
  installationId: string;
  expectedBusinessId?: string | null;
  currentBusinessDigest?: string | null;
  appVersion?: string | null;
  schemaVersion?: string | null;
  healthSummary?: Record<string, unknown> | null;
  acknowledgeStagedToken?: boolean;
}): Promise<
  | {
      ok: true;
      protocol: typeof LOCAL_ACTIVATION_PROTOCOL_VERSION;
      validatedAt: string;
      unchanged: boolean;
      businessBundle: CloudAuthoritativeBusinessBundle | null;
      lease: SignedOfflineLease;
      stagedCredential: { credentialId: string; token: string } | null;
      rotationCompleted: boolean;
    }
  | { ok: false; httpStatus: 401 | 403; code: ConfirmedCloudDenialCode }
> {
  const auth = await authenticateLocalInstallationBearer(input.token, input.installationId);
  if (!auth.ok) return auth;
  const inst = auth.installation;

  if (input.expectedBusinessId && input.expectedBusinessId.trim() !== inst.businessId) {
    return { ok: false, httpStatus: 403, code: "business_mismatch" };
  }

  return withTenantTransaction(inst.businessId, async () => {
    let rotationCompleted = false;
    if (inst.credentialState === "staged" && input.acknowledgeStagedToken) {
      await query(
        `UPDATE local_installation_credentials
            SET state = 'revoked', revoked_at = now(), token_ciphertext = NULL
          WHERE local_installation_id = $1 AND business_id = $2
            AND id <> $3 AND state = 'active' AND revoked_at IS NULL`,
        [inst.localInstallationId, inst.businessId, inst.credentialId],
      );
      await query(
        `UPDATE local_installation_credentials
            SET state = 'active', acknowledged_at = now(), token_ciphertext = NULL, valid_until = NULL
          WHERE id = $1 AND business_id = $2`,
        [inst.credentialId, inst.businessId],
      );
      rotationCompleted = true;
    }

    // Check if an unacknowledged staged credential exists to hand off over TLS.
    let stagedCredential: { credentialId: string; token: string } | null = null;
    if (!rotationCompleted) {
      const staged = await query<{ id: string; token_ciphertext: string | null }>(
        `SELECT id, token_ciphertext
           FROM local_installation_credentials
          WHERE local_installation_id = $1 AND business_id = $2
            AND state = 'staged' AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [inst.localInstallationId, inst.businessId],
      );
      if (staged.rows[0]?.token_ciphertext) {
        try {
          const decrypted = decryptSecret(
            staged.rows[0].token_ciphertext,
            resolveEncryptionKey(process.env),
          );
          stagedCredential = { credentialId: staged.rows[0].id, token: decrypted };
        } catch {
          stagedCredential = null;
        }
      }
    }

    const bundle = await buildCloudAuthoritativeBusinessBundle(
      inst.businessId,
      inst.locationId,
      inst.offlineLeaseDays,
    );
    if (!bundle) {
      return { ok: false, httpStatus: 403, code: "business_disabled" } as const;
    }
    const statusDenial = mapBusinessStatusDenial(bundle.status);
    if (statusDenial) {
      return { ok: false, httpStatus: 403, code: statusDenial } as const;
    }

    const redactedHealth = (redactLocalSupportDiagnostics(input.healthSummary ?? {}) ??
      {}) as Record<string, unknown>;
    const now = new Date();

    await query(
      `UPDATE local_installations
          SET last_seen_at = $3,
              last_validated_at = $3,
              app_version = COALESCE($4, app_version),
              schema_version = COALESCE($5, schema_version),
              last_business_revision = $6,
              last_health_summary = $7::jsonb,
              updated_at = $3
        WHERE id = $1 AND business_id = $2`,
      [
        inst.localInstallationId,
        inst.businessId,
        now,
        input.appVersion ?? null,
        input.schemaVersion ?? null,
        bundle.revision,
        JSON.stringify(redactedHealth),
      ],
    );

    const unchanged =
      Boolean(input.currentBusinessDigest) && input.currentBusinessDigest === bundle.digest;
    const lease = signOfflineLease({
      installationId: inst.installationId,
      cloudBusinessId: inst.businessId,
      issuedAt: now,
      leaseDays: inst.offlineLeaseDays,
      enforceOfflineLease: inst.offlineLeaseDays !== null && inst.offlineLeaseDays > 0,
    });

    return {
      ok: true,
      protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
      validatedAt: now.toISOString(),
      unchanged,
      businessBundle: unchanged ? null : bundle,
      lease,
      stagedCredential,
      rotationCompleted,
    } as const;
  });
}

// ── Online-only Support Tickets & Bug Reports on Cloud ───────────────────────

const MAX_ATTACHMENT_CHARS = 5_600_000;

function validImageDataUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return null;
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) return null;
  if (raw.length > MAX_ATTACHMENT_CHARS) return null;
  return raw;
}

export async function listCloudSupportTicketsForLocalInstallation(
  inst: AuthenticatedLocalInstallation,
  statusFilter?: string | null,
) {
  return withTenant(inst.businessId, async () => {
    const { rows } = await query<{
      id: string;
      business_id: string;
      location_id: string | null;
      location_name: string | null;
      user_id: string | null;
      user_name: string | null;
      subject: string;
      category: string;
      priority: string;
      status: string;
      assigned_admin_id: string | null;
      assigned_admin_name: string | null;
      message_count: string;
      last_message_at: Date | null;
      last_message_preview: string | null;
      created_at: Date;
      updated_at: Date;
      closed_at: Date | null;
    }>(
      `SELECT t.id, t.business_id, t.location_id, l.name AS location_name,
              t.user_id, u.full_name AS user_name,
              t.subject, t.category, t.priority, t.status,
              t.assigned_admin_id, pa.full_name AS assigned_admin_name,
              (SELECT count(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
              (SELECT max(m.created_at) FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at,
              (SELECT left(m.body, 140) FROM support_ticket_messages m
                WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
              t.created_at, t.updated_at, t.closed_at
         FROM support_tickets t
         LEFT JOIN locations l ON l.id = t.location_id
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN platform_admins pa ON pa.id = t.assigned_admin_id
        WHERE t.business_id = $1
          AND ($2::text IS NULL OR $2 = '' OR (
            CASE
              WHEN $2 = 'open_group' THEN t.status IN ('open', 'in_progress', 'waiting_customer')
              WHEN $2 = 'closed_group' THEN t.status IN ('resolved', 'closed')
              ELSE t.status = $2
            END
          ))
        ORDER BY t.updated_at DESC
        LIMIT 100`,
      [inst.businessId, statusFilter ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      locationId: r.location_id,
      locationName: r.location_name,
      userId: r.user_id,
      userName: r.user_name,
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status,
      assignedAdminId: r.assigned_admin_id,
      assignedAdminName: r.assigned_admin_name,
      messageCount: Number(r.message_count),
      lastMessageAt: r.last_message_at?.toISOString() ?? null,
      lastMessagePreview: r.last_message_preview,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      closedAt: r.closed_at?.toISOString() ?? null,
    }));
  });
}

export async function getCloudSupportTicketDetailForLocalInstallation(
  inst: AuthenticatedLocalInstallation,
  ticketId: string,
) {
  return withTenant(inst.businessId, async () => {
    const tickets = await listCloudSupportTicketsForLocalInstallation(inst);
    const summary = tickets.find((t) => t.id === ticketId);
    if (!summary) return null;
    const { rows: msgRows } = await query<{
      id: string;
      author_type: "member" | "admin";
      user_id: string | null;
      user_name: string | null;
      admin_id: string | null;
      admin_name: string | null;
      body: string;
      attachment: string | null;
      created_at: Date;
    }>(
      `SELECT m.id, m.author_type, m.user_id, u.full_name AS user_name,
              m.admin_id, pa.full_name AS admin_name,
              m.body, m.attachment, m.created_at
         FROM support_ticket_messages m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN platform_admins pa ON pa.id = m.admin_id
        WHERE m.ticket_id = $1 AND m.business_id = $2
        ORDER BY m.created_at ASC`,
      [ticketId, inst.businessId],
    );
    return {
      ...summary,
      messages: msgRows.map((m) => ({
        id: m.id,
        ticketId,
        authorType: m.author_type,
        userId: m.user_id,
        userName: m.user_name,
        adminId: m.admin_id,
        adminName: m.admin_name,
        body: m.body,
        attachment: m.attachment,
        createdAt: m.created_at.toISOString(),
      })),
    };
  });
}

export async function createCloudSupportTicketFromLocalInstallation(
  inst: AuthenticatedLocalInstallation,
  input: {
    subject: string;
    category: string;
    priority: string;
    description: string;
    attachment?: unknown;
    reporterName?: string | null;
    reporterRole?: string | null;
  },
) {
  const subject = redactSensitiveText(input.subject.trim());
  const description = redactSensitiveText(input.description.trim());
  if (!subject || subject.length > 200 || !description || description.length > 8000) {
    return { ok: false as const, error: "invalid_fields" };
  }
  const category = isTicketCategory(input.category) ? input.category : "technical";
  const priority = isTicketPriority(input.priority) ? input.priority : "normal";
  const attachment = validImageDataUrl(input.attachment);
  if (input.attachment && !attachment) {
    return { ok: false as const, error: "invalid_attachment" };
  }

  const ticketId = await withTenantTransaction(inst.businessId, async () => {
    const ownerUser = await query<{ id: string }>(
      `SELECT id FROM users WHERE business_id = $1 AND role = 'owner' ORDER BY created_at ASC LIMIT 1`,
      [inst.businessId],
    );
    const authorPrefix = input.reporterName
      ? `[ارسال‌شده از نصب آفلاین «${inst.displayName}» — ${redactSensitiveText(input.reporterName.slice(0, 80))}]\n\n`
      : "";
    const { rows } = await query<{ id: string }>(
      `INSERT INTO support_tickets
         (business_id, location_id, user_id, subject, category, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        inst.businessId,
        inst.locationId,
        ownerUser.rows[0]?.id ?? null,
        subject,
        category,
        priority,
      ],
    );
    await query(
      `INSERT INTO support_ticket_messages
         (ticket_id, business_id, author_type, user_id, body, attachment)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [
        rows[0].id,
        inst.businessId,
        ownerUser.rows[0]?.id ?? null,
        `${authorPrefix}${description}`,
        attachment,
      ],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'support.local_online_ticket_created', 'support_ticket', $3, $4)`,
      [
        inst.businessId,
        ownerUser.rows[0]?.id ?? null,
        rows[0].id,
        JSON.stringify({
          localInstallationPublicId: inst.publicId,
          category,
          priority,
        }),
      ],
    );
    return rows[0].id;
  });

  const detail = await getCloudSupportTicketDetailForLocalInstallation(inst, ticketId);
  return { ok: true as const, ticket: detail! };
}

export async function replyCloudSupportTicketFromLocalInstallation(
  inst: AuthenticatedLocalInstallation,
  input: {
    ticketId: string;
    body: string;
    attachment?: unknown;
    reporterName?: string | null;
  },
) {
  const cleanBody = redactSensitiveText(input.body.trim());
  if (!cleanBody || cleanBody.length > 8000) {
    return { ok: false as const, error: "invalid_fields" };
  }
  const attachment = validImageDataUrl(input.attachment);
  if (input.attachment && !attachment) {
    return { ok: false as const, error: "invalid_attachment" };
  }

  const ok = await withTenantTransaction(inst.businessId, async () => {
    const existing = await query<{ id: string; status: string }>(
      `SELECT id, status FROM support_tickets WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.ticketId, inst.businessId],
    );
    if (!existing.rows[0]) return false;
    const ownerUser = await query<{ id: string }>(
      `SELECT id FROM users WHERE business_id = $1 AND role = 'owner' ORDER BY created_at ASC LIMIT 1`,
      [inst.businessId],
    );
    const prefix = input.reporterName
      ? `[${redactSensitiveText(input.reporterName.slice(0, 80))}]\n`
      : "";
    await query(
      `INSERT INTO support_ticket_messages
         (ticket_id, business_id, author_type, user_id, body, attachment)
       VALUES ($1, $2, 'member', $3, $4, $5)`,
      [
        input.ticketId,
        inst.businessId,
        ownerUser.rows[0]?.id ?? null,
        `${prefix}${cleanBody}`,
        attachment,
      ],
    );
    await query(
      `UPDATE support_tickets
          SET updated_at = now(),
              status = CASE WHEN status IN ('waiting_customer', 'resolved', 'closed') THEN 'open' ELSE status END,
              closed_at = CASE WHEN status IN ('resolved', 'closed') THEN NULL ELSE closed_at END
        WHERE id = $1 AND business_id = $2`,
      [input.ticketId, inst.businessId],
    );
    return true;
  });
  if (!ok) return { ok: false as const, error: "not_found" };
  const detail = await getCloudSupportTicketDetailForLocalInstallation(inst, input.ticketId);
  return { ok: true as const, ticket: detail! };
}

export async function updateCloudSupportTicketStatusFromLocalInstallation(
  inst: AuthenticatedLocalInstallation,
  ticketId: string,
  status: string,
) {
  if (!isMemberSettableStatus(status)) {
    return { ok: false as const, error: "invalid_status" };
  }
  const ok = await withTenantTransaction(inst.businessId, async () => {
    const { rowCount } = await query(
      `UPDATE support_tickets
          SET status = $3,
              updated_at = now(),
              closed_at = CASE WHEN $3 = 'closed' THEN now() ELSE NULL END
        WHERE id = $1 AND business_id = $2`,
      [ticketId, inst.businessId, status],
    );
    return Boolean(rowCount);
  });
  if (!ok) return { ok: false as const, error: "not_found" };
  const detail = await getCloudSupportTicketDetailForLocalInstallation(inst, ticketId);
  return { ok: true as const, ticket: detail! };
}

export async function createCloudBugReportFromLocalInstallation(
  inst: AuthenticatedLocalInstallation,
  input: {
    description: string;
    screenshot?: unknown;
    pageUrl?: string | null;
    userAgent?: string | null;
    viewport?: string | null;
    reporterName?: string | null;
  },
) {
  const cleanDescription = redactSensitiveText(input.description.trim());
  if (!cleanDescription || cleanDescription.length > 4000) {
    return { ok: false as const, error: "invalid_description" };
  }
  const screenshot = validImageDataUrl(input.screenshot);
  if (input.screenshot && !screenshot) {
    return { ok: false as const, error: "invalid_screenshot" };
  }
  const cleanPageUrl = input.pageUrl
    ? redactSensitiveText(String(input.pageUrl).slice(0, 500))
    : null;
  const cleanUserAgent = input.userAgent
    ? redactSensitiveText(String(input.userAgent).slice(0, 500))
    : null;
  const cleanViewport = input.viewport
    ? redactSensitiveText(String(input.viewport).slice(0, 64))
    : null;

  return withTenantTransaction(inst.businessId, async () => {
    const prefix = input.reporterName
      ? `[نصب آفلاین «${inst.displayName}» (${inst.publicId}) — ${redactSensitiveText(input.reporterName.slice(0, 80))}]\n`
      : `[نصب آفلاین «${inst.displayName}» (${inst.publicId})]\n`;
    const { rows } = await query<{ id: string; created_at: Date }>(
      `INSERT INTO bug_reports
         (business_id, location_id, user_id, description, screenshot, page_url, user_agent, viewport)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        inst.businessId,
        inst.locationId,
        `${prefix}${cleanDescription}`,
        screenshot,
        cleanPageUrl,
        cleanUserAgent,
        cleanViewport,
      ],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, NULL, 'bug_report.local_online_submitted', 'bug_report', $2, $3)`,
      [
        inst.businessId,
        rows[0].id,
        JSON.stringify({ localInstallationPublicId: inst.publicId }),
      ],
    );
    return {
      ok: true as const,
      id: rows[0].id,
      createdAt: rows[0].created_at.toISOString(),
    };
  });
}

export async function updateLocalInstallationPolicyOnCloud(input: {
  businessId: string;
  localInstallationId: string;
  status?: "active" | "disabled";
  enforceOfflineLease?: boolean;
  offlineLeaseDays?: number;
  actorUserId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_revoked" | "invalid_lease_days" }> {
  if (
    input.offlineLeaseDays !== undefined &&
    (!Number.isInteger(input.offlineLeaseDays) ||
      input.offlineLeaseDays < 1 ||
      input.offlineLeaseDays > 365)
  ) {
    return { ok: false, error: "invalid_lease_days" };
  }

  return withTenantTransaction(input.businessId, async () => {
    const cur = await query<{ status: string }>(
      `SELECT status FROM local_installations WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.localInstallationId, input.businessId],
    );
    if (!cur.rows[0]) return { ok: false as const, error: "not_found" as const };
    if (cur.rows[0].status === "revoked") {
      return { ok: false as const, error: "already_revoked" as const };
    }

    await query(
      `UPDATE local_installations
          SET status = COALESCE($3, status),
              enforce_offline_lease = COALESCE($4, enforce_offline_lease),
              offline_lease_days = COALESCE($5, offline_lease_days),
              policy_version = policy_version + 1,
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [
        input.localInstallationId,
        input.businessId,
        input.status ?? null,
        input.enforceOfflineLease ?? null,
        input.offlineLeaseDays ?? null,
      ],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_installation.policy_updated', 'local_installation', $3, $4)`,
      [
        input.businessId,
        input.actorUserId ?? null,
        input.localInstallationId,
        JSON.stringify({
          status: input.status,
          enforceOfflineLease: input.enforceOfflineLease,
          offlineLeaseDays: input.offlineLeaseDays,
        }),
      ],
    );
    return { ok: true as const };
  });
}

