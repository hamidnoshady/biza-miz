import { NextRequest, NextResponse } from "next/server";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createAiWidget,
  listAiWidgets,
  listRecommendedAiWidgets,
  normalizeWidgetInput,
} from "@/lib/ai-widgets";

export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const industry = await getBusinessIndustry(guard.session.businessId);
  const [widgets, recommended] = await Promise.all([
    listAiWidgets(guard.session.businessId, guard.session.sub),
    listRecommendedAiWidgets(industry, guard.membership.permissions),
  ]);
  return NextResponse.json({ widgets, recommended });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = normalizeWidgetInput(body ?? {});
  if (!input) return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
  try {
    const widget = await createAiWidget(
      guard.session.businessId,
      guard.session.sub,
      input,
      guard.membership.permissions,
    );
    return NextResponse.json({ widget }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_widget";
    const status = code === "widget_permission_widening" || code === "project_inaccessible" ? 403 : 400;
    return NextResponse.json({ error: code }, { status });
  }
});
