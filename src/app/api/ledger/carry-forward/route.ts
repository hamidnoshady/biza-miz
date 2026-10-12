import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, generateCarryForward } from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

/**
 * Generates the next year's opening proposal from the prior year's close
 * (issue #867 carry-forward):
 *
 *  - the prior year must be transitioned (every period locked, or the year
 *    closed) — an open prior year has no close to carry;
 *  - balance-sheet balances become opening lines, revenue/expense never do
 *    (their net becomes the equity line);
 *  - A/R and A/P carry per party, cheques per cheque (serial/Sayad kept),
 *    fixed assets per asset (cost, accumulated depreciation, provenance);
 *  - the proposal lands as a draft set for the next year (effective date: the
 *    next year's first day) and is idempotent per prior year — a retry
 *    returns the original;
 *  - approval (its own route) re-derives the proposal from the books and
 *    requires an exact match before the set may post.
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
  if (!isUuid(body.fromYearId ?? "") || !isUuid(body.toYearId ?? "")) {
    return NextResponse.json({ error: "fiscal_year_not_found" }, { status: 404 });
  }

  try {
    const result = await generateCarryForward({
      businessId: session.businessId,
      fromYearId: body.fromYearId!,
      toYearId: body.toYearId!,
      actorId: session.sub,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.idempotent ? 200 : 201 });
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
