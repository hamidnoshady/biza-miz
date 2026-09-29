import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { CONTROLLED_SESSION_CAPABILITIES } from "@/lib/platform-admin";
import { clientIpFrom } from "@/lib/rate-limit";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { businessHost, hostRoutingEnabled, preferredProto, rootDomain } from "@/lib/host";
import {
  startImpersonation,
  getBusiness,
  BusinessNotImpersonableError,
  SupportSessionConflictError,
  type ImpersonationMode,
} from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Enter a business as its owner — support access / impersonation.
 *
 * The order of operations is the whole security story, and it is enforced here
 * and in the service layer together:
 *
 *   1. `startImpersonation` writes the grant row FIRST, inside a transaction,
 *      so a tenant session can never be minted without a durable record naming
 *      the admin, the business, the mode and the window (exit criterion 3).
 *   2. Only then is a tenant `pos_session` minted — carrying the `imp` claim
 *      that marks it as an operator's borrowed seat, not a real login. The
 *      cookie is the normal tenant cookie so the whole app "just works", but
 *      the claim lets the middleware enforce read-only and lets every write be
 *      attributed to the admin.
 *
 *      **Where** it is minted depends on the deployment. On a host-routed
 *      install (ROOT_DOMAIN set) the tenant cookie is host-scoped and can only
 *      be sent back to the host that set it, so minting it here — on
 *      admin.{root} — would trap the session inside the console's origin. The
 *      response instead carries a short-lived, single-use handoff URL on the
 *      business's own origin, which the browser follows to redeem the session
 *      there (/api/auth/impersonate-handoff). A single-host install has no
 *      business origin to hand off to, so it keeps the cookie-on-this-host
 *      flow.
 *   3. We audit the entry.
 *
 * `read_only` needs `impersonate.readOnly` (support and up); `full` needs
 * `impersonate.full` (owner only) — full access can change a customer's data,
 * so it is the most trusted capability short of hard-delete.
 */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;

  let body: { mode?: ImpersonationMode; reason?: string; minutes?: number; ticketId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const mode: ImpersonationMode = body.mode === "full" ? "full" : body.mode === "controlled" ? "controlled" : "read_only";
  const capability = mode === "full" ? "impersonate.full" : mode === "controlled" ? "impersonate.controlled" : "impersonate.readOnly";
  const { session, error } = await requirePlatformCapability(capability);
  if (error) return error;
  if (mode === "full") {
    const authenticatedAt = (session.iat ?? 0) * 1000;
    if (!authenticatedAt || Date.now() - authenticatedAt > 15 * 60_000) {
      return NextResponse.json({ error: "recent_auth_required" }, { status: 403 });
    }
    if (!session.mfaVerified) return NextResponse.json({ error: "mfa_required" }, { status: 403 });
  }

  try {
    const { grant, userId, fullName, handoff } = await startImpersonation({
      adminId: session.padmin,
      businessId: id,
      mode,
      reason: body.reason,
      minutes: body.minutes,
      ticketId: body.ticketId,
      // One list, in platform-admin.ts beside the rest of the capability
      // policy — it used to be inline here while a dead near-copy sat unused in
      // that file (issue #755 §20).
      allowedCapabilities: mode === "controlled" ? [...CONTROLLED_SESSION_CAPABILITIES] : [],
      ipAddress: clientIpFrom(request.headers, 0),
      userAgent: request.headers.get("user-agent"),
    });

    // The business was just confirmed to exist by startImpersonation, so this
    // second read is only for its slug and subdomain.
    const business = await getBusiness(id);

    // Host-routed: hand the browser the one-time handoff URL on the business's
    // own origin instead of a cookie that could never leave this (the admin)
    // host. The token is minted inside startImpersonation's transaction, so it
    // can never outlive its grant.
    if (hostRoutingEnabled() && business?.subdomain) {
      const proto = preferredProto(
        request.headers.get("x-forwarded-proto"),
        request.nextUrl.protocol,
      );
      const host = businessHost(business.subdomain, rootDomain());
      return NextResponse.json({
        grant: { id: grant.id, mode: grant.mode, expiresAt: grant.expiresAt },
        handoffUrl: `${proto}://${host}/api/auth/impersonate-handoff?token=${encodeURIComponent(handoff.token)}`,
      });
    }

    // Single-host install: mint the tenant session right here, as before.
    // locationId null: an owner roams every branch, and so does the operator
    // standing in for them.
    const token = await signSession({
      sub: userId,
      role: "owner",
      businessId: id,
      businessSlug: business?.slug,
      businessSubdomain: business?.subdomain,
      locationId: null,
      fullName,
      imp: { grantId: grant.id, adminId: session.padmin, mode, allowedCapabilities: grant.allowedCapabilities },
    });

    const res = NextResponse.json({
      grant: { id: grant.id, mode: grant.mode, expiresAt: grant.expiresAt },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    if (err instanceof SupportSessionConflictError) {
      return NextResponse.json({ error: err.message, code: "ACTIVE_SUPPORT_SESSION_EXISTS", sessionId: err.grant.id, expiresAt: err.grant.expiresAt }, { status: 409 });
    }
    if (err instanceof BusinessNotImpersonableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
