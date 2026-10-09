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
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import { query, withTenantTransaction, withoutTenantScope } from "./db";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { getSmsProvider } from "./sms-config";
import { isMobilePhone, phoneE164 } from "./phone";
import {
  DEFAULT_PHONE_OTP_POLICY,
  normalizePhoneOtpPolicy,
  phoneOtpDaysRemaining,
  phoneOtpEnforcement,
  otpSendBudgetDecision,
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
 * What a phone-OTP code is being asked to prove.
 *
 *  - `login`  — possession of the number on file *is* the credential for this
 *               login.
 *  - `attach` — a PIN-verified member is proving ownership of a number that is
 *               about to be written to `users.phone_e164`.
 *  - `manage` — an already-signed-in member changing their own number in
 *               account settings (`/api/auth/phone/self`). Same proof, a
 *               different ceremony: keeping it separate means a challenge
 *               minted before a session exists cannot be redeemed by one, or
 *               the other way round.
 *
 * The distinction exists because the code is the same six digits either way.
 * Before issue #885 (L02) nothing bound a proof to the ceremony that minted
 * it, so a code earned while attaching a number during a PIN login satisfied
 * any other pending token for the same member — including one whose
 * destination was a different number.
 */
export type PhoneOtpPurpose = "login" | "attach" | "manage";

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
   * The exact challenge row this token may be redeemed against (L02). Null
   * only on the anti-enumeration path, where no code was ever sent and the
   * verify can therefore only ever refuse.
   */
  cid: string | null;
  /** The E.164 number the bound challenge was actually sent to. */
  destination: string | null;
  purpose: PhoneOtpPurpose;
  realm: "phone";
}

const PHONE_PENDING_TTL = "10m";

export async function signPhonePendingToken(
  payload: Omit<PhonePendingPayload, "realm">,
): Promise<string> {
  const secret = await getRealmSecret("phone");
  return new SignJWT({ ...payload, sub: undefined, uid: payload.sub, realm: "phone" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(PHONE_PENDING_TTL)
    .sign(secret);
}

/** A token with no subject is the anti-enumeration shape, and is valid. */
function isPurpose(value: unknown): value is PhoneOtpPurpose {
  return value === "login" || value === "attach" || value === "manage";
}

export async function verifyPhonePendingToken(token: string): Promise<PhonePendingPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{
      realm?: string;
      uid?: string | null;
      businessId?: string;
      mayAttachPhone?: boolean;
      phone?: string | null;
      cid?: string | null;
      destination?: string | null;
      purpose?: string;
    }>(token, "phone");
    if (!payload || payload.realm !== "phone") return null;

    const sub = payload.uid ?? null;
    // `cid` is null in two legitimate cases, and they are told apart by the
    // route rather than here: the anti-enumeration token (no subject, no code
    // ever sent) and the PIN door's *pre-send* token, which authorises a send
    // and only acquires a challenge once that send happens. Requiring a
    // challenge here would break the second.
    //
    // What must not happen is a *redemption* without one, and that is the
    // verify route's check: a token naming a member but no challenge cannot be
    // redeemed against anything, because there is nothing to redeem it
    // against.
    const cid = typeof payload.cid === "string" && payload.cid ? payload.cid : null;

    return {
      sub,
      businessId: payload.businessId ?? "",
      mayAttachPhone: payload.mayAttachPhone === true,
      phone: payload.phone ?? null,
      cid,
      destination:
        typeof payload.destination === "string" && payload.destination
          ? payload.destination
          : null,
      purpose: isPurpose(payload.purpose) ? payload.purpose : "login",
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
/** Wrong codes burn the challenge, same ceiling as the MFA interstitial. */
const MAX_OTP_ATTEMPTS = 5;
/** Till door: a code must survive a busy shift's worth of SMS lag, not a login form's. */
const OTP_TTL_MINUTES = 5;

async function hashOtp(otp: string): Promise<string> {
  const secretKey = await getRealmSecret("platform");
  return createHmac("sha256", secretKey).update(otp).digest("hex");
}

/** `+98912***4567` — enough to recognise your own number, not to dial it. */
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
export interface OtpSendOutcome {
  allowed: true;
  /** The challenge row the caller must bind its pending token to. */
  challengeId: string;
}

export type OtpSendResult = OtpSendOutcome | { allowed: false; retryAfterMs: number };

/**
 * A send budget reservation.
 *
 * Deliberately a distinct shape from `OtpSendResult`: at this point no
 * challenge exists yet, so there is no `challengeId` to hand back. Pretending
 * otherwise would let a caller bind a pending token to a challenge that was
 * never issued, which is exactly the class of bug issue #885 L02 removes.
 */
export type OtpSendReservation =
  | { allowed: true; reservationId: string }
  | { allowed: false; retryAfterMs: number };

/**
 * Reserve one send against the membership's budget, atomically.
 *
 * Issue #885 L03: this used to be a read, a comparison, and a write on the
 * way back out — so two requests arriving together both saw "four sent this
 * hour, five allowed" and both spent a message. The check and the record are
 * now one transaction, serialised per membership by an advisory lock, so the
 * fifth concurrent caller is the first one refused rather than the sixth
 * one sent.
 *
 * The lock key is derived from the identity (`businessId:userId`), never from
 * anything the client supplies, so an attacker cannot widen or narrow it.
 *
 * A reservation that is never spent is refunded by `refundOtpSend`; leaving
 * it in place would charge a member for a message that was never delivered.
 */
export async function reserveOtpSend(options: {
  businessId: string;
  userId: string;
}): Promise<OtpSendReservation> {
  const identityKey = `${options.businessId}:${options.userId}`;

  return withTenantTransaction(options.businessId, async () => {
    // Serialises every reservation for this one membership. Scoped to the
    // transaction, so it is released on commit or rollback with nothing to
    // leak, and cannot deadlock against a caller that forgets to unlock.
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [identityKey]);

    const { rows } = await query<{ created_at: Date }>(
      `SELECT created_at FROM auth_login_attempts
        WHERE realm = 'phone_otp' AND identity_key = $1
        ORDER BY created_at DESC LIMIT 40`,
      [identityKey],
    );

    const decision = otpSendBudgetDecision(rows.map((r) => r.created_at));
    if (!decision.allowed) {
      return { allowed: false, retryAfterMs: decision.retryAfterMs };
    }

    const { rows: inserted } = await query<{ id: string }>(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('phone_otp', $1, 'reserved')
       RETURNING id`,
      [identityKey],
    );
    return { allowed: true, reservationId: inserted[0]?.id ?? "" };
  });
}

/**
 * Give a reservation back because the message was never delivered.
 *
 * Best-effort and never throws: the dispatch already failed, and turning that
 * into a second failure would only confuse the caller about what went wrong.
 */
export async function refundOtpSend(reservationId: string): Promise<void> {
  if (!reservationId) return;
  await withoutTenantScope("platform", () =>
    query(`DELETE FROM auth_login_attempts WHERE id = $1 AND realm = 'phone_otp'`, [
      reservationId,
    ]),
  ).catch(() => {});
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
 * The successful send is recorded here — the limiter exists to cap spend, so
 * the count must happen on the path that spent the money, not be left to each
 * caller to remember. Issue #885 L03: it is now recorded *before* the spend,
 * as a reservation, which is what makes the ceiling hold under concurrency.
 *
 * The returned `challengeId` is not optional metadata. The caller binds it
 * into the pending token so the verify half can redeem exactly this row and
 * nothing else (L02); a send that does not hand its id back cannot be
 * verified at all.
 */
export async function sendEmployeePhoneOtp(options: {
  businessId: string;
  userId: string;
  phone: string;
  /** Defaults to `login`; the PIN-verified attach flow passes `attach`. */
  purpose?: PhoneOtpPurpose;
}): Promise<OtpSendResult> {
  const purpose = options.purpose ?? "login";

  const reservation = await reserveOtpSend({
    businessId: options.businessId,
    userId: options.userId,
  });
  if (!reservation.allowed) return reservation;

  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hashed = await hashOtp(otp);

  let challengeId = "";
  try {
    // One transaction: retire every older live challenge for this member,
    // then insert the new one. Without the first statement an attacker (or a
    // member with two tabs open) could collect several live codes and, after
    // the newest was consumed, fall back to an older one that was still
    // inside its five minutes — the "newest challenge" read would simply find
    // it again.
    const { rows } = await withoutTenantScope("platform", () =>
      query<{ id: string }>(
        `WITH retired AS (
           UPDATE mfa_challenges
              SET consumed_at = now()
            WHERE subject_realm = $1 AND subject_id = $2
              AND consumed_at IS NULL AND expires_at > now()
           RETURNING id
         )
         INSERT INTO mfa_challenges
           (subject_realm, subject_id, hashed_otp, expires_at,
            business_id, purpose, destination)
         VALUES ($1, $2, $3, now() + interval '1 minute' * $4, $5, $6, $7)
         RETURNING id`,
        [
          EMPLOYEE_PHONE_REALM,
          options.userId,
          hashed,
          OTP_TTL_MINUTES,
          options.businessId,
          purpose,
          options.phone,
        ],
      ),
    );
    challengeId = rows[0]?.id ?? "";
    if (!challengeId) throw new Error("phone-otp challenge insert returned no row");
  } catch (err) {
    await refundOtpSend(reservation.reservationId);
    throw err;
  }

  try {
    const provider = await getSmsProvider();
    await provider.sendOtp(options.phone, otp);
  } catch (err) {
    await withoutTenantScope("platform", () =>
      query(`DELETE FROM mfa_challenges WHERE id = $1`, [challengeId]),
    ).catch(() => {});
    await refundOtpSend(reservation.reservationId);
    throw err;
  }

  return { allowed: true, challengeId };
}

export type PhoneOtpVerifyResult =
  | { verified: true }
  | {
      verified: false;
      /**
       *  - `no_challenge`    — no such challenge id exists.
       *  - `scope_mismatch`  — the row exists but belongs to another member,
       *                      tenant or ceremony than the token claims (L02).
       *  - `expired`         — the five minutes elapsed.
       *  - `consumed`        — already redeemed, or retired by a later send.
       *  - `wrong_code`      — the code did not match; one attempt burned.
       *  - `burned`          — the attempt ceiling was reached.
       */
      reason:
        | "no_challenge"
        | "scope_mismatch"
        | "expired"
        | "consumed"
        | "wrong_code"
        | "burned";
    };

/**
 * Check one submitted code against the exact challenge the pending token
 * names, and consume it.
 *
 * Issue #885 L02 and L03 together. The old shape read "the newest live
 * challenge for this member", compared, and then deleted: nothing tied the
 * code to the ceremony that sent it, and the read-then-delete pair let two
 * concurrent valid submissions both pass before either removed the row.
 *
 * Now the challenge is addressed by id and re-checked against the member,
 * tenant, purpose and destination the token carries, so a proof cannot be
 * replayed sideways; and redemption is a single conditional UPDATE whose
 * `consumed_at IS NULL` predicate is re-evaluated under the row lock, so the
 * second of two concurrent valid submissions finds zero rows and is refused.
 *
 * A wrong code burns one attempt and leaves the row live until the ceiling,
 * so a wrong guess cannot be retried forever.
 */
export async function verifyEmployeePhoneOtp(options: {
  /** The challenge the pending token is bound to. */
  challengeId: string;
  userId: string;
  businessId: string;
  purpose: PhoneOtpPurpose;
  /** The number the challenge was sent to; the token's `destination`. */
  destination: string;
  code: string;
}): Promise<PhoneOtpVerifyResult> {
  const fail = (reason: Extract<PhoneOtpVerifyResult, { verified: false }>["reason"]) =>
    ({ verified: false, reason } as const);

  if (!options.challengeId) return fail("no_challenge");

  const { rows } = await query<{
    id: string;
    subject_id: string;
    business_id: string | null;
    purpose: string | null;
    destination: string | null;
    hashed_otp: string;
    attempts: number;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id, subject_id, business_id, purpose, destination, hashed_otp,
            attempts, expires_at, consumed_at
       FROM mfa_challenges
      WHERE id = $1 AND subject_realm = $2
      LIMIT 1`,
    [options.challengeId, EMPLOYEE_PHONE_REALM],
  );
  const challenge = rows[0];
  if (!challenge) return fail("no_challenge");

  // The binding check. Every field the token asserts about this challenge is
  // re-checked against the row, because the token is a claim and the row is
  // the fact. A null column means the row predates migration 0215 and has no
  // binding to honour — it cannot be redeemed at all, which is the safe
  // answer for a row this build did not mint.
  if (
    challenge.subject_id !== options.userId ||
    challenge.business_id !== options.businessId ||
    challenge.purpose !== options.purpose ||
    challenge.destination !== options.destination ||
    challenge.business_id === null ||
    challenge.purpose === null ||
    challenge.destination === null
  ) {
    return fail("scope_mismatch");
  }

  if (challenge.consumed_at) return fail("consumed");
  if (new Date(challenge.expires_at).getTime() <= Date.now()) return fail("expired");
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) return fail("burned");

  const offered = await hashOtp(options.code.trim());
  const stored = Buffer.from(challenge.hashed_otp, "hex");
  const candidate = Buffer.from(offered, "hex");
  const isMatch = stored.length === candidate.length && timingSafeEqual(stored, candidate);

  if (!isMatch) {
    await query(
      `UPDATE mfa_challenges
          SET attempts = attempts + 1
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
          AND attempts < $2`,
      [challenge.id, MAX_OTP_ATTEMPTS],
    );
    return fail("wrong_code");
  }

  // The atomic single-use. Under READ COMMITTED the losing racer blocks here
  // until the winner commits, then re-evaluates this predicate against the
  // committed row — where consumed_at is now set — and updates nothing. One
  // row, one redemption, regardless of how many requests arrive together.
  const { rowCount } = await query(
    `UPDATE mfa_challenges
        SET consumed_at = now()
      WHERE id = $1 AND subject_realm = $2
        AND consumed_at IS NULL AND expires_at > now()
        AND attempts < $3
      RETURNING id`,
    [challenge.id, EMPLOYEE_PHONE_REALM, MAX_OTP_ATTEMPTS],
  );
  if (!rowCount) return fail("consumed");

  return { verified: true };
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
