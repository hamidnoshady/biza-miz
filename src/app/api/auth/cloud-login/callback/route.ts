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
import { cloudLoginIdentityReadiness, type IdentityReadiness } from "@/lib/iam/identity-readiness";
import { syncHybridLoginCredentials } from "@/lib/iam/login-credential-sync";

const COOKIE_PATH = "/api/auth/cloud-login";

/**
 * Phase 46, on the desktop: Electron loads this with the code and state the
 * cloud handed back through businesssuite://. The state must match this
 * window's cookie (a link nobody here asked for signs nobody in); the code is
 * redeemed server-to-server with the install's own credential.
 *
 * The local session is then minted **only** once identity convergence is
 * proven. A membership can be replicated while its login credentials have not
 * arrived (the IAM snapshot is metadata-only), and signing that member in
 * without `platformUserId`/`tokenVersion` would put the session outside the
 * cloud's token-version revocation chain — a cloud password change could not
 * end it. So when the cloud reports a global identity, this route requires the
 * local replica to be bound to it, reconciling credentials once and otherwise
 * failing closed with `identity_not_synced` (an actionable, retryable state).
 * PIN-only memberships legitimately have no cloud identity and keep working.
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

  let redeemed: { userId?: unknown; sessionCode?: unknown; platformUserId?: unknown; tokenVersion?: unknown };
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
  // Older clouds do not report the expected identity; `undefined` keeps the
  // legacy behaviour (bind when local data allows, otherwise sign in).
  const expectedPlatformUserId =
    typeof redeemed.platformUserId === "string" ? redeemed.platformUserId : null;

  const businessId = context.businessId;

  const readLocal = () => withTenant(businessId, async () => {
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
    const row = rows[0];
    if (!row) return null;
    return {
      row,
      readiness: cloudLoginIdentityReadiness({
        expectedPlatformUserId,
        local: { platformUserId: row.platform_user_id, tokenVersion: row.token_version },
      }),
    };
  });

  let local = await readLocal();
  if (!local) return fail("not_synced");
  if (!local.readiness.ok) {
    // Membership-only convergence. Reconcile the credential plane once (this
    // is the same call the sync tick and the repair action use) and re-check;
    // only then, if the expected global identity is still missing, refuse the
    // hand-back instead of minting an unbound session.
    if (local.readiness.issue === "identity_binding_missing" || local.readiness.issue === "identity_binding_mismatch") {
      await syncHybridLoginCredentials(businessId).catch(() => null);
      local = await readLocal();
      if (!local) return fail("not_synced");
    }
    if (!local.readiness.ok) return fail("identity_not_synced");
  }
  const readiness = local.readiness as Extract<IdentityReadiness, { ok: true }>;
  const resolved = local;

  const signed = await withTenant(businessId, async () => {
    const user = resolved.row;
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
      platformUserId: readiness.platformUserId,
      ...(readiness.platformUserId && readiness.tokenVersion !== null ? { tokenVersion: readiness.tokenVersion } : {}),
      employeeSessionId: session.id,
    });
  });

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
