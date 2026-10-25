/**
 * The vocabulary of Hybrid identity health, kept pure so both the API routes
 * and the screens agree on what "green" means.
 *
 * The point of this module is the split the 1.0.18 fix left open: membership
 * convergence and login-credential convergence are two different planes. A
 * site can hold every membership and still have staff who cannot sign in,
 * because their PIN arrives through `/api/iam/login-credentials`. Anything
 * that answers "is Hybrid identity healthy?" must read both — never the
 * membership snapshot alone.
 */

/** Durable credential-stage state, stored in `iam_login_credential_sync_state`. */
export type CredentialSyncStatus =
  | "healthy"
  | "pending"
  | "syncing"
  | "degraded"
  | "unsupported_legacy_cloud"
  | "snapshot_required"
  | "repair_required";

/** The evidence the credential stage recorded, without any secret material. */
export interface CredentialSyncSnapshot {
  status: CredentialSyncStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  credentialsReceived: number;
  pinsReceived: number;
  pinsApplied: number;
  /** Issue #850: staff PINs the cloud removed; the last pass revoked them here. */
  pinsRevoked: number;
  identitiesApplied: number;
  pinMembersExpected: number;
  pinMembersUsable: number;
  pinMembersMissing: number;
  missingIdentityBindings: number;
  /**
   * Issue #948 P0-1 — identity bindings the payload named that are *still*
   * wrong/missing after the last pass, plus identity email conflicts left for
   * review. This is the "identity correctly bound" measure: zero is the only
   * value that may read green. Separate from `missingIdentityBindings` (the
   * crude count of password-role members without any link, which includes
   * legitimate PIN-only managers the cloud has no identity for).
   */
  identityMismatches: number;
  /** Pre-v2 local identity UUIDs migrated onto the canonical cloud ID. */
  identityRekeys: number;
  /** Which contract the last payload spoke: canonical v2 or legacy v1. */
  identityContract: "canonical" | "legacy" | null;
  convergedAt: string | null;
}

/** Membership/identity plane as `iam_sync_state` records it. */
export type IdentitySyncStatus =
  | "healthy"
  | "pending"
  | "syncing"
  | "degraded"
  | "conflict"
  | "snapshot_required"
  | "offline";

/** Operational (master data / push / pull) plane summary. */
export type OperationalSyncStatus =
  | "connected"
  | "connecting"
  | "paused"
  | "not_configured"
  | "attention_required";

export type HybridIdentityHealth =
  | "healthy"
  | "syncing"
  | "degraded"
  | "limited"
  | "not_configured";

export interface HybridIdentityHealthInput {
  configured: boolean;
  identity: IdentitySyncStatus | null;
  credentials: CredentialSyncStatus | null;
  /** Active PIN-role memberships with no usable local PIN, as last measured. */
  pinMembersMissing?: number;
  /**
   * Issue #948 P1-6 — identity bindings the cloud's payload named that are
   * not in place (wrong or missing `users.platform_user_id` link, or an
   * unresolved identity email conflict). Credential hashes can all match
   * while this is non-zero; "healthy" must never be reported then, or
   * `identity_not_synced` is invisible until someone tries cloud login.
   * Deliberately *not* "every password-role member without a link": a
   * PIN-eligible manager the cloud has no identity for is legitimate.
   */
  identityBindingsMissing?: number;
}

export interface HybridIdentityHealthResult {
  overall: HybridIdentityHealth;
  /** Which plane made it not-green; null when overall is healthy. */
  degradedBy: "identity" | "credentials" | null;
  reason: string | null;
}

export const CREDENTIAL_SYNC_STATUSES: readonly CredentialSyncStatus[] = [
  "healthy", "pending", "syncing", "degraded", "unsupported_legacy_cloud", "snapshot_required", "repair_required",
] as const;

export function isCredentialSyncStatus(value: unknown): value is CredentialSyncStatus {
  return typeof value === "string" && (CREDENTIAL_SYNC_STATUSES as readonly string[]).includes(value);
}

/** A state that must never be rendered as a green identity. */
export function credentialSyncNeedsAttention(status: CredentialSyncStatus | null): boolean {
  return status === null
    || status === "pending"
    || status === "degraded"
    || status === "snapshot_required"
    || status === "repair_required";
}

/**
 * The one place that answers whether Hybrid identity is fully converged.
 *
 * Rules, in order:
 *  - not configured → not_configured (a Local install is never "degraded"
 *    for the absence of a cloud it never joined);
 *  - a missing/degraded credential plane is degraded even when every
 *    membership is present — this is the exact partial state the roster bug
 *    hid;
 *  - a legacy cloud that genuinely has no credential endpoint is `limited`:
 *    supported, but not fully converged and not green;
 *  - active PIN-role members without a usable local PIN are degraded even if
 *    the last credential fetch itself succeeded (e.g. a membership created
 *    after the last credential pass);
 *  - password-role members not bound to the cloud's global identity are
 *    degraded even when every credential hash matches (issue #948: matching
 *    hashes are "credential data synced", not "identity correctly bound");
 *  - only then does membership health decide.
 */
export function hybridIdentityHealth(input: HybridIdentityHealthInput): HybridIdentityHealthResult {
  if (!input.configured) {
    return { overall: "not_configured", degradedBy: null, reason: null };
  }
  const missingPinMembers = Math.max(0, input.pinMembersMissing ?? 0);
  const missingBindings = Math.max(0, input.identityBindingsMissing ?? 0);
  if (input.identity === null || input.credentials === null) {
    return { overall: "degraded", degradedBy: input.identity === null ? "identity" : "credentials", reason: "state_unavailable" };
  }
  if (input.identity === "syncing" || input.credentials === "syncing") {
    return { overall: "syncing", degradedBy: null, reason: "sync_in_progress" };
  }
  if (input.credentials === "unsupported_legacy_cloud") {
    return { overall: "limited", degradedBy: "credentials", reason: "unsupported_legacy_cloud" };
  }
  if (credentialSyncNeedsAttention(input.credentials)) {
    return { overall: "degraded", degradedBy: "credentials", reason: `credentials_${input.credentials}` };
  }
  if (missingPinMembers > 0) {
    return { overall: "degraded", degradedBy: "credentials", reason: `pin_credentials_missing:${missingPinMembers}` };
  }
  if (missingBindings > 0) {
    return { overall: "degraded", degradedBy: "credentials", reason: `identity_bindings_missing:${missingBindings}` };
  }
  if (input.identity !== "healthy") {
    return { overall: "degraded", degradedBy: "identity", reason: `identity_${input.identity}` };
  }
  return { overall: "healthy", degradedBy: null, reason: null };
}

/** One-line operator text for a connection/IAM panel row. */
export function credentialSyncLabel(status: CredentialSyncStatus): string {
  switch (status) {
    case "healthy": return "سالم";
    case "pending": return "در انتظار اجرا";
    case "syncing": return "در حال همگام‌سازی";
    case "degraded": return "نیازمند بررسی";
    case "unsupported_legacy_cloud": return "نسخهٔ ابری قدیمی (بدون پشتیبانی رمز کارکنان)";
    case "snapshot_required": return "نیازمند همگام‌سازی کامل";
    case "repair_required": return "نیازمند تعمیر";
  }
}

/**
 * Issue #1003 — what the pre-session staff door may say about the credential
 * plane: a count and the names the operator will recognise, nothing more.
 *
 * `/api/auth/pin-login/roster` and its «همگام‌سازی دوباره» retry answer before
 * anybody has signed in, to whoever can reach the till (the desktop's LAN
 * gateway included). They used to pass the whole hybrid health record through:
 * member ids and roles, the plane's internal state, the last success time and
 * the raw text of the last sync error. The login screen renders exactly two
 * numbers and a list of names (src/app/login/login-form.tsx), so that is all
 * either route returns now; the full record stays behind the owner's session
 * at /api/connection/status.
 */
export interface LoginCredentialNotice {
  /** PIN memberships this site expects on the roster. */
  expected: number;
  /** How many of them cannot sign in here yet. */
  missing: number;
  /** Who they are, by the name a colleague knows them by. */
  missingMembers: Array<{ fullName: string }>;
}

export function loginCredentialNotice(gap: {
  expected: number;
  missing: number;
  missingMembers: ReadonlyArray<{ fullName: string }>;
}): LoginCredentialNotice {
  return {
    expected: gap.expected,
    missing: gap.missing,
    missingMembers: gap.missingMembers.map((member) => ({ fullName: member.fullName })),
  };
}
