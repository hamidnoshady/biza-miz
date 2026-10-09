import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getMcpClient, issueAuthorizationCode, validateAuthorizationRequest } from "@/lib/mcp/oauth-service";
import { parseMcpScopes, isMcpWriteMode } from "@/lib/mcp/scopes";

/**
 * The owner's "allow" on the consent screen.
 *
 * This is the *only* place in the OAuth flow where a decision is made, and it is
 * the only one that requires a tenant session — which is the point of splitting
 * it out from `/api/mcp/oauth/*` (all public by necessity) and putting it under
 * `/api/connections`, where middleware already demands a session and this handler
 * demands the Owner role.
 *
 * Everything the query string carries is re-validated here against the
 * registered client before anything is minted, so a tampered `redirect_uri` or
 * `code_challenge` on the consent URL can only produce a refusal.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;

  if (!(await isFeatureEnabled(session.businessId, "api_platform"))) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 403 });
  }

  const clientId = request.nextUrl.searchParams.get("client_id") ?? "";
  const client = await getMcpClient(session.businessId, clientId);
  if (!client) return NextResponse.json({ error: "invalid_client" }, { status: 404 });

  const location = await resolveActiveLocation(session);
  return NextResponse.json({
    client: { clientId: client.clientId, clientName: client.clientName },
    branch: location ? { id: location.id, name: location.name } : null,
    requestedScopes: parseMcpScopes(
      (request.nextUrl.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
    ),
  });
});

interface ConsentBody {
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  state?: string | null;
  requestedScopes?: unknown;
  approvedScopes?: unknown;
  writeMode?: unknown;
  connectionName?: string;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.mcpManage);
  if (error) return error;

  if (!(await isFeatureEnabled(session.businessId, "api_platform"))) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 403 });
  }

  let body: ConsentBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Re-run the full authorization-request validation from the values the page
  // is echoing back, rather than trusting that /authorize already passed them:
  // the browser has held them in a URL in between.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: body.clientId ?? "",
    redirect_uri: body.redirectUri ?? "",
    code_challenge: body.codeChallenge ?? "",
    code_challenge_method: "S256",
  });
  const validation = await validateAuthorizationRequest(session.businessId, params);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "error" in validation ? validation.error : "invalid_request" },
      { status: 400 },
    );
  }

  const writeMode = body.writeMode ?? "approve";
  if (!isMcpWriteMode(writeMode)) {
    return NextResponse.json({ error: "invalid_write_mode" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await issueAuthorizationCode({
    businessId: session.businessId,
    clientId: validation.request.clientId,
    redirectUri: validation.request.redirectUri,
    codeChallenge: validation.request.codeChallenge,
    state: body.state ?? null,
    requestedScopes: parseMcpScopes(body.requestedScopes),
    approvedScopes: parseMcpScopes(body.approvedScopes),
    writeMode,
    locationId: location.id,
    // Every write this connection ever makes runs under this owner's authority.
    userId: session.sub,
    connectionName: body.connectionName ?? validation.client.clientName,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const response = NextResponse.json({ redirectTo: result.redirectTo });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
