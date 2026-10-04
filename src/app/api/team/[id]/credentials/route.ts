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
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { readDeploymentProfile } from "@/lib/deployment-mode";

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
      password?: string;
      currentPassword?: string;
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
        const reset = await requestMemberPasswordReset(session.businessId, id, session.sub);
        return NextResponse.json({
          ok: true,
          token: reset.token,
          expiresAt: reset.expiresAt,
          email: reset.email,
          url: `/reset-password?token=${encodeURIComponent(reset.token)}`,
        });
      }

      if (body.action === "revoke_sessions") {
        const res = await revokeMemberTenantSessions(session.businessId, id, session.sub);
        return NextResponse.json({ ok: true, revokedCount: res.revokedCount });
      }

      if (body.pin !== undefined) {
        const pin = toLatinDigits(String(body.pin));
        if (!isValidPin(pin)) {
          return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
        }
        await setPin(session.businessId, id, pin, session.sub);
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
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
