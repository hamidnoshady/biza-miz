import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { buildRedirect } from "@/lib/mcp/oauth";
import { validateAuthorizationRequest } from "@/lib/mcp/oauth-service";
import { mcpTenantErrorDescription, resolveMcpTenant } from "@/lib/mcp/origin";

/**
 * The OAuth authorization endpoint.
 *
 * It authorizes nothing itself. It validates the request and then hands the
 * browser to `/mcp/consent`, which is an ordinary authenticated dashboard page —
 * so the owner signs in with the account they already have, on the origin they
 * already trust, and the "which scopes, which branch, apply or approve" decision
 * is made by a human looking at a screen rather than inferred from a query
 * string.
 *
 * The validation order is the security property here. `client_id` and
 * `redirect_uri` are checked *first*, and only once both are known-registered
 * does any other failure get redirected back to the client. The other way round,
 * this endpoint is an open redirect: anyone could hand it an arbitrary
 * `redirect_uri` plus a deliberately broken `response_type` and have this server
 * bounce a victim wherever they liked.
 */
export async function GET(request: NextRequest) {
  const tenant = await resolveMcpTenant(request.headers);
  if (!tenant.ok) {
    return NextResponse.json(
      { error: "invalid_request", error_description: mcpTenantErrorDescription(tenant.reason) },
      { status: 400 },
    );
  }

  const businessId = tenant.business.businessId;
  const params = request.nextUrl.searchParams;
  const result = await withTenant(businessId, () => validateAuthorizationRequest(businessId, params));

  if (!result.ok && result.kind === "display") {
    // Deliberately not a redirect: an unregistered client or an unregistered
    // redirect URI is exactly the case where redirecting hands a code to
    // whoever asked.
    return NextResponse.json(
      { error: result.error, error_description: result.description },
      { status: 400 },
    );
  }
  if (!result.ok) {
    return NextResponse.redirect(
      buildRedirect(result.redirectUri, {
        error: result.error,
        error_description: result.description,
        state: result.state,
      }),
    );
  }

  // Carried through the URL rather than stashed server-side: the consent POST
  // re-validates every one of these against the registered client before it
  // mints anything, so a tampered value can only produce a refusal — and a
  // pending-request row would be a table to expire and sweep for no gain.
  const params_out = new URLSearchParams({
    client_id: result.request.clientId,
    redirect_uri: result.request.redirectUri,
    code_challenge: result.request.codeChallenge,
  });
  if (result.request.state !== null) params_out.set("state", result.request.state);
  if (result.request.scopes.length > 0) {
    params_out.set("scope", result.request.scopes.join(" "));
  }

  // A RELATIVE Location, deliberately — not NextResponse.redirect, which
  // demands an absolute URL and would have to reconstruct this origin from
  // somewhere. `request.url` inside a route handler is the *container's*
  // origin (http://localhost:3000 behind a proxy), so redirecting there sends
  // the browser to a port nothing is listening on — the identical trap
  // /api/host/redirect documents. Rebuilding it from `x-forwarded-host`
  // instead would make a client-supplied header decide where an authorization
  // request goes, which is an open redirect with extra steps. A relative
  // reference (RFC 7231 §7.1.2) is resolved by the browser against the URL it
  // actually asked for, so it lands on the host the owner is signed in at —
  // which is the host that names the tenant.
  return new NextResponse(null, {
    status: 307,
    headers: { location: `/mcp/consent?${params_out.toString()}` },
  });
}
