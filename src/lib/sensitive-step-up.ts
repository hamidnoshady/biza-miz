/**
 * #1386 — the one server-side guard for sensitive security mutations.
 *
 * `requireRecentAuth` answers *when* the session last proved its identity.
 * After the owner-approved passwordless door, that is no longer enough: a
 * routine phone-OTP login (or an `sms_otp` step-up) proves possession of the
 * SMS number and nothing else, yet it stamps the same fresh `recentAuthAt`.
 * On an account that holds a separately enrolled TOTP, that let SMS alone —
 * a SIM swap — remove the TOTP, change the login phone or register a passkey.
 *
 * This guard composes the existing freshness rule with the pure policy in
 * `login-assurance.ts` (`decideSensitiveStepUp`). It never loosens anything:
 * a stale session still gets the plain `recent_auth_required` it always got,
 * and a session with no `otpOnlyAssurance` claim is judged exactly as before.
 *
 * The refusal keeps the same `403 recent_auth_required` contract every client
 * already handles (the step-up prompt opens and the change is retried), and
 * adds `distinctFactorRequired` + `allowedMethods`. The step-up route's `GET`
 * narrows its method list the same way, so the prompt never offers a method
 * that could not satisfy the retry.
 */
import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth-edge";
import {
  decideSensitiveStepUp,
  type SensitiveStepUpDecision,
} from "./login-assurance";
import { distinctSecondFactorMethods } from "./mfa";
import { filterActiveMfaEnrolments, getAccountMfaEnrolments } from "./mfa-service";
import { requireRecentAuth } from "./recent-auth";

type SensitiveSession = Pick<
  SessionPayload,
  "platformUserId" | "recentAuthAt" | "iat" | "otpOnlyAssurance"
>;

/**
 * The decision for this session, reading the account's live factors.
 *
 * The factor read is skipped entirely for a session that did not come from an
 * OTP-only proof — the overwhelmingly common case — so the guard costs no
 * query on password, MFA, PIN or legacy sessions.
 */
export async function sensitiveStepUpDecision(
  session: SensitiveSession,
): Promise<SensitiveStepUpDecision> {
  if (session.otpOnlyAssurance !== true || !session.platformUserId) {
    return { distinctFactorRequired: false, allowedMethods: [] };
  }
  const active = filterActiveMfaEnrolments(
    await getAccountMfaEnrolments("platform_user", session.platformUserId),
  );
  return decideSensitiveStepUp({
    otpOnlyAssurance: true,
    distinctFactors: distinctSecondFactorMethods(active, "phone_otp"),
  });
}

/**
 * `requireRecentAuth`, plus the distinct-factor rule for OTP-only sessions.
 *
 * Returns `null` when the mutation may proceed, otherwise the `403` to send.
 */
export async function requireSensitiveRecentAuth(
  session: SensitiveSession,
): Promise<NextResponse | null> {
  const stale = requireRecentAuth(session);
  if (stale) return stale;

  const decision = await sensitiveStepUpDecision(session);
  if (!decision.distinctFactorRequired) return null;

  return NextResponse.json(
    {
      error: "recent_auth_required",
      distinctFactorRequired: true,
      allowedMethods: decision.allowedMethods,
    },
    { status: 403 },
  );
}
