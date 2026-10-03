import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { promotionEffectivenessReport } from "@/lib/promotions-service";

/** گزارش اثربخشی کمپین‌ها — how often each promotion fired and how much discount it cost. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const report = await promotionEffectivenessReport(session.businessId, {
    from: params.get("from") ?? null,
    to: params.get("to") ?? null,
  });
  return NextResponse.json(report);
});
