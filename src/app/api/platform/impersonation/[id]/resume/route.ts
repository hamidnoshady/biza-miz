import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { businessHost, hostRoutingEnabled, preferredProto, rootDomain } from "@/lib/host";
import { getBusiness, resumeImpersonation } from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Resume my own open support session.
 *
 * The console's «ادامه نشست فعلی» used to open the *create* dialog: there was
 * no endpoint that re-entered an existing grant, so the operator either got a
 * confusing new-session form or a 409. This mints a fresh short-lived handoff
 * into the *same* grant, which is what makes resume real without making it
 * stronger — the grant's expiry, mode and capability are unchanged, and
 * `resumeImpersonation` authorizes with the same `activeGrant` re-check every
 * impersonated request already performs, so a colleague's session can never be
 * resumed as one's own.
 *
 * Entering a business needs the capability for the grant's *mode*
 * (`impersonate.readOnly` upward); `impersonate.revoke` is for ending someone
 * else's session and is deliberately not a way in.
 */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { id: grantId } = await ctx.params;

  let body: { businessId?: string } = {};
  try {
    body = (await request.json()) as { businessId?: string };
  } catch {
    body = {};
  }
  const businessId = typeof body.businessId === "string" ? body.businessId : "";
  if (!businessId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const { session, error } = await requirePlatformCapability("impersonate.readOnly");
  if (error) return error;

  const result = await resumeImpersonation({
    grantId,
    adminId: session.padmin,
    businessId,
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  if (!result.ok) {
    // Also the answer when the grant belongs to another operator: ownership is
    // part of the same live check, so "not yours" and "not live" are one reply
    // with nothing to distinguish them by.
    return NextResponse.json({ error: "support_session_not_active" }, { status: 409 });
  }

  // Same two deployment shapes as entering a business (see the impersonate
  // route): host-routed installs hand off to the business's own origin, a
  // single-host install mints the tenant cookie right here.
  const business = await getBusiness(businessId);
  if (hostRoutingEnabled() && business?.subdomain) {
    const proto = preferredProto(
      request.headers.get("x-forwarded-proto"),
      request.nextUrl.protocol,
    );
    const host = businessHost(business.subdomain, rootDomain());
    return NextResponse.json({
      grant: { id: result.grant.id, mode: result.grant.mode, expiresAt: result.grant.expiresAt },
      handoffUrl: `${proto}://${host}/api/auth/impersonate-handoff?token=${encodeURIComponent(result.handoff.token)}`,
    });
  }

  const token = await signSession({
    sub: result.userId,
    role: "owner",
    businessId,
    businessSlug: business?.slug,
    businessSubdomain: business?.subdomain,
    locationId: null,
    fullName: result.fullName,
    imp: {
      grantId: result.grant.id,
      adminId: session.padmin,
      mode: result.grant.mode,
      allowedCapabilities: result.grant.allowedCapabilities,
    },
  });

  const res = NextResponse.json({
    grant: { id: result.grant.id, mode: result.grant.mode, expiresAt: result.grant.expiresAt },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
