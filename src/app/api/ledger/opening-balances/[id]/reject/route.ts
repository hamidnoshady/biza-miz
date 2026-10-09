import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import { rejectOpeningBalanceSet } from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Sends a set back to draft with a reason. The reason is kept on the set. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ set: await rejectOpeningBalanceSet(session.businessId, session.sub, id, body.reason) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
