import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, getSession, sessionCookieOptions, signSession, withTenantScope } from "@/lib/auth";
import { withTenant, withoutTenantScope } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import { hostRoutingEnabled } from "@/lib/host";
import { endPendingRevocation, pendingRevocationFor } from "@/lib/logout-service";
import { membershipBlockedReason, membershipForBusiness } from "@/lib/memberships";

/**
 * Move the current session to another of this person's businesses.
 *
 * Re-issues the session cookie against the target membership, so the caller's
 * role, default branch and — through `getSession()` — the tenant scope every
 * subsequent query runs under all change together. No re-authentication is
 * needed: the person already proved who they are, and the membership lookup
 * below is what proves they belong to the business they asked for.
 *
 * A PIN-only member has no platform identity and so has nothing to switch to.
 *
 * **The session moves; it is not copied (#854 follow-up, third pass).** The
 * new cookie names a fresh `employee_sessions` row in the target business
 * (`login_method = 'business_switch'`), so it can be listed, ended from the
 * security center and signed out like any other session; it used to carry no
 * row at all, which left «خروج» nothing to end and a retained copy valid. The
 * row this browser leaves behind in the source business is ended in the same
 * request (audited `via: "business_switch"`) — the cookie that named it is
 * being replaced, so nothing legitimate can use it again. The switch is
 * all-or-nothing: if the old row cannot be ended, the new one is ended again,
 * the cookie is left as it was and the caller gets `503 switch_unconfirmed`
 * to retry — never two live sessions for one browser.
 *
 * **Being retired (Phase 23).** Once each business has its own origin this
 * endpoint is exactly the thing the wave removes: it mints, on business A's
 * host, a cookie valid for business B. Under `SUBDOMAIN_ROUTING=on` it refuses
 * — a person with several memberships signs in on each business's own host,
 * finding them through the apex directory. The handler stays for the one
 * release the path-prefix mode is still supported, and is deleted in Wave 4
 * along with the rewrite itself.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  if (hostRoutingEnabled()) {
    return NextResponse.json({ error: "cross_origin_switch_retired" }, { status: 410 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!session.platformUserId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { businessId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.businessId) {
    return NextResponse.json({ error: "missing_business" }, { status: 400 });
  }

  const membership = await withoutTenantScope("login", () =>
    membershipForBusiness(session.platformUserId as string, body.businessId as string),
  );

  // Not a member, or the membership is inactive — the same answer either way,
  // so this can't be used to probe which businesses exist.
  if (!membership) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const blocked = membershipBlockedReason(membership);
  if (blocked) {
    return NextResponse.json({ error: "business_unavailable", reason: blocked }, { status: 403 });
  }

  // The target business's row first: if it cannot be opened (a database or
  // audit failure throws), nothing has changed and the old cookie still works.
  const userAgent = request.headers.get("user-agent");
  const { session: opened } = await withTenant(membership.businessId, () =>
    createSession(membership.userId, membership.businessId, {
      locationId: membership.locationId,
      loginMethod: "business_switch",
      deviceLabel: userAgent?.slice(0, 120) ?? null,
      userAgent,
    }),
  );

  // Then the row being left behind. Only ever this browser's own session: the
  // id comes from the signed cookie and the revocation is restricted to its
  // own member.
  const leaving = pendingRevocationFor(session);
  if (leaving) {
    const ended = await endPendingRevocation(leaving, "business_switch", request.headers);
    if (ended === "failed") {
      const undone = await endPendingRevocation(
        {
          kind: "employee_session",
          sessionId: opened.id,
          businessId: membership.businessId,
          employeeId: membership.userId,
          expiresAt: Math.floor(new Date(opened.expiresAt).getTime() / 1000),
        },
        "business_switch",
        request.headers,
      );
      if (undone === "failed") {
        // No token naming it was ever issued, so the row is unusable; it is
        // still listed until it expires, and an owner can end it by hand.
        console.error("business switch could not end the session it had just opened");
      }
      return NextResponse.json({ error: "switch_unconfirmed" }, { status: 503 });
    }
  }

  const token = await signSession({
    sub: membership.userId,
    role: membership.role,
    businessId: membership.businessId,
    businessSlug: membership.businessSlug,
    businessSubdomain: membership.businessSubdomain,
    locationId: membership.locationId,
    fullName: membership.fullName,
    platformUserId: session.platformUserId,
    tokenVersion: session.tokenVersion,
    mfaVerified: session.mfaVerified,
    recentAuthAt: session.recentAuthAt,
    employeeSessionId: opened.id,
  });

  const res = NextResponse.json({
    user: { id: membership.userId, role: membership.role, fullName: membership.fullName },
    business: {
      id: membership.businessId,
      name: membership.businessName,
      slug: membership.businessSlug,
    },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
