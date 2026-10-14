import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { checkLoginLockout, auditLoginFailure } from "@/lib/employee-service";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import {
  canonicalMemberPhone,
  liveEmployeePhoneChallenge,
  maskPhoneE164,
  phoneOtpEnforcementFor,
  sendEmployeePhoneOtp,
  stampPhoneVerified,
  verifyEmployeePhoneOtp,
} from "@/lib/phone-otp";
import { isPhoneTaken } from "@/lib/team-service";
import { memberPhoneState } from "@/lib/phone-otp-policy";
import { KavenegarError } from "@/lib/sms-kavenegar";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";

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
  const [changeChallenge, verifyChallenge] = await Promise.all([
    liveEmployeePhoneChallenge({ userId: session.sub, purpose: "change_login_phone" }),
    liveEmployeePhoneChallenge({ userId: session.sub, purpose: "verify_login_phone" }),
  ]);
  const live = changeChallenge ?? verifyChallenge;

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

  let body: { action?: string; phone?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
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

    try {
      // The send-side limiter (1/min, 5/h, 20/day) lives inside the send, on
      // the path that spends the SMS credit.
      const sent = await sendEmployeePhoneOtp({
        businessId: session.businessId,
        userId: session.sub,
        phone: target,
        /**
         * Issue #854 (P0.8): the purpose and the destination are decided here
         * and bound into the challenge row. Verification then reads them off
         * the row instead of re-deriving them from the next request body.
         */
        purpose: isChange ? "change_login_phone" : "verify_login_phone",
      });
      if (!sent.allowed) {
        return NextResponse.json(
          { error: "rate_limited", retryAfterMs: sent.retryAfterMs },
          { status: 429 },
        );
      }
    } catch (err) {
      console.error("Phone-OTP dispatch failed (self)", err);
      const message =
        err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
      return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
    }

    return NextResponse.json({
      status: "sent",
      maskedPhone: maskPhoneE164(target),
      /**
       * The masked destination of the *challenge*, which after a refresh the
       * client reads from `GET` rather than remembering (P2.19).
       */
      purpose: isChange ? "change_login_phone" : "verify_login_phone",
      expiresInSeconds: 5 * 60,
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

    const code = String((body as { code?: string }).code ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
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
    const live =
      (await liveEmployeePhoneChallenge({
        userId: session.sub,
        purpose: "change_login_phone",
      })) ??
      (await liveEmployeePhoneChallenge({
        userId: session.sub,
        purpose: "verify_login_phone",
      }));
    if (!live) {
      return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
    }

    /**
     * Issue #854 (P1.16): the uniqueness check runs again on the same path as
     * the write, so a number taken between the send and the verify is refused
     * with `phone_taken` instead of failing the transaction.
     */
    const attachPhone =
      live.purpose === "change_login_phone" ? live.candidatePhoneE164 : null;
    if (attachPhone && (await isPhoneTaken(session.businessId, attachPhone, session.sub))) {
      return NextResponse.json({ error: "phone_taken" }, { status: 409 });
    }

    const ok = await verifyEmployeePhoneOtp({
      userId: session.sub,
      code,
      purpose: live.purpose,
      /**
       * Null for a plain re-verification (the stored number is the only
       * candidate); the bound candidate for a change. A mismatch is refused
       * inside `redeemOtpChallenge` before the code is even compared.
       */
      expectedPhoneE164: attachPhone,
    });
    if (!ok) {
      await auditLoginFailure(session.businessId, session.sub, "invalid_phone_otp");
      return NextResponse.json({ error: "invalid_code", message: "کد ۶ رقمی واردشده نادرست است." }, { status: 401 });
    }

    /**
     * Only now is anything written — and the number written is the one the code
     * actually went to, never a field from this request (#854 P0.8).
     */
    await stampPhoneVerified({
      businessId: session.businessId,
      userId: session.sub,
      phone: attachPhone,
    });

    // Security-sensitive mutation: audited with the *fact* and the masked
    // destination, never the code (#854 P2.22).
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'user', $4, $5)`,
      [
        session.businessId,
        session.sub,
        live.purpose === "change_login_phone"
          ? "auth.self_phone_changed"
          : "auth.self_phone_verified",
        session.sub,
        JSON.stringify({
          channel: "sms",
          deliveredTo: live.maskedPhone,
          previouslyVerified: currentlyVerified,
        }),
      ],
    ).catch(() => {});

    return NextResponse.json({
      status: "verified",
      purpose: live.purpose,
      maskedPhone: live.maskedPhone,
    });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
