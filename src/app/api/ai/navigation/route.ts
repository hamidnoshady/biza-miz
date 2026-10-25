import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { authorizedAiDestinations, findAuthorizedAiDestinations } from "@/lib/ai-navigation";

/** Find and resolve only routes the current tenant member may actually use. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.aiUse);
  if (error) return error;
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 120) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const destinations = await authorizedAiDestinations(session.businessId, session.sub, session.locationId ?? null);
  return NextResponse.json({ destinations: findAuthorizedAiDestinations(destinations, query) });
});

/** Recheck a concrete registered route before navigating; never accept raw URLs. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.aiUse);
  if (error) return error;
  const body = (await request.json().catch(() => null)) as { featureId?: unknown } | null;
  if (typeof body?.featureId !== "string" || body.featureId.length > 160) {
    return NextResponse.json({ error: "invalid_feature" }, { status: 400 });
  }
  const destinations = await authorizedAiDestinations(session.businessId, session.sub, session.locationId ?? null);
  const destination = destinations.find((item) => item.id === body.featureId);
  if (!destination) return NextResponse.json({ error: "destination_unavailable" }, { status: 404 });
  return NextResponse.json({ status: "ready", destination });
});
