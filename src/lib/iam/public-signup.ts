/**
 * ESH-200 / #1385 — public phone-first signup.
 *
 * The journey this module owns has exactly one rule that shapes everything
 * else: **no personal identity exists until a code texted to the number has
 * been redeemed.** Requesting a code writes a proof-in-flight row; redeeming it
 * creates the person. Nothing here creates a business, membership, branch,
 * wallet, subscription or charge — that is #1387's separate, explicit act.
 *
 * Reused rather than re-invented:
 *
 *  - the purpose-bound `mfa_challenges` machinery (`src/lib/otp-challenge.ts`),
 *    under a `signup` purpose that no login door redeems;
 *  - the deployment's managed SMS provider (`src/lib/sms-config.ts`, #902);
 *  - the same send limiter the other OTP doors use, on its own realm;
 *  - `preparePhoneClaim`, so the number stored is the canonical E.164 mobile the
 *    global identity already enforces.
 *
 * Deliberate boundaries:
 *
 *  - **No enumeration.** The request endpoint answers the same `sent` shape
 *    whether or not the number already has an account, and the verify endpoint
 *    only reveals "you already have an account" *after* the caller proved
 *    control of the number — at which point it is their own information.
 *  - **One identity per verified number.** Concurrent redemptions of one code
 *    (or two codes for one number) converge on the partial unique index
 *    `idx_platform_users_verified_phone`; a loser reads the winner back instead
 *    of creating a duplicate. An ambiguous legacy state is refused, never
 *    merged.
 *  - **Names are captured at request time**, in the proof row, so the second
 *    request cannot substitute a different name for the one SMS that was sent.
 *
 * The service is DB-touching; the normalisation/validation half is pure and
 * unit-tested in `public-signup.test.ts`.
 */
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import {
  consumeAllChallenges,
  issueOtpChallenge,
  normalizeOtpCode,
  redeemOtpChallenge,
} from "../otp-challenge";
import { checkPhoneOtpRateLimit, maskPhoneE164 } from "../phone-otp";
import { getSmsProvider } from "../sms-config";
import { KavenegarError } from "../sms-kavenegar";
import { preparePhoneClaim } from "./global-identity-service";
import { isPublicSignupEnabled } from "./platform-auth-settings";

/** The `mfa_challenges.subject_realm` a signup code lives under. */
export const SIGNUP_SUBJECT_REALM = "platform_signup";

/** Every wrong/expired/unknown code answers the same way. */
export const SIGNUP_CODE_TTL_SECONDS = 5 * 60;

export const SIGNUP_NAME_MAX = 100;

/**
 * Normalise one name field.
 *
 * Collapses whitespace and drops control characters, rejects an empty result and
 * enforces the column's bound. A name is not validated against a script or
 * alphabet: this product's people write Persian, Latin and a mix of the two.
 */
export function normalizeSignupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > SIGNUP_NAME_MAX) return null;
  return name;
}

export interface SignupDetails {
  firstName: string;
  lastName: string;
  phoneE164: string;
}

export type SignupDetailsResult =
  | { ok: true; details: SignupDetails }
  | { ok: false; error: "invalid_name" | "invalid_phone" };

/** Validate exactly the three fields signup asks for. Pure. */
export function validateSignupDetails(body: {
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
}): SignupDetailsResult {
  const firstName = normalizeSignupName(body.firstName);
  const lastName = normalizeSignupName(body.lastName);
  if (!firstName || !lastName) return { ok: false, error: "invalid_name" };

  // `preparePhoneClaim` already normalises Persian/Arabic-Indic digits through
  // `src/lib/phone.ts` and accepts a mobile only: a landline cannot receive the
  // SMS this flow depends on.
  const prepared = preparePhoneClaim(typeof body.phone === "string" ? body.phone : "");
  if (!prepared.ok) return { ok: false, error: "invalid_phone" };

  return { ok: true, details: { firstName, lastName, phoneE164: prepared.phoneE164 } };
}

/** The identity's display name, composed once so both writes agree. */
export function signupFullName(details: Pick<SignupDetails, "firstName" | "lastName">): string {
  return `${details.firstName} ${details.lastName}`;
}

export type SignupRequestResult =
  | { ok: true; status: "sent"; maskedPhone: string; expiresInSeconds: number }
  | { ok: false; error: "signup_disabled" | "invalid_name" | "invalid_phone" }
  | { ok: false; error: "rate_limited"; retryAfterMs: number }
  | { ok: false; error: "sms_dispatch_failed"; message?: string };

/**
 * Start a signup: validate, mint a `signup` challenge and send it.
 *
 * Superseding live requests for the number matters: only the newest code may
 * be redeemed, so a resend cannot leave two attempt budgets alive for one
 * number, and an old SMS read from a notification shade cannot create a second
 * identity.
 */
export async function requestSignupOtp(body: {
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
}): Promise<SignupRequestResult> {
  if (!(await isPublicSignupEnabled())) return { ok: false, error: "signup_disabled" };

  const validated = validateSignupDetails(body);
  if (!validated.ok) return validated;
  const { details } = validated;

  const limit = await checkPhoneOtpRateLimit(`signup:${details.phoneE164}`, "signup");
  if (!limit.allowed) return { ok: false, error: "rate_limited", retryAfterMs: limit.retryAfterMs };

  const issued = await withoutTenantScopeTransaction("signup", async () => {
    const { rows: live } = await query<{ id: string }>(
      `SELECT id FROM platform_signup_requests
        WHERE phone_e164 = $1 AND consumed_at IS NULL
        FOR UPDATE`,
      [details.phoneE164],
    );
    for (const request of live) {
      await consumeAllChallenges({
        subjectRealm: SIGNUP_SUBJECT_REALM,
        subjectId: request.id,
      }).catch(() => {});
    }
    await query(
      `UPDATE platform_signup_requests
          SET consumed_at = now()
        WHERE phone_e164 = $1 AND consumed_at IS NULL`,
      [details.phoneE164],
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO platform_signup_requests (phone_e164, first_name, last_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [details.phoneE164, details.firstName, details.lastName],
    );
    const requestId = rows[0].id;
    const challenge = await issueOtpChallenge({
      subjectRealm: SIGNUP_SUBJECT_REALM,
      subjectId: requestId,
      purpose: "signup",
      candidatePhoneE164: details.phoneE164,
    });
    return { requestId, challenge };
  });

  try {
    const provider = await getSmsProvider();
    await provider.sendOtp(details.phoneE164, issued.challenge.code);
  } catch (error) {
    // A code that was never delivered must not sit live for five minutes, and
    // the request must not stay redeemable.
    await consumeAllChallenges({
      subjectRealm: SIGNUP_SUBJECT_REALM,
      subjectId: issued.requestId,
    }).catch(() => {});
    await withoutTenantScope("signup", () =>
      query(
        `UPDATE platform_signup_requests SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
        [issued.requestId],
      ),
    ).catch(() => {});
    console.error("[signup] SMS dispatch failed", {
      requestId: issued.requestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    const message =
      error instanceof KavenegarError && !error.operatorFault ? error.message : undefined;
    return { ok: false, error: "sms_dispatch_failed", message };
  }

  await withoutTenantScope("signup", () =>
    query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('signup', $1, 'success')`,
      [`signup:${details.phoneE164}`],
    ),
  );

  return {
    ok: true,
    status: "sent",
    maskedPhone: maskPhoneE164(details.phoneE164),
    expiresInSeconds: SIGNUP_CODE_TTL_SECONDS,
  };
}

export type SignupVerifyResult =
  | { ok: true; platformUserId: string; created: boolean }
  | { ok: false; error: "invalid_code" | "invalid_phone" | "signup_disabled" | "account_ambiguous" };

/**
 * Redeem the code and resolve the person.
 *
 * `created: false` means the number already belonged to a verified identity and
 * the caller proved control of it: the request is linked to that identity and
 * no second person is created. The route answers with a sign-in path rather than
 * an onboarding cookie, because their account already exists.
 */
export async function verifySignupOtp(body: {
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
  code?: unknown;
}): Promise<SignupVerifyResult> {
  if (!(await isPublicSignupEnabled())) return { ok: false, error: "signup_disabled" };

  const validated = validateSignupDetails(body);
  if (!validated.ok) {
    return { ok: false, error: validated.error === "invalid_phone" ? "invalid_phone" : "invalid_code" };
  }
  const phone = validated.details.phoneE164;
  const code = normalizeOtpCode(body.code);
  if (!code) return { ok: false, error: "invalid_code" };

  const { rows: requests } = await withoutTenantScope("signup", () =>
    query<{ id: string }>(
      `SELECT id FROM platform_signup_requests
        WHERE phone_e164 = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone],
    ),
  );
  const request = requests[0];
  if (!request) return { ok: false, error: "invalid_code" };

  const redeemed = await redeemOtpChallenge({
    subjectRealm: SIGNUP_SUBJECT_REALM,
    subjectId: request.id,
    purpose: "signup",
    code,
    expectedPhoneE164: phone,
  });
  if (!redeemed.ok) return { ok: false, error: "invalid_code" };

  return resolveSignupIdentity(request.id, phone);
}

/**
 * Create the personal identity, or find the one this number already owns.
 *
 * Runs under an advisory lock keyed on the number *and* relies on the partial
 * unique index, so two concurrent redemptions (two devices, a double tap, a
 * retried request) produce one row. A state with more than one candidate
 * identity is refused — #1384 forbids resolving ambiguity by picking one.
 */
async function resolveSignupIdentity(
  requestId: string,
  phoneE164: string,
): Promise<SignupVerifyResult> {
  try {
    return await withoutTenantScopeTransaction("signup", async () => {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `signup:${phoneE164}`,
      ]);

      const { rows: requestRows } = await query<{
        id: string;
        first_name: string;
        last_name: string;
        platform_user_id: string | null;
        consumed_at: Date | null;
      }>(
        `SELECT id, first_name, last_name, platform_user_id, consumed_at
           FROM platform_signup_requests
          WHERE id = $1
          FOR UPDATE`,
        [requestId],
      );
      const signupRequest = requestRows[0];
      if (!signupRequest) return { ok: false as const, error: "invalid_code" as const };

      /*
       * Dual-read on purpose while both columns exist: the global identity's
       * verified number is authoritative, and a membership that verified the
       * same number is the legacy shape the mirror backfills from. The union is
       * de-duplicated by identity id so one person with two memberships is still
       * one candidate.
       */
      const { rows: existing } = await query<{ id: string }>(
        `SELECT p.id
           FROM platform_users p
          WHERE p.phone_e164 = $1 AND p.phone_verified_at IS NOT NULL
         UNION
         SELECT p.id
           FROM users u
           JOIN platform_users p ON p.id = u.platform_user_id
          WHERE u.phone_e164 = $1 AND u.phone_verified_at IS NOT NULL
          LIMIT 2`,
        [phoneE164],
      );

      if (existing.length > 1) {
        // Proof of the number is not proof of *which* person: refuse rather than
        // merge or pick. The conflict is visible to support, not resolvable here.
        console.error("[signup] ambiguous verified phone resolved to several identities", {
          requestId,
          identityCount: existing.length,
        });
        return { ok: false as const, error: "account_ambiguous" as const };
      }

      let platformUserId: string;
      let created = false;
      if (existing[0]) {
        platformUserId = existing[0].id;
      } else {
        const { rows } = await query<{ id: string }>(
          `INSERT INTO platform_users (email, password_hash, full_name, phone_e164, phone_verified_at)
           VALUES (NULL, NULL, $1, $2, now())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            signupFullName({
              firstName: signupRequest.first_name,
              lastName: signupRequest.last_name,
            }),
            phoneE164,
          ],
        );
        if (rows[0]) {
          platformUserId = rows[0].id;
          created = true;
        } else {
          // The unique index rejected the insert: another redemption of the same
          // number won between the advisory lock being taken and the write (a
          // second, separately-keyed request). Read the winner back.
          const { rows: winner } = await query<{ id: string }>(
            `SELECT id FROM platform_users
              WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL
              LIMIT 2`,
            [phoneE164],
          );
          if (winner.length !== 1) {
            return { ok: false as const, error: "account_ambiguous" as const };
          }
          platformUserId = winner[0].id;
        }
      }

      /*
       * The proof row is consumed only now. A failed redemption never reaches
       * here; a successful one leaves an auditable record of the identity it
       * resolved to, which is what a support call needs.
       */
      await query(
        `UPDATE platform_signup_requests
            SET consumed_at = COALESCE(consumed_at, now()),
                platform_user_id = $2
          WHERE id = $1`,
        [requestId, platformUserId],
      );

      return { ok: true as const, platformUserId, created };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      // A verified number appeared under us. Treat the retry as the existing-
      // account outcome rather than as a failure the visitor could retry into a
      // second identity.
      const { rows } = await withoutTenantScope("signup", () =>
        query<{ id: string }>(
          `SELECT id FROM platform_users
            WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL
            LIMIT 2`,
          [phoneE164],
        ),
      );
      if (rows.length === 1) {
        return { ok: true, platformUserId: rows[0].id, created: false };
      }
      return { ok: false, error: "account_ambiguous" };
    }
    throw error;
  }
}
