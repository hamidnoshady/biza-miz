import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessOverview } from "@/lib/reports-service";

/**
 * Phase 14 — consolidated numbers across a business's own branches.
 *
 * Distinct from Phase 9's `/api/rollup/*`: that aggregates other *servers*
 * pushing summaries over HTTP. This queries the Phase 8 reporting views
 * directly for branches sharing this database, so a branch's row here is
 * computed the same way its own reports are — there's no second code path
 * for the numbers to disagree through.
 *
 * Cross-branch comparison is one step more restricted than a single branch's
 * own reports, and that step is now a *capability* rather than a comment:
 * `reports.business_wide` (issue #819). The route used to guard with plain
 * `reports.view` while both its own comment and the `branches` tab claimed
 * "Owner-only" — so hiding the tab was the only thing standing between a
 * branch-scoped manager and every other branch's numbers, and a direct API
 * call walked straight past it.
 *
 * `reports.business_wide` is deliberately absent from every role preset: no
 * preset grants it, so the default answer for manager, accountant, admin and
 * every custom member is "no", exactly as the product rule says, while the
 * owner keeps it (the owner's set is the whole catalogue) and a business that
 * decides otherwise can grant it to one member explicitly.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsBusinessWide);
  if (error) return error;

  const dateFrom = request.nextUrl.searchParams.get("dateFrom") ?? undefined;
  const dateTo = request.nextUrl.searchParams.get("dateTo") ?? undefined;

  return NextResponse.json(await getBusinessOverview(session.businessId, { dateFrom, dateTo }));
});
