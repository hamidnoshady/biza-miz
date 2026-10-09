import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getTaxReconciliation } from "@/lib/tax-invoice-queries";
import { registerFiltersFromSearch, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * The register tied to the sales ledger for a window of days. Requires `from` and
 * `to`: an unbounded reconciliation would compare the whole history on every click.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    const filters = registerFiltersFromSearch(request.nextUrl.searchParams);
    if (!filters.from || !filters.to) {
      return NextResponse.json({ error: "range_required", message: "بازهٔ تاریخ را مشخص کنید." }, { status: 400 });
    }
    const result = await getTaxReconciliation(session.businessId, {
      from: filters.from,
      to: filters.to,
      locationId: filters.locationId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return taxErrorResponse(err);
  }
});
