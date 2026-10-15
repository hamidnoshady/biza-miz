import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";
import { exportShareholderEventsCsv } from "@/lib/shareholder-read-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  const query = request.nextUrl.searchParams;
  try {
    const csv = await exportShareholderEventsCsv(
      session.businessId,
      shareholderActorOf(session, membership),
      {
        dateFrom: query.get("dateFrom"),
        dateTo: query.get("dateTo"),
        partyId: query.get("partyId"),
        eventType: query.get("eventType"),
        category: query.get("category"),
      },
    );
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="shareholder-history.csv"',
        "cache-control": "private, no-store",
      },
    });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
