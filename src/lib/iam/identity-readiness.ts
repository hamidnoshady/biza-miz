/**
 * Pure readiness check for «ورود با حساب ابری» on a paired desktop.
 *
 * A Hybrid membership can exist locally while its replicated login credentials
 * have not arrived: the IAM snapshot is metadata-only, so `users.platform_user_id`
 * stays NULL until the credential plane links it. The cloud-login hand-off used
 * to accept that partial state and mint a local session with `platformUserId:
 * null` and no `tokenVersion` — a session outside the cloud's token-version
 * revocation chain, which is precisely the property that lets a cloud password
 * change end a desktop session.
 *
 * The cloud's redemption answers what identity the membership signs in through
 * (`platformUserId`/`tokenVersion`). This module decides whether the local
 * replica is converged enough for that answer:
 *  - no expected global identity (a PIN-only membership, or an older cloud that
 *    does not report one) → allowed; the existing local binding is used if
 *    present, and the PIN-only distinction is preserved;
 *  - expected identity present locally with a token version → bound, allowed;
 *  - expected identity missing or mismatched locally → fail closed, so the
 *    caller reports "identity not synced" and reconciles credentials instead of
 *    minting a weaker session;
 *  - the expected identity exists but has no active token version (inactive
 *    cloud account) → fail closed too.
 */

export interface LocalIdentityBinding {
  platformUserId: string | null;
  tokenVersion: number | null;
}

export type IdentityReadinessIssue =
  | "membership_missing"
  | "identity_binding_missing"
  | "identity_binding_mismatch"
  | "identity_inactive";

export type IdentityReadiness =
  | { ok: true; bound: boolean; platformUserId: string | null; tokenVersion: number | null }
  | { ok: false; issue: IdentityReadinessIssue };

export function cloudLoginIdentityReadiness(input: {
  /** What the cloud redemption said this membership signs in through. */
  expectedPlatformUserId?: string | null;
  /** The local replica: `platformUserId` + the active `platform_users.token_version`. */
  local: LocalIdentityBinding | null;
}): IdentityReadiness {
  const { expectedPlatformUserId, local } = input;
  if (!local) return { ok: false, issue: "membership_missing" };
  // No expectation to verify (PIN-only identity, or a pre-#837 cloud that does
  // not report one): keep today's behaviour rather than inventing a binding.
  if (expectedPlatformUserId === null || expectedPlatformUserId === undefined) {
    return {
      ok: true,
      bound: local.platformUserId !== null && local.tokenVersion !== null,
      platformUserId: local.platformUserId,
      tokenVersion: local.platformUserId !== null ? local.tokenVersion : null,
    };
  }
  if (local.platformUserId === null) return { ok: false, issue: "identity_binding_missing" };
  if (local.platformUserId !== expectedPlatformUserId) return { ok: false, issue: "identity_binding_mismatch" };
  // Bound to the right identity, but revocation needs a version to compare
  // against; an inactive/missing platform row has none.
  if (local.tokenVersion === null) return { ok: false, issue: "identity_inactive" };
  return { ok: true, bound: true, platformUserId: local.platformUserId, tokenVersion: local.tokenVersion };
}
