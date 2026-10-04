import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  requireMember,
  sessionCookieOptions,
  signSession,
  withTenantScope,
} from "@/lib/auth";
import { query } from "@/lib/db";
import {
  revokeMembershipSessions,
  revokePlatformUserSessions,
} from "@/lib/password-reset";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { rows } = await query<{
    id: string;
    location_id: string | null;
    device_label: string | null;
    issued_at: Date;
    last_seen_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT s.id, s.location_id, coalesce(s.device_label, d.label) AS device_label,
            s.issued_at, s.last_seen_at, s.expires_at
       FROM employee_sessions s
       LEFT JOIN pos_devices d ON d.id = s.device_id
      WHERE s.business_id = $1
        AND s.employee_id = $2
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      ORDER BY s.issued_at DESC`,
    [session.businessId, session.sub],
  );

  return NextResponse.json({
    currentSessionId: session.employeeSessionId ?? null,
    recentAuth: isRecentAuth(session),
    sessions: rows.map((row) => ({
      id: row.id,
      locationId: row.location_id,
      deviceLabel: row.device_label,
      issuedAt: row.issued_at.toISOString(),
      lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      expiresAt: row.expires_at.toISOString(),
      isCurrent: row.id === session.employeeSessionId,
    })),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: { action?: string; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "revoke_one") {
    const targetId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!targetId) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const { rowCount } = await query(
      `UPDATE employee_sessions
          SET revoked_at = now()
        WHERE id = $1 AND business_id = $2 AND employee_id = $3 AND revoked_at IS NULL`,
      [targetId, session.businessId, session.sub],
    );
    if (!rowCount) {
      return NextResponse.json({ error: "session_not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_others") {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;

    if (session.platformUserId) {
      const revoked = await revokePlatformUserSessions(session.platformUserId, {
        bumpTokenVersion: true,
        keepEmployeeSessionId: session.employeeSessionId ?? null,
        endImpersonation: true,
      });
      const nextToken = await signSession({
        ...session,
        tokenVersion: revoked.tokenVersion ?? (session.tokenVersion ?? 1) + 1,
      });
      const res = NextResponse.json({
        ok: true,
        revokedCount: revoked.revokedEmployeeSessions,
      });
      res.cookies.set(SESSION_COOKIE, nextToken, sessionCookieOptions());
      return res;
    }

    const revokedCount = await revokeMembershipSessions(
      session.businessId,
      session.sub,
      { keepEmployeeSessionId: session.employeeSessionId ?? null },
    );
    return NextResponse.json({ ok: true, revokedCount });
  }

  if (body.action === "revoke_all") {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;

    if (session.platformUserId) {
      await revokePlatformUserSessions(session.platformUserId, {
        bumpTokenVersion: true,
        keepEmployeeSessionId: null,
        endImpersonation: true,
      });
    } else {
      await revokeMembershipSessions(session.businessId, session.sub);
    }

    const res = NextResponse.json({ ok: true, signedOut: true });
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
    return res;
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
