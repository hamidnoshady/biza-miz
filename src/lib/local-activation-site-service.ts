/**
 * Issue #974 — Site-side (`DEPLOYMENT_ROLE=site`, `deployment.profile='local'`)
 * Cloud activation, periodic validation, atomic Cloud-authoritative business
 * refresh, lock-gate enforcement, and online-only Support/Bug Report client.
 *
 * Hard invariant: nothing in this module ever writes `server_sync.config`,
 * `site_devices`, or `site_sync_credentials`, or calls `runServerSyncTick()`.
 */
import { isPinnedToTransaction, query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile } from "./deployment-mode";
import { classifyLocalEnrollmentCode } from "./connection-code";
import { localInstallationId } from "./pairing-apply";
import { SETTING_KEYS } from "./settings";
import {
  computeNextActivationState,
  computeValidationBackoffMs,
  deriveLocalActivationStatusSummary,
  HEALTHY_VALIDATION_INTERVAL_MS,
  isAllowedWhenLocalInstallationLocked,
  isConfirmedCloudDenial,
  LOCAL_ACTIVATION_PROTOCOL_VERSION,
  MIN_AUTO_VALIDATION_GAP_MS,
  type ConfirmedCloudDenialCode,
  type LocalActivationState,
  type LocalActivationStatusSummary,
} from "./local-activation-contract";
import {
  openLocalCredential,
  sealLocalCredential,
  validateCloudOriginForLocalActivation,
  verifyOfflineLease,
  type SignedOfflineLease,
  type SignedOfflineLeasePayload,
} from "./local-activation-crypto";
import type { CloudAuthoritativeBusinessBundle } from "./local-activation-cloud-service";

const CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const CLOUD_ENDPOINT_PATH = "/api/local-activation/cloud";

export interface LocalActivationRecordView {
  enrolled: boolean;
  state: LocalActivationState;
  installationId: string;
  cloudBusinessId: string | null;
  cloudLocationId: string | null;
  cloudOrigin: string | null;
  cloudInstallationPublicId: string | null;
  credentialId: string | null;
  hasCredential: boolean;
  lockReason: string | null;
  lastErrorCode: string | null;
  lastAttemptAt: string | null;
  lastVerifiedAt: string | null;
  lastBusinessUpdatedAt: string | null;
  businessRevision: string | null;
  policyVersion: number;
  entitlementVersion: number;
  enforceOfflineLease: boolean;
  leaseExpiresAt: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  cloudReachable: boolean;
  unsentSupportDraftCount: number;
  summary: LocalActivationStatusSummary;
}

interface RawLocalActivationRow extends Record<string, unknown> {
  business_id: string;
  installation_id: string;
  cloud_business_id: string;
  cloud_location_id: string | null;
  cloud_origin: string;
  cloud_installation_public_id: string;
  credential_id: string | null;
  credential_ciphertext: string | null;
  staged_credential_ciphertext: string | null;
  pending_ack: boolean;
  state: LocalActivationState;
  lock_reason: string | null;
  last_error_code: string | null;
  last_attempt_at: Date | null;
  last_verified_at: Date | null;
  consecutive_failures: number;
  next_retry_at: Date | null;
  policy_version: number;
  entitlement_version: number;
  business_revision: string | null;
  business_digest: string | null;
  last_business_updated_at: Date | null;
  entitlement_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  lease_public_key: string | null;
  lease_payload: SignedOfflineLeasePayload | null;
  lease_signature: string | null;
  lease_expires_at: Date | null;
  enforce_offline_lease: boolean;
  max_observed_clock_at: Date;
}

async function readRawActivationRow(businessId: string): Promise<RawLocalActivationRow | null> {
  const res = await query<RawLocalActivationRow>(
    `SELECT * FROM local_cloud_activations WHERE business_id = $1`,
    [businessId],
  );
  const row = res?.rows?.[0];
  if (!row || typeof row.installation_id !== "string" || typeof row.state !== "string") {
    return null;
  }
  return row;
}

function classifyFetchException(err: unknown):
  | "dns_error"
  | "tls_error"
  | "timeout"
  | "network_error" {
  const msg =
    err instanceof Error
      ? `${err.name} ${err.message} ${(err as { cause?: { code?: string; message?: string } }).cause?.code ?? ""} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}`
      : String(err);
  if (/abort|timeout/i.test(msg)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "dns_error";
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY/i.test(msg)) return "tls_error";
  return "network_error";
}

/**
 * Evaluates whether an enforced signed offline lease has expired or suffered
 * system clock rollback, persisting the `locked_invalid` transition if so.
 */
async function evaluateAndPersistOfflineLeaseIfNeeded(
  row: RawLocalActivationRow,
): Promise<RawLocalActivationRow> {
  const now = new Date();
  // Advance monotonic max_observed_clock_at whenever system clock moves forward.
  if (now.getTime() > row.max_observed_clock_at.getTime() + 60_000) {
    await query(
      `UPDATE local_cloud_activations
          SET max_observed_clock_at = GREATEST(max_observed_clock_at, $2)
        WHERE business_id = $1`,
      [row.business_id, now],
    );
    row = { ...row, max_observed_clock_at: now };
  }

  if (!row.enforce_offline_lease || row.state === "locked_invalid") {
    return row;
  }

  const check = verifyOfflineLease({
    payload: row.lease_payload,
    signature: row.lease_signature,
    publicKeyPem: row.lease_public_key,
    expectedInstallationId: row.installation_id,
    expectedCloudBusinessId: row.cloud_business_id,
    enforceOfflineLease: row.enforce_offline_lease,
    maxObservedClockAt: row.max_observed_clock_at,
    now,
  });

  if (check.valid) return row;

  const transition = computeNextActivationState(
    row.state,
    (row.lock_reason as ConfirmedCloudDenialCode | null) ?? null,
    {
      kind: "offline_lease_expired",
      clockRollbackDetected: check.reason === "clock_rollback_detected",
    },
  );
  await withTenantTransaction(row.business_id, async () => {
    await query(
      `UPDATE local_cloud_activations
          SET state = $2, lock_reason = $3, last_error_code = $4, updated_at = now()
        WHERE business_id = $1`,
      [row.business_id, transition.nextState, transition.lockReason, check.reason],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, NULL, 'local_activation.locked_offline_lease', 'local_cloud_activation', $1::uuid::text, $2)`,
      [row.business_id, JSON.stringify({ reason: check.reason })],
    );
  });

  return (await readRawActivationRow(row.business_id)) ?? row;
}

/**
 * Fast server/API boundary lock check invoked by `withTenantScope` and
 * `WorkspaceShell` on `local` site deployments.
 */
export async function checkLocalInstallationLockGate(
  businessId: string,
  pathname: string,
  method: string,
): Promise<{
  locked: boolean;
  allowed: boolean;
  state: LocalActivationState;
  lockReason: string | null;
}> {
  if (deploymentRole() !== "site") {
    return { locked: false, allowed: true, state: "active", lockReason: null };
  }
  const deployment = await readDeploymentProfile(businessId);
  if (deployment.profile !== "local") {
    return { locked: false, allowed: true, state: "active", lockReason: null };
  }

  let row = await readRawActivationRow(businessId);
  if (!row) {
    return { locked: false, allowed: true, state: "not_enrolled", lockReason: null };
  }

  row = await evaluateAndPersistOfflineLeaseIfNeeded(row);
  if (row.state !== "locked_invalid") {
    return { locked: false, allowed: true, state: row.state, lockReason: null };
  }

  const allowed = isAllowedWhenLocalInstallationLocked(pathname, method);
  return {
    locked: true,
    allowed,
    state: "locked_invalid",
    lockReason: row.lock_reason,
  };
}

export async function probeCloudEndpointReachability(cloudOrigin: string): Promise<boolean> {
  try {
    const res = await fetch(`${cloudOrigin}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(4_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getLocalActivationView(
  businessId: string,
  options: { probeReachability?: boolean; internetHintOffline?: boolean } = {},
): Promise<LocalActivationRecordView> {
  const installationId = localInstallationId();
  let row = await readRawActivationRow(businessId);
  const unsentRes = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM cloud_exception_outbox WHERE business_id = $1`,
    [businessId],
  );
  const unsentSupportDraftCount = Number(unsentRes.rows[0]?.count ?? 0);

  if (!row) {
    const summary = deriveLocalActivationStatusSummary({
      state: "not_enrolled",
      cloudReachable: false,
      internetHintOffline: options.internetHintOffline,
    });
    return {
      enrolled: false,
      state: "not_enrolled",
      installationId,
      cloudBusinessId: null,
      cloudLocationId: null,
      cloudOrigin: null,
      cloudInstallationPublicId: null,
      credentialId: null,
      hasCredential: false,
      lockReason: null,
      lastErrorCode: null,
      lastAttemptAt: null,
      lastVerifiedAt: null,
      lastBusinessUpdatedAt: null,
      businessRevision: null,
      policyVersion: 1,
      entitlementVersion: 1,
      enforceOfflineLease: false,
      leaseExpiresAt: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      cloudReachable: false,
      unsentSupportDraftCount,
      summary,
    };
  }

  row = await evaluateAndPersistOfflineLeaseIfNeeded(row);

  let cloudReachable = false;
  if (options.probeReachability && row.cloud_origin) {
    cloudReachable = await probeCloudEndpointReachability(row.cloud_origin);
  } else if (row.state === "active" && row.last_verified_at && !row.last_error_code) {
    cloudReachable = Date.now() - row.last_verified_at.getTime() < 5 * 60_000;
  }

  const summary = deriveLocalActivationStatusSummary({
    state: row.state,
    lockReason: row.lock_reason,
    lastErrorCode: row.last_error_code,
    cloudReachable,
    internetHintOffline: options.internetHintOffline,
  });

  return {
    enrolled: row.state !== "not_enrolled",
    state: row.state,
    installationId: row.installation_id,
    cloudBusinessId: row.cloud_business_id,
    cloudLocationId: row.cloud_location_id,
    cloudOrigin: row.cloud_origin,
    cloudInstallationPublicId: row.cloud_installation_public_id,
    credentialId: row.credential_id,
    hasCredential: Boolean(row.credential_ciphertext),
    lockReason: row.lock_reason,
    lastErrorCode: row.last_error_code,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    lastBusinessUpdatedAt: row.last_business_updated_at?.toISOString() ?? null,
    businessRevision: row.business_revision,
    policyVersion: row.policy_version,
    entitlementVersion: row.entitlement_version,
    enforceOfflineLease: row.enforce_offline_lease,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    consecutiveFailures: row.consecutive_failures,
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    cloudReachable,
    unsentSupportDraftCount,
    summary,
  };
}

/**
 * Atomically applies Cloud-authoritative business metadata/policies/entitlements
 * onto the local Full Offline tenant WITHOUT overwriting `device_local` settings
 * or operational POS/accounting data, and WITHOUT enabling Hybrid sync.
 */
export async function applyCloudAuthoritativeBusinessBundleLocally(
  localBusinessId: string,
  bundle: CloudAuthoritativeBusinessBundle,
  previousDigest: string | null,
): Promise<{ updated: boolean; changedDomains: string[] }> {
  if (previousDigest && previousDigest === bundle.digest) {
    return { updated: false, changedDomains: [] };
  }

  const runStep = async () => {
    const changedDomains: string[] = [];

    const currentBiz = await query<{
      name: string;
      plan: string;
      support_access_policy: string;
    }>(
      `SELECT name, plan, support_access_policy FROM businesses WHERE id = $1 FOR UPDATE`,
      [localBusinessId],
    );
    if (currentBiz.rows[0]) {
      const planCheck = await query<{ ok: number }>(
        `SELECT 1 AS ok FROM billing_plans WHERE key = $1 LIMIT 1`,
        [bundle.plan],
      );
      const nextPlan = planCheck.rows[0] ? bundle.plan : currentBiz.rows[0].plan;
      const validPolicy = ["standard", "approval_required", "strict", "disabled"].includes(
        bundle.supportAccessPolicy,
      )
        ? bundle.supportAccessPolicy
        : currentBiz.rows[0].support_access_policy;

      if (
        currentBiz.rows[0].name !== bundle.name ||
        currentBiz.rows[0].plan !== nextPlan ||
        currentBiz.rows[0].support_access_policy !== validPolicy
      ) {
        await query(
          `UPDATE businesses
              SET name = $2, plan = $3, support_access_policy = $4, updated_at = now()
            WHERE id = $1`,
          [localBusinessId, bundle.name, nextPlan, validPolicy],
        );
        changedDomains.push("business_identity_and_policy");
      }
    }

    // Update the primary bound location's Cloud metadata (never deleting local branches or tables).
    const locTarget = await query<{ id: string; name: string; address: string | null; phone: string | null }>(
      `SELECT id, name, address, phone
         FROM locations
        WHERE business_id = $1
        ORDER BY (id = $2::uuid) DESC, created_at ASC
        LIMIT 1`,
      [localBusinessId, bundle.location.id],
    );
    if (locTarget.rows[0]) {
      const cur = locTarget.rows[0];
      if (
        cur.name !== bundle.location.name ||
        (cur.address ?? null) !== (bundle.location.address ?? null) ||
        (cur.phone ?? null) !== (bundle.location.phone ?? null)
      ) {
        await query(
          `UPDATE locations SET name = $2, address = $3, phone = $4
            WHERE id = $1 AND business_id = $5`,
          [
            cur.id,
            bundle.location.name,
            bundle.location.address,
            bundle.location.phone,
            localBusinessId,
          ],
        );
        changedDomains.push("primary_location_metadata");
      }
    }

    // Sync Cloud feature entitlements known to this schema.
    if (Array.isArray(bundle.features)) {
      const knownFlags = await query<{ key: string }>(`SELECT key FROM feature_flags`);
      const knownSet = new Set(knownFlags.rows.map((r) => r.key));
      for (const f of bundle.features) {
        if (!knownSet.has(f.flagKey)) continue;
        await query(
          `INSERT INTO business_features (business_id, flag_key, enabled, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (business_id, flag_key)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
          [localBusinessId, f.flagKey, Boolean(f.enabled)],
        );
      }
      changedDomains.push("plan_and_entitlements");
    }

    // Sync per-business app availability overrides.
    if (Array.isArray(bundle.appAvailability)) {
      const validStates = new Set(["available", "beta", "coming_soon", "maintenance", "disabled"]);
      for (const app of bundle.appAvailability) {
        if (!validStates.has(app.state)) continue;
        await query(
          `INSERT INTO business_app_availability (business_id, app_key, state, note, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (business_id, app_key)
           DO UPDATE SET state = EXCLUDED.state, note = EXCLUDED.note, updated_at = now()`,
          [localBusinessId, app.appKey, app.state, app.note ?? null],
        );
      }
    }

    await query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, $2, $3::jsonb)
       ON CONFLICT (business_id, location_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        localBusinessId,
        SETTING_KEYS.localCloudBusinessProfile,
        JSON.stringify({
          ...(bundle.profileMetadata ?? {}),
          cloudSlug: bundle.slug,
          cloudSubdomain: bundle.subdomain,
          cloudIndustry: bundle.industry,
          cloudPlan: bundle.plan,
          refreshedAt: new Date().toISOString(),
        }),
      ],
    );

    if (changedDomains.length > 0 || !previousDigest) {
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_activation.business_data_refreshed', 'business', $1::uuid::text, $2)`,
        [
          localBusinessId,
          JSON.stringify({
            revision: bundle.revision,
            changedDomains,
          }),
        ],
      );
    }

    return { updated: true, changedDomains };
  };

  return isPinnedToTransaction()
    ? runStep()
    : withTenantTransaction(localBusinessId, runStep);
}

export type SiteVerifyTokenResult =
  | {
      ok: true;
      cloudOrigin: string;
      businessBundle: CloudAuthoritativeBusinessBundle;
    }
  | {
      ok: false;
      httpStatus: number;
      error: string;
    };

/**
 * Preflight verification of `cloudOrigin` + `OFL1-…` token against the real
 * Cloud server WITHOUT consuming the token.
 */
export async function verifyCloudTokenFromSite(input: {
  cloudUrl: string;
  token: string;
  expectedCloudBusinessId?: string | null;
}): Promise<SiteVerifyTokenResult> {
  const urlCheck = await validateCloudOriginForLocalActivation(input.cloudUrl);
  if (!urlCheck.ok) {
    return { ok: false, httpStatus: 400, error: urlCheck.error };
  }

  const codeKind = classifyLocalEnrollmentCode(input.token);
  if (codeKind !== "local_enrollment_code") {
    return { ok: false, httpStatus: 400, error: `token_${codeKind}` };
  }

  const installationId = localInstallationId();
  let res: Response;
  try {
    res = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "verify_token",
        code: input.token.trim(),
        installationId,
        expectedBusinessId: input.expectedCloudBusinessId ?? null,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, httpStatus: 502, error: classifyFetchException(err) };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    protocol?: string;
    code?: string;
    error?: string;
    businessBundle?: CloudAuthoritativeBusinessBundle;
  };

  if (!res.ok || !payload.ok || payload.protocol !== LOCAL_ACTIVATION_PROTOCOL_VERSION || !payload.businessBundle) {
    const errCode = payload.code || payload.error || (res.status >= 500 ? "cloud_5xx" : "cloud_invalid_response");
    return { ok: false, httpStatus: res.status || 502, error: errCode };
  }

  return {
    ok: true,
    cloudOrigin: urlCheck.origin,
    businessBundle: payload.businessBundle,
  };
}

export interface SiteEnrollResponse {
  cloudOrigin: string;
  installationId: string;
  installationPublicId: string;
  credentialId: string;
  token: string;
  lease: SignedOfflineLease;
  businessBundle: CloudAuthoritativeBusinessBundle;
  resumed: boolean;
}

export async function requestCloudEnrollmentFromSite(input: {
  cloudUrl: string;
  token: string;
  expectedCloudBusinessId?: string | null;
  appVersion?: string | null;
}): Promise<{ ok: true; enrolled: SiteEnrollResponse } | { ok: false; httpStatus: number; error: string }> {
  const urlCheck = await validateCloudOriginForLocalActivation(input.cloudUrl);
  if (!urlCheck.ok) {
    return { ok: false, httpStatus: 400, error: urlCheck.error };
  }
  const codeKind = classifyLocalEnrollmentCode(input.token);
  if (codeKind !== "local_enrollment_code") {
    return { ok: false, httpStatus: 400, error: `token_${codeKind}` };
  }

  const installationId = localInstallationId();
  let res: Response;
  try {
    res = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enroll",
        code: input.token.trim(),
        installationId,
        deviceName: process.env.DESKTOP_DEVICE_NAME || "Windows Business Suite (Full Offline)",
        appVersion: input.appVersion ?? process.env.DESKTOP_APP_VERSION ?? null,
        expectedBusinessId: input.expectedCloudBusinessId ?? null,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, httpStatus: 502, error: classifyFetchException(err) };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    protocol?: string;
    code?: string;
    error?: string;
    installationPublicId?: string;
    credentialId?: string;
    token?: string;
    lease?: SignedOfflineLease;
    businessBundle?: CloudAuthoritativeBusinessBundle;
    resumed?: boolean;
  };

  if (
    !res.ok ||
    !payload.ok ||
    payload.protocol !== LOCAL_ACTIVATION_PROTOCOL_VERSION ||
    !payload.token ||
    !payload.credentialId ||
    !payload.installationPublicId ||
    !payload.lease ||
    !payload.businessBundle
  ) {
    const errCode = payload.code || payload.error || (res.status >= 500 ? "cloud_5xx" : "cloud_invalid_response");
    return { ok: false, httpStatus: res.status || 502, error: errCode };
  }

  return {
    ok: true,
    enrolled: {
      cloudOrigin: urlCheck.origin,
      installationId,
      installationPublicId: payload.installationPublicId,
      credentialId: payload.credentialId,
      token: payload.token,
      lease: payload.lease,
      businessBundle: payload.businessBundle,
      resumed: Boolean(payload.resumed),
    },
  };
}

/**
 * Persists a verified Cloud enrollment locally for `localBusinessId`, applies
 * Cloud-authoritative business metadata atomically, and sends the phase-2
 * acknowledgement to Cloud (falling back to `pending_ack = true` if the network
 * drops right after local commit so the background worker finishes it).
 */
export async function commitLocalActivationRecordAndAcknowledge(
  localBusinessId: string,
  enrolled: SiteEnrollResponse,
  actorUserId: string | null = null,
): Promise<{ acknowledged: boolean }> {
  const sealed = sealLocalCredential(enrolled.token);
  const now = new Date();

  await withTenantTransaction(localBusinessId, async () => {
    const existing = await readRawActivationRow(localBusinessId);
    if (existing && existing.cloud_business_id !== enrolled.businessBundle.businessId) {
      throw new Error("business_mismatch");
    }

    await applyCloudAuthoritativeBusinessBundleLocally(
      localBusinessId,
      enrolled.businessBundle,
      existing?.business_digest ?? null,
    );

    await query(
      `INSERT INTO local_cloud_activations (
         business_id, installation_id, cloud_business_id, cloud_location_id,
         cloud_origin, cloud_installation_public_id, credential_id, credential_ciphertext,
         staged_credential_ciphertext, pending_ack, state, lock_reason, last_error_code,
         last_attempt_at, last_verified_at, consecutive_failures, next_retry_at,
         policy_version, entitlement_version, business_revision, business_digest,
         last_business_updated_at, entitlement_snapshot, policy_snapshot,
         lease_public_key, lease_payload, lease_signature, lease_expires_at,
         enforce_offline_lease, max_observed_clock_at, enrolled_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         NULL, true, 'active', NULL, NULL,
         $9::timestamptz, $9::timestamptz, 0, NULL,
         $10, $11, $12, $13,
         $9::timestamptz, $14::jsonb, $15::jsonb,
         $16, $17::jsonb, $18, $19::timestamptz,
         $20, GREATEST(now(), $9::timestamptz), $9::timestamptz, $9::timestamptz
       )
       ON CONFLICT (business_id) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         cloud_location_id = EXCLUDED.cloud_location_id,
         cloud_origin = EXCLUDED.cloud_origin,
         cloud_installation_public_id = EXCLUDED.cloud_installation_public_id,
         credential_id = EXCLUDED.credential_id,
         credential_ciphertext = EXCLUDED.credential_ciphertext,
         staged_credential_ciphertext = NULL,
         pending_ack = true,
         state = 'active',
         lock_reason = NULL,
         last_error_code = NULL,
         last_attempt_at = EXCLUDED.last_attempt_at,
         last_verified_at = EXCLUDED.last_verified_at,
         consecutive_failures = 0,
         next_retry_at = NULL,
         policy_version = EXCLUDED.policy_version,
         entitlement_version = EXCLUDED.entitlement_version,
         business_revision = EXCLUDED.business_revision,
         business_digest = EXCLUDED.business_digest,
         last_business_updated_at = EXCLUDED.last_business_updated_at,
         entitlement_snapshot = EXCLUDED.entitlement_snapshot,
         policy_snapshot = EXCLUDED.policy_snapshot,
         lease_public_key = EXCLUDED.lease_public_key,
         lease_payload = EXCLUDED.lease_payload,
         lease_signature = EXCLUDED.lease_signature,
         lease_expires_at = EXCLUDED.lease_expires_at,
         enforce_offline_lease = EXCLUDED.enforce_offline_lease,
         max_observed_clock_at = GREATEST(local_cloud_activations.max_observed_clock_at, EXCLUDED.max_observed_clock_at),
         updated_at = EXCLUDED.updated_at`,
      [
        localBusinessId,
        enrolled.installationId,
        enrolled.businessBundle.businessId,
        enrolled.businessBundle.location.id,
        enrolled.cloudOrigin,
        enrolled.installationPublicId,
        enrolled.credentialId,
        sealed,
        now,
        enrolled.businessBundle.policy.policyVersion,
        enrolled.businessBundle.policy.entitlementVersion,
        enrolled.businessBundle.revision,
        enrolled.businessBundle.digest,
        JSON.stringify({
          plan: enrolled.businessBundle.plan,
          features: enrolled.businessBundle.features,
          appAvailability: enrolled.businessBundle.appAvailability,
        }),
        JSON.stringify(enrolled.businessBundle.policy),
        enrolled.lease.publicKeyPem,
        JSON.stringify(enrolled.lease.payload),
        enrolled.lease.signature,
        enrolled.lease.payload.expiresAt,
        enrolled.lease.payload.enforceOfflineLease,
      ],
    );

    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_activation.committed', 'local_cloud_activation', $1::uuid::text, $3)`,
      [
        localBusinessId,
        actorUserId,
        JSON.stringify({
          cloudOrigin: enrolled.cloudOrigin,
          cloudBusinessId: enrolled.businessBundle.businessId,
          installationPublicId: enrolled.installationPublicId,
          resumed: enrolled.resumed,
        }),
      ],
    );
  });

  // Phase 2 acknowledgement (best-effort; retried automatically on validation ticks if offline).
  try {
    const ackRes = await fetch(`${enrolled.cloudOrigin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${enrolled.token}`,
      },
      body: JSON.stringify({
        action: "acknowledge",
        installationId: enrolled.installationId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (ackRes.ok) {
      await withTenant(localBusinessId, () =>
        query(
          `UPDATE local_cloud_activations SET pending_ack = false, updated_at = now()
            WHERE business_id = $1`,
          [localBusinessId],
        ),
      );
      return { acknowledged: true };
    }
  } catch {
    // Kept as pending_ack = true; self-heals on next validation tick.
  }
  return { acknowledged: false };
}

/**
 * Safe upgrade/enrollment path for pre-existing legacy Full Offline (`local`)
 * installations that already hold operational data:
 *   1. Records a verified pre-enrollment recovery snapshot of business/location/settings
 *      metadata in `audit_log` (and preserves every local operational row untouched),
 *   2. Verifies & enrolls against Cloud,
 *   3. Keeps `deployment.profile = 'local'` (never converting to Hybrid!).
 */
export async function enrollLegacyLocalInstallation(input: {
  localBusinessId: string;
  cloudUrl: string;
  token: string;
  actorUserId: string;
}): Promise<{ ok: true; view: LocalActivationRecordView } | { ok: false; httpStatus: number; error: string }> {
  const existing = await withTenant(input.localBusinessId, () =>
    readRawActivationRow(input.localBusinessId),
  );
  if (existing && existing.state !== "not_enrolled") {
    return { ok: false, httpStatus: 409, error: "already_enrolled" };
  }

  const enrollRes = await requestCloudEnrollmentFromSite({
    cloudUrl: input.cloudUrl,
    token: input.token,
  });
  if (!enrollRes.ok) return enrollRes;

  // Record verified pre-enrollment metadata safeguard before applying Cloud refresh.
  await withTenantTransaction(input.localBusinessId, async () => {
    const [bizBefore, locBefore, counts] = await Promise.all([
      query(`SELECT id, name, slug::text, plan, industry, status::text FROM businesses WHERE id = $1`, [
        input.localBusinessId,
      ]),
      query(`SELECT id, name, address, phone FROM locations WHERE business_id = $1`, [
        input.localBusinessId,
      ]),
      query<{ orders: string; users: string }>(
        `SELECT (SELECT count(*)::text FROM orders o JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1) AS orders,
                (SELECT count(*)::text FROM users WHERE business_id = $1) AS users`,
        [input.localBusinessId],
      ),
    ]);
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_activation.pre_enrollment_safeguard', 'business', $1::uuid::text, $3)`,
      [
        input.localBusinessId,
        input.actorUserId,
        JSON.stringify({
          businessBefore: bizBefore.rows[0] ?? null,
          locationsBefore: locBefore.rows,
          preservedOperationalCounts: counts.rows[0] ?? { orders: "0", users: "0" },
        }),
      ],
    );
  });

  await commitLocalActivationRecordAndAcknowledge(
    input.localBusinessId,
    enrollRes.enrolled,
    input.actorUserId,
  );
  const view = await withTenant(input.localBusinessId, () =>
    getLocalActivationView(input.localBusinessId, { probeReachability: true }),
  );
  return { ok: true, view };
}

/**
 * Credential replacement / Cloud URL migration for an already-enrolled (or
 * `locked_invalid`) Full Offline installation. Strictly enforces `cloud_business_id`
 * continuity so a token from another business can NEVER cross-bind this DB.
 */
export async function repairOrReenrollLocalInstallation(input: {
  localBusinessId: string;
  cloudUrl?: string | null;
  token: string;
  actorUserId: string;
}): Promise<{ ok: true; view: LocalActivationRecordView } | { ok: false; httpStatus: number; error: string }> {
  const existing = await withTenant(input.localBusinessId, () =>
    readRawActivationRow(input.localBusinessId),
  );
  if (!existing) {
    if (!input.cloudUrl) {
      return { ok: false, httpStatus: 400, error: "missing_cloud_url" };
    }
    return enrollLegacyLocalInstallation({
      localBusinessId: input.localBusinessId,
      cloudUrl: input.cloudUrl,
      token: input.token,
      actorUserId: input.actorUserId,
    });
  }

  const targetUrl = input.cloudUrl?.trim() ? input.cloudUrl.trim() : existing.cloud_origin;
  const enrollRes = await requestCloudEnrollmentFromSite({
    cloudUrl: targetUrl,
    token: input.token,
    expectedCloudBusinessId: existing.cloud_business_id,
  });
  if (!enrollRes.ok) return enrollRes;

  if (enrollRes.enrolled.businessBundle.businessId !== existing.cloud_business_id) {
    return { ok: false, httpStatus: 403, error: "business_mismatch" };
  }

  await commitLocalActivationRecordAndAcknowledge(
    input.localBusinessId,
    enrollRes.enrolled,
    input.actorUserId,
  );
  const view = await withTenant(input.localBusinessId, () =>
    getLocalActivationView(input.localBusinessId, { probeReachability: true }),
  );
  return { ok: true, view };
}

/**
 * Runs one Cloud device/business validation & refresh pass for `businessId`
 * (within `withTenant(businessId, ...)`).
 */
export async function runLocalActivationValidationForBusiness(
  businessId: string,
  options: { force?: boolean } = {},
): Promise<{
  ran: boolean;
  state: LocalActivationState;
  refreshed: boolean;
  error?: string | null;
}> {
  let row = await readRawActivationRow(businessId);
  if (!row || row.state === "not_enrolled") {
    return { ran: false, state: "not_enrolled", refreshed: false };
  }

  row = await evaluateAndPersistOfflineLeaseIfNeeded(row);
  const now = Date.now();

  if (!options.force) {
    // Locked installations require explicit Owner credential repair or manual retry.
    if (row.state === "locked_invalid") {
      return { ran: false, state: "locked_invalid", refreshed: false };
    }
    if (row.last_attempt_at && now - row.last_attempt_at.getTime() < MIN_AUTO_VALIDATION_GAP_MS) {
      return { ran: false, state: row.state, refreshed: false };
    }
    if (row.state === "validation_pending" && row.next_retry_at && now < row.next_retry_at.getTime()) {
      return { ran: false, state: row.state, refreshed: false };
    }
    if (
      row.state === "active" &&
      !row.pending_ack &&
      !row.staged_credential_ciphertext &&
      row.last_verified_at &&
      now - row.last_verified_at.getTime() < HEALTHY_VALIDATION_INTERVAL_MS
    ) {
      return { ran: false, state: "active", refreshed: false };
    }
  }

  const urlCheck = await validateCloudOriginForLocalActivation(row.cloud_origin);
  if (!urlCheck.ok) {
    return { ran: false, state: row.state, refreshed: false, error: urlCheck.error };
  }

  const stagedToken = openLocalCredential(row.staged_credential_ciphertext);
  const activeToken = openLocalCredential(row.credential_ciphertext);
  const bearer = stagedToken || activeToken;
  if (!bearer) {
    // Undecryptable local secret (e.g. missing OS key) -> transient error, never wipe data.
    return { ran: false, state: row.state, refreshed: false, error: "credential_undecryptable" };
  }

  let res: Response;
  try {
    res = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        action: "validate",
        installationId: row.installation_id,
        expectedBusinessId: row.cloud_business_id,
        currentBusinessDigest: row.business_digest,
        appVersion: process.env.DESKTOP_APP_VERSION ?? null,
        acknowledgeStagedToken: Boolean(stagedToken),
        healthSummary: {
          state: row.state,
          lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
          deploymentProfile: "local",
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const transientReason = classifyFetchException(err);
    const failures = row.consecutive_failures + 1;
    const backoffMs = computeValidationBackoffMs(failures, Math.random());
    const transition = computeNextActivationState(
      row.state,
      (row.lock_reason as ConfirmedCloudDenialCode | null) ?? null,
      { kind: "transient_failure", reason: transientReason },
    );
    await query(
      `UPDATE local_cloud_activations
          SET state = $2,
              lock_reason = $3,
              last_error_code = $4,
              last_attempt_at = now(),
              consecutive_failures = $5,
              next_retry_at = now() + ($6::bigint * interval '1 millisecond'),
              updated_at = now()
        WHERE business_id = $1`,
      [
        businessId,
        transition.nextState,
        transition.lockReason,
        transientReason,
        failures,
        backoffMs,
      ],
    );
    return {
      ran: true,
      state: transition.nextState,
      refreshed: false,
      error: transientReason,
    };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    protocol?: string;
    code?: string;
    unchanged?: boolean;
    businessBundle?: CloudAuthoritativeBusinessBundle | null;
    lease?: SignedOfflineLease;
    stagedCredential?: { credentialId: string; token: string } | null;
    rotationCompleted?: boolean;
  };

  if (!res.ok) {
    if (
      isConfirmedCloudDenial({
        httpStatus: res.status,
        protocol: payload.protocol,
        code: payload.code,
      })
    ) {
      // If a staged token failed, drop the staged token first before locking if an active token remains.
      if (stagedToken && activeToken) {
        await query(
          `UPDATE local_cloud_activations
              SET staged_credential_ciphertext = NULL, updated_at = now()
            WHERE business_id = $1`,
          [businessId],
        );
        return runLocalActivationValidationForBusiness(businessId, options);
      }

      const transition = computeNextActivationState(
        row.state,
        (row.lock_reason as ConfirmedCloudDenialCode | null) ?? null,
        {
          kind: "confirmed_denial",
          code: payload.code as ConfirmedCloudDenialCode,
        },
      );
      await withTenantTransaction(businessId, async () => {
        await query(
          `UPDATE local_cloud_activations
              SET state = $2,
                  lock_reason = $3,
                  last_error_code = $3,
                  last_attempt_at = now(),
                  updated_at = now()
            WHERE business_id = $1`,
          [businessId, transition.nextState, transition.lockReason],
        );
        await query(
          `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
           VALUES ($1, NULL, 'local_activation.locked_cloud_denial', 'local_cloud_activation', $1::uuid::text, $2)`,
          [businessId, JSON.stringify({ code: payload.code, httpStatus: res.status })],
        );
      });
      return {
        ran: true,
        state: "locked_invalid",
        refreshed: false,
        error: payload.code,
      };
    }

    // Non-confirmed error (5xx, 429, reverse proxy error): treat as transient!
    const reason = res.status === 429 ? "rate_limited" : "cloud_5xx";
    const failures = row.consecutive_failures + 1;
    const backoffMs = computeValidationBackoffMs(failures, Math.random());
    const transition = computeNextActivationState(
      row.state,
      (row.lock_reason as ConfirmedCloudDenialCode | null) ?? null,
      { kind: "transient_failure", reason },
    );
    await query(
      `UPDATE local_cloud_activations
          SET state = $2,
              lock_reason = $3,
              last_error_code = $4,
              last_attempt_at = now(),
              consecutive_failures = $5,
              next_retry_at = now() + ($6::bigint * interval '1 millisecond'),
              updated_at = now()
        WHERE business_id = $1`,
      [businessId, transition.nextState, transition.lockReason, reason, failures, backoffMs],
    );
    return { ran: true, state: transition.nextState, refreshed: false, error: reason };
  }

  // Validated OK!
  let refreshed = false;
  if (payload.businessBundle && !payload.unchanged) {
    if (payload.businessBundle.businessId !== row.cloud_business_id) {
      await query(
        `UPDATE local_cloud_activations
            SET state = 'locked_invalid', lock_reason = 'business_mismatch',
                last_error_code = 'business_mismatch', last_attempt_at = now(), updated_at = now()
          WHERE business_id = $1`,
        [businessId],
      );
      return { ran: true, state: "locked_invalid", refreshed: false, error: "business_mismatch" };
    }
    const applied = await applyCloudAuthoritativeBusinessBundleLocally(
      businessId,
      payload.businessBundle,
      row.business_digest,
    );
    refreshed = applied.updated;
  }

  let nextCredCiphertext = row.credential_ciphertext;
  let nextStagedCiphertext: string | null = row.staged_credential_ciphertext;
  let nextCredentialId = row.credential_id;

  if (payload.rotationCompleted && stagedToken) {
    nextCredCiphertext = row.staged_credential_ciphertext;
    nextStagedCiphertext = null;
  } else if (payload.stagedCredential?.token) {
    nextStagedCiphertext = sealLocalCredential(payload.stagedCredential.token);
    nextCredentialId = payload.stagedCredential.credentialId;
  }

  const bundle = payload.businessBundle;
  const lease = payload.lease;

  await query(
    `UPDATE local_cloud_activations
        SET credential_id = $2,
            credential_ciphertext = $3,
            staged_credential_ciphertext = $4,
            pending_ack = false,
            state = 'active',
            lock_reason = NULL,
            last_error_code = NULL,
            last_attempt_at = now(),
            last_verified_at = now(),
            consecutive_failures = 0,
            next_retry_at = NULL,
            policy_version = COALESCE($5, policy_version),
            entitlement_version = COALESCE($6, entitlement_version),
            business_revision = COALESCE($7, business_revision),
            business_digest = COALESCE($8, business_digest),
            last_business_updated_at = CASE WHEN $9::boolean THEN now() ELSE last_business_updated_at END,
            lease_public_key = COALESCE($10, lease_public_key),
            lease_payload = COALESCE($11::jsonb, lease_payload),
            lease_signature = COALESCE($12, lease_signature),
            lease_expires_at = COALESCE($13::timestamptz, lease_expires_at),
            enforce_offline_lease = COALESCE($14, enforce_offline_lease),
            max_observed_clock_at = GREATEST(max_observed_clock_at, now()),
            updated_at = now()
      WHERE business_id = $1`,
    [
      businessId,
      nextCredentialId,
      nextCredCiphertext,
      nextStagedCiphertext,
      bundle?.policy.policyVersion ?? null,
      bundle?.policy.entitlementVersion ?? null,
      bundle?.revision ?? null,
      bundle?.digest ?? null,
      refreshed,
      lease?.publicKeyPem ?? null,
      lease ? JSON.stringify(lease.payload) : null,
      lease?.signature ?? null,
      lease?.payload.expiresAt ?? null,
      lease ? lease.payload.enforceOfflineLease : null,
    ],
  );

  // If Cloud just handed us a newly staged credential, complete the ack right away.
  if (payload.stagedCredential?.token && !payload.rotationCompleted) {
    await runLocalActivationValidationForBusiness(businessId, { force: true }).catch(() => {});
  }

  return { ran: true, state: "active", refreshed, error: null };
}

/**
 * Background tick invoked on `site` servers (`server.ts`): iterates enrolled
 * `local` businesses and executes rate-limited periodic validation/refresh.
 */
export async function runLocalActivationValidationTick(): Promise<number> {
  if (deploymentRole() !== "site") return 0;
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string }>(
      `SELECT a.business_id
         FROM local_cloud_activations a
        WHERE a.state IN ('active', 'validation_pending', 'validating')
        ORDER BY a.updated_at ASC
        LIMIT 25`,
    ),
  );
  let checked = 0;
  for (const row of rows) {
    try {
      const deployment = await withTenant(row.business_id, () =>
        readDeploymentProfile(row.business_id),
      );
      if (deployment.profile !== "local") continue;
      const res = await withTenant(row.business_id, () =>
        runLocalActivationValidationForBusiness(row.business_id),
      );
      if (res.ran) checked += 1;
    } catch {
      // Never let one tenant interrupt background validation for another.
    }
  }
  return checked;
}

// ── Online-only Support & Bug Report Forwarding from Local Site ──────────────

export type LocalOnlineSupportFailure =
  | "cloud_enrollment_required"
  | "local_installation_locked"
  | "cloud_support_offline"
  | "cloud_validation_failed"
  | "not_found"
  | "invalid_fields"
  | "invalid_attachment"
  | "invalid_status";

export async function callCloudOnlineSupportFromSite<T>(
  businessId: string,
  request:
    | { method: "GET"; queryParams: Record<string, string> }
    | { method: "POST"; body: Record<string, unknown> },
): Promise<{ ok: true; data: T } | { ok: false; httpStatus: number; error: LocalOnlineSupportFailure }> {
  const row = await readRawActivationRow(businessId);
  if (!row || row.state === "not_enrolled") {
    return { ok: false, httpStatus: 503, error: "cloud_enrollment_required" };
  }

  const checkedRow = await evaluateAndPersistOfflineLeaseIfNeeded(row);
  const bearer = openLocalCredential(checkedRow.credential_ciphertext);
  if (!bearer) {
    return { ok: false, httpStatus: 503, error: "cloud_validation_failed" };
  }

  const urlCheck = await validateCloudOriginForLocalActivation(checkedRow.cloud_origin);
  if (!urlCheck.ok) {
    return { ok: false, httpStatus: 503, error: "cloud_support_offline" };
  }

  let res: Response;
  try {
    if (request.method === "GET") {
      const qs = new URLSearchParams(request.queryParams).toString();
      res = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}?${qs}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "x-installation-id": checkedRow.installation_id,
          "x-cloud-business-id": checkedRow.cloud_business_id,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
    } else {
      res = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
          "x-installation-id": checkedRow.installation_id,
        },
        body: JSON.stringify({
          ...request.body,
          installationId: checkedRow.installation_id,
          cloudBusinessId: checkedRow.cloud_business_id,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
    }
  } catch {
    return { ok: false, httpStatus: 503, error: "cloud_support_offline" };
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (
      isConfirmedCloudDenial({
        httpStatus: res.status,
        protocol: typeof payload.protocol === "string" ? payload.protocol : null,
        code: typeof payload.code === "string" ? payload.code : null,
      })
    ) {
      await query(
        `UPDATE local_cloud_activations
            SET state = 'locked_invalid', lock_reason = $2, last_error_code = $2,
                last_attempt_at = now(), updated_at = now()
          WHERE business_id = $1`,
        [businessId, payload.code],
      );
      return { ok: false, httpStatus: 423, error: "local_installation_locked" };
    }
    if (res.status === 404) return { ok: false, httpStatus: 404, error: "not_found" };
    if (res.status === 400) {
      const code = String(payload.error ?? "invalid_fields");
      if (code === "invalid_attachment" || code === "invalid_screenshot") {
        return { ok: false, httpStatus: 400, error: "invalid_attachment" };
      }
      if (code === "invalid_status") {
        return { ok: false, httpStatus: 400, error: "invalid_status" };
      }
      return { ok: false, httpStatus: 400, error: "invalid_fields" };
    }
    return { ok: false, httpStatus: 503, error: "cloud_support_offline" };
  }

  return { ok: true, data: payload as T };
}

export interface UnsentSupportDraftView {
  eventId: string;
  kind: string;
  createdAt: string;
  summary: string;
}

export async function listUnsentSupportDrafts(
  businessId: string,
): Promise<UnsentSupportDraftView[]> {
  const { rows } = await query<{
    event_id: string;
    kind: string;
    created_at: Date;
    payload: Record<string, unknown>;
  }>(
    `SELECT event_id::text AS event_id, kind, occurred_at AS created_at, payload
       FROM cloud_exception_outbox
      WHERE business_id = $1
      ORDER BY occurred_at DESC
      LIMIT 20`,
    [businessId],
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    kind: r.kind,
    createdAt: r.created_at.toISOString(),
    summary: String(
      r.payload?.subject ?? r.payload?.description ?? r.payload?.body ?? r.kind,
    ).slice(0, 120),
  }));
}

export async function discardUnsentSupportDraft(
  businessId: string,
  eventId: string,
  actorUserId: string,
): Promise<boolean> {
  return withTenantTransaction(businessId, async () => {
    const { rowCount } = await query(
      `DELETE FROM cloud_exception_outbox WHERE business_id = $1 AND event_id = $2::uuid`,
      [businessId, eventId],
    );
    if (rowCount) {
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'support.unsent_draft_discarded', 'cloud_exception_outbox', $3, '{}'::jsonb)`,
        [businessId, actorUserId, eventId],
      );
    }
    return Boolean(rowCount);
  });
}
