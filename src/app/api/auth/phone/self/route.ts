import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { checkLoginLockout, auditLoginFailure } from "@/lib/employee-service";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import {
  canonicalMemberPhone,
  maskPhoneE164,
  phoneOtpEnforcementFor,
  sendEmployeePhoneOtp,
  stampPhoneVerified,
  verifyEmployeePhoneOtp,
} from "@/lib/phone-otp";
import { memberPhoneState } from "@/lib/phone-otp-policy";
import { boundedString, normalizeOtpCode } from "@/lib/login-contract";
import { KavenegarError } from "@/lib/sms-kavenegar";

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

  const [row, enforcement] = await Promise.all([
    query<{ phone_e164: string | null; phone_verified_at: Date | null; otp_login_at: Date | null }>(
      `SELECT phone_e164, phone_verified_at, otp_login_at FROM users
        WHERE id = $1 AND business_id = $2`,
      [session.sub, session.businessId],
    ),
    phoneOtpEnforcementFor(session.businessId),
  ]);
  const member = row.rows[0];

  return NextResponse.json({
    phone: member?.phone_e164 ?? null,
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
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  let body: {
    action?: string;
    phone?: string;
    code?: string;
    /** Echoed from the `send` response — the challenge this verify redeems. */
    challengeId?: string;
    /** Echoed from the `send` response — the number that challenge went to. */
    destination?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { rows } = await query<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM users WHERE id = $1 AND business_id = $2`,
    [session.sub, session.businessId],
  );
  const current = rows[0]?.phone_e164 ?? null;

  // Set by the send branch, returned to the client, echoed back on verify.
  let challenge: { challengeId: string; destination: string } | null = null;

  // --- send ---------------------------------------------------------------
  if (body.action === "send") {
    // A typed number is a *change candidate*: it is only stored by a
    // successful verify below, so a typo costs one SMS, not a login.
    const target = body.phone ? canonicalMemberPhone(body.phone) : current;
    if (body.phone && !target) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
    if (!target) return NextResponse.json({ error: "phone_missing" }, { status: 400 });

    try {
      // The send-side limiter (1/min, 5/h, 20/day) lives inside the send, on
      // the path that spends the SMS credit.
      const sent = await sendEmployeePhoneOtp({
        businessId: session.businessId,
        userId: session.sub,
        phone: target,
        // Its own purpose: a signed-in member changing their number is not the
        // same ceremony as a login proving one, and a challenge minted by one
        // must not be redeemable by the other.
        purpose: "manage",
      });
      if (!sent.allowed) {
        return NextResponse.json(
          { error: "rate_limited", retryAfterMs: sent.retryAfterMs },
          { status: 429 },
        );
      }
      // The client echoes both back on `verify`. Without them the verify half
      // would have to fall back to "newest challenge for this member", which
      // is the ambiguity issue #885 L02 removes.
      challenge = { challengeId: sent.challengeId, destination: target };
    } catch (err) {
      console.error("Phone-OTP dispatch failed (self)", err);
      const message =
        err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
      return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
    }

    return NextResponse.json({
      status: "sent",
      maskedPhone: maskPhoneE164(target),
      challengeId: challenge?.challengeId ?? null,
      destination: challenge?.destination ?? null,
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

    // Same canonicalisation as the login door: a code typed on a Persian
    // keyboard arrives as Persian digits and must be converted, not deleted.
    const code = normalizeOtpCode(body.code);
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    // Issue #885 L02 — redeem the exact challenge the `send` minted. Both
    // halves of the binding come from the client's echo of that response and
    // are re-checked against the row, so a stale or swapped pair simply does
    // not match.
    const challengeId = boundedString(body.challengeId, { max: 64 });
    const destination = canonicalMemberPhone(body.destination);
    if (!challengeId || !destination) {
      return NextResponse.json({ error: "challenge_required" }, { status: 400 });
    }

    const verification = await verifyEmployeePhoneOtp({
      challengeId,
      userId: session.sub,
      businessId: session.businessId,
      purpose: "manage",
      destination,
      code,
    });
    if (!verification.verified) {
      await auditLoginFailure(session.businessId, session.sub, "invalid_phone_otp");
      return NextResponse.json(
        { error: verification.reason === "expired" ? "code_expired" : "invalid_code" },
        { status: 401 },
      );
    }

    // The change candidate (if one was typed) is resent by the client on
    // verify; storing it here is what makes this a *change* rather than a
    // re-verification of the number already on file.
    const candidate = body.phone !== undefined ? canonicalMemberPhone(body.phone) : null;
    await stampPhoneVerified({
      businessId: session.businessId,
      userId: session.sub,
      phone: candidate,
    });
    return NextResponse.json({ status: "verified" });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
