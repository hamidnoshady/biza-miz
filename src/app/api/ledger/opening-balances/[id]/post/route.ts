import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, postOpeningSet } from "@/lib/opening-balances-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * approved → posted. The set's lines become one ordinary journal entry
 * (`source_type = 'opening'`, dated at the set's effective date) through the
 * same posting path every other document uses — so the fiscal period lock
 * trigger, RLS and the reports all apply with no special case, and the entry
 * carries its voucher number from the opening book.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });
  try {
    const result = await postOpeningSet({ businessId: session.businessId, setId: id, actorId: session.sub });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
