import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { authorizedReportBranchScope, reportScopeDenialResponse } from "@/lib/report-scope-service";
import { listMenuCostDrift } from "@/lib/pricing-service";

/** Menu items whose ingredient cost rose past the business's drift threshold since they were priced. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const resolved = await authorizedReportBranchScope(session);
  if (!resolved.ok) return reportScopeDenialResponse(resolved.reason);

  const items = await listMenuCostDrift(session.businessId, resolved.scope.locationId);
  return NextResponse.json({ items });
});
