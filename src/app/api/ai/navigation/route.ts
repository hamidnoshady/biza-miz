import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { authorizedAiDestinations, findAuthorizedAiDestinations } from "@/lib/ai-navigation";
import { resolveAuthorizedAiGuide } from "@/lib/ai-guided-tours";

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
  const body = (await request.json().catch(() => null)) as { featureId?: unknown; guideId?: unknown } | null;
  if (!body || (body.featureId !== undefined) === (body.guideId !== undefined)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (body.guideId !== undefined && (typeof body.guideId !== "string" || body.guideId.length > 80)) {
    return NextResponse.json({ error: "invalid_guide" }, { status: 400 });
  }
  if (body.featureId !== undefined && (typeof body.featureId !== "string" || body.featureId.length > 160)) {
    return NextResponse.json({ error: "invalid_feature" }, { status: 400 });
  }
  const destinations = await authorizedAiDestinations(session.businessId, session.sub, session.locationId ?? null);
  if (body.guideId !== undefined) {
    const guide = resolveAuthorizedAiGuide(body.guideId, destinations);
    if (!guide) return NextResponse.json({ error: "guide_unavailable" }, { status: 404 });
    return NextResponse.json(
      { guide: { id: guide.id, label: guide.label, steps: guide.steps } },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const destination = destinations.find((item) => item.id === body.featureId);
  if (!destination) return NextResponse.json({ error: "destination_unavailable" }, { status: 404 });
  return NextResponse.json({ status: "ready", destination });
});
