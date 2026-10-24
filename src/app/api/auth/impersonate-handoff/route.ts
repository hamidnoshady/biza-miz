import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { hostRoutingEnabled, parseHost, requestHost, rootDomain } from "@/lib/host";
import {
  handoffOriginContext,
  resolveHandoffOrigin,
  withHandoffHeaders,
} from "@/lib/public-origin";
import { redeemImpersonationHandoff } from "@/lib/platform-service";

const ERROR_STATUS: Record<string, number> = {
  invalid: 400,
  expired: 400,
  used: 409,
  grant_inactive: 409,
};

/**
 * Phase 23 follow-up — the business-origin half of entering a business.
 *
 * The console's impersonate route (admin.{root}) writes the grant and hands the
 * browser a one-time URL here; the browser lands on the business's own origin
 * and presents the token, which is what mints the tenant session on the host
 * where the host-scoped cookie actually belongs.
 *
 * Session-less by necessity: the visitor has no session on this origin yet —
 * the whole point of the token is to mint the first one. The token is the
 * credential, exactly like /api/auth/accept-invite's, and like that one it is
 * short-lived and single-use (enforced by a row lock in
 * `redeemImpersonationHandoff`, never trusted from the URL alone).
 *
 * Sibling audit for issue #1062: the company-handoff defect (redirect built
 * from an internal request origin / an unvalidated `X-Forwarded-Host`) is the
 * same construction this route had. The destination now comes from
 * `resolveHandoffOrigin`, the shared browser-reachable canonical origin
 * policy, and is resolved BEFORE the one-time token is redeemed. This is a
 * redirect-construction fix only — the impersonation grant model, its
 * capability checks and its revocation semantics are untouched and stay a
 * different permission model from the company handoff's real membership.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return withHandoffHeaders(NextResponse.json({ error: "missing_token" }, { status: 400 }));
  }

  const parsedHost = hostRoutingEnabled() ? parseHost(requestHost(request.headers), rootDomain()) : null;
  if (parsedHost && parsedHost.kind !== "business") {
    return withHandoffHeaders(NextResponse.json({ error: "wrong_origin" }, { status: 400 }));
  }

  // No redeem until the destination origin is proven browser-reachable; a
  // spoofed or misconfigured request must not spend the one-time credential.
  const origin = resolveHandoffOrigin(
    handoffOriginContext(request, parsedHost ? parsedHost.label : null),
  );
  if (!origin.ok) {
    return withHandoffHeaders(
      NextResponse.json({ error: "origin_unreachable", reason: origin.code }, { status: 400 }),
    );
  }

  const result = await redeemImpersonationHandoff(
    token,
    parsedHost?.kind === "business" ? parsedHost.label : undefined,
  );
  if (!result.ok) {
    return withHandoffHeaders(
      NextResponse.json(
        { error: result.error },
        { status: ERROR_STATUS[result.error] ?? 400 },
      ),
    );
  }

  // The minted cookie is host-scoped, so it is only usable on the origin that
  // serves this business. Redeeming anywhere else (the console, the apex, a
  // neighbour business) would mint a cookie middleware bounces on the very next
  // navigation — refuse here instead, so a misdelivered or replayed token fails
  // at the point of use rather than somewhere confusing.
  if (hostRoutingEnabled()) {
    if (parsedHost?.kind !== "business" || parsedHost.label !== result.businessSubdomain) {
      return withHandoffHeaders(NextResponse.json({ error: "wrong_origin" }, { status: 400 }));
    }
  }

  const sessionToken = await signSession({
    sub: result.userId,
    role: "owner",
    businessId: result.businessId,
    businessSlug: result.businessSlug,
    businessSubdomain: result.businessSubdomain,
    locationId: null,
    fullName: result.fullName,
    imp: { grantId: result.grantId, adminId: result.adminId, mode: result.mode, allowedCapabilities: result.allowedCapabilities },
  });

  // Built from the validated origin above — not `x-forwarded-host`, which a
  // direct caller could spoof into an open redirect, and not `request.url`,
  // which is the container's internal origin behind a proxy (#1062). The
  // cookie is scoped to exactly this origin, so the redirect cannot drift off
  // it. `no-store`/`no-referrer` keep the token-bearing URL out of caches and
  // out of the next request's Referer.
  const res = NextResponse.redirect(`${origin.origin}/dashboard`);
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
  return withHandoffHeaders(res);
}
