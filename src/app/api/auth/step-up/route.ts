import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  requireMember,
  sessionCookieOptions,
  signSession,
  withTenantScope,
} from "@/lib/auth";
import { query, withoutTenantScope } from "@/lib/db";
import { verifyPassword } from "@/lib/team-service";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { verifyExistingConfirmedMfaFactor } from "@/lib/mfa-verify";
import { issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import {
  isRecentAuth,
  RECENT_AUTH_WINDOW_SECONDS,
} from "@/lib/recent-auth";
import {
  AUTH_ERROR_CODES,
  authErrorMessage,
  availableStepUpMethods,
  parseStepUpRequest,
  stepUpMethodLabel,
} from "@/lib/auth-contracts";
import {
  hasWebauthnCredential,
  readSelfCredentialState,
  verifySelfPin,
} from "@/lib/self-credentials";
import { toLatinDigits } from "@/lib/digits";

/**
 * Issue #854 (P1.6 / P1.9 / P1.10 / P1.11) — recent-authentication step-up,
 * tenant realm.
 *
 * Three things were wrong with the previous version, and all three are fixed by
 * the shared contract rather than here:
 *
 *  1. It read `body.code` while the only UI that called it sent `mfaCode`, so
 *     the TOTP branch was unreachable and every code-based step-up fell through
 *     to `missing_credentials` (#854 P1.9).
 *  2. It defaulted a missing `method` to `totp`, so an SMS-MFA user's code was
 *     checked against the wrong factor and could never succeed (#854 P1.9).
 *  3. It accepted only a password, so a PIN-only role could not satisfy a
 *     recent-auth requirement at all and was told to sign out and back in
 *     (#854 P1.6).
 *  4. It called `verifyAndConfirmMfaCode`, which activates a pending enrolment
 *     as a side effect. A "prove it's still you" endpoint must not finish
 *     somebody's half-done 2FA setup (#854 P1.11) — this now uses
 *     `verifyExistingConfirmedMfaFactor`, which accepts confirmed factors only.
 *
 * `GET` answers the question the Profile picker actually asks: *which* doors
 * does this member have? Previously the client had to guess, which is how it
 * ended up showing a password box to people who have no password.
 */

export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;

  const state = await readSelfCredentialState(session.businessId, session.sub);
  if (!state) return NextResponse.json({ error: AUTH_ERROR_CODES.unauthorized }, { status: 401 });

  const hasWebauthn = state.hasPassword
    ? await hasWebauthnCredential(session.businessId, session.sub)
    : false;

  const availability = { ...state, hasWebauthn };
  return NextResponse.json({
    recentAuth: isRecentAuth(session),
    recentAuthAt: session.recentAuthAt ?? session.iat ?? null,
    maxAgeSeconds: RECENT_AUTH_WINDOW_SECONDS,
    availableMethods: availableStepUpMethods(availability),
    methodLabels: Object.fromEntries(
      availableStepUpMethods(availability).map((method) => [
        method,
        stepUpMethodLabel(method),
      ]),
    ),
    /**
     * Whether the caller holds a *password* for the global identity. The UI
     * uses this to decide between «رمز عبور» and «رمز عددی» wording.
     */
    hasPassword: state.hasPassword,
    hasPin: state.hasPin,
    loginManagedByCloud: state.loginManagedByCloud,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: AUTH_ERROR_CODES.badRequest }, { status: 400 });
  }

  /**
   * `action: "send_sms"` is the one non-verification the endpoint accepts: the
   * SMS step-up needs a live challenge before a code exists to type (#854
   * P1.10). It issues nothing the caller could not already trigger, and the
   * challenge is bound to the confirmed factor's number — the request cannot
   * redirect it.
   */
  if (raw && typeof raw === "object" && (raw as { action?: unknown }).action === "send_sms") {
    if (!session.platformUserId) {
      return NextResponse.json({ error: AUTH_ERROR_CODES.mfaRequired }, { status: 400 });
    }
    const { rows } = await query<{ email: string | null }>(
      `SELECT email::text AS email FROM users WHERE id = $1 AND business_id = $2`,
      [session.sub, session.businessId],
    );
    const email = rows[0]?.email ?? "";
    const challenge = await issueSmsMfaChallenge({
      subjectRealm: "platform_user",
      subjectId: session.platformUserId,
      email,
      purpose: "step_up_sms",
    });
    if (!challenge.ok) {
      const status = challenge.error === "rate_limited" ? 429 : 400;
      return NextResponse.json(
        {
          error: challenge.error,
          message: authErrorMessage(challenge.error),
          retryAfterMs: challenge.retryAfterMs,
        },
        { status },
      );
    }
    return NextResponse.json({
      status: "challenge_sent",
      maskedPhone: challenge.maskedPhone,
      /** The destination, so a resumed screen can show it without trusting the body. */
      candidatePhoneE164: challenge.candidatePhoneE164,
      expiresInSeconds: 5 * 60,
    });
  }

  const parsed = parseStepUpRequest(raw);
  if (!parsed.ok) {
    const code =
      parsed.error === "missing_credentials"
        ? AUTH_ERROR_CODES.missingCredentials
        : AUTH_ERROR_CODES.invalidMethod;
    return NextResponse.json({ error: code, message: authErrorMessage(code) }, { status: 400 });
  }
  const { method, credential, recovery } = parsed.request;

  const { rows: emailRows } = await query<{ email: string | null }>(
    `SELECT email::text AS email FROM users WHERE id = $1 AND business_id = $2`,
    [session.sub, session.businessId],
  );
  const email = emailRows[0]?.email ?? null;

  // Lockout is checked before the secret is touched, so a valid lockout cannot
  // be walked around by switching methods.
  if (email) {
    const lockout = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: AUTH_ERROR_CODES.accountLocked, lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }
  }

  let verified = false;
  let failureDetail: string | null = null;

  switch (method) {
    case "password": {
      if (!email) return NextResponse.json({ error: AUTH_ERROR_CODES.mfaRequired }, { status: 400 });
      verified = await verifyPassword(session.sub, credential);
      break;
    }
    case "pin": {
      /**
       * Issue #854 P1.6: the door a PIN-only member actually has. The PIN is
       * verified against their own credential (`verifySelfPin` reads
       * `session.sub`), with the same lockout the lock screen uses, so a
       * cashier can satisfy a recent-auth requirement from Profile without
       * being signed out.
       */
      verified = await verifySelfPin(session.businessId, session.sub, toLatinDigits(credential));
      failureDetail = "invalid_pin_step_up";
      break;
    }
    case "totp":
    case "sms_otp": {
      if (!session.platformUserId) {
        return NextResponse.json({ error: AUTH_ERROR_CODES.mfaRequired }, { status: 400 });
      }
      /**
       * Confirmed factors only (#854 P1.11). A pending enrolment is not a
       * factor yet, and finishing one is the enrolment screen's job.
       */
      const detail = await withoutTenantScope("platform", () =>
        verifyExistingConfirmedMfaFactor({
          subjectRealm: "platform_user",
          subjectId: session.platformUserId!,
          method,
          code: credential,
          expectedPhoneE164: null,
          // Issue #854 (invariant 4): a step-up code is a step-up code. A
          // challenge minted for the login interstitial is not spendable here.
          smsPurposes: ["step_up_sms"],
        }),
      );
      verified = detail.outcome !== "rejected";
      failureDetail = "invalid_mfa_step_up";
      break;
    }
    case "recovery": {
      if (!session.platformUserId) {
        return NextResponse.json({ error: AUTH_ERROR_CODES.mfaRequired }, { status: 400 });
      }
      const detail = await withoutTenantScope("platform", () =>
        verifyExistingConfirmedMfaFactor({
          subjectRealm: "platform_user",
          subjectId: session.platformUserId!,
          method: null,
          code: credential,
          useRecoveryCode: true,
        }),
      );
      verified = detail.outcome !== "rejected";
      failureDetail = "invalid_recovery_code_step_up";
      break;
    }
    case "webauthn": {
      /**
       * A passkey proves possession of the device, but the *global identity*
       * step-up must still be tied to a confirmed factor or password — a
       * biometric credential is device-bound and tenant-local, so it cannot be
       * the whole answer for a "this is the account holder" question. Refused
       * explicitly rather than silently downgraded.
       */
      void recovery;
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.invalidMethod,
          message: "برای تأیید هویت از روش‌های حساب (رمز عبور، رمز عددی یا کد دومرحله‌ای) استفاده کنید.",
        },
        { status: 400 },
      );
    }
    default:
      return NextResponse.json({ error: AUTH_ERROR_CODES.invalidMethod }, { status: 400 });
  }

  if (email) {
    if (verified) await recordAuthSuccess("tenant_password", email);
    else await recordAuthFailure("tenant_password", email);
  }

  if (!verified) {
    if (failureDetail) {
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'auth.step_up_failed', 'user', $3, $4)`,
        [
          session.businessId,
          session.sub,
          session.sub,
          JSON.stringify({ method }),
        ],
      ).catch(() => {});
    }
    return NextResponse.json(
      {
        error:
          method === "pin"
            ? AUTH_ERROR_CODES.invalidPin
            : method === "password"
              ? AUTH_ERROR_CODES.invalidCurrentPassword
              : AUTH_ERROR_CODES.invalidCode,
        message: authErrorMessage(
          method === "pin"
            ? AUTH_ERROR_CODES.invalidPin
            : method === "password"
              ? AUTH_ERROR_CODES.invalidCurrentPassword
              : AUTH_ERROR_CODES.invalidCode,
        ),
      },
      { status: 401 },
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const nextToken = await signSession({
    ...session,
    recentAuthAt: nowSec,
  });

  // Audit the *fact* of a successful step-up and which door was used — never
  // the secret, and never the code (#854 P2.22).
  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, 'auth.step_up', 'user', $3, $4)`,
    [session.businessId, session.sub, session.sub, JSON.stringify({ method })],
  ).catch(() => {});

  const res = NextResponse.json({
    ok: true,
    recentAuth: true,
    recentAuthAt: nowSec,
    method,
  });
  res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions());
  return res;
});
