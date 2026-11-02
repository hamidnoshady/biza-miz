import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { platformCan, type PlatformCapability } from "@/lib/platform-admin";
import { PLATFORM_MCP_TOOLS } from "@/lib/mcp/platform-mcp";
import { canonicalRedirectUri } from "@/lib/mcp/oauth";
import {
  PLATFORM_CONNECTION_DEFAULT_DAYS,
  PLATFORM_CONNECTION_MAX_DAYS,
  getPlatformMcpClient,
  issuePlatformAuthorizationCode,
  platformAccessDeniedRedirect,
} from "@/lib/mcp/platform-oauth";

/**
 * The console-side "allow" of the platform MCP OAuth flow — the platform twin
 * of `/api/connections/mcp/consent`.
 *
 * Session-authenticated (a platform-admin cookie, enforced by middleware and
 * again here) and owner-only (`admins.manage`, the same gate as minting a
 * pasted token): a console credential reaches across every business, so the
 * rule the tenant side applies to `mcp.manage` applies here with more force.
 * The admin picks the capabilities and optionally the businesses; whatever the
 * client asked for is irrelevant, and only capabilities the admin's CURRENT role
 * holds and the tool catalogue offers can be granted.
 */
const OFFERED_CAPABILITIES = [...new Set(PLATFORM_MCP_TOOLS.map((t) => t.capability))];

function grantableCapabilities(role: Parameters<typeof platformCan>[0]): PlatformCapability[] {
  return OFFERED_CAPABILITIES.filter((capability) => platformCan(role, capability));
}

/** Who is asking: the registered client's name and the host a code would be sent to. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error, session } = await requirePlatformAdmin();
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const client = await getPlatformMcpClient(params.get("client_id") ?? "");
  const redirectUri = client ? canonicalRedirectUri(params.get("redirect_uri") ?? "", client.redirectUris) : null;
  if (!client || !redirectUri) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  let redirectHost = "";
  try {
    redirectHost = new URL(redirectUri).host || new URL(redirectUri).protocol;
  } catch {
    redirectHost = "";
  }
  return NextResponse.json(
    {
      clientName: client.clientName,
      redirectHost,
      canManage: platformCan(session.role, "admins.manage" as PlatformCapability),
      grantable: grantableCapabilities(session.role),
      defaultExpiresInDays: PLATFORM_CONNECTION_DEFAULT_DAYS,
      maxExpiresInDays: PLATFORM_CONNECTION_MAX_DAYS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { error, session } = await requirePlatformAdmin();
  if (error) return error;
  if (!platformCan(session.role, "admins.manage" as PlatformCapability)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const str = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

  const clientId = str("clientId");
  const redirectUri = str("redirectUri");
  const state = typeof body.state === "string" ? body.state : null;

  // A refusal goes back to the client as `access_denied`, so a connector that
  // is waiting for the admin stops waiting.
  if (body.deny === true) {
    const client = await getPlatformMcpClient(clientId);
    const target = client ? canonicalRedirectUri(redirectUri, client.redirectUris) : null;
    if (!target) return NextResponse.json({ error: "invalid_client" }, { status: 400 });
    return NextResponse.json({ redirectTo: platformAccessDeniedRedirect(target, state) });
  }

  const allowed = new Set<string>(grantableCapabilities(session.role));
  const capabilities = Array.isArray(body.capabilities)
    ? [...new Set(body.capabilities.filter((c): c is string => typeof c === "string" && allowed.has(c)))]
    : [];
  if (capabilities.length === 0) {
    return NextResponse.json({ error: "invalid_capabilities" }, { status: 400 });
  }

  let businessIds: string[] | null = null;
  if (Array.isArray(body.businessIds) && body.businessIds.length > 0) {
    businessIds = body.businessIds.filter((x): x is string => typeof x === "string");
  }

  const days =
    typeof body.expiresInDays === "number" && Number.isFinite(body.expiresInDays)
      ? Math.min(Math.max(Math.floor(body.expiresInDays), 1), PLATFORM_CONNECTION_MAX_DAYS)
      : PLATFORM_CONNECTION_DEFAULT_DAYS;

  const result = await issuePlatformAuthorizationCode({
    clientId,
    redirectUri,
    codeChallenge: str("codeChallenge"),
    state,
    adminId: session.padmin,
    connectionName: str("connectionName"),
    capabilities,
    businessIds,
    expiresInDays: days,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_mcp.oauth_consent",
    entity: "platform_mcp_oauth_client",
    entityId: clientId,
    payload: { name: str("connectionName"), capabilities, businessIds, expiresInDays: days },
  });

  return NextResponse.json({ redirectTo: result.redirectTo }, { headers: { "Cache-Control": "no-store" } });
});
