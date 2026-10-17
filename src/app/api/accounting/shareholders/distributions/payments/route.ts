import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";
import { listShareholderPayments } from "@/lib/shareholder-read-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  const query = request.nextUrl.searchParams;
  try {
    return NextResponse.json(await listShareholderPayments(
      session.businessId,
      shareholderActorOf(session, membership),
      {
        distributionId: query.get("distributionId"),
        partyId: query.get("partyId"),
        dateFrom: query.get("dateFrom"),
        dateTo: query.get("dateTo"),
        paymentType: query.get("paymentType"),
        limit: query.get("limit"),
        cursor: query.get("cursor"),
      },
    ));
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
