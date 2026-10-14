import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import {
  PLATFORM_SESSION_COOKIE,
  platformAudit,
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
import { changeOwnPassword } from "@/lib/password-reset";

/**
 * Superadmin self-service password change (Issue #809 — Findings 3 & 6).
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ email: string }>(
      `SELECT email::text AS email FROM platform_admins WHERE id = $1 AND is_active = true`,
      [session.padmin],
    );
    const email = rows[0]?.email;
    if (!email) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const lockout = await checkAuthLockout(
      "platform_admin",
      email,
      PLATFORM_LOCKOUT_POLICY,
    );
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const result = await changeOwnPassword({
      subjectRealm: "platform_admin",
      subjectId: session.padmin,
      currentPassword,
      newPassword,
      keepAdminSessionId: session.sessionId ?? null,
    });

    if (!result.ok) {
      if (result.error === "invalid_current_password") {
        await recordAuthFailure("platform_admin", email);
        return NextResponse.json({ error: "invalid_current_password" }, { status: 403 });
      }
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await recordAuthSuccess("platform_admin", email);

    await platformAudit({
      adminId: session.padmin,
      action: "platform_admin.password_changed_self",
      entity: "platform_admin",
      entityId: session.padmin,
      payload: { tokenVersion: result.tokenVersion },
    });

    const nextToken = await signPlatformSession({
      ...session,
      tokenVersion: result.tokenVersion,
      recentAuthAt: Math.floor(Date.now() / 1000),
    });

    const res = NextResponse.json({ ok: true, tokenVersion: result.tokenVersion });
    res.cookies.set(PLATFORM_SESSION_COOKIE, nextToken, platformSessionCookieOptions());
    return res;
  });
});
