/**
 * ESH-200 / #1385 â€” public phone-first signup.
 *
 * The journey this module owns has one rule that shapes everything else: **no
 * personal identity exists until a code texted to the number has been
 * redeemed.** Requesting a code writes a proof-in-flight row; redeeming it
 * creates the person. Nothing here creates a business, membership, branch,
 * wallet, subscription or charge â€” that is #1387's separate, explicit act.
 *
 * Reused rather than re-invented:
 *
 *  - the purpose-bound `mfa_challenges` machinery (`src/lib/otp-challenge.ts`),
 *    under a `signup` purpose that no login door redeems;
 *  - the deployment's managed SMS provider (`src/lib/sms-config.ts`, #902);
 *  - the same send limiter the other OTP doors use, on its own realm;
 *  - `preparePhoneClaim`, so the number stored is the canonical E.164 mobile the
 *    global identity already enforces;
 *  - `createVerifiedPersonalIdentity`, the one canonical creator for a
 *    phone-first person.
 *
 * Deliberate boundaries:
 *
 *  - **No enumeration.** The request endpoint answers the same `sent` shape
 *    whether or not the number already has an account, and the verify endpoint
 *    only reveals "you already have an account" *after* the caller proved
 *    control of the number â€” at which point it is their own information.
 *  - **One identity per verified number.** Concurrent redemptions of one code
 *    (or two codes for one number) converge on the partial unique index
 *    `idx_platform_users_verified_phone`; a loser reads the winner back instead
 *    of creating a duplicate. An ambiguous legacy state is refused, never
 *    merged.
 *  - **The proof and the identity commit together.** The request row and its
 *    challenge are locked and redeemed on the same transaction that creates the
 *    person, so a database failure cannot leave a consumed code with no
 *    identity (the retry would have no live challenge).
 *  - **Names are captured at request time**, in the proof row, so the second
 *    request cannot substitute a different name for the one SMS that was sent.
 *  - **The pending request carries its own random token.** The client proves it
 *    is the same browser that asked for this code, which makes a replayed verify
 *    unable to hand a continuation to someone who only knows the number.
 *
 * The service is DB-touching; the normalisation/validation half is pure and
 * unit-tested in `public-signup.test.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import {
  consumeAllChallenges,
  issueOtpChallenge,
  normalizeOtpCode,
  redeemOtpChallengeOnClient,
} from "../otp-challenge";
import { checkPhoneOtpRateLimit, maskPhoneE164 } from "../phone-otp";
import { resolveSmsProvider } from "../sms-config";
import { KavenegarError } from "../sms-kavenegar";
import { publicSignupEnabled } from "../business-provisioning";
import { recordSecurityAudit, transactionAuditExecutor } from "../security-audit";
import {
  createVerifiedPersonalIdentity,
  preparePhoneClaim,
} from "./global-identity-service";

/** The `mfa_challenges.subject_realm` a signup code lives under. */
export const SIGNUP_SUBJECT_REALM = "platform_signup";

/** Same five-minute window as every other OTP door. */
export const SIGNUP_CODE_TTL_SECONDS = 5 * 60;
/** Matches `checkPhoneOtpRateLimit`'s first window. */
export const SIGNUP_RESEND_COOLDOWN_SECONDS = 60;
/** How long a successfully redeemed request may be replayed by its own client. */
export const SIGNUP_IDEMPOTENCY_MINUTES = 15;

export const SIGNUP_NAME_MAX = 100;

/** Every failure a public caller may see is deliberately generic. */
export type SignupError =
  | "signup_disabled"
  | "invalid_name"
  | "invalid_phone"
  | "invalid_code"
  | "rate_limited"
  | "sms_dispatch_failed"
  | "account_ambiguous"
  | "account_unavailable";

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

/** The client-held proof that this browser started the request. */
export function normalizeSignupRequestToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return /^[A-Za-z0-9_-]{20,256}$/.test(token) ? token : null;
}

/** The stored form of the pending-request token. Never the token itself. */
export function hashSignupRequestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The limiter key for one number.
 *
 * Hashed so a table read of `auth_login_attempts` does not become a list of
 * every mobile number that has tried to register. The same number maps to the
 * same key, which is all the cooldown and hourly/daily caps need.
 */
export function signupRateLimitKey(phoneE164: string): string {
  return `signup:${createHash("sha256").update(phoneE164, "utf8").digest("hex")}`;
}

export type SignupRequestResult =
  | {
      ok: true;
      status: "sent";
      maskedPhone: string;
      requestToken: string;
      expiresInSeconds: number;
      resendAfterSeconds: number;
    }
  | { ok: false; error: "signup_disabled" | "invalid_name" | "invalid_phone" }
  | { ok: false; error: "rate_limited"; retryAfterMs: number }
  | { ok: false; error: "sms_dispatch_failed"; message?: string };

/** Raised inside the request transaction when the post-lock re-check refuses. */
class SignupRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("rate_limited");
    this.name = "SignupRateLimitedError";
  }
}

/**
 * Start a signup: validate, mint a `signup` challenge and send it.
 *
 * Superseding live requests for the number matters: only the newest code may be
 * redeemed, so a resend cannot leave two attempt budgets alive for one number,
 * and an old SMS read from a notification shade cannot create a second
 * identity. The request row and challenge commit together; the SMS leaves only
 * after that commit.
 */
export async function requestSignupOtp(
  body: { firstName?: unknown; lastName?: unknown; phone?: unknown },
  options: {
    /**
     * Test seam. Production leaves it out and the managed provider is resolved
     * from the platform SMS configuration; an integration test injects a
     * recorder so a live code never appears in test output.
     */
    sendOtp?: (phoneE164: string, code: string) => Promise<void>;
  } = {},
): Promise<SignupRequestResult> {
  if (!publicSignupEnabled()) return { ok: false, error: "signup_disabled" };

  const validated = validateSignupDetails(body);
  if (!validated.ok) return validated;
  const { details } = validated;

  const identityKey = signupRateLimitKey(details.phoneE164);
  const limit = await checkPhoneOtpRateLimit(identityKey, "signup");
  if (!limit.allowed) {
    await auditBestEffort({
      action: "auth.signup.rate_limited",
      payload: { scope: "request", retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000) },
    });
    return { ok: false, error: "rate_limited", retryAfterMs: limit.retryAfterMs };
  }

  const requestToken = randomBytes(32).toString("base64url");
  const requestTokenHash = hashSignupRequestToken(requestToken);

  let issued: {
    requestId: string;
    attemptId: string;
    challenge: Awaited<ReturnType<typeof issueOtpChallenge>>;
  };
  try {
    issued = await withoutTenantScopeTransaction("signup", async () => {
      // Serialise this number's live requests before the limiter is re-read.
      // Two tabs submitting at once otherwise both pass the pre-lock check and
      // race the partial unique index; with the lock the second sees the first
      // send and is answered with the cooldown, not a 23505.
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `signup:${details.phoneE164}`,
      ]);
      const afterLock = await checkPhoneOtpRateLimit(identityKey, "signup");
      if (!afterLock.allowed) throw new SignupRateLimitedError(afterLock.retryAfterMs);

      // A resend consumes the old row and its challenge before the new one
      // exists, so there is exactly one live code for the number.
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
        });
        await query(
          `UPDATE platform_signup_requests SET consumed_at = now()
            WHERE id = $1 AND consumed_at IS NULL`,
          [request.id],
        );
      }

      const expiresAt = new Date(Date.now() + SIGNUP_CODE_TTL_SECONDS * 1000);
      const { rows } = await query<{ id: string }>(
        `INSERT INTO platform_signup_requests
           (phone_e164, first_name, last_name, request_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [details.phoneE164, details.firstName, details.lastName, requestTokenHash, expiresAt],
      );
      const requestId = rows[0].id;

      const challenge = await issueOtpChallenge({
        subjectRealm: SIGNUP_SUBJECT_REALM,
        subjectId: requestId,
        purpose: "signup",
        candidatePhoneE164: details.phoneE164,
      });

      // 'reserved' rather than 'success': the send has not happened yet. It is
      // still a row in the limiter's window, so a provider failure cannot let a
      // caller retry faster than a delivered code.
      const { rows: attempts } = await query<{ id: string }>(
        `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
         VALUES ('signup', $1, 'reserved')
         RETURNING id`,
        [identityKey],
      );

      await recordSecurityAudit(
        {
          realm: "platform",
          action: "auth.signup.requested",
          entity: "platform_signup_request",
          entityId: requestId,
          payload: { maskedPhone: maskPhoneE164(details.phoneE164) },
        },
        transactionAuditExecutor(),
      );

      return { requestId, attemptId: attempts[0].id, challenge };
    });
  } catch (error) {
    if (error instanceof SignupRateLimitedError) {
      await auditBestEffort({
        action: "auth.signup.rate_limited",
        payload: { scope: "request", retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) },
      });
      return { ok: false, error: "rate_limited", retryAfterMs: error.retryAfterMs };
    }
    console.error("[signup] could not persist the pending request", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, error: "sms_dispatch_failed" };
  }

  try {
    if (options.sendOtp) {
      await options.sendOtp(details.phoneE164, issued.challenge.code);
    } else {
      const { provider, configured } = await resolveSmsProvider();
      // An unconfigured fallback would log the code in development and throw
      // elsewhere. Signup must never rely on a log line: refuse, consume the
      // challenge and report a recoverable failure.
      if (!configured) throw new Error("sms_not_configured");
      await provider.sendOtp(details.phoneE164, issued.challenge.code);
    }
  } catch (error) {
    await failPendingRequest(issued.requestId, issued.attemptId, error);
    const message =
      error instanceof KavenegarError && !error.operatorFault ? error.message : undefined;
    return { ok: false, error: "sms_dispatch_failed", message };
  }

  await withoutTenantScope("signup", () =>
    query(`UPDATE auth_login_attempts SET outcome = 'success' WHERE id = $1`, [
      issued.attemptId,
    ]),
  ).catch((error) => {
    // The SMS has already left; an unrecorded success must not make the person
    // request a second code. The row still counts as a send in the window.
    console.error("[signup] could not mark the send successful", {
      attemptId: issued.attemptId,
      error: error instanceof Error ? error.message : "unknown",
    });
  });

  await auditBestEffort({
    action: "auth.signup.sent",
    entity: "platform_signup_request",
    entityId: issued.requestId,
    payload: { maskedPhone: maskPhoneE164(details.phoneE164) },
  });

  return {
    ok: true,
    status: "sent",
    maskedPhone: maskPhoneE164(details.phoneE164),
    requestToken,
    expiresInSeconds: SIGNUP_CODE_TTL_SECONDS,
    resendAfterSeconds: SIGNUP_RESEND_COOLDOWN_SECONDS,
  };
}

async function failPendingRequest(
  requestId: string,
  attemptId: string,
  error: unknown,
): Promise<void> {
  console.error("[signup] SMS dispatch failed", {
    requestId,
    error: error instanceof Error ? error.message : "unknown",
  });
  try {
    await withoutTenantScopeTransaction("signup", async () => {
      await consumeAllChallenges({
        subjectRealm: SIGNUP_SUBJECT_REALM,
        subjectId: requestId,
      });
      await query(
        `UPDATE platform_signup_requests SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL`,
        [requestId],
      );
      await query(`UPDATE auth_login_attempts SET outcome = 'failed' WHERE id = $1`, [
        attemptId,
      ]);
    });
    // The proof is already unusable; a failed audit write must not roll that
    // back and leave a live challenge behind a "could not send" response.
    await auditBestEffort({
      action: "auth.signup.sms_failed",
      entity: "platform_signup_request",
      entityId: requestId,
      payload: { reason: error instanceof Error ? error.message : "unknown" },
    });
  } catch (cleanupError) {
    // The request row remains live only if this also failed; the route still
    // answers a recoverable failure and the provider never delivered a code.
    console.error("[signup] could not consume a failed request", {
      requestId,
      error: cleanupError instanceof Error ? cleanupError.message : "unknown",
    });
  }
}

export type SignupVerifyResult =
  | {
      ok: true;
      platformUserId: string;
      /** True only for the redemption that created the identity. */
      created: boolean;
      /** True when the request had already been redeemed by this client. */
      resumed: boolean;
      /** Whether the person already belongs to a business. */
      hasBusinessMemberships: boolean;
    }
  | { ok: false; error: Exclude<SignupError, "rate_limited"> };

/**
 * A refusal discovered *after* the code was redeemed.
 *
 * Thrown rather than returned so the surrounding transaction ROLLBACKs the OTP
 * consumption. Returning a failure object would COMMIT the consumed challenge
 * and trap the person with no live code â€” the exact state #1385 forbids.
 */
class SignupResolutionError extends Error {
  constructor(readonly signupError: "account_ambiguous" | "account_unavailable") {
    super(signupError);
    this.name = "SignupResolutionError";
  }
}

/**
 * Redeem the code and resolve the person.
 *
 * The OTP consumption and the identity write share one transaction. A failure
 * at any point rolls the challenge back too, so the person can retry the same
 * code instead of being trapped by a consumed challenge and no account.
 *
 * `created: false` with `resumed: true` means this same client already redeemed
 * the request (a lost response, a double tap); it is idempotent for the
 * configured grace period. Any other already-redeemed request is refused.
 */
export async function verifySignupOtp(body: {
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
  code?: unknown;
  requestToken?: unknown;
}): Promise<SignupVerifyResult> {
  if (!publicSignupEnabled()) return { ok: false, error: "signup_disabled" };

  const validated = validateSignupDetails(body);
  if (!validated.ok) {
    // A malformed number must not get a more specific answer than a wrong code:
    // this is an unauthenticated caller, and the phone is the account key.
    return { ok: false, error: "invalid_code" };
  }
  const phone = validated.details.phoneE164;
  const code = normalizeOtpCode(body.code);
  const requestToken = normalizeSignupRequestToken(body.requestToken);
  if (!code || !requestToken) return { ok: false, error: "invalid_code" };

  const tokenHash = hashSignupRequestToken(requestToken);

  let outcome:
    | (Extract<SignupVerifyResult, { ok: true }>)
    | { ok: false; error: Exclude<SignupError, "rate_limited">; reason: string };
  try {
    outcome = await withoutTenantScopeTransaction("signup", async (client) => {
      const { rows: requests } = await query<{
        id: string;
        first_name: string;
        last_name: string;
        consumed_at: Date | null;
        verified_at: Date | null;
        platform_user_id: string | null;
        identity_created: boolean;
        expires_at: Date;
      }>(
        `SELECT id, first_name, last_name, consumed_at, verified_at,
                platform_user_id, identity_created, expires_at
           FROM platform_signup_requests
          WHERE phone_e164 = $1 AND request_token_hash = $2
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [phone, tokenHash],
      );
      const signupRequest = requests[0];
      if (!signupRequest) {
        return { ok: false as const, error: "invalid_code" as const, reason: "request_missing" };
      }

      // Idempotent retry of a successful redemption by the client that owns the
      // request token. Bounded in time: the token is not a permanent credential.
      if (signupRequest.verified_at && signupRequest.platform_user_id) {
        const fresh =
          Date.now() - new Date(signupRequest.verified_at).getTime() <=
          SIGNUP_IDEMPOTENCY_MINUTES * 60_000;
        const identity = await readIdentity(signupRequest.platform_user_id);
        if (!identity) {
          return { ok: false as const, error: "invalid_code" as const, reason: "identity_missing" };
        }
        if (!identity.isActive) {
          return {
            ok: false as const,
            error: "account_unavailable" as const,
            reason: "identity_inactive",
          };
        }
        if (!fresh) {
          return { ok: false as const, error: "invalid_code" as const, reason: "replay_window_expired" };
        }
        return {
          ok: true as const,
          platformUserId: identity.id,
          // This call did not create the identity; the request it is replaying
          // did. `resumed` carries that distinction, so `created` stays honest
          // for the caller that is counting new people.
          created: false,
          resumed: true,
          hasBusinessMemberships: await hasMembership(identity.id),
        };
      }

      if (signupRequest.consumed_at) {
        return { ok: false as const, error: "invalid_code" as const, reason: "request_consumed" };
      }
      if (new Date(signupRequest.expires_at).getTime() <= Date.now()) {
        await query(
          `UPDATE platform_signup_requests SET consumed_at = now()
            WHERE id = $1 AND consumed_at IS NULL`,
          [signupRequest.id],
        );
        return { ok: false as const, error: "invalid_code" as const, reason: "request_expired" };
      }

      const redeemed = await redeemOtpChallengeOnClient(client, {
        subjectRealm: SIGNUP_SUBJECT_REALM,
        subjectId: signupRequest.id,
        purpose: "signup",
        code,
        expectedPhoneE164: phone,
      });
      if (!redeemed.ok) {
        return { ok: false as const, error: "invalid_code" as const, reason: redeemed.reason };
      }

      const resolution = await resolveSignupIdentity(
        phone,
        signupFullName({ firstName: signupRequest.first_name, lastName: signupRequest.last_name }),
      );
      if (!resolution.ok) {
        // Thrown, not returned: the surrounding transaction must roll the OTP
        // consumption back, or the person is left with a burned code and no
        // account. The catch below turns it into a safe response.
        throw new SignupResolutionError(resolution.error);
      }

      await query(
        `UPDATE platform_signup_requests
            SET consumed_at = now(),
                verified_at = COALESCE(verified_at, now()),
                platform_user_id = $2,
                identity_created = $3
          WHERE id = $1`,
        [signupRequest.id, resolution.platformUserId, resolution.created],
      );

      await recordSignupAudit(
        resolution.created ? "auth.signup.identity_created" : "auth.signup.identity_linked",
        {
          requestId: signupRequest.id,
          platformUserId: resolution.platformUserId,
          maskedPhone: maskPhoneE164(phone),
        },
        transactionAuditExecutor(),
      );
      await recordSecurityAudit(
        {
          realm: "platform",
          action: "auth.signup.verified",
          entity: "platform_signup_request",
          entityId: signupRequest.id,
          payload: {
            platformUserId: resolution.platformUserId,
            created: resolution.created,
            maskedPhone: maskPhoneE164(phone),
          },
        },
        transactionAuditExecutor(),
      );

      return {
        ok: true as const,
        platformUserId: resolution.platformUserId,
        created: resolution.created,
        resumed: false,
        hasBusinessMemberships: await hasMembership(resolution.platformUserId),
      };
    });
  } catch (error) {
    if (error instanceof SignupResolutionError) {
      await auditBestEffort({
        action: "auth.signup.verify_failed",
        entity: "platform_signup_request",
        payload: { reason: error.signupError, error: error.signupError },
      });
      return { ok: false, error: error.signupError };
    }
    throw error;
  }

  if (!outcome.ok) {
    await auditBestEffort({
      action: "auth.signup.verify_failed",
      entity: "platform_signup_request",
      payload: { reason: outcome.reason, error: outcome.error },
    });
    return { ok: false, error: outcome.error };
  }
  return outcome;
}

interface IdentityRow {
  id: string;
  isActive: boolean;
}

async function readIdentity(platformUserId: string): Promise<IdentityRow | null> {
  const { rows } = await query<{ id: string; is_active: boolean }>(
    `SELECT id, is_active FROM platform_users WHERE id = $1`,
    [platformUserId],
  );
  const row = rows[0];
  return row ? { id: row.id, isActive: row.is_active } : null;
}

async function hasMembership(platformUserId: string): Promise<boolean> {
  const { rows } = await query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users WHERE platform_user_id = $1
     ) AS present`,
    [platformUserId],
  );
  return rows[0]?.present === true;
}

type IdentityResolution =
  | { ok: true; platformUserId: string; created: boolean }
  | { ok: false; error: "account_ambiguous" | "account_unavailable" };

/**
 * Create the personal identity, or find the one this number already owns.
 *
 * The union is deliberate while both columns exist: the global identity's
 * verified number is authoritative, and a membership that verified the same
 * number is the legacy shape the mirror backfills from. The union is
 * de-duplicated by identity id so one person with two memberships is still one
 * candidate. More than one candidate is refused rather than merged (#1384).
 */
async function resolveSignupIdentity(
  phoneE164: string,
  fullName: string,
): Promise<IdentityResolution> {
  const { rows: candidates } = await query<{ id: string; is_active: boolean }>(
    `SELECT p.id, p.is_active
       FROM platform_users p
      WHERE p.phone_e164 = $1 AND p.phone_verified_at IS NOT NULL
     UNION
     SELECT p.id, p.is_active
       FROM users u
       JOIN platform_users p ON p.id = u.platform_user_id
      WHERE u.phone_e164 = $1 AND u.phone_verified_at IS NOT NULL`,
    [phoneE164],
  );

  const distinct = [...new Map(candidates.map((row) => [row.id, row])).values()];
  if (distinct.length > 1) {
    console.error("[signup] ambiguous verified phone resolved to several identities", {
      identityCount: distinct.length,
    });
    return { ok: false, error: "account_ambiguous" };
  }

  if (distinct[0]) {
    if (!distinct[0].is_active) return { ok: false, error: "account_unavailable" };
    return { ok: true, platformUserId: distinct[0].id, created: false };
  }

  const created = await createVerifiedPersonalIdentity({ fullName, phone: phoneE164 });
  if (!created.ok) {
    if (created.error === "identity_conflict") {
      console.error("[signup] verified phone creation conflicted with several identities");
      return { ok: false, error: "account_ambiguous" };
    }
    // A validation refusal here means the number changed shape between the two
    // checks; it is a programming error, not something the visitor can fix.
    throw new Error(`signup identity refused: ${created.error}`);
  }

  const identity = await readIdentity(created.platformUserId);
  if (!identity) throw new Error("signup identity vanished after creation");
  if (!identity.isActive) return { ok: false, error: "account_unavailable" };
  return { ok: true, platformUserId: created.platformUserId, created: created.created };
}

type AuditEntry = {
  action: string;
  entity?: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
};

function recordSignupAudit(
  action: string,
  payload: Record<string, unknown>,
  executor?: ReturnType<typeof transactionAuditExecutor>,
): Promise<void> {
  return recordSecurityAudit(
    {
      realm: "platform",
      action,
      entity: "platform_signup_request",
      entityId: typeof payload.requestId === "string" ? payload.requestId : null,
      payload,
    },
    executor,
  );
}

/**
 * An audit row for a refusal or a send outcome must be durable, but it is not
 * worth turning a safe 429/401 into a 500 after the security decision has
 * already been made. State changes (the request row, the challenge, the
 * identity) write their audit rows inside the transaction instead.
 */
async function auditBestEffort(entry: AuditEntry): Promise<void> {
  try {
    await recordSecurityAudit({
      realm: "platform",
      action: entry.action,
      entity: entry.entity ?? "platform_signup_request",
      entityId: entry.entityId ?? null,
      payload: entry.payload ?? {},
    });
  } catch (error) {
    console.error("[signup] audit write failed", {
      action: entry.action,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
