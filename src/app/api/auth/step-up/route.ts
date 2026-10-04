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
import { verifyAndConfirmMfaCode } from "@/lib/mfa-verify";
import { issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import { isRecentAuth } from "@/lib/recent-auth";
import type { MfaMethod } from "@/lib/mfa";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;
  return NextResponse.json({
    recentAuth: isRecentAuth(session),
    recentAuthAt: session.recentAuthAt ?? session.iat ?? null,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
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

  const { rows } = await query<{ email: string | null }>(
    `SELECT email::text AS email FROM users WHERE id = $1 AND business_id = $2`,
    [session.sub, session.businessId],
  );
  const email = rows[0]?.email ?? null;

  if (email) {
    const lockout = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }
  }

  if (body.action === "send_sms" && session.platformUserId && email) {
    const challenge = await issueSmsMfaChallenge({
      subjectRealm: "platform_user",
      subjectId: session.platformUserId,
      email,
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
    verified = await verifyPassword(session.sub, body.password);
  } else if (
    typeof body.code === "string" &&
    body.code.trim().length > 0 &&
    session.platformUserId
  ) {
    const method: MfaMethod | null =
      body.method === "totp" || body.method === "sms_otp" ? body.method : "totp";
    const detail = await withoutTenantScope("platform", () =>
      verifyAndConfirmMfaCode({
        subjectRealm: "platform_user",
        subjectId: session.platformUserId!,
        method,
        code: body.code!,
        useRecoveryCode: Boolean(body.useRecoveryCode),
      }),
    );
    verified = detail.outcome !== "rejected";
  } else {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  if (email) {
    if (verified) await recordAuthSuccess("tenant_password", email);
    else await recordAuthFailure("tenant_password", email);
  }

  if (!verified) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const nextToken = await signSession({
    ...session,
    recentAuthAt: nowSec,
  });

  const res = NextResponse.json({
    ok: true,
    recentAuth: true,
    recentAuthAt: nowSec,
  });
  res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions());
  return res;
});
