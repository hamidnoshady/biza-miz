import { NextRequest, NextResponse } from "next/server";
import { registerPlatformMcpClient } from "@/lib/mcp/platform-oauth";
import { platformOauthCors, platformOauthError, platformOauthPreflight } from "@/lib/mcp/platform-oauth-http";
import { platformRealmUnavailable } from "@/lib/platform-runtime-guard";

/**
 * RFC 7591 — dynamic client registration for the console's MCP endpoint.
 *
 * Unauthenticated, as the spec intends and every MCP client requires: it is the
 * first call a client makes, before any admin has been asked anything. What it
 * produces is a `client_id` and nothing else — no secret, no grant, no access.
 * A registration can reach console data only after a signed-in owner admin
 * walks the consent screen and a code is exchanged.
 */
export async function OPTIONS() {
  return platformOauthPreflight();
}

export async function POST(request: NextRequest) {
  // Issue #1194 — the Central realm does not exist on a site runtime. Deny
  // before reading any credential, so a local install cannot even begin a
  // platform sign-in or MCP grant.
  const realmUnavailable = platformRealmUnavailable();
  if (realmUnavailable) return realmUnavailable;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return platformOauthError("invalid_client_metadata", "invalid JSON body");
  }

  const result = await registerPlatformMcpClient({
    clientName: body.client_name,
    redirectUris: body.redirect_uris,
    clientUri: body.client_uri,
    softwareId: body.software_id,
  });
  if (!result.ok) return platformOauthError(result.error, result.description);

  return platformOauthCors(
    NextResponse.json(
      {
        client_id: result.client.clientId,
        client_id_issued_at: Math.floor(new Date(result.client.createdAt).getTime() / 1000),
        client_name: result.client.clientName,
        redirect_uris: result.client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public client: PKCE is the authentication, so there is no secret to issue.
        token_endpoint_auth_method: "none",
      },
      { status: 201 },
    ),
  );
}
