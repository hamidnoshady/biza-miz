import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import { submitOpeningBalanceSet } from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Draft → for review. Refused unless the set balances, every A/R and A/P line has a party, and a carry-forward reconciles. */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ set: await submitOpeningBalanceSet(session.businessId, session.sub, id) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
