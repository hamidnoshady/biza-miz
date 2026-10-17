import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";
import { listShareholderEvents } from "@/lib/shareholder-read-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  const query = request.nextUrl.searchParams;
  try {
    return NextResponse.json(await listShareholderEvents(
      session.businessId,
      shareholderActorOf(session, membership),
      {
        dateFrom: query.get("dateFrom"),
        dateTo: query.get("dateTo"),
        partyId: query.get("partyId"),
        eventType: query.get("eventType"),
        category: query.get("category"),
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
