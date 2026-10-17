import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { payShareholderDistribution } from "@/lib/shareholder-service";
import { idempotencyKeyFrom, parseDistributionPayment, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ distributionId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersDistributionsPay);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    const { distributionId } = await context.params;
    const result = await payShareholderDistribution(session.businessId, shareholderActorOf(session, membership), distributionId, parseDistributionPayment(body), idempotencyKeyFrom(request, body));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
