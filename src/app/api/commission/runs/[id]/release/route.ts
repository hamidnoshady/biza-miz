import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actorOf, commissionErrorResponse } from "@/lib/commission-settlement-http";
import { badRequest, readJsonObject } from "@/lib/payroll-http";
import { parseNoteBody } from "@/lib/commission-settlement-input";
import { releaseCommissionRun } from "@/lib/commission-settlement-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Release an approved run for payment. From here it can be paid or closed, not edited. Gated on `commission.payout`.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.commissionPayout);
  if (error) return error;

  const { id } = await ctx.params;
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return badRequest();

  try {
    const run = await releaseCommissionRun(session.businessId, actorOf(session, membership), id, parseNoteBody(body));
    return NextResponse.json({ run });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
