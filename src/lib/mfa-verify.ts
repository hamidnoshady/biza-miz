/**
 * Phase 24 Wave 2 — second-factor verification, shared across both realms.
 *
 * The tenant `/api/auth/mfa/verify` and platform `/api/platform/auth/mfa/verify`
 * endpoints only differ in what they do *after* the code checks out (which
 * session cookie to mint, which user table to load). Everything that decides
 * whether the submitted digits or recovery code are genuine is identical and
 * lives here, so the two realms cannot drift on window tolerance, challenge
 * attempt counting, or recovery-code single-use semantics.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from "otplib";
import { query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";
import {
  confirmMfaEnrolment,
  decryptTotpSecret,
  type MfaSubjectRealm,
} from "./mfa-service";
import { consumeRecoveryCode } from "./mfa-recovery";

const totp = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

export type MfaVerificationOutcome = "totp" | "sms_otp" | "recovery_code" | "rejected";

export interface MfaVerificationDetail {
  outcome: MfaVerificationOutcome;
  wasUnconfirmed: boolean;
  recoveryCodes: string[];
}

/**
 * Verify a TOTP code against the stored encrypted secret for `subject`.
 *
 * `epochTolerance: 30` accepts the current 30-second step and the one on
 * either side (±1 step), per the Phase 24 spec.
 */
async function verifyTotp(subjectRealm: MfaSubjectRealm, subjectId: string, code: string): Promise<boolean> {
  const digits = code.trim();
  if (!/^\d{6}$/.test(digits)) return false;

  const { rows } = await query<{ totp_secret: Buffer | null }>(
    `SELECT totp_secret FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = $2 AND method = 'totp'`,
    [subjectRealm, subjectId],
  );
  const encrypted = rows[0]?.totp_secret;
  if (!encrypted) return false;

  const secret = await decryptTotpSecret(encrypted);
  if (!secret) return false;

  try {
    const result = await totp.verify(digits, { secret, epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}

/**
 * Verify an SMS OTP against the live challenge row for `subject`.
 *
 * Five wrong tries burn the challenge (`attempts < 5`); a hit deletes it so
 * the same six digits cannot be replayed inside the 5-minute TTL.
 */
async function verifySmsOtp(subjectRealm: MfaSubjectRealm, subjectId: string, code: string): Promise<boolean> {
  const digits = code.trim();
  if (!/^\d{6}$/.test(digits)) return false;

  const { rows } = await query<{ id: string; hashed_otp: string; attempts: number }>(
    `SELECT id, hashed_otp, attempts FROM mfa_challenges
      WHERE subject_realm = $1 AND subject_id = $2
        AND expires_at > now() AND attempts < 5
      ORDER BY created_at DESC LIMIT 1`,
    [subjectRealm, subjectId],
  );
  const challenge = rows[0];
  if (!challenge) return false;

  const secret = await getRealmSecret("platform");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(digits).digest("hex"),
    "utf8",
  );
  const stored = Buffer.from(challenge.hashed_otp, "utf8");
  const match = expected.length === stored.length && timingSafeEqual(expected, stored);

  if (!match) {
    await query(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`, [challenge.id]);
    return false;
  }

  await query(`DELETE FROM mfa_challenges WHERE id = $1`, [challenge.id]);
  return true;
}

/**
 * Run the second-factor check and confirm any pending enrolment on success.
 */
export async function verifyAndConfirmMfaCode(params: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  method: "totp" | "sms_otp" | null;
  code: string;
  useRecoveryCode?: boolean;
}): Promise<MfaVerificationDetail> {
  const { subjectRealm, subjectId, method, code, useRecoveryCode } = params;
  if (!code || typeof code !== "string") {
    return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
  }

  return withoutTenantScope("platform", async () => {
    if (useRecoveryCode) {
      const ok = await consumeRecoveryCode(subjectRealm, subjectId, code);
      return {
        outcome: ok ? "recovery_code" : "rejected",
        wasUnconfirmed: false,
        recoveryCodes: [],
      };
    }
    if (method === "totp") {
      const ok = await verifyTotp(subjectRealm, subjectId, code);
      if (!ok) {
        return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
      }
      const confirmation = await confirmMfaEnrolment(subjectRealm, subjectId, "totp");
      return {
        outcome: "totp",
        wasUnconfirmed: confirmation.wasUnconfirmed,
        recoveryCodes: confirmation.recoveryCodes,
      };
    }
    if (method === "sms_otp") {
      const ok = await verifySmsOtp(subjectRealm, subjectId, code);
      if (!ok) {
        return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
      }
      const confirmation = await confirmMfaEnrolment(subjectRealm, subjectId, "sms_otp");
      return {
        outcome: "sms_otp",
        wasUnconfirmed: confirmation.wasUnconfirmed,
        recoveryCodes: confirmation.recoveryCodes,
      };
    }
    return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
  });
}

/**
 * Run the second-factor check requested by the caller.
 */
export async function verifyMfaCode(params: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  method: "totp" | "sms_otp" | null;
  code: string;
  useRecoveryCode?: boolean;
}): Promise<MfaVerificationOutcome> {
  const detail = await verifyAndConfirmMfaCode(params);
  return detail.outcome;
}
