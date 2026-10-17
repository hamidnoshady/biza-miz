import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { checkLoginLockout, auditLoginFailure } from "@/lib/employee-service";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import {
  canonicalMemberPhone,
  consumeSelfPhoneChallenges,
  liveSelfPhoneChallenge,
  maskPhoneE164,
  phoneOtpEnforcementFor,
  sendEmployeePhoneOtp,
  stampPhoneVerified,
  verifyEmployeePhoneOtp,
  type SelfPhonePurpose,
} from "@/lib/phone-otp";
import { isPhoneTaken } from "@/lib/team-service";
import { memberPhoneState } from "@/lib/phone-otp-policy";
import { KavenegarError } from "@/lib/sms-kavenegar";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { SELF_CREDENTIAL_AUDIT_ACTIONS } from "@/lib/security-audit";
import { normalizeOtpCode } from "@/lib/otp-challenge";

/**
 * Phase 42 — self-service phone verification for a member who is *already
 * signed in* (owner, manager, anyone): the security-center card where the
 * 14-day adoption window is actually spent.
 *
 * Strictly about the caller's own membership row — `users.sub` from the
 * session, never a request field, so there is no shape of this endpoint that
 * touches somebody else's number. An owner setting *another* member's number
 * goes through the team screen (`/api/team`), where the member re-verifies it
 * at their next door login; this route is where a member proves their own.
 *
 * A verify here stamps the same facts the door does (`phone_verified_at` +
 * the 7-day `otp_login_at` window) but mints no session — one already exists.
 *
 * ## Issue #854 follow-up (F05 / F06)
 *
 *  - **F05** — the stamp and its audit row commit in one transaction
 *    (`stampPhoneVerified({ audit })`); a failure of either rolls both back and
 *    answers `credential_change_failed` instead of a silent `.catch(() => {})`.
 *  - **F06** — every step after the send reads the live challenge row, never the
 *    browser's memory of it: `resend` re-sends to the challenge's own candidate
 *    number under its own purpose (a reload used to resend to the number *on
 *    file* under the verify purpose), `cancel` burns the challenge on the server
 *    (it used to only hide the form), and `verify` writes exactly the number
 *    the code was sent to. A fresh send burns the other self-service purpose,
 *    so one verification is in flight at a time.
 */
export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [row, enforcement, deployment] = await Promise.all([
    query<{ phone_e164: string | null; phone_verified_at: Date | null; otp_login_at: Date | null }>(
      `SELECT phone_e164, phone_verified_at, otp_login_at FROM users
        WHERE id = $1 AND business_id = $2`,
      [session.sub, session.businessId],
    ),
    phoneOtpEnforcementFor(session.businessId),
    /**
     * Issue #854 (P1.14 / P1.15): the card renders from the deployment's
     * authority over the login phone, so a Hybrid site shows the number
     * read-only with «این مورد در نسخهٔ ابری مدیریت می‌شود.» instead of an
     * editable control the POST then refuses.
     */
    readDeploymentProfile(session.businessId),
  ]);
  const member = row.rows[0];

  /**
   * Issue #854 (P2.19): a reload must not lose the half-finished verification.
   * The pending challenge is read from the challenge row — number *and* purpose
   * come from the server, never from a remembered masked string or a body
   * field — so the card can reopen on «کد ارسالشده به …» after a refresh.
   */
  const live = await liveSelfPhoneChallenge(session.sub);

  return NextResponse.json({
    phone: member?.phone_e164 ?? null,
    pendingChallenge: live
      ? {
          maskedPhone: live.maskedPhone,
          purpose: live.purpose,
          // Issue #854 (P2.25) — the resend cooldown is honest only if it
          // counts from when the code was actually sent, which a reload needs.
          requestedAt: live.requestedAt,
          expiresAt: live.expiresAt,
        }
      : null,
    phoneState: memberPhoneState(member?.phone_e164 ?? null, member?.phone_verified_at ?? null),
    otpWindowOpen: Boolean(
      member?.otp_login_at &&
        Date.now() - new Date(member.otp_login_at).getTime() < 7 * 86_400_000,
    ),
    policy: {
      state: enforcement.state,
      daysLeft: enforcement.daysLeft,
    },
    recentAuth: isRecentAuth(session),
    deploymentProfile: deployment.profile,
    credential: describeCredentialSurface(deployment.profile, "login_phone"),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { action?: string; phone?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // --- cancel -------------------------------------------------------------
  /**
   * Issue #854 (F06): «انصراف» burns the member's own pending self-service
   * code on the server, so a reload cannot resurrect a verification the member
   * walked away from. It only ever *removes* capability (never the door's
   * `login` purpose), so it needs neither a fresh step-up nor a writable
   * deployment — a member on a Hybrid site can still discard a stale code.
   */
  if (body.action === "cancel") {
    const cancelled = await consumeSelfPhoneChallenges(session.sub);
    return NextResponse.json({ status: "cancelled", cancelled });
  }

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  /**
   * Issue #854 (P1.14): a Hybrid site does not originate changes to the login
   * phone — the number is part of the global identity the cloud owns (it is the
   * `platform_users`-level second channel), so a local change would create a
   * credential the cloud never sees. The shared table decides, and the refusal
   * carries the same notice the UI renders.
   */
  const deployment = await readDeploymentProfile(session.businessId);
  const surface = describeCredentialSurface(deployment.profile, "login_phone");
  if (!surface.editable) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.loginManagedByCloud,
        message: surface.notice ?? authErrorMessage(AUTH_ERROR_CODES.loginManagedByCloud),
      },
      { status: 409 },
    );
  }

  const { rows } = await query<{ phone_e164: string | null; phone_verified_at: Date | null }>(
    `SELECT phone_e164, phone_verified_at FROM users WHERE id = $1 AND business_id = $2`,
    [session.sub, session.businessId],
  );
  const current = rows[0]?.phone_e164 ?? null;
  const currentlyVerified = Boolean(rows[0]?.phone_verified_at);

  // --- send ---------------------------------------------------------------
  if (body.action === "send") {
    // A typed number is a *change candidate*: it is only stored by a
    // successful verify below, so a typo costs one SMS, not a login.
    const target = body.phone ? canonicalMemberPhone(body.phone) : current;
    if (body.phone && !target) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
    if (!target) return NextResponse.json({ error: "phone_missing" }, { status: 400 });
    /**
     * Issue #854 (P0.8 / P1.16): a *typed* number is a change candidate;
     * re-verifying the number already on file is not. The distinction decides
     * the purpose the challenge is minted under, and a change candidate is
     * checked for uniqueness **before** the SMS is sent — the old flow let the
     * OTP be consumed and then failed at the final write on the unique index,
     * which cost the member an SMS and showed a database error.
     */
    const isChange = Boolean(body.phone) && target !== current;

    if (isChange && (await isPhoneTaken(session.businessId, target, session.sub))) {
      return NextResponse.json(
        { error: "phone_taken", message: "این شماره قبلاً برای عضو دیگری ثبت شده است." },
        { status: 409 },
      );
    }

    /**
     * Issue #854 (P0.8): the purpose and the destination are decided here and
     * bound into the challenge row. Verification then reads them off the row
     * instead of re-deriving them from the next request body.
     */
    return dispatchSelfPhoneCode({
      businessId: session.businessId,
      userId: session.sub,
      phone: target,
      purpose: isChange ? "change_login_phone" : "verify_login_phone",
    });
  }

  // --- resend -------------------------------------------------------------
  /**
   * Issue #854 (F06): a resend names nothing. The destination and purpose are
   * the live challenge's own, so a reloaded card — which knows only a masked
   * number — re-sends to the candidate it is actually proving, never to the
   * number on file, and never under a different purpose.
   */
  if (body.action === "resend") {
    const live = await liveSelfPhoneChallenge(session.sub);
    if (!live?.candidatePhoneE164) {
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.challengeExpired,
          message: authErrorMessage(AUTH_ERROR_CODES.challengeExpired),
        },
        { status: 400 },
      );
    }
    if (live.purpose === "verify_login_phone" && live.candidatePhoneE164 !== current) {
      // The number on file changed since the code was requested: re-proving the
      // old one would prove nothing about the row. Start over instead.
      await consumeSelfPhoneChallenges(session.sub);
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.challengeExpired,
          message: authErrorMessage(AUTH_ERROR_CODES.challengeExpired),
        },
        { status: 400 },
      );
    }
    if (
      live.purpose === "change_login_phone" &&
      live.candidatePhoneE164 !== current &&
      (await isPhoneTaken(session.businessId, live.candidatePhoneE164, session.sub))
    ) {
      return NextResponse.json(
        { error: "phone_taken", message: authErrorMessage(AUTH_ERROR_CODES.phoneTaken) },
        { status: 409 },
      );
    }
    return dispatchSelfPhoneCode({
      businessId: session.businessId,
      userId: session.sub,
      phone: live.candidatePhoneE164,
      purpose: live.purpose,
    });
  }

  // --- verify -------------------------------------------------------------
  if (body.action === "verify") {
    const lockout = await checkLoginLockout(session.businessId, session.sub);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    /*
     * #854 follow-up — fold the digits at the boundary, as the door does
     * (`phone-otp/verify`, #885 L11). A bare `/^\d{6}$/` on the raw input told
     * a member who typed «۱۲۳۴۵۶» off the SMS that the code was wrong without
     * ever comparing it. `normalizeOtpCode` maps Persian/Arabic-Indic digits to
     * ASCII, drops spaces and dashes, and still demands exactly six digits; the
     * challenge's purpose, destination, expiry, attempt limit and single-use
     * redemption are all still enforced by `redeemOtpChallenge` below.
     */
    const code = normalizeOtpCode(body.code);
    if (!code) {
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    /**
     * Issue #854 (P0.8): the candidate phone is **not** read from this body.
     *
     * The old flow sent a code to number A and then accepted a fresh `phone`
     * field at verify time, so a valid code for A could be submitted while
     * asking the server to persist B — possession of one number authorising a
     * write of another. The destination now comes from the challenge row; the
     * body is only consulted to know *which purpose* the member is finishing,
     * and even that has to match a live challenge to redeem.
     */
    const live = await liveSelfPhoneChallenge(session.sub);
    const provenPhone = live?.candidatePhoneE164 ?? null;
    if (!live || !provenPhone) {
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.challengeExpired,
          message: authErrorMessage(AUTH_ERROR_CODES.challengeExpired),
        },
        { status: 400 },
      );
    }

    /**
     * Issue #854 (F06): a re-verification proves the number the code went to,
     * so it only counts while that is still the number on file. If the row
     * changed in between (an administrator edited it), the code proves nothing
     * about the current number — refuse rather than mark the new one verified.
     */
    if (live.purpose === "verify_login_phone" && provenPhone !== current) {
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.codeWrongPhone,
          message: authErrorMessage(AUTH_ERROR_CODES.codeWrongPhone),
        },
        { status: 409 },
      );
    }

    /**
     * Issue #854 (P1.16): the uniqueness check runs again on the same path as
     * the write, so a number taken between the send and the verify is refused
     * with `phone_taken` instead of failing the transaction.
     */
    if (
      live.purpose === "change_login_phone" &&
      provenPhone !== current &&
      (await isPhoneTaken(session.businessId, provenPhone, session.sub))
    ) {
      return NextResponse.json(
        { error: "phone_taken", message: authErrorMessage(AUTH_ERROR_CODES.phoneTaken) },
        { status: 409 },
      );
    }

    const ok = await verifyEmployeePhoneOtp({
      userId: session.sub,
      code,
      purpose: live.purpose,
      /**
       * The number bound into the challenge, for both purposes. A mismatch is
       * refused inside `redeemOtpChallenge` before the code is even compared.
       */
      expectedPhoneE164: provenPhone,
    });
    if (!ok) {
      await auditLoginFailure(session.businessId, session.sub, "invalid_phone_otp");
      return NextResponse.json({ error: "invalid_code", message: "کد ۶ رقمی واردشده نادرست است." }, { status: 401 });
    }

    /**
     * Only now is anything written — and the number written is the one the code
     * actually went to, never a field from this request (#854 P0.8). The stamp
     * and its audit row (the *fact* and the masked destination, never the code
     * — P2.22) commit together or not at all (F05).
     */
    try {
      await stampPhoneVerified({
        businessId: session.businessId,
        userId: session.sub,
        phone: provenPhone,
        audit: {
          realm: "tenant",
          businessId: session.businessId,
          actorUserId: session.sub,
          action:
            live.purpose === "change_login_phone"
              ? SELF_CREDENTIAL_AUDIT_ACTIONS.phoneChangedSelf
              : SELF_CREDENTIAL_AUDIT_ACTIONS.phoneVerifiedSelf,
          entity: "user",
          entityId: session.sub,
          payload: {
            channel: "sms",
            deliveredTo: live.maskedPhone,
            previouslyVerified: currentlyVerified,
          },
        },
      });
    } catch (err) {
      // The code is spent, but nothing about the number changed.
      if ((err as { code?: string } | null)?.code === "23505") {
        return NextResponse.json(
          { error: "phone_taken", message: authErrorMessage(AUTH_ERROR_CODES.phoneTaken) },
          { status: 409 },
        );
      }
      // The error's message only — never the number, the code or a row.
      console.error(
        "self phone verification could not be committed:",
        err instanceof Error ? err.message : "unknown error",
      );
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.credentialChangeFailed,
          message: authErrorMessage(AUTH_ERROR_CODES.credentialChangeFailed),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      status: "verified",
      purpose: live.purpose,
      maskedPhone: live.maskedPhone,
    });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

/**
 * Send a self-service code and report it — the one path both `send` and
 * `resend` take, so the limiter, the dispatch-failure handling and the
 * one-ceremony-at-a-time rule cannot drift apart.
 */
async function dispatchSelfPhoneCode(input: {
  businessId: string;
  userId: string;
  phone: string;
  purpose: SelfPhonePurpose;
}): Promise<NextResponse> {
  try {
    // The send-side limiter (1/min, 5/h, 20/day) lives inside the send, on
    // the path that spends the SMS credit.
    const sent = await sendEmployeePhoneOtp(input);
    if (!sent.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: sent.retryAfterMs },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error(
      "Phone-OTP dispatch failed (self)",
      err instanceof Error ? err.message : "unknown error",
    );
    const message =
      err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
    return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
  }

  // One verification in flight at a time (#854 F06): a change abandoned for a
  // re-verification (or the reverse) must not stay live and be preferred by
  // the next verify.
  await consumeSelfPhoneChallenges(input.userId, { except: input.purpose });

  return NextResponse.json({
    status: "sent",
    maskedPhone: maskPhoneE164(input.phone),
    /**
     * The purpose of the *challenge*; after a refresh the client reads both
     * from `GET` rather than remembering them (P2.19).
     */
    purpose: input.purpose,
    expiresInSeconds: 5 * 60,
  });
}
