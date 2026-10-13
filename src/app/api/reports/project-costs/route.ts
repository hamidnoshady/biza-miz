import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listProjectCostReport } from "@/lib/ai-projects";

/**
 * Project-cost report: accounting documents are the source of every spend
 * figure.
 *
 * Gated on `reports.business_wide` (issue #819): `ai_projects` span the
 * business, not a branch, and their spend is summed from journal lines where
 * `project_id` is set — including entries that carry no `location_id` at all. A
 * branch filter here would silently drop those entries and understate what a
 * project cost, so the honest answer for a branch-only member is no answer.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsBusinessWide);
  if (error) return error;
  const rows = await listProjectCostReport({ businessId: session.businessId, actorUserId: session.sub });
  return NextResponse.json({ rows });
});
