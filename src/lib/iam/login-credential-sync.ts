/**
 * The site's login-credential reconciliation, as one reusable step.
 *
 * Memberships arrive through `runIamSync()`'s snapshot/event plane; passwords
 * and staff PINs arrive through `/api/iam/login-credentials`. Until PR #837
 * the second call was best-effort inside `runIamSync()`: a failure was a
 * `console.error`, the membership plane stayed `healthy`, and cloud-created
 * cashiers simply never appeared on the quick-login roster — with no durable
 * evidence anywhere that their credentials were missing.
 *
 * This module owns that second plane:
 *  - `syncHybridLoginCredentials()` performs one full reconciliation (report
 *    spent recovery codes → fetch → validate → apply PINs → apply passwords →
 *    measure what is still missing → record the outcome) and is the single
 *    entry point used by the sync tick, pairing completion, the manual sync
 *    button and the repair action.
 *  - `pinCredentialGap()` answers "how many active PIN-role members can
 *    actually sign in here?", the diagnostic that makes an owner-only roster
 *    explicit instead of silent.
 *  - `readHybridIdentityStatus()` reads both planes plus that gap and hands
 *    them to the pure `hybridIdentityHealth()` resolver.
 *
 * A failure here does not stop operational sync — the product decision that
 * already existed — but it now persists `degraded` + the reason, and every
 * surface that answers "is Hybrid healthy?" reads it.
 *
 * DB-touching, so per repo convention no direct unit test — covered by
 * integration/hybrid-credential-sync.integration.test.ts.
 */
import { query, withTenant } from "../db";
import { getSetting, SETTING_KEYS } from "../settings";
import type { ServerSyncConfig } from "../server-sync-config";
import {
  type ReplicatedLoginCredential,
  type ReplicatedPin,
  validateLoginCredentialPayload,
} from "./login-credentials";
import {
  applyLoginCredentials,
  applyReplicatedPins,
  spentRecoveryCodes,
} from "./login-credentials-service";
import {
  credentialSyncNeedsAttention,
  hybridIdentityHealth,
  type CredentialSyncSnapshot,
  type CredentialSyncStatus,
  type HybridIdentityHealthResult,
  type IdentitySyncStatus,
} from "./credential-health";

/** Connection details one reconciliation needs; a subset of ServerSyncConfig. */
export interface CredentialSyncConfig {
  enabled?: boolean;
  remoteUrl?: string | null;
  token?: string | null;
  siteDeviceId?: string | null;
}

export interface PinCredentialGap {
  /** Active cashier/waiter/kitchen memberships this site expects on the roster. */
  expected: number;
  /** How many of them hold an active usable local PIN. */
  usable: number;
  /** `expected - usable`, the number the login screen warns about. */
  missing: number;
  /** Names/roles only — never a credential. */
  missingMembers: Array<{ id: string; fullName: string; role: string }>;
}

export interface CredentialSyncResult {
  status: CredentialSyncStatus;
  businessId: string;
  siteDeviceId: string | null;
  error: string | null;
  httpStatus: number | null;
  credentialsReceived: number;
  pinsReceived: number;
  pinsApplied: number;
  identitiesApplied: number;
  pinMembersExpected: number;
  pinMembersUsable: number;
  pinMembersMissing: number;
  missingIdentityBindings: number;
  /** True when this pass wrote or relinked at least one credential. */
  changed: boolean;
  gap: PinCredentialGap;
}

export interface IdentitySyncSnapshot {
  state: IdentitySyncStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

/** How much of the membership/identity plane is present locally. */
export interface MembershipCounts {
  /** Active memberships the site holds (what the cloud snapshot expects). */
  expected: number;
  /** Active password-role memberships (owner/admin/manager/accountant). */
  passwordRoles: number;
  /** Password-role memberships already linked to a replicated global identity. */
  linkedIdentities: number;
}

export interface HybridIdentityStatus extends HybridIdentityHealthResult {
  configured: boolean;
  siteDeviceId: string | null;
  identity: IdentitySyncSnapshot | null;
  credentials: CredentialSyncSnapshot | null;
  /** Live measure right now, next to the counts recorded at the last sync. */
  pinGap: PinCredentialGap;
  memberships: MembershipCounts;
  missingIdentityBindings: number;
}

const IDENTITY_STATUSES: readonly IdentitySyncStatus[] = [
  "healthy", "pending", "syncing", "degraded", "conflict", "snapshot_required", "offline",
] as const;

function baseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EMPTY_GAP: PinCredentialGap = { expected: 0, usable: 0, missing: 0, missingMembers: [] };

/**
 * The owner-only symptom, measured directly: active PIN-role memberships
 * (cashier/waiter/kitchen) with no active PIN in `employee_credentials` and no
 * legacy `users.pin_hash` fallback. These are exactly the members
 * `loginRoster()` omits, so a non-zero `missing` means the roster is
 * incomplete — not that the business has fewer staff.
 */
export async function pinCredentialGap(businessId: string): Promise<PinCredentialGap> {
  const { rows } = await query<{ id: string; full_name: string; role: string; usable: boolean }>(
    `SELECT u.id, u.full_name, u.role::text AS role,
            (u.pin_hash IS NOT NULL OR EXISTS (
               SELECT 1 FROM employee_credentials pin
                WHERE pin.employee_id = u.id AND pin.business_id = u.business_id
                  AND pin.credential_type = 'pin' AND pin.status = 'active'
             )) AS usable
       FROM users u
      WHERE u.business_id = $1
        AND u.is_active
        AND u.membership_status = 'active'
        AND u.role IN ('cashier','waiter','kitchen')
      ORDER BY u.full_name`,
    [businessId],
  );
  const missingMembers = rows
    .filter((row) => !row.usable)
    .map((row) => ({ id: row.id, fullName: row.full_name, role: row.role }));
  return {
    expected: rows.length,
    usable: rows.length - missingMembers.length,
    missing: missingMembers.length,
    missingMembers,
  };
}

/**
 * Membership/identity counts for Hybrid diagnostics: how many active
 * memberships exist, how many of them are password-role members who should
 * carry a replicated global identity, and how many already do.
 */
export async function membershipCounts(businessId: string): Promise<MembershipCounts> {
  const { rows } = await query<{ expected: string; password_roles: string; linked: string }>(
    `SELECT
       count(*)::text AS expected,
       count(*) FILTER (WHERE role IN ('owner','admin','manager','accountant'))::text AS password_roles,
       count(*) FILTER (WHERE role IN ('owner','admin','manager','accountant') AND platform_user_id IS NOT NULL)::text AS linked
     FROM users
     WHERE business_id = $1 AND is_active AND membership_status = 'active'`,
    [businessId],
  );
  const row = rows[0];
  return {
    expected: Number(row?.expected ?? 0),
    passwordRoles: Number(row?.password_roles ?? 0),
    linkedIdentities: Number(row?.linked ?? 0),
  };
}

/**
 * Password-role members (owner/admin/manager/accountant) that still have no
 * replicated global identity. On a Hybrid site these are the members whose
 * cloud password/session revocation chain is not yet in place locally, which
 * is also what makes «ورود با حساب ابری» temporarily unbound (see
 * src/app/api/auth/cloud-login/callback/route.ts).
 */
export async function missingGlobalIdentityBindings(businessId: string): Promise<number> {
  const counts = await membershipCounts(businessId);
  return Math.max(0, counts.passwordRoles - counts.linkedIdentities);
}

export async function readCredentialSyncState(
  businessId: string,
  siteDeviceId: string,
): Promise<CredentialSyncSnapshot | null> {
  const { rows } = await query<{
    status: CredentialSyncStatus;
    last_attempt_at: Date | null;
    last_success_at: Date | null;
    last_error: string | null;
    credentials_received: number;
    pins_received: number;
    pins_applied: number;
    identities_applied: number;
    pin_members_expected: number;
    pin_members_usable: number;
    pin_members_missing: number;
    missing_identity_bindings: number;
    converged_at: Date | null;
  }>(
    `SELECT status,last_attempt_at,last_success_at,last_error,credentials_received,pins_received,pins_applied,
            identities_applied,pin_members_expected,pin_members_usable,pin_members_missing,missing_identity_bindings,converged_at
       FROM iam_login_credential_sync_state
      WHERE business_id=$1 AND site_device_id=$2`,
    [businessId, siteDeviceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastError: row.last_error,
    credentialsReceived: row.credentials_received,
    pinsReceived: row.pins_received,
    pinsApplied: row.pins_applied,
    identitiesApplied: row.identities_applied,
    pinMembersExpected: row.pin_members_expected,
    pinMembersUsable: row.pin_members_usable,
    pinMembersMissing: row.pin_members_missing,
    missingIdentityBindings: row.missing_identity_bindings,
    convergedAt: row.converged_at?.toISOString() ?? null,
  };
}

export async function readIdentitySyncState(
  businessId: string,
  siteDeviceId: string,
): Promise<IdentitySyncSnapshot | null> {
  const { rows } = await query<{ status: string; last_attempt_at: Date | null; last_success_at: Date | null; last_error: string | null }>(
    `SELECT status,last_attempt_at,last_success_at,last_error
       FROM iam_sync_state WHERE business_id=$1 AND site_device_id=$2`,
    [businessId, siteDeviceId],
  );
  const row = rows[0];
  if (!row) return null;
  const state = (IDENTITY_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as IdentitySyncStatus)
    : "degraded";
  return {
    state,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

interface CredentialStateWrite {
  status: CredentialSyncStatus;
  error: string | null;
  credentialsReceived?: number;
  pinsReceived?: number;
  pinsApplied?: number;
  identitiesApplied?: number;
  gap: PinCredentialGap;
  missingIdentityBindings: number;
}

async function recordCredentialState(businessId: string, siteDeviceId: string, write: CredentialStateWrite): Promise<void> {
  const healthy = write.status === "healthy";
  await query(
    `INSERT INTO iam_login_credential_sync_state
       (business_id,site_device_id,status,last_attempt_at,last_success_at,last_error,credentials_received,pins_received,
        pins_applied,identities_applied,pin_members_expected,pin_members_usable,pin_members_missing,
        missing_identity_bindings,converged_at)
     VALUES ($1,$2,$3,now(),CASE WHEN $3='healthy' THEN now() END,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $3='healthy' THEN now() END)
     ON CONFLICT (business_id,site_device_id) DO UPDATE SET
       status=$3,last_attempt_at=now(),last_error=$4,
       last_success_at=CASE WHEN $3='healthy' THEN now() ELSE iam_login_credential_sync_state.last_success_at END,
       credentials_received=$5,pins_received=$6,pins_applied=$7,identities_applied=$8,
       pin_members_expected=$9,pin_members_usable=$10,pin_members_missing=$11,missing_identity_bindings=$12,
       converged_at=CASE WHEN $3='healthy' THEN now() ELSE iam_login_credential_sync_state.converged_at END`,
    [
      businessId, siteDeviceId, write.status, write.error,
      write.credentialsReceived ?? 0, write.pinsReceived ?? 0, write.pinsApplied ?? 0, write.identitiesApplied ?? 0,
      write.gap.expected, write.gap.usable, write.gap.missing, write.missingIdentityBindings,
    ],
  );
}

interface FailureContext {
  businessId: string;
  siteDeviceId: string;
  httpStatus: number | null;
  credentialsReceived: number;
  pinsReceived: number;
  pinsApplied: number;
  identitiesApplied: number;
}

async function fail(
  context: FailureContext,
  status: CredentialSyncStatus,
  message: string,
): Promise<CredentialSyncResult> {
  const gap = await pinCredentialGap(context.businessId);
  const missingIdentityBindings = await missingGlobalIdentityBindings(context.businessId);
  await recordCredentialState(context.businessId, context.siteDeviceId, {
    status,
    error: message.slice(0, 500),
    credentialsReceived: context.credentialsReceived,
    pinsReceived: context.pinsReceived,
    pinsApplied: context.pinsApplied,
    identitiesApplied: context.identitiesApplied,
    gap,
    missingIdentityBindings,
  });
  return {
    status,
    businessId: context.businessId,
    siteDeviceId: context.siteDeviceId,
    error: message,
    httpStatus: context.httpStatus,
    credentialsReceived: context.credentialsReceived,
    pinsReceived: context.pinsReceived,
    pinsApplied: context.pinsApplied,
    identitiesApplied: context.identitiesApplied,
    pinMembersExpected: gap.expected,
    pinMembersUsable: gap.usable,
    pinMembersMissing: gap.missing,
    missingIdentityBindings,
    changed: false,
    gap,
  };
}

/**
 * One full pass of the login-credential plane.
 *
 * Statuses recorded:
 *  - `healthy` — payload fetched, validated and applied, and every active
 *    PIN-role member can sign in locally;
 *  - `degraded` — any non-404 HTTP failure, invalid payload, apply failure, a
 *    failed spent-code report, or a remaining PIN gap. This is the state that
 *    must stop the connection UI from claiming full health;
 *  - `unsupported_legacy_cloud` — the cloud genuinely has no credential
 *    endpoint (404). Supported for backward compatibility, never green;
 *  - `pending` — configuration exists but the first pass has not run.
 */
export async function syncHybridLoginCredentials(
  businessId: string,
  options: { config?: CredentialSyncConfig | null } = {},
): Promise<CredentialSyncResult> {
  return withTenant(businessId, async () => {
    const config = options.config
      ?? (await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig));
    const remoteUrl = config?.remoteUrl?.trim() ?? "";
    const token = config?.token?.trim() ?? "";
    const siteDeviceId = config?.siteDeviceId ?? null;
    if (!remoteUrl || !token || !siteDeviceId) {
      return {
        status: "pending",
        businessId,
        siteDeviceId,
        error: "site_sync_not_configured",
        httpStatus: null,
        credentialsReceived: 0,
        pinsReceived: 0,
        pinsApplied: 0,
        identitiesApplied: 0,
        pinMembersExpected: 0,
        pinMembersUsable: 0,
        pinMembersMissing: 0,
        missingIdentityBindings: 0,
        changed: false,
        gap: { ...EMPTY_GAP },
      };
    }

    await query(
      `INSERT INTO iam_login_credential_sync_state (business_id,site_device_id,status,last_attempt_at,last_error)
       VALUES ($1,$2,'syncing',now(),NULL)
       ON CONFLICT (business_id,site_device_id)
         DO UPDATE SET status='syncing',last_attempt_at=now(),last_error=NULL`,
      [businessId, siteDeviceId],
    );

    const context: FailureContext = {
      businessId, siteDeviceId, httpStatus: null,
      credentialsReceived: 0, pinsReceived: 0, pinsApplied: 0, identitiesApplied: 0,
    };
    const headers = { Authorization: `Bearer ${token}` };
    let reportedSpentCodes = true;

    // Spent recovery codes first: the payload fetched next already carries
    // them spent, so the two replicas compare equal and a code burned here
    // cannot be replayed against the cloud.
    try {
      const spent = await spentRecoveryCodes(businessId);
      if (spent.length > 0) {
        const response = await fetch(`${baseUrl(remoteUrl)}/api/iam/login-credentials`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ spent }),
          signal: AbortSignal.timeout(30_000),
        });
        // 404/405 means an older cloud that predates the endpoint; the fetch
        // below reports `unsupported_legacy_cloud` in that case.
        reportedSpentCodes = response.ok || response.status === 404 || response.status === 405;
        if (!reportedSpentCodes) context.httpStatus = response.status;
      }
    } catch (error) {
      reportedSpentCodes = false;
      return fail(context, "degraded", `spent_recovery_codes_unreachable: ${errorText(error)}`);
    }

    let payload: unknown;
    try {
      const response = await fetch(`${baseUrl(remoteUrl)}/api/iam/login-credentials`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      context.httpStatus = response.status;
      if (response.status === 404 || response.status === 405) {
        // Backward compatibility with a cloud that predates #837. Not an
        // error, but never reported as fully healthy either: PIN staff made
        // there cannot sign in here.
        return fail(context, "unsupported_legacy_cloud", "cloud_has_no_login_credential_endpoint");
      }
      if (!response.ok) return fail(context, "degraded", `login_credentials_http_${response.status}`);
      payload = await response.json();
    } catch (error) {
      return fail(context, "degraded", `login_credentials_unreachable: ${errorText(error)}`);
    }

    const validated = validateLoginCredentialPayload(payload);
    if (!validated.ok) return fail(context, "degraded", `login_credentials_invalid: ${validated.code}`);

    const credentials: ReplicatedLoginCredential[] = validated.credentials;
    const pins: ReplicatedPin[] = validated.pins;
    context.credentialsReceived = credentials.length;
    context.pinsReceived = pins.length;

    // PINs and passwords are independent planes on purpose: one failing must
    // not silently hold back the other, but either failure is visible.
    let pinsApplied = 0;
    try {
      pinsApplied = await applyReplicatedPins(businessId, pins);
      context.pinsApplied = pinsApplied;
    } catch (error) {
      return fail(context, "degraded", `pin_apply_failed: ${errorText(error)}`);
    }

    let identitiesApplied = 0;
    try {
      const changed = await applyLoginCredentials(businessId, credentials);
      identitiesApplied = changed ? credentials.length : 0;
      context.identitiesApplied = identitiesApplied;
    } catch (error) {
      return fail(context, "degraded", `login_credential_apply_failed: ${errorText(error)}`);
    }

    const gap = await pinCredentialGap(businessId);
    const missingIdentityBindings = await missingGlobalIdentityBindings(businessId);
    // A credential pass that fetched and applied cleanly can still leave a
    // roster gap: a membership created after the cloud built its PIN list, or
    // a local-only PIN-role member. That is exactly the owner-only symptom and
    // it is degraded, not healthy.
    const status: CredentialSyncStatus = gap.missing > 0 ? "degraded" : "healthy";
    const error = !reportedSpentCodes
      ? "spent_recovery_codes_not_reported"
      : gap.missing > 0
        ? `pin_credentials_missing:${gap.missing}`
        : missingIdentityBindings > 0
          ? `identity_bindings_missing:${missingIdentityBindings}`
          : null;
    await recordCredentialState(businessId, siteDeviceId, {
      status,
      error,
      credentialsReceived: credentials.length,
      pinsReceived: pins.length,
      pinsApplied,
      identitiesApplied,
      gap,
      missingIdentityBindings,
    });
    return {
      status,
      businessId,
      siteDeviceId,
      error,
      httpStatus: context.httpStatus,
      credentialsReceived: credentials.length,
      pinsReceived: pins.length,
      pinsApplied,
      identitiesApplied,
      pinMembersExpected: gap.expected,
      pinMembersUsable: gap.usable,
      pinMembersMissing: gap.missing,
      missingIdentityBindings,
      changed: pinsApplied > 0 || identitiesApplied > 0,
      gap,
    };
  });
}

/**
 * Both identity planes plus the live roster gap, resolved into one overall
 * verdict. Used by `/api/connection/status`, `/api/team/iam-status` and the
 * login screen so all three tell the same story.
 */
export async function readHybridIdentityStatus(
  businessId: string,
  options: { config?: CredentialSyncConfig | null } = {},
): Promise<HybridIdentityStatus> {
  return withTenant(businessId, async () => {
    const config = options.config
      ?? (await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig));
    const configured = Boolean(config?.enabled && config.remoteUrl?.trim() && config.token?.trim() && config.siteDeviceId);
    const siteDeviceId = config?.siteDeviceId ?? null;
    if (!configured || !siteDeviceId) {
      return {
        configured: false,
        siteDeviceId,
        identity: null,
        credentials: null,
        pinGap: { ...EMPTY_GAP },
        memberships: { expected: 0, passwordRoles: 0, linkedIdentities: 0 },
        missingIdentityBindings: 0,
        overall: "not_configured",
        degradedBy: null,
        reason: null,
      };
    }
    const [identity, credentials, pinGap, memberships] = await Promise.all([
      readIdentitySyncState(businessId, siteDeviceId),
      readCredentialSyncState(businessId, siteDeviceId),
      pinCredentialGap(businessId),
      membershipCounts(businessId),
    ]);
    const missingIdentityBindings = Math.max(0, memberships.passwordRoles - memberships.linkedIdentities);
    // The live gap is passed into the resolver, so a member created after the
    // last credential pass cannot be outvoted by a stored "healthy" record.
    const health = hybridIdentityHealth({
      configured: true,
      identity: identity?.state ?? null,
      credentials: credentials?.status ?? null,
      pinMembersMissing: pinGap.missing,
    });
    return { configured: true, siteDeviceId, identity, credentials, pinGap, memberships, missingIdentityBindings, ...health };
  });
}
