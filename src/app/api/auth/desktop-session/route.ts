import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { isLoginToken, safeNextPath } from "@/lib/desktop-cloud-login";
import { redeemSessionLoginCode } from "@/lib/desktop-cloud-login-service";
import { createSession, resolveLoginBusinessId } from "@/lib/employee-service";
import { requestHost } from "@/lib/host";

/**
 * Phase 46: the desktop's embedded cloud pane opens this once with the
 * session code its desktop just received, and is signed in on the business's
 * own origin — the owner pressed «ورود با حساب ابری» once, not twice.
 *
 * Session-less by necessity, like /api/auth/impersonate-handoff: the code is
 * the credential, single-use and two minutes long. The host names the tenant
 * (the login family's rule); the cookie is host-scoped as always.
 *
 * The session it opens is an ordinary revocable one (#854 follow-up, third
 * pass): an `employee_sessions` row with `login_method = 'desktop_handoff'`,
 * named by the cookie, so «خروج» in the cloud pane ends it on the server and
 * the security center can see and end it. If the row cannot be opened, no
 * cookie is issued at all — the pane lands on the sign-in page instead of
 * holding a session nothing could revoke.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  // Relative Location: request.url is the container's origin behind a proxy.
  const relative = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path } });
  if (!isLoginToken(code)) return relative("/login");
  const { businessId } = await resolveLoginBusinessId({ host: requestHost(request.headers) });
  if (!businessId) return relative("/login");
  const member = await withTenant(businessId, () => redeemSessionLoginCode(businessId, code));
  if (!member) return relative(`/login?next=${encodeURIComponent(next)}`);
  const userAgent = request.headers.get("user-agent");
  const opened = await withTenant(businessId, () =>
    createSession(member.userId, businessId, {
      locationId: member.locationId,
      loginMethod: "desktop_handoff",
      deviceLabel: userAgent?.slice(0, 120) ?? null,
      userAgent,
    }),
  ).catch((err: unknown) => {
    console.error(
      "desktop hand-off could not open a session:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  });
  if (!opened) return relative(`/login?next=${encodeURIComponent(next)}`);
  const token = await signSession({
    sub: member.userId,
    role: member.role,
    businessId,
    businessSlug: member.businessSlug,
    businessSubdomain: member.businessSubdomain,
    locationId: member.locationId,
    fullName: member.fullName,
    platformUserId: member.platformUserId,
    ...(member.tokenVersion !== null ? { tokenVersion: member.tokenVersion } : {}),
    employeeSessionId: opened.session.id,
  });
  const response = relative(next);
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
