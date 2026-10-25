import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { authorizedAiDestinations } from "@/lib/ai-navigation";
import { resolveAuthorizedAiGuide } from "@/lib/ai-guided-tours";

/**
 * Reauthorize the exact registered tour on every run. Neither model output nor
 * client body can supply selectors, actions, HTML or an unrestricted URL.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.aiUse);
  if (error) return error;
  const body = (await request.json().catch(() => null)) as { guideId?: unknown } | null;
  const allowed = await authorizedAiDestinations(
    session.businessId, session.sub, session.locationId ?? null,
  );
  const guide = resolveAuthorizedAiGuide(body?.guideId, allowed);
  if (!guide) return NextResponse.json({ error: "guide_unavailable" }, { status: 404 });
  return NextResponse.json({
    guide: { id: guide.id, label: guide.label, steps: guide.steps },
  }, { headers: { "Cache-Control": "no-store" } });
});
