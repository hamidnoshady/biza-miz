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
import { changeOwnPassword, setInitialPasswordForPlatformUser } from "@/lib/password-reset";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { requireRecentAuth } from "@/lib/recent-auth";
import { describeCredentialSurface } from "@/lib/credential-authority";
import {
  SELF_CREDENTIAL_AUDIT_ACTIONS,
  recordSecurityAudit,
  transactionAuditExecutor,
} from "@/lib/security-audit";

/**
 * Canonical tenant self-service password change (Issue #809 — Findings 3 & 5).
 *
 * Always operates on the signed-in caller (`session.platformUserId`), requires
 * the current password, validates password strength, atomically increments
 * `platform_users.token_version`, revokes all other active sessions, and
 * refreshes the caller's current session cookie.
 *
 * Issue #854 follow-up (F04): the credential write, the token-version bump,
 * the revocations, the audit row and the refreshed session token are one unit.
 * The audit row and the token are produced inside `changeOwnPassword`'s
 * transaction (`beforeCommit`), so either all of it commits and the caller gets
 * the new cookie, or none of it does and the caller gets
 * `credential_change_failed` with the old password, the old sessions and the
 * old cookie all still valid. It used to commit the password first and then
 * fail on the audit, leaving the member signed out by their own change.
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

  const platformUserId = session.platformUserId;
  /*
   * #1386 — read the global identity, not the membership's email. A phone-only
   * identity has no email at all, and the password door counts its lockout
   * under the E.164 number. `password_hash` is also the only honest answer to
   * "is this a password account", which `hasGlobalIdentity` is not.
   */
  const { rows: identities } = await query<{
    email: string | null;
    phone_e164: string | null;
    password_hash: string | null;
  }>(
    `SELECT email::text AS email, phone_e164, password_hash
       FROM platform_users
      WHERE id = $1 AND is_active = true`,
    [platformUserId],
  );
  const identity = identities[0];
  if (!identity) {
    return NextResponse.json(
      { error: "no_login", message: authErrorMessage("no_login") },
      { status: 409 },
    );
  }
  const lockoutKey = identity.email ?? identity.phone_e164;

  if (lockoutKey) {
    const lockout = await checkAuthLockout(
      "tenant_password",
      lockoutKey,
      PASSWORD_LOCKOUT_POLICY,
    );
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }
  }

  /*
   * A passwordless identity creates its first password here. There is no
   * current password to prove, so the session itself is the proof — and a
   * recent one: creating a credential from a long-idle browser is a
   * credential change and must be stepped up.
   */
  if (identity.password_hash === null) {
    const recentAuthError = requireRecentAuth(session);
    if (recentAuthError) return recentAuthError;

    let created: Awaited<ReturnType<typeof setInitialPasswordForPlatformUser>>;
    try {
      created = await setInitialPasswordForPlatformUser({
        platformUserId,
        newPassword,
        lockoutKey: lockoutKey ?? platformUserId,
        keepEmployeeSessionId: session.employeeSessionId ?? null,
      });
    } catch (err) {
      console.error(
        "initial password creation rolled back:",
        err instanceof Error ? err.message : "unknown error",
      );
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.credentialChangeFailed,
          message: authErrorMessage(AUTH_ERROR_CODES.credentialChangeFailed),
        },
        { status: 500 },
      );
    }
    if (!created.ok) {
      return NextResponse.json(
        {
          error:
            created.error === "password_strength" ? created.detail : created.error,
        },
        { status: 400 },
      );
    }

    const res = NextResponse.json({
      ok: true,
      tokenVersion: created.tokenVersion,
      created: true,
    });
    res.cookies.set(
      SESSION_COOKIE,
      await signSession({
        ...session,
        tokenVersion: created.tokenVersion,
        recentAuthAt: Math.floor(Date.now() / 1000),
      }),
      sessionCookieOptions(session),
    );
    return res;
  }

  if (!currentPassword) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.missingCurrentPassword,
        message: authErrorMessage(AUTH_ERROR_CODES.missingCurrentPassword),
      },
      { status: 400 },
    );
  }
  // A holder rather than a `let`: the token is minted inside the transaction
  // hook, and control-flow narrowing does not follow assignments in callbacks.
  const issued: { token: string | null } = { token: null };
  let result: Awaited<ReturnType<typeof changeOwnPassword>>;
  try {
    result = await changeOwnPassword({
      subjectRealm: "platform_user",
      subjectId: platformUserId,
      currentPassword,
      newPassword,
      lockoutKey: lockoutKey ?? platformUserId,
      keepEmployeeSessionId: session.employeeSessionId ?? null,
      beforeCommit: async ({ tokenVersion, revokedSessions }) => {
        if (lockoutKey) await recordAuthSuccess("tenant_password", lockoutKey);
        await recordSecurityAudit(
          {
            realm: "tenant",
            businessId: session.businessId,
            actorUserId: session.sub,
            platformUserId,
            action: SELF_CREDENTIAL_AUDIT_ACTIONS.passwordChangedSelf,
            entity: "user",
            entityId: session.sub,
            payload: { tokenVersion, revokedSessions },
          },
          transactionAuditExecutor(),
        );
        // Signed before COMMIT: a token that cannot be minted rolls the change
        // back rather than leaving a committed password and no usable cookie.
        issued.token = await signSession({
          ...session,
          tokenVersion,
          recentAuthAt: Math.floor(Date.now() / 1000),
        });
      },
    });
  } catch (err) {
    // Nothing was committed. Log the reason, never the request.
    console.error(
      "self password change rolled back:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.credentialChangeFailed,
        message: authErrorMessage(AUTH_ERROR_CODES.credentialChangeFailed),
      },
      { status: 500 },
    );
  }

  if (!result.ok) {
    if (result.error === "invalid_current_password") {
      if (lockoutKey) await recordAuthFailure("tenant_password", lockoutKey);
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

  if (!issued.token) {
    // Unreachable: `beforeCommit` runs on every successful change. Refuse
    // rather than answer 200 without the cookie the change made necessary.
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.credentialChangeFailed,
        message: authErrorMessage(AUTH_ERROR_CODES.credentialChangeFailed),
      },
      { status: 500 },
    );
  }

  const res = NextResponse.json({ ok: true, tokenVersion: result.tokenVersion });
  res.cookies.set(SESSION_COOKIE, issued.token, sessionCookieOptions(session));
  return res;
});
