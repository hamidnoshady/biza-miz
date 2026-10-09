import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import { postOpeningBalanceSet } from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Approved → posted: one balanced journal entry, numbered by the database. Re-checks every rule first. */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ set: await postOpeningBalanceSet(session.businessId, session.sub, id) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
