import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import { approveOpeningBalanceSet } from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** In review → approved. The approver must not be the person who proposed the set. */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ set: await approveOpeningBalanceSet(session.businessId, session.sub, id) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
