import { NextRequest, NextResponse } from "next/server";
import {
  getAccountMfaEnrolments,
  verifyMfaPendingToken,
} from "@/lib/mfa-service";
import { verifyAndConfirmMfaCode } from "@/lib/mfa-verify";
import { countRemainingRecoveryCodes } from "@/lib/mfa-recovery";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { createSession } from "@/lib/employee-service";
import { completeInvitationAcceptance } from "@/lib/team-service";
import { stampPhoneVerified } from "@/lib/phone-otp";
import {
  membershipBlockedReason,
  membershipsForPlatformUser,
} from "@/lib/memberships";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import {
  mayConfirmPendingEnrolmentAtLogin,
  selectPrimaryMfaEnrolment,
  type MfaMethod,
} from "@/lib/mfa";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = authHeader.slice(7);
  const payload = await verifyMfaPendingToken(token);
  if (!payload || payload.authRealm !== "tenant_password") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { code?: string; useRecoveryCode?: boolean; method?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  const useRecoveryCode = Boolean(body.useRecoveryCode);

  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  return withoutTenantScope("login", async () => {
    const { rows: users } = await query<{
      id: string;
      email: string;
      full_name: string;
      token_version: number;
    }>(
      `SELECT id, email::text AS email, full_name, token_version
         FROM platform_users
        WHERE id = $1 AND is_active = true`,
      [payload.sub],
    );
    if (users.length === 0) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const user = users[0];

    // Issue #809 (Finding 8 — P1): Enforce account lockout BEFORE checking the
    // MFA code so a valid 5-minute pending token cannot bypass an active lockout.
    const lockout = await checkAuthLockout(
      "tenant_password",
      user.email,
      PASSWORD_LOCKOUT_POLICY,
    );
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const enrolments = await getAccountMfaEnrolments("platform_user", user.id);
    const requestedMethod: MfaMethod | null =
      body.method === "totp" || body.method === "sms_otp" ? body.method : null;
    const primaryChoice = selectPrimaryMfaEnrolment(enrolments, {
      allowUnconfirmedFallback: true,
    });
    const method: MfaMethod | null =
      requestedMethod && enrolments.some((e) => e.method === requestedMethod)
        ? requestedMethod
        : (primaryChoice?.method ?? payload.method);

    // Issue #809 (Finding 1 — P0): Never accept SMS OTP as the second factor
    // when phone OTP was already used as the primary login factor.
    if (payload.primaryAuth === "phone_otp" && !useRecoveryCode && method === "sms_otp") {
      return NextResponse.json({ error: "mfa_distinct_factor_required" }, { status: 400 });
    }

    const detail = await verifyAndConfirmMfaCode({
      subjectRealm: "platform_user",
      /**
       * Issue #854 (P1.11): confirm a pending enrolment here only when the
       * account has no confirmed factor — the mid-enrolment lockout case. If a
       * confirmed factor exists, the strict path applies and a half-finished
       * enrolment cannot stand in as the second factor.
       */
      confirmPendingEnrolment: mayConfirmPendingEnrolmentAtLogin(enrolments, method),
      /*
       * Issue #854 (invariant 4): signing in spends a login challenge only —
       * on both branches. The strict branch proves a confirmed factor; the
       * mid-enrolment branch (no confirmed factor yet) uses the same
       * `mfa_login` challenge the login screen already sent and activates the
       * pending row as it succeeds.
       */
      smsPurposes: ["mfa_login"],
      subjectId: user.id,
      method,
      code,
      useRecoveryCode,
    });

    if (detail.outcome === "rejected") {
      await recordAuthFailure("tenant_password", user.email);
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    await recordAuthSuccess("tenant_password", user.email);

    const remainingRecoveryCodes = await countRemainingRecoveryCodes(
      "platform_user",
      user.id,
    );

    /**
     * Issue #854 (P0.4) — an invitation acceptance that was interrupted by the
     * second factor finishes here, before any session is minted.
     *
     * The acceptance route proves the invitation and the password, then hands
     * over a pending token that carries `invitationId`; the membership is
     * deliberately *not* written at that point (an abandoned ceremony must not
     * leave one behind). Completing it inside the same call that just verified
     * the factor is what keeps the documented order — accept membership, then
     * session — and it runs before `membershipsForPlatformUser` below, so the
     * membership being created is exactly what that lookup finds.
     */
    if (payload.invitationId) {
      await completeInvitationAcceptance({
        invitationId: payload.invitationId,
        platformUserId: user.id,
      });
    }

    /**
     * Issue #854 (GAP 8) — commit the phone-OTP ceremony that this pending
     * token stands for, now that the second factor has passed.
     *
     * The phone door redeemed its challenge but deliberately stamped nothing
     * when a second factor was still owed. Everything committed here comes
     * from the *signed* token — the membership, the proven number, the number
     * to attach — never from this request body, so there is no client input a
     * crafted request could forge into a verification. The membership is
     * re-read first: if it was suspended, offboarded or detached between the
     * two halves of the ceremony, the stamps (and the 7-day PIN window they
     * open) are refused. A number that changed in between is not stamped
     * either — it was never proven — while the attach flow writes exactly the
     * number the ceremony verified.
     */
    if (payload.primaryAuth === "phone_otp" && payload.phoneCompletion) {
      const completion = payload.phoneCompletion;
      const businessId = payload.businessId;
      if (!businessId) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      const committable = await withTenant(businessId, async () => {
        const { rows: fresh } = await query<{
          id: string;
          phone_e164: string | null;
          active: boolean;
          identity_active: boolean | null;
        }>(
          `SELECT u.id, u.phone_e164, u.is_active AS active,
                  p.is_active AS identity_active
             FROM users u
             LEFT JOIN platform_users p ON p.id = u.platform_user_id
            WHERE u.id = $1 AND u.business_id = $2`,
          [completion.membershipId, businessId],
        );
        const member = fresh[0];
        if (!member || !member.active || member.identity_active === false) return false;
        const attaching = completion.attachPhone ?? null;
        const phoneStillProven =
          attaching !== null ||
          (completion.provenPhone !== null && member.phone_e164 === completion.provenPhone);
        if (phoneStillProven) {
          await stampPhoneVerified({
            businessId,
            userId: completion.membershipId,
            phone: attaching,
          });
        }
        return true;
      });
      if (!committable) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const memberships = await membershipsForPlatformUser(user.id);
    const usable = memberships.filter((m) => membershipBlockedReason(m) === null);
    const chosen = payload.businessId
      ? usable.find((m) => m.businessId === payload.businessId)
      : usable[0];

    if (!chosen) {
      return NextResponse.json({ error: "business_unavailable" }, { status: 403 });
    }

    // The signed completion context names the membership this ceremony signs
    // into; a different one cannot be substituted by the identity lookup.
    if (
      payload.phoneCompletion &&
      chosen.userId !== payload.phoneCompletion.membershipId
    ) {
      return NextResponse.json({ error: "business_unavailable" }, { status: 403 });
    }

    const employeeSessionId =
      payload.employeeSession?.employeeSessionId ??
      (
        await withTenant(chosen.businessId, () =>
          createSession(chosen.userId, chosen.businessId, {
            locationId: chosen.locationId,
            deviceLabel: request.headers.get("user-agent")?.slice(0, 120) ?? "Web (MFA)",
            /**
             * Issue #854 (GAP 8) — the session keeps the true provenance of a
             * phone-OTP door finished through MFA. The label above is the only
             * client-supplied metadata it carries, observed on *this* request
             * by the server; nothing is replayed from the earlier call.
             */
            loginMethod: payload.primaryAuth === "phone_otp" ? "phone_otp" : null,
          }),
        )
      ).session.id;

    const sessionToken = await signSession({
      sub: chosen.userId,
      role: chosen.role,
      businessId: chosen.businessId,
      businessSlug: chosen.businessSlug,
      businessSubdomain: chosen.businessSubdomain,
      locationId: chosen.locationId,
      fullName: chosen.fullName,
      platformUserId: user.id,
      tokenVersion: user.token_version,
      employeeSessionId,
      mfaVerified: true,
      recentAuthAt: Math.floor(Date.now() / 1000),
    });

    const res = NextResponse.json({
      status: "verified",
      user: { id: chosen.userId, role: chosen.role, fullName: chosen.fullName },
      business: {
        id: chosen.businessId,
        name: chosen.businessName,
        slug: chosen.businessSlug,
      },
      recoveryCodesRemaining: remainingRecoveryCodes,
      recoveryCodes: detail.recoveryCodes,
    });

    res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
    return res;
  });
}
