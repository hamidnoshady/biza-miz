import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportShape, standardReportsFor } from "@/lib/reports";
import { isConsolidatedStandardReport, parseReportScope } from "@/lib/report-scope";
import { authorizedReportScope, reportScopeDenialResponse } from "@/lib/report-scope-service";
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
 * owns 404s here exactly as an invented one does.
 *
 * ## Scope (issue #819)
 *
 * Every report runs against the caller's **authorized branch** — the resolved
 * active branch, never a location from the query string. The four ledger
 * statements used to be a hard-coded exception here (`LEDGER_WIDE_REPORTS`)
 * that skipped the branch entirely, so a manager assigned to one branch read
 * the whole business's P&L, balance sheet and cash flow through this route —
 * while `/api/v1/reports/standard/[key]`, the API-key front door into the same
 * reports, scoped the identical keys to the key's branch. Two doors, one
 * report, two different answers about whose numbers they were.
 *
 * The consolidated form still exists, because the product genuinely has one:
 * it is asked for explicitly with `?scope=business-wide`, requires
 * `reports.business_wide`, and is offered only for the statements
 * (`isConsolidatedStandardReport`) — a business-wide *row dump* is the leak
 * this route was fixed for, not a report the product has.
 *
 * Branch scoping of the statements is sound rather than a compromise: every
 * posted journal entry's lines share the entry's `location_id`
 * (`v_ledger_by_account` selects whole entries), so a branch's assets,
 * liabilities, equity and retained earnings are that branch's slice of the same
 * balanced books and the sheet still balances by construction. That is exactly
 * what the API-key route has always done.
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
  const requested = parseReportScope(searchParams.get("scope"));
  if (requested === null) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }

  if (requested === "business-wide" && !isConsolidatedStandardReport(key)) {
    // Refused by name rather than silently downgraded to one branch: a caller
    // asking for every branch's row dump has misunderstood what this route
    // serves, and answering with one branch's rows would look like success.
    return NextResponse.json({ error: "scope_not_supported", message: "این گزارش فقط برای یک شعبه اجرا می‌شود." }, { status: 400 });
  }

  const resolved = await authorizedReportScope(session, {
    requested,
    authorizeBusinessWide: async () => {
      const { error: wideError } = await requirePermission(PERMISSIONS.reportsBusinessWide);
      return !wideError;
    },
  });
  if (!resolved.ok) return reportScopeDenialResponse(resolved.reason);

  return NextResponse.json(await runStandardReport(session.businessId, industry, def, {
    dateFrom, dateTo, compare,
    previousAsOfDate: searchParams.get("previousAsOfDate") ?? undefined,
    scope: resolved.scope,
  }));
});
