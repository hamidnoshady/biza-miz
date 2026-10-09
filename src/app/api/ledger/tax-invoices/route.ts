import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listTaxRegister } from "@/lib/tax-invoice-queries";
import { registerFiltersFromSearch, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * The taxpayer register: every record sent, unsent or refused, with the counts
 * the three views show. `tax.view`: reading the register sends nothing.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    const params = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 200);
    const page = await listTaxRegister(session.businessId, registerFiltersFromSearch(params), {
      limit,
      cursor: params.get("cursor"),
    });
    return NextResponse.json(page);
  } catch (err) {
    return taxErrorResponse(err);
  }
});
