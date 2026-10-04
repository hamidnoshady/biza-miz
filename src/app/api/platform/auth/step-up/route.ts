import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  requirePlatformAdmin,
  signPlatformSession,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { verifyAndConfirmMfaCode } from "@/lib/mfa-verify";
import { issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import { isRecentAuth } from "@/lib/recent-auth";
import type { MfaMethod } from "@/lib/mfa";

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({
    recentAuth: isRecentAuth(session),
    recentAuthAt: session.recentAuthAt ?? session.iat ?? null,
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;

  let body: {
    action?: string;
    password?: string;
    code?: string;
    method?: string;
    useRecoveryCode?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ email: string; password_hash: string }>(
      `SELECT email::text AS email, password_hash
         FROM platform_admins
        WHERE id = $1 AND is_active = true`,
      [session.padmin],
    );
    const admin = rows[0];
    if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

    if (body.action === "send_sms") {
      const challenge = await issueSmsMfaChallenge({
        subjectRealm: "platform_admin",
        subjectId: session.padmin,
        email: admin.email,
      });
      if (!challenge.ok) {
        const status = challenge.error === "rate_limited" ? 429 : 400;
        return NextResponse.json(
          { error: challenge.error, retryAfterMs: challenge.retryAfterMs },
          { status },
        );
      }
      return NextResponse.json({
        status: "challenge_sent",
        maskedPhone: challenge.maskedPhone,
      });
    }

    let verified = false;
    if (typeof body.password === "string" && body.password.length > 0) {
      verified = await bcrypt.compare(body.password, admin.password_hash);
    } else if (typeof body.code === "string" && body.code.trim().length > 0) {
      const method: MfaMethod | null =
        body.method === "totp" || body.method === "sms_otp" ? body.method : "totp";
      const detail = await verifyAndConfirmMfaCode({
        subjectRealm: "platform_admin",
        subjectId: session.padmin,
        method,
        code: body.code,
        useRecoveryCode: Boolean(body.useRecoveryCode),
      });
      verified = detail.outcome !== "rejected";
    } else {
      return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
    }

    if (verified) await recordAuthSuccess("platform_admin", admin.email);
    else await recordAuthFailure("platform_admin", admin.email);

    if (!verified) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const nextToken = await signPlatformSession({
      ...session,
      recentAuthAt: nowSec,
    });

    const res = NextResponse.json({
      ok: true,
      recentAuth: true,
      recentAuthAt: nowSec,
    });
    res.cookies.set(PLATFORM_SESSION_COOKIE, nextToken, platformSessionCookieOptions());
    return res;
  });
});
