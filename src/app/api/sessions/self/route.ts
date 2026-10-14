import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  requireMember,
  sessionCookieOptions,
  withTenantScope,
} from "@/lib/auth";
import { query } from "@/lib/db";
import {
  revokeMembershipSessions,
  revokePlatformUserSessions,
} from "@/lib/password-reset";
import { isRecentAuth, requireRecentAuth, RECENT_AUTH_WINDOW_SECONDS } from "@/lib/recent-auth";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { SECURITY_AUDIT_ACTIONS, recordSecurityAudit } from "@/lib/security-audit";
import {
  describeDevice,
  isSessionLoginMethod,
  isSessionRevokeAction,
  type SelfSessionView,
} from "@/lib/session-contract";

/**
 * Issue #854 (P1.3 / P1.4 / P1.5 / P2.22 / P2.27) — the caller's own sessions.
 *
 * ## Scope
 *
 * The list is the **current business's** sessions and the revocations reach
 * exactly what the list showed. Previously `revoke_others` detected a global
 * identity and revoked that identity's sessions across *every* business plus
 * its impersonation grants, while the list showed one business — so a member
 * could silently end sessions they had never been shown (#854 P1.4). Signing
 * out everywhere is now its own action (`revoke_all`), documented in the UI as
 * global, and confirmed before it runs.
 *
 * ## Method
 *
 * `DELETE = POST` (#854 P1.3). The Profile card sends `DELETE`; the route
 * implemented `POST` only, so every revoke button in that card got a 405 and
 * reported it as a generic failure. Mirroring the platform route is the
 * documented preference from the issue, and it keeps both spellings working
 * for any client that already sends one of them.
 *
 * ## Contract
 *
 * `SelfSessionView` (`src/lib/session-contract.ts`) is the one shape: branch
 * *name*, `issuedAt`, a nullable `lastSeenAt` the UI falls back from, a parsed
 * device label and the login method (#854 P1.5, P2.27).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { rows } = await query<{
    id: string;
    location_id: string | null;
    location_name: string | null;
    device_label: string | null;
    user_agent: string | null;
    login_method: string | null;
    issued_at: Date;
    last_seen_at: Date | null;
    expires_at: Date;
    business_name: string;
  }>(
    `SELECT s.id, s.location_id, l.name AS location_name,
            coalesce(s.device_label, d.label) AS device_label,
            s.user_agent, s.login_method,
            s.issued_at, s.last_seen_at, s.expires_at,
            b.name AS business_name
       FROM employee_sessions s
       LEFT JOIN pos_devices d ON d.id = s.device_id
       LEFT JOIN locations l ON l.id = s.location_id
       JOIN businesses b ON b.id = s.business_id
      WHERE s.business_id = $1
        AND s.employee_id = $2
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      ORDER BY s.issued_at DESC`,
    [session.businessId, session.sub],
  );

  const sessions: SelfSessionView[] = rows.map((row) => ({
    id: row.id,
    businessId: session.businessId,
    businessName: row.business_name,
    locationId: row.location_id,
    locationName: row.location_name,
    deviceLabel: row.device_label ?? describeDevice(row.user_agent),
    userAgent: row.user_agent,
    loginMethod: isSessionLoginMethod(row.login_method) ? row.login_method : null,
    issuedAt: row.issued_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    expiresAt: row.expires_at.toISOString(),
    isCurrent: row.id === session.employeeSessionId,
  }));

  return NextResponse.json({
    scope: "business",
    revocableCount: sessions.filter((s) => !s.isCurrent).length,
    currentSessionId: session.employeeSessionId ?? null,
    recentAuth: isRecentAuth(session),
    maxAgeSeconds: RECENT_AUTH_WINDOW_SECONDS,
    sessions,
  });
});

async function revoke(request: NextRequest) {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: { action?: string; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: AUTH_ERROR_CODES.badRequest }, { status: 400 });
  }

  if (!isSessionRevokeAction(body.action)) {
    return NextResponse.json({ error: AUTH_ERROR_CODES.invalidAction }, { status: 400 });
  }
  const action = body.action;

  // ------------------------------------------------------------------ revoke_one
  if (action === "revoke_one") {
    const targetId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!targetId) {
      return NextResponse.json({ error: AUTH_ERROR_CODES.badRequest }, { status: 400 });
    }
    /**
     * Scoped to this business and this membership in the predicate itself, so
     * a guessed id from another tenant — or another member — matches nothing.
     */
    const { rowCount } = await query(
      `UPDATE employee_sessions
          SET revoked_at = now()
        WHERE id = $1 AND business_id = $2 AND employee_id = $3 AND revoked_at IS NULL`,
      [targetId, session.businessId, session.sub],
    );
    if (!rowCount) {
      return NextResponse.json(
        { error: AUTH_ERROR_CODES.sessionNotFound, message: authErrorMessage(AUTH_ERROR_CODES.sessionNotFound) },
        { status: 404 },
      );
    }
    await auditRevocation(session.businessId, session.sub, SECURITY_AUDIT_ACTIONS.sessionRevoked, {
      sessionId: targetId,
    });
    return NextResponse.json({
      ok: true,
      action,
      scope: "business",
      revokedCount: rowCount,
      signedOut: targetId === session.employeeSessionId,
    });
  }

  // --------------------------------------------------- revoke_others / revoke_all
  const recentError = requireRecentAuth(session);
  if (recentError) return recentError;

  if (action === "revoke_others") {
    /**
     * Business scope, whatever the caller's identity (P1.4). A global identity
     * does **not** get a cross-business sweep here: the list above shows one
     * business, and a revoke must not reach past what the member was shown.
     */
    const revokedCount = await revokeMembershipSessions(session.businessId, session.sub, {
      keepEmployeeSessionId: session.employeeSessionId ?? null,
    });
    await auditRevocation(session.businessId, session.sub, SECURITY_AUDIT_ACTIONS.sessionsRevokedOthers, {
      revokedCount,
    });
    return NextResponse.json({
      ok: true,
      action,
      scope: "business",
      revokedCount,
      signedOut: false,
    });
  }

  // ---------------------------------------------------------------- revoke_all
  /**
   * The explicit global sign-out: every business the identity belongs to, plus
   * any support impersonation grant, and `token_version` is bumped so an
   * already-issued cookie elsewhere cannot be replayed. The response says
   * `scope: "global"` so the UI can state what happened rather than implying it
   * was the same thing as `revoke_others`.
   */
  let revokedCount = 0;
  if (session.platformUserId) {
    const revoked = await revokePlatformUserSessions(session.platformUserId, {
      bumpTokenVersion: true,
      keepEmployeeSessionId: null,
      endImpersonation: true,
    });
    revokedCount = revoked.revokedEmployeeSessions;
  } else {
    revokedCount = await revokeMembershipSessions(session.businessId, session.sub);
  }

  await auditRevocation(session.businessId, session.sub, SECURITY_AUDIT_ACTIONS.signedOutEverywhere, {
    revokedCount,
    acrossBusinesses: Boolean(session.platformUserId),
  });

  const res = NextResponse.json({
    ok: true,
    action,
    scope: "global",
    revokedCount,
    signedOut: true,
  });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}

/**
 * Every sensitive mutation writes a row naming *what* was revoked and *how
 * many* — never a token, never a session hash (#854 P2.22).
 *
 * Issue #854 (invariant 12) — the durability policy lives in
 * `security-audit.ts` and this call site used to violate it: `.catch(() => {})`
 * turned a failed audit of a session revocation into a silent success, so a
 * member could be signed out everywhere with nothing recording that it happened
 * or who asked. The write is now retried once and, if it still fails, logged
 * loudly and surfaced as an error: a caller who sees a failure that in fact
 * succeeded is a support ticket, and a caller who sees success on an unlogged
 * credential change is an incident nobody can reconstruct.
 */
async function auditRevocation(
  businessId: string,
  actorId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await recordSecurityAudit({
    realm: "tenant",
    businessId,
    actorUserId: actorId,
    action,
    entity: "employee_session",
    entityId: actorId,
    payload,
  });
}

export const POST = withTenantScope(revoke);
/**
 * The Profile card's spelling (#854 P1.3). Aliased rather than renamed in the
 * UI so a client already sending either method keeps working.
 */
export const DELETE = POST;
