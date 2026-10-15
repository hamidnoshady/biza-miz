import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { formatMcpScopeString } from "@/lib/mcp/scopes";
import { exchangeAuthorizationCode, refreshMcpToken } from "@/lib/mcp/oauth-service";
import { mcpTenantErrorDescription, resolveMcpTenant } from "@/lib/mcp/origin";

/**
 * The OAuth token endpoint: code → tokens, and refresh → fresh tokens.
 *
 * Session-less by definition, and it makes no policy decisions: everything the
 * grant is allowed to become — which scopes, which branch, whose authority,
 * apply-or-approve — was decided by the owner at the consent screen and stored
 * on the authorization code. All this endpoint decides is whether the code is
 * real, unused, unexpired, presented by the client it was issued to, and backed
 * by the right PKCE verifier.
 *
 * Accepts both `application/x-www-form-urlencoded` (what RFC 6749 specifies and
 * most clients send) and JSON, because several MCP clients send JSON and a 400
 * here is a connector that never finishes adding.
 */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

function cors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function oauthError(error: string, description: string, status = 400): NextResponse {
  return cors(NextResponse.json({ error, error_description: description }, { status }));
}

async function readParams(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]),
      );
    } catch {
      return {};
    }
  }
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(request: NextRequest) {
  const tenant = await resolveMcpTenant(request.headers);
  if (!tenant.ok) return oauthError("invalid_request", mcpTenantErrorDescription(tenant.reason));

  const businessId = tenant.business.businessId;
  const params = await readParams(request);
  const grantType = params.grant_type ?? "";

  const result = await withTenant(businessId, async () => {
    if (grantType === "authorization_code") {
      return exchangeAuthorizationCode({
        businessId,
        code: params.code ?? "",
        codeVerifier: params.code_verifier ?? "",
        redirectUri: params.redirect_uri ?? "",
        clientId: params.client_id ?? "",
      });
    }
    if (grantType === "refresh_token") {
      return refreshMcpToken({ businessId, refreshToken: params.refresh_token ?? "" });
    }
    return null;
  });

  if (!result) {
    return oauthError(
      "unsupported_grant_type",
      "only authorization_code and refresh_token are supported",
    );
  }
  if (!result.ok) return oauthError(result.error, result.description);

  return cors(
    NextResponse.json({
      access_token: result.tokens.accessToken,
      token_type: "Bearer",
      expires_in: result.tokens.expiresInSeconds,
      refresh_token: result.tokens.refreshToken,
      // Echoed because it may be narrower than what was asked for: the owner's
      // consent decides, and this is how the client learns what it actually got.
      scope: formatMcpScopeString(result.tokens.scopes),
    }),
  );
}
