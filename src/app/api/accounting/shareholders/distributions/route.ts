import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { createShareholderDistribution } from "@/lib/shareholder-service";
import { idempotencyKeyFrom, parseDistribution, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

/** Create an immutable profit-allocation draft from a closed-year result and dated ownership snapshot. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersDistributionsManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    const result = await createShareholderDistribution(session.businessId, shareholderActorOf(session, membership), parseDistribution(body), idempotencyKeyFrom(request, body));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
