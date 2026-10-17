import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";
import { loadShareholderAccountStatement } from "@/lib/shareholder-read-service";

export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ accountId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  const query = request.nextUrl.searchParams;
  try {
    const { accountId } = await context.params;
    return NextResponse.json(await loadShareholderAccountStatement(
      session.businessId,
      shareholderActorOf(session, membership),
      accountId,
      {
        partyId: query.get("partyId"),
        dateFrom: query.get("dateFrom"),
        dateTo: query.get("dateTo"),
        limit: query.get("limit"),
        offset: query.get("offset"),
      },
    ));
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
