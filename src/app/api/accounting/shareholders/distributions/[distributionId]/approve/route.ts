import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { approveShareholderDistribution } from "@/lib/shareholder-service";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ distributionId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersDistributionsApprove);
  if (error) return error;
  try {
    const { distributionId } = await context.params;
    return NextResponse.json(await approveShareholderDistribution(session.businessId, shareholderActorOf(session, membership), distributionId));
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
