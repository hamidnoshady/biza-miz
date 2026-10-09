import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import { reverseOpeningBalanceSet } from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a posted set — the controlled correction. Refused once anything else
 * has been posted on or after the set's date; correct the books then with an
 * adjusting entry instead.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ set: await reverseOpeningBalanceSet(session.businessId, session.sub, id, body.reason) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
