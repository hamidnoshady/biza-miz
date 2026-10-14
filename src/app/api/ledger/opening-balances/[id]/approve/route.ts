import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, approveOpeningSet } from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * review → approved — the reconciliation gate (issue #867: "exact
 * reconciliation before post").
 *
 * A carry-forward set is re-derived from the books at approval time and must
 * match to the Rial (the ledger may have moved since the proposal was
 * generated, and a moved prior close means the proposal is stale, not
 * closeable). No year may approve into a second opening. The decision
 * permission is `ledger.approve`, the same as approving a manual journal.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });
  try {
    const reconciliation = await approveOpeningSet({
      businessId: session.businessId,
      setId: id,
      actorId: session.sub,
    });
    return NextResponse.json({ ok: true, reconciliation: reconciliation ?? null });
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
