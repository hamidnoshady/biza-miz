import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { reconcileCarryForwardSet } from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The prior-close vs next-open reconciliation for a carry-forward set
 * (issue #867 report "prior-close vs next-open reconciliation"): the
 * proposal is recomputed from the books and compared with the set, account
 * by account and party by party. `null` → not a carry-forward set.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });
  const result = await reconcileCarryForwardSet(session.businessId, id);
  if (!result) {
    return NextResponse.json({ error: "not_carry_forward" }, { status: 400 });
  }
  return NextResponse.json(result);
});
