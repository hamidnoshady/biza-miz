import { NextRequest, NextResponse } from "next/server";
import { exchangePlatformAuthorizationCode, refreshPlatformMcpToken, PLATFORM_MCP_OAUTH_SCOPE } from "@/lib/mcp/platform-oauth";
import {
  platformOauthCors,
  platformOauthError,
  platformOauthPreflight,
  readPlatformOauthParams,
} from "@/lib/mcp/platform-oauth-http";

/**
 * The console realm's OAuth token endpoint: code → tokens, and refresh → fresh
 * tokens. It decides nothing about authority: the capabilities and business
 * scope were chosen by the admin at the consent screen and stored on the code.
 * It only checks the code is real, unused, unexpired, presented by the client
 * it was issued to, and backed by the right PKCE verifier.
 */
export async function OPTIONS() {
  return platformOauthPreflight();
}

export async function POST(request: NextRequest) {
  const params = await readPlatformOauthParams(request);
  const grantType = params.grant_type ?? "";

  let result;
  if (grantType === "authorization_code") {
    result = await exchangePlatformAuthorizationCode({
      code: params.code ?? "",
      codeVerifier: params.code_verifier ?? "",
      redirectUri: params.redirect_uri ?? "",
      clientId: params.client_id ?? "",
    });
  } else if (grantType === "refresh_token") {
    result = await refreshPlatformMcpToken({ refreshToken: params.refresh_token ?? "" });
  } else {
    return platformOauthError("unsupported_grant_type", "only authorization_code and refresh_token are supported");
  }
  if (!result.ok) return platformOauthError(result.error, result.description);

  return platformOauthCors(
    NextResponse.json({
      access_token: result.tokens.accessToken,
      token_type: "Bearer",
      expires_in: result.tokens.expiresInSeconds,
      refresh_token: result.tokens.refreshToken,
      scope: PLATFORM_MCP_OAUTH_SCOPE,
    }),
  );
}
