import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseReportOrderFilters } from "@/lib/report-order-filters";
import { getShiftOrdersReport } from "@/lib/shift-orders-service";
import { authorizedReportBranchScope, reportScopeDenialResponse } from "@/lib/report-scope-service";

/** Branch-scoped, paginated order report. All filtering happens in PostgreSQL. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const resolved = await authorizedReportBranchScope(session);
  if (!resolved.ok) return reportScopeDenialResponse(resolved.reason);

  const parsed = parseReportOrderFilters(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json({
    report: await getShiftOrdersReport(resolved.scope.locationId, {
      ...parsed.filters,
      timeZone: resolved.scope.location.timezone,
    }),
  });
});
