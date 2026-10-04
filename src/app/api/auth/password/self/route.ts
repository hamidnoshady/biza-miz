import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  requireMember,
  sessionCookieOptions,
  signSession,
  withTenantScope,
} from "@/lib/auth";
import { query } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { changeOwnPassword } from "@/lib/password-reset";

/**
 * Canonical tenant self-service password change (Issue #809 — Findings 3 & 5).
 *
 * Always operates on the signed-in caller (`session.platformUserId`), requires
 * the current password, validates password strength, atomically increments
 * `platform_users.token_version`, revokes all other active sessions, and
 * refreshes the caller's current session cookie.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  if (!session.platformUserId) {
    return NextResponse.json({ error: "no_login" }, { status: 409 });
  }

  if ((await readDeploymentProfile(session.businessId)).profile === "hybrid") {
    return NextResponse.json({ error: "login_managed_by_cloud" }, { status: 409 });
  }

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

  const result = await changeOwnPassword({
    subjectRealm: "platform_user",
    subjectId: session.platformUserId,
    currentPassword,
    newPassword,
    keepEmployeeSessionId: session.employeeSessionId ?? null,
  });

  if (!result.ok) {
    if (result.error === "invalid_current_password") {
      if (email) await recordAuthFailure("tenant_password", email);
      return NextResponse.json({ error: "invalid_current_password" }, { status: 403 });
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  if (email) {
    await recordAuthSuccess("tenant_password", email);
  }

  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, 'user.password_changed_self', 'user', $3, $4)`,
    [
      session.businessId,
      session.sub,
      session.sub,
      JSON.stringify({ tokenVersion: result.tokenVersion }),
    ],
  );

  const nextToken = await signSession({
    ...session,
    tokenVersion: result.tokenVersion,
    recentAuthAt: Math.floor(Date.now() / 1000),
  });

  const res = NextResponse.json({ ok: true, tokenVersion: result.tokenVersion });
  res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions());
  return res;
});
