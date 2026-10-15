import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readJsonObject } from "@/lib/payroll-http";
import { recordOwnershipEvents } from "@/lib/shareholder-service";
import { idempotencyKeyFrom, parseOwnershipEvents, shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";

/** Append one or more effective-dated ownership facts; never edits a prior snapshot. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "invalid_request_body" }, { status: 400 });
  try {
    const events = parseOwnershipEvents(body.events);
    const result = await recordOwnershipEvents(session.businessId, shareholderActorOf(session, membership), events, idempotencyKeyFrom(request, body));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
