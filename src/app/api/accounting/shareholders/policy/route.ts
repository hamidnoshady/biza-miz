import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { updateOwnershipTotalPolicy } from "@/lib/shareholder-service";
import { parseOwnershipPolicy, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

/** Set the tenant's total-ownership invariant after validating the full timeline. */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    await updateOwnershipTotalPolicy(session.businessId, shareholderActorOf(session, membership), parseOwnershipPolicy(body.totalPolicy));
    return NextResponse.json({ ok: true });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
