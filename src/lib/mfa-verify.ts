/**
 * Phase 24 Wave 2 — the second-factor check itself, shared by both realms.
 *
 * `/api/auth/mfa/verify` and `/api/platform/auth/mfa/verify` were byte-for-byte
 * the same logic with `'platform_user'` swapped for `'platform_admin'`, which
 * is how the recovery-code path came to be missing from both. One
 * implementation, two callers: whatever is true of a tenant Owner's second
 * factor is true of a super-admin's, and the only thing that legitimately
 * differs between them is which session gets minted afterwards.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from "otplib";
import { query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { decryptTotpSecret } from "./mfa-service";
import { consumeRecoveryCode } from "./mfa-recovery";

export type MfaSubjectRealm = "platform_user" | "platform_admin";

/** How the code was accepted — the caller records it, and the UI says so. */
export type MfaVerifyOutcome = "totp" | "sms_otp" | "recovery_code" | "rejected";

/** Five wrong OTPs burn the challenge, per the phase spec. */
const MAX_OTP_ATTEMPTS = 5;

async function verifyTotp(subjectRealm: MfaSubjectRealm, subjectId: string, code: string): Promise<boolean> {
  const { rows } = await query<{ totp_secret: Buffer }>(
    `SELECT totp_secret FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = $2 AND method = 'totp'`,
    [subjectRealm, subjectId],
  );
  if (rows.length === 0 || !rows[0].totp_secret) return false;

  const secret = await decryptTotpSecret(rows[0].totp_secret);
  if (!secret) return false;

  const totp = new TOTP({ crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() });
  const result = await totp.verify(code, { secret });
  if (!result.valid) return false;

  await query(
    `UPDATE mfa_enrolments SET confirmed_at = now()
      WHERE subject_realm = $1 AND subject_id = $2 AND method = 'totp' AND confirmed_at IS NULL`,
    [subjectRealm, subjectId],
  );
  return true;
}

async function verifySmsOtp(subjectRealm: MfaSubjectRealm, subjectId: string, code: string): Promise<boolean> {
  const secretKey = await getRealmSecret("platform");
  const hmac = createHmac("sha256", secretKey).update(code).digest("hex");

  const { rows } = await query<{ id: string; hashed_otp: string; attempts: number }>(
    `SELECT id, hashed_otp, attempts FROM mfa_challenges
      WHERE subject_realm = $1 AND subject_id = $2 AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [subjectRealm, subjectId],
  );
  if (rows.length === 0) return false;

  const challenge = rows[0];
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) return false;

  const stored = Buffer.from(challenge.hashed_otp, "hex");
  const offered = Buffer.from(hmac, "hex");
  const isMatch = stored.length === offered.length && timingSafeEqual(stored, offered);

  if (!isMatch) {
    await query(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`, [challenge.id]);
    return false;
  }

  await query(`DELETE FROM mfa_challenges WHERE id = $1`, [challenge.id]);
  await query(
    `UPDATE mfa_enrolments SET confirmed_at = now()
      WHERE subject_realm = $1 AND subject_id = $2 AND method = 'sms_otp' AND confirmed_at IS NULL`,
    [subjectRealm, subjectId],
  );
  return true;
}

/**
 * Check one submitted code against the account's enrolments.
 *
 * `useRecoveryCode` is explicit rather than inferred from the shape of the
 * string: a six-digit OTP and a ten-character recovery code are told apart
 * easily enough, but silently spending a single-use recovery code because
 * someone fat-fingered their authenticator app is not a mistake worth making.
 * The verify screen has its own "use a recovery code instead" path, and this
 * flag is that path.
 *
 * A recovery code is honoured whatever the enrolled method is — that is the
 * entire point of it, since the reason it is being used is that the enrolled
 * method is unavailable.
 */
export async function verifyMfaCode(options: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  method: "totp" | "sms_otp" | null;
  code: string;
  useRecoveryCode?: boolean;
}): Promise<MfaVerifyOutcome> {
  const { subjectRealm, subjectId, method, code } = options;

  if (options.useRecoveryCode) {
    return (await consumeRecoveryCode(subjectRealm, subjectId, code)) ? "recovery_code" : "rejected";
  }

  return withoutTenantScope("platform", async () => {
    if (method === "totp") {
      return (await verifyTotp(subjectRealm, subjectId, code)) ? "totp" : "rejected";
    }
    if (method === "sms_otp") {
      return (await verifySmsOtp(subjectRealm, subjectId, code)) ? "sms_otp" : "rejected";
    }
    return "rejected";
  });
}
