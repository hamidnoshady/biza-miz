import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import {
  CLOUD_LOGIN_STATE_COOKIE,
  CLOUD_SESSION_CODE_COOKIE,
  isLoginToken,
  LOGIN_CODE_TTL_SECONDS,
  statesMatch,
} from "@/lib/desktop-cloud-login";
import { desktopCloudLoginContext } from "@/lib/desktop-cloud-login-local";
import { createSession } from "@/lib/employee-service";
import { requestHost } from "@/lib/host";

const COOKIE_PATH = "/api/auth/cloud-login";

/**
 * Phase 46, on the desktop: Electron loads this with the code and state the
 * cloud handed back through businesssuite://. The state must match this
 * window's cookie (a link nobody here asked for signs nobody in); the code is
 * redeemed server-to-server with the install's own credential. The member is
 * then signed in locally — IAM sync gives desktop users the cloud's ids — and
 * the cloud pane's single-use session code waits in a short httpOnly cookie.
 */
export async function GET(request: NextRequest) {
  const relative = (path: string) => {
    const response = new NextResponse(null, { status: 303, headers: { Location: path } });
    response.cookies.set(CLOUD_LOGIN_STATE_COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
    return response;
  };
  const fail = (reason: string) => relative(`/login?cloudLogin=${reason}`);
  const code = request.nextUrl.searchParams.get("code");
  if (!isLoginToken(code)) return fail("invalid");
  if (!statesMatch(request.nextUrl.searchParams.get("state"), request.cookies.get(CLOUD_LOGIN_STATE_COOKIE)?.value)) {
    return fail("expired");
  }
  const context = await desktopCloudLoginContext(requestHost(request.headers));
  if (!context) return fail("unavailable");

  let redeemed: { userId?: unknown; sessionCode?: unknown };
  try {
    const res = await fetch(`${context.remoteUrl.replace(/\/+$/, "")}/api/server-sync/desktop-login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fail("refused");
    redeemed = (await res.json()) as typeof redeemed;
  } catch {
    return fail("offline");
  }
  const userId = typeof redeemed.userId === "string" ? redeemed.userId : null;
  if (!userId) return fail("refused");

  const businessId = context.businessId;
  const signed = await withTenant(businessId, async () => {
    const { rows } = await query<{
      id: string;
      role: Role;
      full_name: string;
      location_id: string | null;
      business_slug: string;
      business_subdomain: string;
      platform_user_id: string | null;
      token_version: number | null;
    }>(
      // The synced platform identity rides along, so a cloud password change
      // (which IAM sync replays here as a token_version bump) ends this session.
      `SELECT u.id, u.role, u.full_name, u.location_id,
              b.slug::text AS business_slug, b.subdomain::text AS business_subdomain,
              u.platform_user_id, pu.token_version
         FROM users u JOIN businesses b ON b.id = u.business_id
         LEFT JOIN platform_users pu ON pu.id = u.platform_user_id AND pu.is_active
        WHERE u.id = $1 AND u.business_id = $2 AND u.is_active`,
      [userId, businessId],
    );
    const user = rows[0];
    if (!user) return null;
    const { session } = await createSession(user.id, businessId, {
      locationId: user.location_id,
      deviceLabel: request.headers.get("user-agent")?.slice(0, 120) ?? null,
    });
    return signSession({
      sub: user.id,
      role: user.role,
      businessId,
      businessSlug: user.business_slug,
      businessSubdomain: user.business_subdomain,
      locationId: user.location_id,
      fullName: user.full_name,
      platformUserId: user.platform_user_id && user.token_version !== null ? user.platform_user_id : null,
      ...(user.platform_user_id && user.token_version !== null ? { tokenVersion: user.token_version } : {}),
      employeeSessionId: session.id,
    });
  });
  // The member exists on the cloud but has not reached this desktop yet.
  if (!signed) return fail("not_synced");

  const response = relative("/dashboard");
  response.cookies.set(SESSION_COOKIE, signed, sessionCookieOptions());
  if (isLoginToken(redeemed.sessionCode)) {
    response.cookies.set(CLOUD_SESSION_CODE_COOKIE, redeemed.sessionCode, {
      httpOnly: true,
      sameSite: "lax",
      path: COOKIE_PATH,
      maxAge: LOGIN_CODE_TTL_SECONDS,
    });
  }
  return response;
}
