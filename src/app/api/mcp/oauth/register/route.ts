import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { registerMcpClient } from "@/lib/mcp/oauth-service";
import { mcpFeatureEnabled } from "@/lib/mcp/auth";
import { mcpTenantErrorDescription, resolveMcpTenant } from "@/lib/mcp/origin";

/**
 * RFC 7591 — dynamic client registration.
 *
 * Unauthenticated, as the spec intends and as every MCP client requires: this is
 * the first call a client makes, before any owner has been asked anything. What
 * it produces is a `client_id` and nothing else — no secret, no grant, no access
 * to a single row. A registration becomes capable of reading a business's data
 * only after a signed-in owner walks the consent screen and a code is exchanged.
 *
 * The tenant comes from the host, never from the body (Phase 23's rule for
 * anything that resolves a business before a session exists). Registering at
 * `biz1.example.com` registers with biz1 and can never be used at biz2.
 */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

function cors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(request: NextRequest) {
  const tenant = await resolveMcpTenant(request.headers);
  if (!tenant.ok) {
    return cors(
      NextResponse.json(
        { error: "invalid_client_metadata", error_description: mcpTenantErrorDescription(tenant.reason) },
        { status: 400 },
      ),
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return cors(
      NextResponse.json({ error: "invalid_client_metadata", error_description: "invalid JSON body" }, { status: 400 }),
    );
  }

  const businessId = tenant.business.businessId;
  const result = await withTenant(businessId, async () => {
    if (!(await mcpFeatureEnabled(businessId))) return null;
    return registerMcpClient(businessId, {
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      clientUri: body.client_uri,
      softwareId: body.software_id,
    });
  });

  if (!result) {
    return cors(
      NextResponse.json(
        { error: "invalid_client_metadata", error_description: "this business has no MCP entitlement" },
        { status: 403 },
      ),
    );
  }
  if (!result.ok) {
    return cors(
      NextResponse.json({ error: result.error, error_description: result.description }, { status: 400 }),
    );
  }

  return cors(
    NextResponse.json(
      {
        client_id: result.client.clientId,
        client_id_issued_at: Math.floor(new Date(result.client.createdAt).getTime() / 1000),
        client_name: result.client.clientName,
        redirect_uris: result.client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public client: PKCE is the authentication, so there is no secret to
        // issue and none to leak.
        token_endpoint_auth_method: "none",
      },
      { status: 201 },
    ),
  );
}
