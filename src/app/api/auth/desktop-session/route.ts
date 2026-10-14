import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { isLoginToken, safeNextPath } from "@/lib/desktop-cloud-login";
import { redeemSessionLoginCode } from "@/lib/desktop-cloud-login-service";
import { resolveLoginBusinessId } from "@/lib/employee-service";
import { requestHost } from "@/lib/host";

/**
 * Phase 46: the desktop's embedded cloud pane opens this once with the
 * session code its desktop just received, and is signed in on the business's
 * own origin — the owner pressed «ورود با حساب ابری» once, not twice.
 *
 * Session-less by necessity, like /api/auth/impersonate-handoff: the code is
 * the credential, single-use and two minutes long. The host names the tenant
 * (the login family's rule); the cookie is host-scoped as always.
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
  });
  const response = relative(next);
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
