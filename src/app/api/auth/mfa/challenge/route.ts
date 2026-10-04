import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken } from "@/lib/mfa-service";
import { issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import { checkAuthLockout } from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { query, withoutTenantScope } from "@/lib/db";

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

  if (payload.primaryAuth === "phone_otp") {
    return NextResponse.json({ error: "mfa_distinct_factor_required" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    const { rows: users } = await query<{ email: string }>(
      `SELECT email::text AS email FROM platform_users WHERE id = $1 AND is_active = true`,
      [payload.sub],
    );
    if (users.length === 0) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const email = users[0].email;

    const lockout = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const challenge = await issueSmsMfaChallenge({
      subjectRealm: "platform_user",
      subjectId: payload.sub,
      email,
    });
    if (!challenge.ok) {
      if (challenge.error === "rate_limited") {
        return NextResponse.json(
          { error: "rate_limited", retryAfterMs: challenge.retryAfterMs ?? 60_000 },
          { status: 429 },
        );
      }
      if (challenge.error === "sms_dispatch_failed") {
        return NextResponse.json({ error: "sms_dispatch_failed" }, { status: 500 });
      }
      return NextResponse.json({ error: challenge.error }, { status: 400 });
    }

    return NextResponse.json({
      status: "challenge_sent",
      maskedPhone: challenge.maskedPhone,
    });
  });
}
