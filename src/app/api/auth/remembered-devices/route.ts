import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, getSession, sessionCookieOptions, withTenantScope } from "@/lib/auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import { uuidOrNull } from "@/lib/login-contract";
import {
  clearedRememberedLoginCookieOptions,
  listRememberedLogins,
  REMEMBERED_LOGIN_COOKIE,
  readRememberedLoginToken,
  resolveRememberedFamilyId,
  revokeRememberedLoginFamily,
  revokeRememberedLoginsForMember,
} from "@/lib/remembered-login";

/**
 * #1585 — the member's own remembered browsers.
 *
 * Scope is the caller's own membership and nothing wider, exactly as
 * `/api/auth/trusted-devices` is: both the list and every revocation are keyed
 * on `session.sub` / `session.businessId` read from the session, never from the
 * request, so no shape of this endpoint reaches another member's authorization.
 *
 * The two authorities stay separately manageable. Revoking a remembered login
 * here does **not** touch the seven-day trusted-device exemption (that is the
 * other endpoint), and revoking trust does not end a remembered login. A member
 * who signs out of a borrowed laptop wants the first; a member who wants the
 * second factor asked for again wants the second.
 *
 * Bulk management requires a recent authentication. Ending the *current*
 * browser's authorization is a sign-out and never needs one.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const currentId = await resolveRememberedFamilyId(readRememberedLoginToken(request));
  const devices = await listRememberedLogins(session.businessId, session.sub);

  return NextResponse.json({
    devices: devices.map((device) => ({
      id: device.id,
      deviceLabel: device.deviceLabel,
      browserFamily: device.browserFamily,
      osFamily: device.osFamily,
      issuedAt: device.issuedAt.toISOString(),
      lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
      idleExpiresAt: device.idleExpiresAt.toISOString(),
      absoluteExpiresAt: device.absoluteExpiresAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString() ?? null,
      isCurrent: currentId === device.id,
    })),
    currentFamilyId: currentId,
  });
});

/**
 * Revoke one remembered browser, or every remembered browser of this
 * membership in this business.
 *
 * Addressed in the body rather than by dynamic segment, matching the
 * trusted-devices route: there is no `[id]` variant that could be reached
 * without these scope checks.
 */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { id?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const currentId = await resolveRememberedFamilyId(readRememberedLoginToken(request));

  if (body.all === true) {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;
    const revokedCount = await revokeRememberedLoginsForMember({
      businessId: session.businessId,
      userId: session.sub,
      reason: "user_revoked_all",
    });
    const res = NextResponse.json({ revoked: true, revokedCount, signedOutCurrent: true });
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(session), maxAge: 0 });
    res.cookies.set(REMEMBERED_LOGIN_COOKIE, "", clearedRememberedLoginCookieOptions());
    return res;
  }

  const id = uuidOrNull(body.id);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const isCurrent = Boolean(currentId) && currentId === id;
  if (!isCurrent) {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;
  }

  const revoked = await revokeRememberedLoginFamily({
    businessId: session.businessId,
    userId: session.sub,
    familyId: id,
    reason: isCurrent ? "user_signed_out" : "user_revoked",
  });

  const res = NextResponse.json({ revoked: true, alreadyRevoked: !revoked, isCurrent });
  if (isCurrent) {
    // Ending the current browser's remembered login is a sign-out: the session
    // cookie goes with it, so the browser does not keep a session that can no
    // longer be renewed.
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(session), maxAge: 0 });
    res.cookies.set(REMEMBERED_LOGIN_COOKIE, "", clearedRememberedLoginCookieOptions());
  }
  return res;
});
