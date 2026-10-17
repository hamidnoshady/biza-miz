import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { recordCapitalMovement } from "@/lib/shareholder-service";
import { idempotencyKeyFrom, parseCapitalMovement, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

/** Post an exact, attributed capital contribution or withdrawal to the ledger. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersCapitalPost);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    const result = await recordCapitalMovement(session.businessId, shareholderActorOf(session, membership), parseCapitalMovement(body), idempotencyKeyFrom(request, body));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
