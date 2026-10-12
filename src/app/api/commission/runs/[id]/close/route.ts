import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actorOf, commissionErrorResponse } from "@/lib/commission-settlement-http";
import { badRequest, readJsonObject } from "@/lib/payroll-http";
import { parseNoteBody } from "@/lib/commission-settlement-input";
import { closeCommissionRun } from "@/lib/commission-settlement-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Close a run that has finished paying. A run closed part-paid carries what each member is still owed
 * forward to the next run that calculates for them. Gated on `commission.payout`.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.commissionPayout);
  if (error) return error;

  const { id } = await ctx.params;
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return badRequest();

  try {
    const run = await closeCommissionRun(session.businessId, actorOf(session, membership), id, parseNoteBody(body));
    return NextResponse.json({ run });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
