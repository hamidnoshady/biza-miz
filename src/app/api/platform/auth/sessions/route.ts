import { NextRequest, NextResponse } from "next/server";
import {
  listPlatformAdminSessions,
  PLATFORM_SESSION_COOKIE,
  platformAudit,
  platformSessionCookieOptions,
  requirePlatformAdmin,
  revokeAllPlatformAdminSessions,
  revokeOtherPlatformAdminSessions,
  revokePlatformAdminSession,
  signPlatformSession,
  withPlatformScope,
} from "@/lib/platform-auth";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;

  const sessions = await listPlatformAdminSessions(session.padmin);

  return NextResponse.json({
    currentSessionId: session.sessionId ?? null,
    recentAuth: isRecentAuth(session),
    sessions: sessions.map((s) => ({
      ...s,
      isCurrent: s.id === session.sessionId,
    })),
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformAdmin();
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
    const ok = await revokePlatformAdminSession(session.padmin, targetId);
    if (!ok) {
      return NextResponse.json({ error: "session_not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_others") {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;

    const revoked = await revokeOtherPlatformAdminSessions(
      session.padmin,
      session.sessionId ?? null,
    );

    await platformAudit({
      adminId: session.padmin,
      action: "platform_admin.other_sessions_revoked",
      entity: "platform_admin",
      entityId: session.padmin,
      payload: { revokedSessions: revoked.revokedSessions },
    });

    const nextToken = await signPlatformSession({
      ...session,
      tokenVersion: revoked.tokenVersion,
    });
    const res = NextResponse.json({
      ok: true,
      revokedCount: revoked.revokedSessions,
    });
    res.cookies.set(PLATFORM_SESSION_COOKIE, nextToken, platformSessionCookieOptions());
    return res;
  }

  if (body.action === "revoke_all") {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;

    const revoked = await revokeAllPlatformAdminSessions(session.padmin);

    await platformAudit({
      adminId: session.padmin,
      action: "platform_admin.all_sessions_revoked",
      entity: "platform_admin",
      entityId: session.padmin,
      payload: { revokedSessions: revoked.revokedSessions },
    });

    const res = NextResponse.json({ ok: true, signedOut: true });
    res.cookies.set(PLATFORM_SESSION_COOKIE, "", {
      ...platformSessionCookieOptions(),
      maxAge: 0,
    });
    return res;
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

export const DELETE = POST;
