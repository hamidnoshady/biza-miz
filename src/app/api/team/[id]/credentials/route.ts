import { NextRequest, NextResponse } from "next/server";
import { getSession, requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { toLatinDigits } from "@/lib/digits";
import { isValidPin } from "@/lib/team";
import { TeamError, setPassword, setPin, verifyPassword } from "@/lib/team-service";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import { readDeploymentProfile } from "@/lib/deployment-mode";

/**
 * Sets a member's PIN or password.
 *
 * Two callers, deliberately in one route because the rules differ only by who
 * is asking:
 *
 *   - **Yourself** — allowed without `team.manage`, but you must prove your
 *     current password before changing it. Otherwise a walk-up at an unlocked
 *     screen becomes a permanent account takeover.
 *   - **Someone else** — requires `team.manage`, and no current password
 *     (that's the point of a force-reset).
 *
 * Note that a password lives on the *global* identity, so an owner resetting a
 * member's password changes that person's login everywhere they are a member,
 * not only here. A PIN is per-membership and stays local to this business.
 */
export const PUT = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
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

  let body: { pin?: string; password?: string; currentPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.pin !== undefined) {
      const pin = toLatinDigits(String(body.pin));
      if (!isValidPin(pin)) return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
      await setPin(session.businessId, id, pin, session.sub);
      return NextResponse.json({ ok: true });
    }

    if (body.password !== undefined) {
      // A paired desktop replicates login from the cloud (src/lib/iam/
      // login-credentials.ts); a password set here would be overwritten on
      // the next sync, so it is changed on the cloud or not at all.
      if ((await readDeploymentProfile(session.businessId)).profile === "hybrid") {
        return NextResponse.json({ error: "login_managed_by_cloud" }, { status: 409 });
      }
      if (isSelf) {
        // The same brute-force surface as a login form: a hijacked or
        // walked-up-to session could otherwise script this field against the
        // real password with nothing but the shared per-business API budget
        // to slow it down. Shares the exact login lockout (tenant_password,
        // 5/15min) rather than a separate counter, since both are attempts
        // to guess the same platform_users password.
        const { rows } = await query<{ email: string | null }>(
          `SELECT email FROM users WHERE id = $1 AND business_id = $2`,
          [session.sub, session.businessId],
        );
        const email = rows[0]?.email;
        if (email) {
          const lockout = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
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
          return NextResponse.json({ error: "invalid_current_password" }, { status: 403 });
        }
      }
      await setPassword(session.businessId, id, body.password, session.sub);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
