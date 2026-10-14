import { NextRequest, NextResponse } from "next/server";
import {
  getAccountMfaEnrolments,
  verifyMfaPendingToken,
} from "@/lib/mfa-service";
import { verifyAndConfirmMfaCode } from "@/lib/mfa-verify";
import { countRemainingRecoveryCodes } from "@/lib/mfa-recovery";
import { query, withoutTenantScope } from "@/lib/db";
import {
  createPlatformAdminSession,
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  signPlatformSession,
  type PlatformAdminRole,
} from "@/lib/platform-auth";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY } from "@/lib/login-lockout";
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
  if (!payload || payload.authRealm !== "platform_admin") {
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

  return withoutTenantScope("platform", async () => {
    const { rows: admins } = await query<{
      id: string;
      email: string;
      full_name: string;
      role: PlatformAdminRole;
      token_version: number;
    }>(
      `SELECT id, email::text AS email, full_name, role::text AS role, token_version
         FROM platform_admins
        WHERE id = $1 AND is_active = true`,
      [payload.sub],
    );
    if (admins.length === 0) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const admin = admins[0];

    const lockout = await checkAuthLockout(
      "platform_admin",
      admin.email,
      PLATFORM_LOCKOUT_POLICY,
    );
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const enrolments = await getAccountMfaEnrolments("platform_admin", admin.id);
    const requestedMethod: MfaMethod | null =
      body.method === "totp" || body.method === "sms_otp" ? body.method : null;
    const primaryChoice = selectPrimaryMfaEnrolment(enrolments, {
      allowUnconfirmedFallback: true,
    });
    const method: MfaMethod | null =
      requestedMethod && enrolments.some((e) => e.method === requestedMethod)
        ? requestedMethod
        : (primaryChoice?.method ?? payload.method);

    const detail = await verifyAndConfirmMfaCode({
      subjectRealm: "platform_admin",
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
      subjectId: admin.id,
      method,
      code,
      useRecoveryCode,
    });

    if (detail.outcome === "rejected") {
      await recordAuthFailure("platform_admin", admin.email);
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    await recordAuthSuccess("platform_admin", admin.email);

    const remainingRecoveryCodes = await countRemainingRecoveryCodes(
      "platform_admin",
      admin.id,
    );

    const sessionId = await createPlatformAdminSession({
      adminId: admin.id,
      tokenVersion: admin.token_version,
      mfaVerified: true,
      deviceLabel: request.headers.get("user-agent")?.slice(0, 120) ?? "Console",
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    const sessionToken = await signPlatformSession({
      padmin: admin.id,
      role: admin.role,
      fullName: admin.full_name,
      email: admin.email,
      tokenVersion: admin.token_version,
      mfaVerified: true,
      recentAuthAt: Math.floor(Date.now() / 1000),
      sessionId,
    });

    const res = NextResponse.json({
      status: "verified",
      admin: { id: admin.id, fullName: admin.full_name, role: admin.role },
      recoveryCodesRemaining: remainingRecoveryCodes,
      recoveryCodes: detail.recoveryCodes,
    });

    res.cookies.set(PLATFORM_SESSION_COOKIE, sessionToken, platformSessionCookieOptions());
    return res;
  });
}
