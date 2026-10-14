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
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { describeCredentialSurface } from "@/lib/credential-authority";

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
    return NextResponse.json(
      { error: "no_login", message: authErrorMessage("no_login") },
      { status: 409 },
    );
  }

  /**
   * Issue #854 (P1.14 / P1.15): the deployment's authority over the global
   * password, asked through the shared table rather than an inline profile
   * check — and answered with the shared code and message so the Profile screen
   * can render the same reason the server gives.
   */
  const deployment = await readDeploymentProfile(session.businessId);
  const surface = describeCredentialSurface(deployment.profile, "global_password");
  if (!surface.editable) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.loginManagedByCloud,
        message: surface.notice ?? authErrorMessage(AUTH_ERROR_CODES.loginManagedByCloud),
      },
      { status: 409 },
    );
  }

  let body: { currentPassword?: string; newPassword?: string; confirmPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: AUTH_ERROR_CODES.badRequest }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword =
    typeof body.confirmPassword === "string" ? body.confirmPassword : undefined;

  /**
   * Issue #854 (P2.15 / P2.17): the same vocabulary the UI translates, emitted
   * from here rather than a bare `missing_fields` the client had no message
   * for. `confirmPassword` is validated server-side because a confirmation the
   * server does not check is a browser decoration, not an invariant.
   */
  if (!currentPassword) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.missingCurrentPassword,
        message: authErrorMessage(AUTH_ERROR_CODES.missingCurrentPassword),
      },
      { status: 400 },
    );
  }
  if (!newPassword) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.passwordBlank,
        message: authErrorMessage(AUTH_ERROR_CODES.passwordBlank),
      },
      { status: 400 },
    );
  }
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.passwordConfirmationMismatch,
        message: authErrorMessage(AUTH_ERROR_CODES.passwordConfirmationMismatch),
      },
      { status: 400 },
    );
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
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.invalidCurrentPassword,
          message: authErrorMessage(AUTH_ERROR_CODES.invalidCurrentPassword),
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: result.error, message: authErrorMessage(result.error) },
      { status: 400 },
    );
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
