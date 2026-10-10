import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportViewsFor } from "@/lib/reports";
import { reportFilterOptions } from "@/lib/report-filter-options-service";
import {
  authorizedReportBranchScope,
  reportScopeDenialResponse,
} from "@/lib/report-scope-service";

/**
 * Filter choices for one canonical report source. The view name is checked
 * against the business's offered source catalogue, while the active branch is
 * resolved from the signed-in member on the server; no client-supplied branch
 * or filter source is trusted.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const viewKey = request.nextUrl.searchParams.get("view");
  if (!viewKey) return NextResponse.json({ error: "missing_view" }, { status: 400 });

  const industry = await getBusinessIndustry(session.businessId);
  if (!reportViewsFor(industry).some((view) => view.key === viewKey)) {
    return NextResponse.json({ error: "unknown_report_view" }, { status: 400 });
  }

  const authorized = await authorizedReportBranchScope(session);
  if (!authorized.ok) return reportScopeDenialResponse(authorized.reason);

  const options = await reportFilterOptions(
    session.businessId,
    authorized.scope.locationId,
    viewKey,
  );
  return NextResponse.json({ options });
});
