import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import {
  deleteOpeningBalanceDraft,
  getOpeningBalanceSet,
} from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One set, with its lines, totals, workflow stamps and — for a carry-forward — the prior-close reconciliation. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ set: await getOpeningBalanceSet(session.businessId, id) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});

/** Deletes a draft that has never been posted. Anything past draft is kept for the record. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    await deleteOpeningBalanceDraft(session.businessId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
