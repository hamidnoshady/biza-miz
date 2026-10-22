import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ALL_API_SCOPES } from "@/lib/api-scopes";
import { createApiKeyForBusiness, listApiKeys } from "@/lib/api-keys-service";

/**
 * Owner-only management of the business's public API keys — the credential
 * `/api/v1/*` authenticates.
 *
 * Gated on `api_platform` explicitly rather than through `featureForApiPath`:
 * that map keys off the request path, and this route is under
 * `/api/connections` (which must stay ungated, because the desktop-pairing
 * panel next to it is not something a business buys). The public API surface
 * itself checks the same flag inside `withApiKeyScope`, so a business that
 * loses the entitlement both stops being able to mint keys and stops being
 * able to use the ones it has.
 *
 * Owner-only, not `settings.manage`: a key is a long-lived machine credential
 * that reads orders, menu, inventory and reports for a whole branch.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.apiManage);
  if (error) return error;

  const enabled = await isFeatureEnabled(session.businessId, "api_platform");
  const keys = enabled ? await listApiKeys(session.businessId) : [];
  return NextResponse.json({ keys, enabled, scopes: ALL_API_SCOPES }, { headers: { "Cache-Control": "no-store" } });
});

interface CreateBody {
  name?: string;
  scopes?: unknown;
  expiresInDays?: number | null;
  locationId?: string;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.apiManage);
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

  // A key names exactly one branch (the column is NOT NULL and composite-FK'd
  // to it). The caller's active branch is the default, and an explicit
  // locationId is honoured only after resolveActiveLocation has validated the
  // caller's assignment — so this can never mint a key for a branch the owner
  // is not scoped to.
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await createApiKeyForBusiness(session.businessId, session.sub, {
    name: body.name ?? "",
    locationId: location.id,
    scopes: body.scopes,
    expiresInDays: body.expiresInDays === undefined ? 90 : body.expiresInDays,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const response = NextResponse.json({ key: result.key, secret: result.secret }, { status: 201 });
  // The secret exists only in this response body.
  response.headers.set("Cache-Control", "no-store");
  return response;
});
