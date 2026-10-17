import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";
import { listShareholderDistributionLines } from "@/lib/shareholder-read-service";

export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ distributionId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  const query = request.nextUrl.searchParams;
  try {
    const { distributionId } = await context.params;
    return NextResponse.json(await listShareholderDistributionLines(
      session.businessId,
      shareholderActorOf(session, membership),
      distributionId,
      { partyId: query.get("partyId"), limit: query.get("limit"), offset: query.get("offset") },
    ));
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
