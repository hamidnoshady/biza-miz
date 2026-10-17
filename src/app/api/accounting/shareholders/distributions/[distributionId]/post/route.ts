import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { postShareholderDistribution } from "@/lib/shareholder-service";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ distributionId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;
  try {
    const { distributionId } = await context.params;
    const result = await postShareholderDistribution(session.businessId, shareholderActorOf(session, membership), distributionId);
    return NextResponse.json(result);
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
