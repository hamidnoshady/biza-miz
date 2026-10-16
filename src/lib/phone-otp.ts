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
import { EncryptJWT, jwtDecrypt } from "jose";
import { query, withTenantTransaction, withoutTenantScope } from "./db";
import { ensurePersonnelFileForMembership } from "./personnel-file";
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
import {
  recordSecurityAudit,
  transactionAuditExecutor,
  type SecurityAuditEntry,
} from "./security-audit";

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

/**
 * The claim shape carried by a pending token, whichever of the two encodings
 * it arrived in. `uid` rather than `sub` because `jose` reserves `sub` for its
 * own validated claim and we do not want a caller-supplied one to shadow it.
 */
interface PhonePendingClaims {
  realm?: string;
  uid?: string | null;
  businessId?: string;
  mayAttachPhone?: boolean;
  phone?: string | null;
  candidatePhone?: string | null;
  multiBusiness?: boolean;
  otpProven?: boolean;
}

const PHONE_PENDING_TTL = "10m";

/**
 * Issue #885, gap 2 — the pending token is **encrypted**, not merely signed.
 *
 * A signed HS256 JWT is readable: its middle segment base64-decodes to the
 * whole payload. That made the anti-enumeration guarantee on the phone door
 * cosmetic — the synthetic "no such member" response and the real one were
 * distinguishable by simply looking at the token, because one carried `uid`,
 * `businessId` and `cid` and the other carried nulls and zeros. Encryption
 * removes the readable payload entirely, so the two tokens differ only in
 * length and the route can keep its byte-identical body.
 *
 * `dir` + `A256GCM` uses the realm secret directly as the content-encryption
 * key, which keeps the existing key material and rotation working unchanged.
 */
export async function signPhonePendingToken(
  payload: Omit<PhonePendingPayload, "realm">,
): Promise<string> {
  const secret = await getRealmSecret("phone");
  return new EncryptJWT({
    ...payload,
    sub: undefined,
    uid: payload.sub,
    realm: "phone",
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(PHONE_PENDING_TTL)
    .encrypt(secret);
}

export async function verifyPhonePendingToken(token: string): Promise<PhonePendingPayload | null> {
  try {
    // The encrypted read is the normal path. Both secret reads sit *inside*
    // this try on purpose: `getRealmSecret` throws when a realm has no
    // previous secret configured, which is the common case, and a throw from
    // outside the try would reject the whole expression so the fallback below
    // silently never ran.
    const secret = await getRealmSecret("phone");
    const decrypted = await jwtDecrypt<PhonePendingClaims>(token, secret).catch(() => null);
    const payload =
      decrypted?.payload ??
      (await verifyWithRealmSecret<PhonePendingClaims>(token, "phone").catch(() => null));
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
  /** When the code was sent — the resend cooldown counts from here (P2.25). */
  requestedAt: string;
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
    requestedAt: live.createdAt.toISOString(),
    expiresAt: live.expiresAt.toISOString(),
    candidatePhoneE164: live.candidatePhoneE164,
    purpose: options.purpose,
  };
}

// ---------------------------------------------------------------------------
// The self-service ceremony (/api/auth/phone/self)
// ---------------------------------------------------------------------------

/**
 * The purposes the signed-in member's own phone card mints — never the door's
 * `login`, which a self-service cancel or resend must not touch.
 */
export const SELF_PHONE_PURPOSES = ["change_login_phone", "verify_login_phone"] as const;
export type SelfPhonePurpose = (typeof SELF_PHONE_PURPOSES)[number];

/**
 * The member's one live self-service challenge, read from the challenge row
 * (#854 F06): destination *and* purpose are the server's copy, so a reload, a
 * resend or a verify never depends on what the browser remembered — or forgot.
 * A change is preferred over a re-verification when (from an older client)
 * both are live, because it is the more specific of the two.
 */
export async function liveSelfPhoneChallenge(userId: string): Promise<
  | (Omit<NonNullable<Awaited<ReturnType<typeof liveEmployeePhoneChallenge>>>, "purpose"> & {
      purpose: SelfPhonePurpose;
    })
  | null
> {
  // `SELF_PHONE_PURPOSES` is ordered change-first, which is the preference.
  for (const purpose of SELF_PHONE_PURPOSES) {
    const live = await liveEmployeePhoneChallenge({ userId, purpose });
    if (live) return { ...live, purpose };
  }
  return null;
}

/**
 * Burn the member's live self-service challenges — all of them (an explicit
 * cancel), or every purpose but `except` (a fresh send, so the card only ever
 * has one verification in flight and a verify cannot land on a stale one).
 */
export async function consumeSelfPhoneChallenges(
  userId: string,
  options: { except?: SelfPhonePurpose } = {},
): Promise<number> {
  let consumed = 0;
  for (const purpose of SELF_PHONE_PURPOSES) {
    if (purpose === options.except) continue;
    consumed += await consumeAllChallenges({
      subjectRealm: EMPLOYEE_PHONE_REALM,
      subjectId: userId,
      purpose,
    });
  }
  return consumed;
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
 *
 * Issue #854 follow-up (F05): with `audit`, the stamp and its security audit
 * row commit together or not at all — the self-service phone card used to
 * stamp first and then write the audit with `.catch(() => {})`, so a verified
 * number change could exist with no record of it. Without `audit` (the door
 * paths, which have their own trail) the single write is unchanged.
 */
export async function stampPhoneVerified(options: {
  businessId: string;
  userId: string;
  phone?: string | null;
  audit?: SecurityAuditEntry;
}): Promise<void> {
  const phone = options.phone ?? null;
  const writeStamp = () =>
    query(
      `UPDATE users
          SET phone_e164 = COALESCE($3, phone_e164),
              phone_verified_at = now(),
              otp_login_at = now(),
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [options.userId, options.businessId, phone],
    );

  if (options.audit) {
    const audit = options.audit;
    await withTenantTransaction(options.businessId, async () => {
      await writeStamp();
      await recordSecurityAudit(audit, transactionAuditExecutor());
    });
  } else {
    await writeStamp();
  }
  // Anything that must observe the *committed* stamp (a projection, a sync)
  // belongs here, after the transaction — never inside it, where its own
  // failure would roll the verification back.
  /*
   * Issue #947 (TEAM-F05) — this door moves the same field the Team screen's phone
   * editor does, so it owes the same propagation. Before this, proving a number at
   * the door stamped `users.phone_e164` and left the personnel file holding the old
   * one (or none at all) — two views of one person disagreeing about the number the
   * shift lead calls. The sync derives the whole canonical identity from the row that
   * just changed and records a durable retry if the file cannot be written; the
   * verification above has already succeeded, so nothing here can fail the login.
   */
  await ensurePersonnelFileForMembership(options.businessId, options.userId);
}

/** Validate + canonicalise a typed number, or null when it is not a mobile. */
export function canonicalMemberPhone(input: string | null | undefined): string | null {
  if (!input || !String(input).trim()) return null;
  if (!isMobilePhone(input)) return null;
  return phoneE164(input);
}
