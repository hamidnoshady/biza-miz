/**
 * Phase 42 — the DB-touching half of phone-OTP login: the policy read, the
 * pending-token signing, the OTP challenge send/verify, and the stamps that
 * record a verified number and open the 7-day PIN window.
 *
 * Pure rules live in phone-otp-policy.ts (unit-tested there, no imports
 * here smuggle them out of reach of the tests). The OTP challenge itself
 * reuses Phase 24's `mfa_challenges` table — hashed with the same realm
 * secret, same five-attempt burn, same shape — under its own
 * `subject_realm = 'employee_phone'`, keyed on users.id. One table, two
 * callers: an Owner's second factor and a cashier's door login differ in
 * ceremony, not in what a live challenge row means.
 */
import { SignJWT } from "jose";
import { query, withoutTenantScope } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import {
  consumeAllChallenges,
  issueOtpChallenge,
  liveChallengePhone,
  redeemOtpChallenge,
  type OtpPurpose,
} from "./otp-challenge";
import { getSmsProvider } from "./sms-config";
import { isMobilePhone, phoneE164 } from "./phone";
import {
  DEFAULT_PHONE_OTP_POLICY,
  normalizePhoneOtpPolicy,
  phoneOtpDaysRemaining,
  phoneOtpEnforcement,
  type PhoneOtpEnforcement,
  type PhoneOtpPolicy,
} from "./phone-otp-policy";
import { SETTING_KEYS } from "./settings";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const PHONE_OTP_SETTING_KEY = SETTING_KEYS.phoneOtpPolicy;

/**
 * One business's phone-OTP policy.
 *
 * Runs with an explicit `business_id` predicate rather than relying on RLS
 * because the login paths reach it inside `withTenant(...)` at best and, on
 * the direct phone-login path, before any scope exists — the same reason and
 * the same shape as getMfaPolicy.
 */
export async function getPhoneOtpPolicy(businessId: string): Promise<PhoneOtpPolicy> {
  const { rows } = await query<{ value: unknown }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, PHONE_OTP_SETTING_KEY],
  );
  return rows[0] ? normalizePhoneOtpPolicy(rows[0].value) : { ...DEFAULT_PHONE_OTP_POLICY };
}

/** The effective enforcement state for one business, SMS configuration included. */
export async function phoneOtpEnforcementFor(
  businessId: string,
): Promise<{ state: PhoneOtpEnforcement; policy: PhoneOtpPolicy; daysLeft: number | null }> {
  const [policy, sms] = await Promise.all([
    getPhoneOtpPolicy(businessId),
    // Configured-ness only — never the key. Read bypassed because this runs
    // on login paths where no session exists to carry a tenant scope.
    withoutTenantScope("platform", async () => {
      const { rows } = await query<{ api_key_enc: Buffer | null }>(
        `SELECT api_key_enc FROM platform_sms_config WHERE id = 1`,
      );
      return rows[0]?.api_key_enc != null || Boolean(process.env.KAVENEGAR_API_KEY);
    }),
  ]);
  return {
    state: phoneOtpEnforcement(policy, sms),
    policy,
    daysLeft: phoneOtpDaysRemaining(policy),
  };
}

// ---------------------------------------------------------------------------
// The pending token — what carries "this far has been proven" between steps
// ---------------------------------------------------------------------------

/**
 * The subject realm the multi-business phone challenge lives under — a
 * challenge keyed on the *number*, not on a membership, used when the caller has
 * not yet named (and must not be told) a business.
 */
export const PENDING_PHONE_REALM = "phone_pending";

export interface PhonePendingPayload {
  /** users.id of the member logging in; null on the anti-enumeration path. */
  sub: string | null;
  businessId: string;
  /**
   * Whether the holder has proven the member's PIN. Only then may a *new*
   * number be attached — the roster/direct paths may only ever be sent to a
   * number already on file.
   */
  mayAttachPhone: boolean;
  /** The candidate number to attach (PIN-verified flow, phone not yet on file). */
  phone?: string | null;
  /**
   * Issue #854 (P1.18): the number a *multi-business* login was started for.
   * Present only on the path where no business was named, so verification can
   * resolve the candidate members after the code checks out rather than
   * publishing them before it does.
   */
  candidatePhone?: string | null;
  /** True when the token represents "a number matched, business not yet chosen". */
  multiBusiness?: boolean;
  /**
   * True once the code for a multi-business login has actually been redeemed.
   * Only then may the business list be shown, and only then can a business be
   * chosen — a token that merely started a login cannot be spent as one.
   */
  otpProven?: boolean;
  realm: "phone";
}

const PHONE_PENDING_TTL = "10m";

export async function signPhonePendingToken(
  payload: Omit<PhonePendingPayload, "realm">,
): Promise<string> {
  const secret = await getRealmSecret("phone");
  return new SignJWT({
    ...payload,
    sub: undefined,
    uid: payload.sub,
    realm: "phone",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(PHONE_PENDING_TTL)
    .sign(secret);
}

export async function verifyPhonePendingToken(token: string): Promise<PhonePendingPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{
      realm?: string;
      uid?: string | null;
      businessId?: string;
      mayAttachPhone?: boolean;
      phone?: string | null;
      candidatePhone?: string | null;
      multiBusiness?: boolean;
      otpProven?: boolean;
    }>(token, "phone");
    if (!payload || payload.realm !== "phone") return null;
    return {
      sub: payload.uid ?? null,
      businessId: payload.businessId ?? "",
      mayAttachPhone: payload.mayAttachPhone === true,
      phone: payload.phone ?? null,
      candidatePhone: payload.candidatePhone ?? null,
      multiBusiness: payload.multiBusiness === true,
      otpProven: payload.otpProven === true,
      realm: "phone",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Challenges — send & verify
// ---------------------------------------------------------------------------

const EMPLOYEE_PHONE_REALM = "employee_phone";

export function maskPhoneE164(e164: string): string {
  return e164.length > 8 ? `+${e164.slice(1, 4)}***${e164.slice(-4)}` : "***";
}

/**
 * Mint a 6-digit challenge for one member and dispatch it through Kavenegar.
 *
 * Returns the send-side rate limits as a `{ allowed: false, retryAfterMs }`
 * object, mirroring mfa-rate-limit's shape so the UI can render the same
 * «درخواست بعدی تا …» sentence. A Kavenegar dispatch failure is thrown as a
 * KavenegarError for the caller to classify (user-actionable vs operator
 * fault); the challenge row it minted is deleted again on that path, since a
 * code that was never delivered must not sit live for five minutes.
 *
 * The successful send is *recorded* here — the limiter exists to cap spend,
 * so the count must happen on the path that spent the money, not be left to
 * each caller to remember.
 */
export async function sendEmployeePhoneOtp(options: {
  businessId: string;
  userId: string;
  phone: string;
  /**
   * What the code authorises. Required rather than defaulted: the whole of
   * #854 P0.8 is that a code must not be spendable for a purpose it was not
   * issued for, and a default would silently give every caller the weakest
   * answer. The candidate phone is bound into the row at the same time.
   */
  purpose: Extract<OtpPurpose, "login" | "verify_login_phone" | "change_login_phone">;
}): Promise<
  | { allowed: true; maskedPhone: string; expiresAt: Date }
  | { allowed: false; retryAfterMs: number }
> {
  const identityKey = `${options.businessId}:${options.userId}`;
  const limit = await checkPhoneOtpRateLimit(identityKey);
  if (!limit.allowed) return limit;

  const issued = await issueOtpChallenge({
    subjectRealm: EMPLOYEE_PHONE_REALM,
    subjectId: options.userId,
    purpose: options.purpose,
    candidatePhoneE164: options.phone,
  });

  try {
    const provider = await getSmsProvider();
    await provider.sendOtp(options.phone, issued.code);
  } catch (err) {
    // A code that was never delivered must not sit live for five minutes.
    await consumeAllChallenges({
      subjectRealm: EMPLOYEE_PHONE_REALM,
      subjectId: options.userId,
      purpose: options.purpose,
    }).catch(() => {});
    throw err;
  }

  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('phone_otp', $1, 'success')`,
      [identityKey],
    ),
  );

  return {
    allowed: true,
    maskedPhone: maskPhoneE164(options.phone),
    expiresAt: issued.expiresAt,
  };
}

/**
 * Check one submitted code against the member's newest live challenge.
 * True consumes the challenge; false burns one attempt and leaves it live
 * until the ceiling, so a wrong guess cannot be retried forever.
 */
export async function verifyEmployeePhoneOtp(options: {
  userId: string;
  code: string;
  purpose: Extract<OtpPurpose, "login" | "verify_login_phone" | "change_login_phone">;
  /**
   * The number this verification is about. When present it must equal the
   * number the code went to — that is what stops a valid code for A being
   * submitted while asking the server to persist B (#854 P0.8).
   */
  expectedPhoneE164?: string | null;
}): Promise<boolean> {
  const result = await redeemOtpChallenge({
    subjectRealm: EMPLOYEE_PHONE_REALM,
    subjectId: options.userId,
    purpose: options.purpose,
    code: options.code,
    expectedPhoneE164: options.expectedPhoneE164,
  });
  return result.ok;
}

/**
 * The destination a live employee challenge is waiting on (#854 P2.19).
 *
 * Lets the verify screen say «کد به … ارسال شد» after a refresh without ever
 * reconstructing the number from a masked string, and without trusting the
 * request body for it.
 */
export async function liveEmployeePhoneChallenge(options: {
  userId: string;
  purpose: Extract<OtpPurpose, "login" | "verify_login_phone" | "change_login_phone">;
}): Promise<{
  maskedPhone: string | null;
  expiresAt: string;
  /** The exact number the code went to — the server's copy, not the body's. */
  candidatePhoneE164: string | null;
  purpose: Extract<OtpPurpose, "login" | "verify_login_phone" | "change_login_phone">;
} | null> {
  const live = await liveChallengePhone({
    subjectRealm: EMPLOYEE_PHONE_REALM,
    subjectId: options.userId,
    purpose: options.purpose,
  });
  if (!live) return null;
  return {
    maskedPhone: live.candidatePhoneE164 ? maskPhoneE164(live.candidatePhoneE164) : null,
    expiresAt: live.expiresAt.toISOString(),
    candidatePhoneE164: live.candidatePhoneE164,
    purpose: options.purpose,
  };
}

export async function checkPhoneOtpRateLimit(
  identityKey: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const now = new Date();
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ created_at: Date }>(
      `SELECT created_at FROM auth_login_attempts
        WHERE realm = 'phone_otp' AND identity_key = $1
        ORDER BY created_at DESC LIMIT 20`,
      [identityKey],
    ),
  );

  if (rows.length > 0) {
    const last = new Date(rows[0].created_at).getTime();
    if (now.getTime() - last < 60_000) {
      return { allowed: false, retryAfterMs: 60_000 - (now.getTime() - last) };
    }
  }
  const lastHour = rows.filter((r) => now.getTime() - new Date(r.created_at).getTime() < 3_600_000);
  if (lastHour.length >= 5) {
    const oldest = new Date(lastHour[4].created_at).getTime();
    return { allowed: false, retryAfterMs: 3_600_000 - (now.getTime() - oldest) };
  }
  const lastDay = rows.filter((r) => now.getTime() - new Date(r.created_at).getTime() < 86_400_000);
  if (lastDay.length >= 20) {
    const oldest = new Date(lastDay[19].created_at).getTime();
    return { allowed: false, retryAfterMs: 86_400_000 - (now.getTime() - oldest) };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// The stamps
// ---------------------------------------------------------------------------

/**
 * Mark a number verified and open the 7-day PIN window, in one write.
 *
 * `phone` is the candidate a PIN-verified login typed (users.phone_e164 was
 * still null); omitting it keeps the number already on file. Runs inside the
 * caller's tenant scope — the door has resolved the business by now.
 */
export async function stampPhoneVerified(options: {
  businessId: string;
  userId: string;
  phone?: string | null;
}): Promise<void> {
  const phone = options.phone ?? null;
  await query(
    `UPDATE users
        SET phone_e164 = COALESCE($3, phone_e164),
            phone_verified_at = now(),
            otp_login_at = now(),
            updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    [options.userId, options.businessId, phone],
  );
}

/** Validate + canonicalise a typed number, or null when it is not a mobile. */
export function canonicalMemberPhone(input: string | null | undefined): string | null {
  if (!input || !String(input).trim()) return null;
  if (!isMobilePhone(input)) return null;
  return phoneE164(input);
}
