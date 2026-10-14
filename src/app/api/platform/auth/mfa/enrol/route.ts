import { NextRequest, NextResponse } from "next/server";
import { verifyMfaPendingToken } from "@/lib/mfa-service";
import { enrolMfaMethod } from "@/lib/mfa-enrol";
import { checkAuthLockout } from "@/lib/login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { query, withoutTenantScope } from "@/lib/db";

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

  let body: { method?: string; phone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    const { rows: admins } = await query<{ email: string }>(
      `SELECT email::text AS email FROM platform_admins WHERE id = $1 AND is_active = true`,
      [payload.sub],
    );
    if (admins.length === 0) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const email = admins[0].email;

    const lockout = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const result = await enrolMfaMethod({
      subjectRealm: "platform_admin",
      subjectId: payload.sub,
      email,
      method: body.method,
      phone: body.phone,
    });
    if (!result.ok) {
      const status =
        result.error === "already_enrolled"
          ? 409
          : result.error === "rate_limited"
            ? 429
            : 400;
      return NextResponse.json(
        { error: result.error, retryAfterMs: result.retryAfterMs },
        { status },
      );
    }

    return NextResponse.json({
      status: "provisioned",
      method: result.method,
      totpSecret: result.totpSecret,
      totpUrl: result.totpUrl,
      totpQr: result.totpQr,
      phone: result.phone,
      maskedPhone: result.maskedPhone,
      recoveryCodes: result.recoveryCodes,
    });
  });
}
