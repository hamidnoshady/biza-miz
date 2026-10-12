import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, generateCarryForward } from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

/**
 * Generate the next year's opening proposal from a closed prior year
 * (issue #867 scope B: "derive closing BS balances → generate next-year
 * opening proposal").
 *
 * The books are read at year-end and the carry-forward rule builds the lines
 * — A/R and A/P per party, cheques and fixed assets per item when the
 * registers agree, revenue/expense closed into one equity line. The set
 * lands as a *draft* with `source = 'carry_forward'`: nothing is posted here,
 * the normal review → approve → post path answers for it, and approve
 * re-derives the proposal and reconciles to the Rial.
 *
 * Idempotent: the same transition (same prior year) returns the set it
 * already generated rather than a second one — the business may have
 * generated the proposal, walked away, and come back. 201 when a new set is
 * created, 200 with `idempotent: true` when the earlier one is returned.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: { fromYearId?: string; toYearId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.fromYearId || !isUuid(body.fromYearId) || !body.toYearId || !isUuid(body.toYearId)) {
    return NextResponse.json({ error: "fiscal_year_not_found" }, { status: 404 });
  }

  try {
    const result = await generateCarryForward({
      businessId: session.businessId,
      fromYearId: body.fromYearId,
      toYearId: body.toYearId,
      actorId: session.sub,
    });
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.idempotent ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
