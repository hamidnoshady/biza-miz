import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { reverseShareholderDistributionPayment } from "@/lib/shareholder-service";
import { idempotencyKeyFrom, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ paymentId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersDistributionsReverse);
  if (error) return error;
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    const { paymentId } = await context.params;
    const result = await reverseShareholderDistributionPayment(session.businessId, shareholderActorOf(session, membership), paymentId, idempotencyKeyFrom(request, body));
    return NextResponse.json(result);
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
