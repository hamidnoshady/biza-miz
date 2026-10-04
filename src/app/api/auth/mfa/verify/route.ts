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
import { selectPrimaryMfaEnrolment, type MfaMethod } from "@/lib/mfa";

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

    const memberships = await membershipsForPlatformUser(user.id);
    const usable = memberships.filter((m) => membershipBlockedReason(m) === null);
    const chosen = payload.businessId
      ? usable.find((m) => m.businessId === payload.businessId)
      : usable[0];

    if (!chosen) {
      return NextResponse.json({ error: "business_unavailable" }, { status: 403 });
    }

    const employeeSessionId =
      payload.employeeSession?.employeeSessionId ??
      (
        await withTenant(chosen.businessId, () =>
          createSession(chosen.userId, chosen.businessId, {
            locationId: chosen.locationId,
            deviceLabel: request.headers.get("user-agent")?.slice(0, 120) ?? "Web (MFA)",
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
