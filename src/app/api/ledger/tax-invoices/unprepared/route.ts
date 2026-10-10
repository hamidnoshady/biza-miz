import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listUnpreparedSales } from "@/lib/tax-invoice-queries";
import { registerFiltersFromSearch, taxErrorResponse } from "@/lib/tax-invoice-http";

/** Completed sales with no live tax record: the worklist batch preparation draws from. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    const filters = registerFiltersFromSearch(request.nextUrl.searchParams);
    const sales = await listUnpreparedSales(
      session.businessId,
      { from: filters.from, to: filters.to, locationId: filters.locationId, q: filters.q },
      200,
    );
    return NextResponse.json({ sales });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
