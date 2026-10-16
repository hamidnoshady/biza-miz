import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getFinancialTransfer } from "@/lib/financial-transfers-service";
import { financialErrorResponse } from "../../financial/support";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One transfer, with the journal lines behind it.
 *
 * The lines travel with the document on purpose: a transfer screen that cannot
 * show which accounts the money actually moved between is a screen that asks the
 * reader to take its word for it. `getFinancialTransfer` returns null for a
 * malformed id as well as an unknown one, so the answer is one 404 shape.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const transfer = await getFinancialTransfer(session.businessId, id);
    if (!transfer) return NextResponse.json({ error: "transfer_not_found" }, { status: 404 });
    return NextResponse.json({ transfer });
  } catch (err) {
    return financialErrorResponse(err);
  }
});
