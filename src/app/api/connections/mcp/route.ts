import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listBranches } from "@/lib/branch-service";
import { originFromHeaders } from "@/lib/desktop-link-service";
import { ALL_MCP_SCOPES } from "@/lib/mcp/scopes";
import {
  createStaticMcpConnection,
  listMcpConnections,
  listMcpPendingActions,
} from "@/lib/mcp/connections-service";

/**
 * Owner-only management of this business's MCP connections — the credential
 * `/api/mcp` authenticates.
 *
 * Owner-only, not `settings.manage`, for the same reason the API-keys route is:
 * this hands a program continuous access to a whole branch's orders, stock,
 * customers and ledger, and (with `pos.write`) the ability to change them.
 *
 * Gated on `api_platform` explicitly rather than through `featureForApiPath`,
 * because that map keys off the request path and this route sits under
 * `/api/connections`, which must stay ungated — the desktop-pairing panel beside
 * it is not something a business buys. The MCP surface itself re-checks the same
 * flag inside `withMcpScope`, so losing the entitlement stops both minting new
 * connections and using existing ones.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error, membership } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;

  const enabled = await isFeatureEnabled(session.businessId, "api_platform");
  const [connections, pending, branches, currentLocation] = enabled
    ? await Promise.all([
        listMcpConnections(session.businessId),
        listMcpPendingActions(session.businessId),
        listBranches(session.businessId),
        resolveActiveLocation(session),
      ])
    : [[], [], [], null];

  return NextResponse.json({
    enabled,
    connections,
    pending,
    scopes: ALL_MCP_SCOPES,
    // Issue #883 §1 — the branch vocabulary the grants editor shows (names
    // only), so the safe default can pin the current branch and the owner can
    // widen deliberately.
    branches: branches.filter((b) => b.isActive).map((b) => ({ id: b.id, name: b.name })),
    currentBranchId: currentLocation?.id ?? null,
    // Issue #883 P0-4 — minting, narrowing, revoking, consenting and approving
    // are owner-only. The panel renders read-only without this flag rather
    // than surfacing the refusal one click too late.
    canManage: membership.permissions.has(PERMISSIONS.mcpManage),
    // The address a client must be pointed at is *this request's own origin* —
    // the same "ask the host" rule Phase 23 states for login and Phase 28 for
    // desktop pairing. Deriving it from PLATFORM_BASE_URL would hand a
    // multi-tenant deployment's apex to a connector that needs biz1's host.
    endpoint: `${originFromHeaders(request.headers)}/api/mcp`,
  });
});

interface CreateBody {
  name?: string;
  scopes?: unknown;
  writeMode?: unknown;
  expiresInDays?: number | null;
  /** Issue #883 §1 — explicit app/branch grants. The panel always builds it;
   * a direct API caller must send it too (no schema-free empty document). */
  grants?: unknown;
}

/**
 * Mint a static-token connection, for clients that authenticate with a header
 * from a config file (Codex, an IDE, a script) rather than by walking OAuth.
 * The token is in this response body and nowhere else, ever again.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  // Owner-only (issue #883 P0-4): a static MCP token is a machine credential
  // with continuous — potentially write — reach, so it joins api.manage's rule
  // rather than the delegatable integrations.manage the route previously used.
  const { session, error } = await requirePermission(PERMISSIONS.mcpManage);
  if (error) return error;

  if (!(await isFeatureEnabled(session.businessId, "api_platform"))) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 403 });
  }

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // A connection names exactly one branch. The caller's active branch is it —
  // already validated against their assignment by resolveActiveLocation — so
  // this can never mint access to a branch the owner is not scoped to.
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await createStaticMcpConnection(session.businessId, session.sub, {
    name: body.name ?? "",
    locationId: location.id,
    scopes: body.scopes,
    writeMode: body.writeMode,
    expiresInDays: body.expiresInDays ?? null,
    grants: body.grants,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const response = NextResponse.json(
    { connection: result.connection, token: result.token },
    { status: 201 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});
