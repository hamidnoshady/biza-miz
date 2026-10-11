/**
 * Issue #854 (P0.7 / P0.8 / P1.17) — one purpose-bound, atomically consumed OTP
 * challenge.
 *
 * Before this module there were three near-identical "look at the newest live
 * `mfa_challenges` row for this subject" implementations
 * (`mfa-verify.verifySmsOtp`, `phone-otp.verifyEmployeePhoneOtp`, and the
 * enrolment confirm path), each with its own copy of the same defects:
 *
 *  - **Identity was the subject, not the transaction.** A challenge was "a code
 *    this person has", so a code texted to number A could be redeemed while the
 *    caller asked the server to persist number B (#854 P0.8).
 *  - **Consumption was `SELECT` then `DELETE`.** Two concurrent verifies could
 *    both read the same live row and both succeed (#854 P1.17).
 *  - **Attempts incremented outside a lock.** Two wrong guesses racing could
 *    each see `attempts = 4`, both increment to 5, and the ceiling was breached.
 *
 * The shape below fixes all three by making the challenge a *transaction*:
 * `(subject, purpose, candidate phone)` is the identity, `consumed_at` is the
 * one transition every redemption goes through, and the whole read-verify-consume
 * runs inside a single `SELECT … FOR UPDATE` so a racing request blocks rather
 * than reads stale state.
 *
 * Everything here is deliberately not imported by anything that renders: the
 * callers are login/enrolment routes. The pure parts (purpose vocabulary, code
 * shape, Persian-digit normalisation) live at the top and are unit-tested in
 * `otp-challenge.test.ts`.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getPool, query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { toLatinDigits } from "./digits";

// ---------------------------------------------------------------------------
// Pure vocabulary
// ---------------------------------------------------------------------------

/**
 * What a challenge authorises. A code minted for one purpose is refused for
 * any other — that is what stops an enrolment SMS from being spendable as a
 * login, and a login SMS from being spendable as a phone change.
 */
export const OTP_PURPOSES = [
  /** Direct phone login: proves possession of the number being logged in with. */
  "login",
  /** Proving a number that is already on the membership (staff periodic check). */
  "verify_login_phone",
  /** Moving the membership's login phone to a new number. */
  "change_login_phone",
  /** The SMS second factor at login. */
  "mfa_login",
  /** Enrolling a new SMS second factor. */
  "mfa_enrol_sms",
  /** Step-up / recent-auth via SMS. */
  "step_up_sms",
  /** Tenant-triggered, account-holder-completed password recovery. */
  "password_recovery",
] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export function isOtpPurpose(value: unknown): value is OtpPurpose {
  return typeof value === "string" && (OTP_PURPOSES as readonly string[]).includes(value);
}

/** How long a code stays live. Five minutes survives a slow SMS without being a window. */
export const OTP_TTL_MINUTES = 5;
/** Wrong guesses allowed before the challenge is burned. */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * The canonical shape of a submitted code: exactly six Latin digits.
 *
 * Persian/Arabic-Indic digits are normalised first (#854 P2.23) — a member
 * reading «۱۲۳۴۵۶» off an SMS app and typing it into a numeric keypad should
 * not be told their code is invalid, and the PIN path already normalised.
 */
export function normalizeOtpCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const latin = toLatinDigits(input.trim()).replace(/[\s-]/g, "");
  return /^\d{6}$/.test(latin) ? latin : null;
}

/** The shape of a challenge as the login/enrolment paths need to see it. */
export interface OtpChallengeRow {
  id: string;
  purpose: OtpPurpose;
  candidatePhoneE164: string | null;
  expiresAt: Date;
}

/** True when a challenge can no longer be offered to a verifier. */
export function challengeIsLive(
  challenge: { consumedAt: Date | string | null; expiresAt: Date | string; attempts: number },
  now: Date = new Date(),
): boolean {
  if (challenge.consumedAt) return false;
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) return false;
  const expires = new Date(challenge.expiresAt).getTime();
  return Number.isFinite(expires) && expires > now.getTime();
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * HMAC of the code under the platform realm secret — the same key `jwt-secret`
 * hands the MFA interstitial, so a leaked `mfa_challenges` row yields nothing
 * without the deployment secret.
 */
async function hashCode(code: string): Promise<string> {
  const secret = await getRealmSecret("platform");
  return createHmac("sha256", secret).update(code).digest("hex");
}

async function codeMatches(code: string, storedHex: string): Promise<boolean> {
  const offered = Buffer.from(await hashCode(code), "hex");
  const stored = Buffer.from(storedHex, "hex");
  return offered.length === stored.length && timingSafeEqual(offered, stored);
}

/**
 * The keyed blind index for PIN uniqueness (#854 P2.13).
 *
 * Business-scoped so the same four digits in two businesses are two different
 * values, and keyed so a database read cannot enumerate the PIN space. It is
 * **not** a password hash and is never a substitute for `secret_hash` — bcrypt
 * still authenticates; this only answers "is this PIN free in this business?".
 */
export async function pinBlindIndex(businessId: string, pin: string): Promise<string> {
  const secret = await getRealmSecret("platform");
  return createHmac("sha256", secret)
    .update(`${businessId}:${pin}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface IssueOtpChallengeInput {
  subjectRealm: string;
  subjectId: string;
  purpose: OtpPurpose;
  /** null for subjects that are not tenant-scoped (platform admins). */
  /** The exact number this code is being sent to — bound into the challenge. */
  candidatePhoneE164?: string | null;
  /** Test seam; production always mints randomly. */
  code?: string;
}

export interface IssuedOtpChallenge {
  challengeId: string;
  /** The plaintext code. Only ever handed to the SMS transport, never returned. */
  code: string;
  expiresAt: Date;
}

/**
 * Mint a challenge.
 *
 * Any earlier *unconsumed* challenge for the same `(subject, purpose)` is
 * consumed first: two live codes for one purpose would make "which code did I
 * type" ambiguous and widen the guessing surface for no benefit. The candidate
 * phone is part of the new row, never inherited.
 */
export async function issueOtpChallenge(
  input: IssueOtpChallengeInput,
): Promise<IssuedOtpChallenge> {
  const code = input.code ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hashed = await hashCode(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

  return withoutTenantScope("platform", async () => {
    await query(
      `UPDATE mfa_challenges
          SET consumed_at = now()
        WHERE subject_realm = $1 AND subject_id = $2 AND purpose = $3
          AND consumed_at IS NULL`,
      [input.subjectRealm, input.subjectId, input.purpose],
    );

    /**
     * No `business_id`: `mfa_challenges` is exempt from RLS on purpose
     * (migration 0021 / `tenant-tables.ts`) because a challenge is minted
     * before any business has been established — the row is keyed by the
     * subject and the phone it was sent to, and the tenant is resolved by the
     * caller *after* proof (`integration/tenant-isolation.integration.test.ts`
     * asserts an exempt table carries no tenant column).
     */
    const { rows } = await query<{ id: string }>(
      `INSERT INTO mfa_challenges
         (subject_realm, subject_id, purpose, candidate_phone_e164,
          hashed_otp, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.subjectRealm,
        input.subjectId,
        input.purpose,
        input.candidatePhoneE164 ?? null,
        hashed,
        expiresAt,
      ],
    );

    return { challengeId: rows[0].id, code, expiresAt };
  });
}

export type OtpRedeemFailure =
  | "no_challenge"
  | "expired"
  | "attempts_exhausted"
  | "wrong_code"
  | "wrong_phone"
  | "wrong_purpose";

export type OtpRedeemResult =
  | { ok: true; challengeId: string; candidatePhoneE164: string | null }
  | { ok: false; reason: OtpRedeemFailure; attemptsRemaining?: number };

/**
 * Redeem a code against the newest live challenge for `(subject, purpose)`.
 *
 * The whole check runs in one transaction with the row locked `FOR UPDATE`, so
 * of N concurrent verifies exactly one can transition the challenge to
 * consumed: the others block on the lock, then see `consumed_at` set and are
 * refused. Attempt counting rides the same lock, so the ceiling is exact rather
 * than approximately five.
 *
 * `expectedPhoneE164` is the binding from #854 P0.8: when the caller has told
 * us which number this verification is *about*, it must equal the number the
 * code was actually sent to. A mismatch is refused **before** the code is even
 * compared, so a valid code for number A can never authorise a write of
 * number B.
 */
export async function redeemOtpChallenge(input: {
  subjectRealm: string;
  subjectId: string;
  purpose: OtpPurpose;
  code: string;
  /** When provided, must equal the challenge's stored candidate phone. */
  expectedPhoneE164?: string | null;
}): Promise<OtpRedeemResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const { rows } = await client.query<{
      id: string;
      hashed_otp: string;
      attempts: number;
      expires_at: Date;
      consumed_at: Date | null;
      candidate_phone_e164: string | null;
    }>(
      `SELECT id, hashed_otp, attempts, expires_at, consumed_at, candidate_phone_e164
         FROM mfa_challenges
        WHERE subject_realm = $1 AND subject_id = $2 AND purpose = $3
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.subjectRealm, input.subjectId, input.purpose],
    );

    const challenge = rows[0];
    if (!challenge) {
      await client.query("COMMIT");
      return { ok: false, reason: "no_challenge" };
    }

    if (challenge.expires_at.getTime() <= Date.now()) {
      // Expired: consume it so it cannot be offered again, and say why.
      await client.query(`UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1`, [
        challenge.id,
      ]);
      await client.query("COMMIT");
      return { ok: false, reason: "expired" };
    }

    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query(`UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1`, [
        challenge.id,
      ]);
      await client.query("COMMIT");
      return { ok: false, reason: "attempts_exhausted" };
    }

    // The binding (P0.8). Refused before the code is compared: the answer must
    // not distinguish "right code, wrong number" from "wrong code" to a caller
    // that only holds one of the two.
    if (
      input.expectedPhoneE164 !== undefined &&
      input.expectedPhoneE164 !== null &&
      challenge.candidate_phone_e164 !== null &&
      challenge.candidate_phone_e164 !== input.expectedPhoneE164
    ) {
      await client.query(
        `UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`,
        [challenge.id],
      );
      await client.query("COMMIT");
      return { ok: false, reason: "wrong_phone" };
    }

    if (!(await codeMatches(input.code, challenge.hashed_otp))) {
      const next = challenge.attempts + 1;
      const exhausted = next >= OTP_MAX_ATTEMPTS;
      await client.query(
        `UPDATE mfa_challenges
            SET attempts = $2,
                consumed_at = CASE WHEN $3 THEN now() ELSE consumed_at END
          WHERE id = $1`,
        [challenge.id, next, exhausted],
      );
      await client.query("COMMIT");
      return {
        ok: false,
        reason: exhausted ? "attempts_exhausted" : "wrong_code",
        attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - next),
      };
    }

    // The one transition. Conditional so a challenge already consumed by a
    // racing request cannot be consumed twice even if the lock were lost.
    const { rowCount } = await client.query(
      `UPDATE mfa_challenges SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL`,
      [challenge.id],
    );
    await client.query("COMMIT");
    if (!rowCount) return { ok: false, reason: "no_challenge" };

    return {
      ok: true,
      challengeId: challenge.id,
      candidatePhoneE164: challenge.candidate_phone_e164,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The candidate phone a live challenge is currently bound to, for the
 * resend/`GET` surfaces. Returns null when there is nothing live.
 *
 * This is what lets the phone card tell the member which number is waiting for
 * a code without ever trusting the request body for it.
 */
export async function liveChallengePhone(input: {
  subjectRealm: string;
  subjectId: string;
  purpose: OtpPurpose;
}): Promise<{
  challengeId: string;
  candidatePhoneE164: string | null;
  /** When the code was sent — the resend cooldown counts from here (P2.25). */
  createdAt: Date;
  expiresAt: Date;
} | null> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ id: string; candidate_phone_e164: string | null; created_at: Date; expires_at: Date }>(
      `SELECT id, candidate_phone_e164, created_at, expires_at
         FROM mfa_challenges
        WHERE subject_realm = $1 AND subject_id = $2 AND purpose = $3
          AND consumed_at IS NULL AND expires_at > now() AND attempts < $4
        ORDER BY created_at DESC LIMIT 1`,
      [input.subjectRealm, input.subjectId, input.purpose, OTP_MAX_ATTEMPTS],
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    challengeId: row.id,
    candidatePhoneE164: row.candidate_phone_e164,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Burn every live challenge for a subject+purpose (a successful completion, or an offboard). */
export async function consumeAllChallenges(input: {
  subjectRealm: string;
  subjectId: string;
  purpose?: OtpPurpose;
}): Promise<number> {
  return withoutTenantScope("platform", async () => {
    const { rowCount } = input.purpose
      ? await query(
          `UPDATE mfa_challenges SET consumed_at = now()
            WHERE subject_realm = $1 AND subject_id = $2 AND purpose = $3
              AND consumed_at IS NULL`,
          [input.subjectRealm, input.subjectId, input.purpose],
        )
      : await query(
          `UPDATE mfa_challenges SET consumed_at = now()
            WHERE subject_realm = $1 AND subject_id = $2 AND consumed_at IS NULL`,
          [input.subjectRealm, input.subjectId],
        );
    return rowCount ?? 0;
  });
}

/**
 * A deterministic UUID-shaped subject id derived from a phone number.
 *
 * Used for the one challenge that has no membership to hang off yet: the
 * "which business am I logging into?" case, where the number matches members in
 * several businesses and naming them before the code is verified would be a free
 * membership oracle (issue #854 P1.18). The challenge is instead keyed on the
 * number itself, so there is exactly one code and exactly one attempt budget for
 * the phone — rather than one per candidate member, which would multiply the
 * guesses an attacker gets.
 *
 * Keyed with the platform realm secret, so the derived id is not reversible to
 * the number by a database reader.
 */
export async function phoneDerivedSubject(e164: string): Promise<string> {
  const secret = await getRealmSecret("platform");
  const digest = createHmac("sha256", secret).update(`phone:${e164}`).digest();
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
