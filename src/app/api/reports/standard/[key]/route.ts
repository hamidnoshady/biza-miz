import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportShape, standardReportsFor } from "@/lib/reports";
import { resolveActiveLocation } from "@/lib/setup-state";
import { runStandardReport } from "@/lib/standard-report-service";

/**
 * Runs one pre-built report. P&L/Balance Sheet/Cash Flow/Food-Cost-Variance
 * are structured rollups computed straight from the ledger (see
 * reports-service.ts); the retail trades' own reports (weight reconciliation,
 * warranty register, variant sell-through, …) are computed by their trade's
 * service through `runTradeReport`; every other standard report is a plain row
 * dump of its backing view, optionally bounded by a date range. `?compare=1`
 * returns `{ comparison: {current, previous} }` instead of `{ report }` — the
 * previous period mirrors the given range's length for P&L/Cash Flow, or is
 * the explicit `previousAsOfDate` for Balance Sheet, which has no length to
 * mirror (food-cost-variance doesn't support `compare` — see its UI note).
 *
 * The report must belong to this business's trade: the lookup is over
 * `standardReportsFor(industry)`, not the whole library, so a key another trade
 * owns 404s here exactly as an invented one does. Without that, hiding a report
 * from the list would be decoration — the route would still run it.
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ key: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const { key } = await context.params;

  const industry = await getBusinessIndustry(session.businessId);
  const def = standardReportsFor(industry).find((r) => r.key === key);
  if (!def) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;
  const compare = searchParams.get("compare") === "1";

  // Phase 14 branch isolation is application-enforced (row security stops at
  // the business, not the branch), so every report that *is* one branch's
  // trading is resolved to the caller's active branch — including the plain
  // row reports, which used to be the one shape that skipped it (issue #819):
  // a member assigned to Branch B could read Branch A's rows through
  // /api/reports/standard/<key> while the branch-scoped query route refused
  // them. Never a client-supplied location.
  //
  // The four ledger-wide statements are the deliberate exception: they read the
  // business's books rather than a branch's trading, and are left unscoped for
  // the same reason the trial balance is.
  const LEDGER_WIDE_REPORTS = ["profit_and_loss", "cash_flow", "balance_sheet", "food_cost_variance"];
  const location = LEDGER_WIDE_REPORTS.includes(key) ? null : await resolveActiveLocation(session);
  return NextResponse.json(await runStandardReport(session.businessId, industry, def, {
    dateFrom, dateTo, compare,
    previousAsOfDate: searchParams.get("previousAsOfDate") ?? undefined,
    locationId: location?.id,
  }));
});
