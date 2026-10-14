import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, reverseOpeningSet } from "@/lib/opening-balances-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * posted → reversed — the controlled correction (issue #867: "controlled
 * correction/reversal", "no destructive rewrite after dependent postings
 * exist").
 *
 * The service posts a mirror entry dated today (never backdated into the
 * original's period) and refuses outright once any other entry is dated
 * after the set's effective date: after that the books have moved on and the
 * correction is a forward entry, not a rewrite. A reason is mandatory — a
 * reversal without one is a disappearance.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });

  let body: { reason?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await reverseOpeningSet({
      businessId: session.businessId,
      setId: id,
      reason: body.reason ?? "",
      actorId: session.sub,
    });
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
