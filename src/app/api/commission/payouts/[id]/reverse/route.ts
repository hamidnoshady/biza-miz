import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actorOf, commissionErrorResponse } from "@/lib/commission-settlement-http";
import { badRequest, readJsonObject } from "@/lib/payroll-http";
import { parseNoteBody } from "@/lib/commission-settlement-input";
import { reverseCommissionPayout } from "@/lib/commission-settlement-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Undo a payout: a mirror journal entry and a reversal document, with each member's allocation negated, so
 * what they are owed in the run goes back up by exactly what they were paid. Once per payout (a second call
 * returns the reversal it made, `replayed: true`). Refused once the run is closed. Gated on `commission.reverse`.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.commissionReverse);
  if (error) return error;

  const { id } = await ctx.params;
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return badRequest();

  try {
    const result = await reverseCommissionPayout(session.businessId, actorOf(session, membership), id, parseNoteBody(body));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
