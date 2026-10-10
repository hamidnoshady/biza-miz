import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getSession,
  requirePermission,
  sessionCookieOptions,
  signSession,
  withTenantScope,
} from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { toLatinDigits } from "@/lib/digits";
import { isValidPin } from "@/lib/team";
import {
  TeamError,
  requestMemberPasswordReset,
  revokeMemberTenantSessions,
  setPassword,
  setPin,
  verifyPassword,
} from "@/lib/team-service";
import { validatePasswordStrength } from "@/lib/password-reset";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { verifySelfPin } from "@/lib/self-credentials";
import { auditLoginFailure, checkLoginLockout } from "@/lib/employee-service";
import { authErrorMessage, AUTH_ERROR_CODES } from "@/lib/auth-contracts";

/**
 * Manages a member's tenant credentials or initiates user-controlled recovery.
 *
 * Per Issue #809 (Findings 2 & 3):
 *   - **PIN (`body.pin`)**: tenant-local (`employee_credentials`), may be set by
 *     `team.manage` or self.
 *   - **Password (`body.password`)**: global (`platform_users`), allowed ONLY
 *     for `isSelf` after verifying `currentPassword`. A tenant administrator in
 *     Business A is strictly forbidden from directly choosing/overwriting
 *     another user's global password (`cross_user_password_reset_forbidden`).
 *   - **Password recovery (`body.action === "send_password_reset"`)**: issues a
 *     one-time user-controlled reset link so the account holder sets their own
 *     password.
 *   - **Session revocation (`body.action === "revoke_sessions"`)**: revokes the
 *     member's active sessions in this tenant.
 */
export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { id } = await context.params;
    const { rows } = await query<{ actor_role: string; target_role: string }>(
      `SELECT actor.role::text AS actor_role, target.role::text AS target_role FROM users actor
         JOIN users target ON target.id = $3 AND target.business_id = actor.business_id
        WHERE actor.id = $1 AND actor.business_id = $2 AND actor.is_active = true`,
      [session.sub, session.businessId, id],
    );
    if (!rows[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (rows[0].actor_role !== "owner" && rows[0].target_role === "owner") {
      return NextResponse.json({ error: "owner_only" }, { status: 403 });
    }
    const isSelf = id === session.sub;

    if (!isSelf) {
      const guard = await requirePermission(PERMISSIONS.teamManage);
      if (guard.error) return guard.error;
    }

    let body: {
      action?: string;
      pin?: string;
      /** Issue #854 (P1.7) — proof required when rotating your own PIN. */
      currentPin?: string;
      password?: string;
      currentPassword?: string;
      confirmPassword?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    try {
      if (body.action === "send_password_reset") {
        if ((await readDeploymentProfile(session.businessId)).profile === "hybrid") {
          return NextResponse.json({ error: "login_managed_by_cloud" }, { status: 409 });
        }
        /**
         * Issue #854 (P0.3) — the tenant administrator triggers delivery and
         * receives **no credential**.
         *
         * This route used to answer with the plaintext one-time reset token, its
         * `/reset-password?token=…` URL and the target email — and that token is
         * directly spendable to change the shared `platform_users` password. An
         * administrator in Business A could therefore start recovery for a
         * shared identity and redeem their own token, taking over that person's
         * password in Businesses B and C, which is precisely the boundary #809
         * set out to create.
         *
         * The recovery is now texted to the account holder's own *verified*
         * phone number and the response says only where it went. There is no
         * mail transport in this deployment, so an identity with no verified
         * number anywhere gets `no_verified_channel` — the alternative
         * (handing the link back to whoever asked) is the vulnerability.
         */
        const reset = await requestMemberPasswordReset(session.businessId, id, session.sub, {
          origin: request.nextUrl.origin,
        });
        return NextResponse.json({
          ok: true,
          deliveredTo: reset.deliveredTo,
          channel: reset.channel,
          expiresAt: reset.expiresAt,
          email: reset.email,
          /** Stated explicitly so a client cannot assume it may render a link. */
          credentialReturned: false,
        });
      }

      if (body.action === "revoke_sessions") {
        const res = await revokeMemberTenantSessions(session.businessId, id, session.sub);
        return NextResponse.json({ ok: true, revokedCount: res.revokedCount });
      }

      if (body.pin !== undefined) {
        /**
         * Issue #854 (P1.7): a **self-service** PIN rotation must prove the
         * current PIN.
         *
         * `PUT /api/team/[id]/credentials` allowed a signed-in member to replace
         * their own PIN with nothing but their session — so an unattended,
         * unlocked terminal was enough to take the credential over and lock its
         * owner out of their own shift. The current PIN is now required for
         * self-rotation, verified against the member's own credential with the
         * same lockout the lock screen uses. An *administrator* reset keeps
         * working without it: that is the point of an admin reset, and it is
         * audited.
         */
        const pin = toLatinDigits(String(body.pin));
        if (!isValidPin(pin)) {
          return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
        }

        let currentPinVerified = false;
        if (isSelf) {
          const offered = String(body.currentPin ?? "");
          if (!offered) {
            return NextResponse.json(
              {
                error: "current_pin_required",
                message: "برای تغییر رمز عددی خود، رمز فعلی را وارد کنید.",
              },
              { status: 403 },
            );
          }
          const lockout = await checkLoginLockout(session.businessId, session.sub);
          if (lockout.locked) {
            return NextResponse.json(
              { error: "account_locked", lockedUntil: lockout.lockedUntil },
              { status: 423 },
            );
          }
          currentPinVerified = await verifySelfPin(
            session.businessId,
            session.sub,
            toLatinDigits(offered),
          );
          if (!currentPinVerified) {
            await auditLoginFailure(session.businessId, session.sub, "invalid_pin_rotation");
            return NextResponse.json(
              { error: "invalid_current_pin", message: "رمز عددی فعلی نادرست است." },
              { status: 401 },
            );
          }
          if (pin === toLatinDigits(offered)) {
            return NextResponse.json({ error: "pin_unchanged" }, { status: 400 });
          }
        }

        await setPin(session.businessId, id, pin, session.sub, {
          selfService: isSelf,
          currentPinVerified,
        });
        return NextResponse.json({ ok: true });
      }

      if (body.password !== undefined) {
        if (!isSelf) {
          return NextResponse.json(
            { error: "cross_user_password_reset_forbidden" },
            { status: 403 },
          );
        }
        if ((await readDeploymentProfile(session.businessId)).profile === "hybrid") {
          return NextResponse.json({ error: "login_managed_by_cloud" }, { status: 409 });
        }

        const { rows: emailRows } = await query<{ email: string | null }>(
          `SELECT email FROM users WHERE id = $1 AND business_id = $2`,
          [session.sub, session.businessId],
        );
        const email = emailRows[0]?.email;
        if (email) {
          const lockout = await checkAuthLockout(
            "tenant_password",
            email,
            PASSWORD_LOCKOUT_POLICY,
          );
          if (lockout.locked) {
            return NextResponse.json(
              { error: "account_locked", lockedUntil: lockout.lockedUntil },
              { status: 423 },
            );
          }
        }

        const ok = await verifyPassword(session.sub, body.currentPassword ?? "");
        if (email) {
          if (ok) await recordAuthSuccess("tenant_password", email);
          else await recordAuthFailure("tenant_password", email);
        }
        if (!ok) {
          return NextResponse.json(
            { error: "invalid_current_password" },
            { status: 403 },
          );
        }
        if (body.password === body.currentPassword) {
          return NextResponse.json({ error: "password_unchanged" }, { status: 400 });
        }

        /**
         * Issue #854 (P2.15 / P2.16 / P2.17): confirmation is validated on the
         * server, not only in the browser, and the shared validator rejects a
         * whitespace-only password. The browser's copy of these rules was the
         * only copy that existed before.
         */
        if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
          return NextResponse.json(
            {
              error: AUTH_ERROR_CODES.passwordConfirmationMismatch,
              message: authErrorMessage(AUTH_ERROR_CODES.passwordConfirmationMismatch),
            },
            { status: 400 },
          );
        }
        const strength = validatePasswordStrength(body.password);
        if (!strength.ok) {
          return NextResponse.json(
            { error: strength.error, message: authErrorMessage(strength.error) },
            { status: 400 },
          );
        }

        const { tokenVersion } = await setPassword(
          session.businessId,
          id,
          body.password,
          session.sub,
          { keepEmployeeSessionId: session.employeeSessionId ?? null },
        );

        const nextToken = await signSession({
          ...session,
          tokenVersion,
          recentAuthAt: Math.floor(Date.now() / 1000),
        });
        const res = NextResponse.json({ ok: true });
        res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions());
        return res;
      }

      return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
    } catch (err) {
      if (err instanceof TeamError) {
        return NextResponse.json(
          { error: err.message, message: authErrorMessage(err.message) },
          { status: err.status },
        );
      }
      throw err;
    }
  },
);
