import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { reverseCapitalMovement } from "@/lib/shareholder-service";
import { idempotencyKeyFrom, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

/** Reverse a posted shareholder capital event with a new mirror journal. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ eventId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersCapitalReverse);
  if (error) return error;
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    const { eventId } = await context.params;
    const result = await reverseCapitalMovement(session.businessId, shareholderActorOf(session, membership), eventId, idempotencyKeyFrom(request, body));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
