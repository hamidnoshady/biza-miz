import { NextRequest, NextResponse } from "next/server";
import { buildRedirect } from "@/lib/mcp/oauth";
import { validatePlatformAuthorizationRequest } from "@/lib/mcp/platform-oauth";

/**
 * The console realm's OAuth authorization endpoint.
 *
 * It authorizes nothing itself. It validates the request and hands the browser
 * to the console's consent page, where a signed-in owner admin decides which
 * capabilities and which businesses the client may have. As in the tenant
 * realm, `client_id` and `redirect_uri` are checked FIRST and only once both
 * are known-registered does any other failure become a redirect — the other
 * order makes this an open redirect.
 */
export async function GET(request: NextRequest) {
  const result = await validatePlatformAuthorizationRequest(request.nextUrl.searchParams);

  if (!result.ok && result.kind === "display") {
    return NextResponse.json({ error: result.error, error_description: result.description }, { status: 400 });
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

  const out = new URLSearchParams({
    client_id: result.request.clientId,
    redirect_uri: result.request.redirectUri,
    code_challenge: result.request.codeChallenge,
  });
  if (result.request.state !== null) out.set("state", result.request.state);

  // A RELATIVE Location on purpose (see the tenant authorize route): inside a
  // route handler `request.url` is the container's origin, and rebuilding it
  // from a forwarded header would let a client-supplied value choose where an
  // authorization request goes. The browser resolves it against the host it
  // actually asked — which is the console's own origin.
  return new NextResponse(null, {
    status: 307,
    headers: { location: `/platform/mcp-connections/consent?${out.toString()}` },
  });
}
