import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getProviderErrorReport } from "@/lib/tax-invoice-queries";
import { registerFiltersFromSearch, taxErrorResponse } from "@/lib/tax-invoice-http";

/** What the authority and the transport kept refusing, grouped by code, so a repeated fault is one row. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    const filters = registerFiltersFromSearch(request.nextUrl.searchParams);
    const rows = await getProviderErrorReport(session.businessId, { from: filters.from, to: filters.to });
    return NextResponse.json({ rows });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
