/**
 * Issue #854 (P1.6 / P1.7 / P1.8 / P2.22) — reading and proving *your own*
 * credentials.
 *
 * Every "re-prove yourself" surface used to answer the question differently:
 *
 *  - `/api/auth/verify-pin` bcrypt-compared the caller's own PIN, with lockout
 *    and audit;
 *  - `/api/auth/step-up` accepted only a password, so a cashier or a PIN-only
 *    manager had no way to satisfy a recent-auth requirement from Profile and
 *    was told to log out and back in (#854 P1.6);
 *  - the Profile PIN card and the WebAuthn panel each described availability
 *    from their own hard-coded assumptions, which is how the profile page ended
 *    up gating MFA on `["owner","manager"]` (#854 P1.2).
 *
 * The readers below are the one answer: what does this membership actually
 * hold, and does this offered secret match it. They are deliberately narrow —
 * every function reads `users.id` from the caller's session and nothing else,
 * so there is no shape of this module that touches somebody else's credential.
 */
import bcrypt from "bcryptjs";
import { query } from "./db";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "./pin-policy";
import type { StepUpAvailability } from "./auth-contracts";

/** What the signed-in member actually holds, for the step-up picker and Profile. */
export interface SelfCredentialState extends StepUpAvailability {
  /** users.id — the membership, not the person. */
  membershipId: string;
  businessId: string;
  hasGlobalIdentity: boolean;
  /** True when a confirmed TOTP or SMS factor exists on the global identity. */
  hasConfirmedMfa: boolean;
  mfaPendingMethods: string[];
  unusedRecoveryCodes: number;
  /** The deployment profile, so the UI can render cloud-owned fields read-only. */
  loginManagedByCloud: boolean;
  /** True when a *verified* phone exists — required before any SMS channel. */
  hasVerifiedPhone: boolean;
}

interface CredentialRow extends Record<string, unknown> {
  platform_user_id: string | null;
  pin_hash: string | null;
  phone_verified_at: Date | null;
  confirmed_mfa: string[] | null;
  pending_mfa: string[] | null;
  unused_recovery_codes: string | number | null;
}

/**
 * Everything the Profile / step-up surfaces need about the caller's own
 * credentials, in one round trip.
 *
 * Reads bypassed for the platform-level facts (MFA enrolments and recovery
 * codes belong to `platform_user`, not to the tenant) — the same justification
 * every other global-identity read in this codebase carries.
 */
export async function readSelfCredentialState(
  businessId: string,
  membershipId: string,
): Promise<SelfCredentialState | null> {
  const { rows } = await query<CredentialRow>(
    `SELECT u.platform_user_id,
            coalesce(ec.secret_hash, u.pin_hash) AS pin_hash,
            u.phone_verified_at,
            (SELECT array_agg(e.method::text)
               FROM mfa_enrolments e
              WHERE e.subject_realm = 'platform_user'
                AND e.subject_id = u.platform_user_id
                AND e.confirmed_at IS NOT NULL) AS confirmed_mfa,
            (SELECT array_agg(e.method::text)
               FROM mfa_enrolments e
              WHERE e.subject_realm = 'platform_user'
                AND e.subject_id = u.platform_user_id
                AND e.confirmed_at IS NULL) AS pending_mfa,
            (SELECT count(*) FROM mfa_recovery_codes r
              WHERE r.subject_realm = 'platform_user'
                AND r.subject_id = u.platform_user_id
                AND r.used_at IS NULL) AS unused_recovery_codes
       FROM users u
       LEFT JOIN LATERAL (
         SELECT secret_hash FROM employee_credentials
          WHERE employee_id = u.id AND business_id = u.business_id
            AND credential_type = 'pin' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1
       ) ec ON true
      WHERE u.id = $1 AND u.business_id = $2 AND u.is_active = true`,
    [membershipId, businessId],
  );
  const row = rows[0];
  if (!row) return null;

  const confirmed = row.confirmed_mfa ?? [];
  const pending = row.pending_mfa ?? [];
  const hasGlobalIdentity = row.platform_user_id !== null;

  // The deployment profile read is a separate module on purpose — this file
  // must stay usable from a surface that has already read it.
  const { readDeploymentProfile } = await import("./deployment-mode");
  const deployment = await readDeploymentProfile(businessId);

  return {
    membershipId,
    businessId,
    hasGlobalIdentity,
    hasPassword: hasGlobalIdentity,
    hasPin: row.pin_hash !== null,
    hasTotp: confirmed.includes("totp"),
    hasSms: confirmed.includes("sms_otp"),
    hasConfirmedMfa: confirmed.length > 0,
    mfaPendingMethods: pending,
    unusedRecoveryCodes: Number(row.unused_recovery_codes ?? 0),
    hasRecoveryCodes: Number(row.unused_recovery_codes ?? 0) > 0,
    hasWebauthn: false,
    hasVerifiedPhone: row.phone_verified_at !== null,
    loginManagedByCloud: deployment.profile === "hybrid",
  };
}

/** Whether the membership has at least one registered biometric credential. */
export async function hasWebauthnCredential(
  businessId: string,
  membershipId: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM employee_credentials
      WHERE employee_id = $1 AND business_id = $2
        AND credential_type = 'webauthn' AND status = 'active'
      LIMIT 1`,
    [membershipId, businessId],
  );
  return rows.length > 0;
}

/**
 * bcrypt-compare an offered PIN against the caller's own active credential.
 *
 * The same lookup `/api/auth/verify-pin` and `pin-login` use — `employee_credentials`
 * first, then the legacy `users.pin_hash` — so a member whose PIN predates the
 * credential store can still be verified. Returns false for a malformed PIN
 * rather than throwing, because the shape check and the secret check are the
 * same answer to the caller ("that is not your PIN").
 */
export async function verifySelfPin(
  businessId: string,
  membershipId: string,
  offered: string,
): Promise<boolean> {
  if (!new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(offered)) return false;
  const { rows } = await query<{ pin_hash: string | null }>(
    `SELECT coalesce(ec.secret_hash, u.pin_hash) AS pin_hash
       FROM users u
       LEFT JOIN LATERAL (
         SELECT secret_hash FROM employee_credentials
          WHERE employee_id = u.id AND business_id = u.business_id
            AND credential_type = 'pin' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1
       ) ec ON true
      WHERE u.id = $1 AND u.business_id = $2 AND u.is_active = true`,
    [membershipId, businessId],
  );
  const hash = rows[0]?.pin_hash;
  if (!hash) return false;
  return bcrypt.compare(offered, hash);
}
