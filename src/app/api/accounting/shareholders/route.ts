import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { loadShareholderWorkspace } from "@/lib/shareholder-service";
import { shareholderErrorResponse } from "@/lib/shareholder-http";

/** Shareholder register, immutable events, ledger tie-out and distribution snapshots (#864). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  try {
    const asOf = request.nextUrl.searchParams.get("asOf");
    const distributionId = request.nextUrl.searchParams.get("distributionId");
    return NextResponse.json(await loadShareholderWorkspace(session.businessId, asOf, distributionId));
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
