import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportShape, standardReportsFor } from "@/lib/reports";
import { branchScope, parseReportScope, reportScopeLocationId } from "@/lib/report-scope";
import { runTradeReport } from "@/lib/trade-reports-service";
import {
  getBalanceSheet,
  getBalanceSheetComparison,
  getCashFlow,
  getCashFlowComparison,
  getProfitAndLoss,
  getProfitAndLossComparison,
  runStandardReportRows,
} from "@/lib/reports-service";

/**
 * Runs a standard report with both business and API-key branch boundaries.
 *
 * The key must belong to the business's own trade — same gate as the dashboard
 * route, so an integration cannot reach a report the UI would never list.
 *
 * ## Scope (issue #819)
 *
 * The scope comes from the key's own configuration, which is the separately
 * authorized decision for this front door: a key pinned to a branch reads that
 * branch (the same four statements the dashboard route used to serve
 * business-wide to a branch-scoped member — two doors into one report
 * disagreeing about whose numbers they were), and a key with no branch is a
 * deliberate business-wide credential, issued as such by whoever created it.
 * Either way it is written down here rather than left to an omitted argument.
 */
export const GET = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ key: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
    if (denied) return denied;

    // Public API keys are pinned to one live location by `api-auth.ts` (and
    // the database column is NOT NULL). Keep this route branch-only: a corrupt
    // or legacy empty location is a refusal, never a consolidated credential.
    if (typeof apiKey.locationId !== "string" || apiKey.locationId.trim() === "") {
      return NextResponse.json({ error: "no_accessible_branch" }, { status: 403 });
    }
    const scope = branchScope(apiKey.locationId);
    const branchLocationId = reportScopeLocationId(scope);
    const { key } = await context.params;
    const industry = await getBusinessIndustry(apiKey.businessId);
    const definition = standardReportsFor(industry).find((report) => report.key === key);
    if (!definition) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const requestedScope = parseReportScope(searchParams.get("scope"));
    if (requestedScope === null) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
    if (requestedScope === "business-wide") {
      // An API key is one-branch only; it carries no reports.business_wide grant.
      return NextResponse.json({ error: "business_wide_forbidden" }, { status: 403 });
    }
    const dateFrom = searchParams.get("dateFrom") ?? undefined;
    const dateTo = searchParams.get("dateTo") ?? undefined;
    const compare = searchParams.get("compare") === "1";

    if (key === "profit_and_loss") {
      if (compare) {
        return NextResponse.json({
          comparison: await getProfitAndLossComparison(
            apiKey.businessId,
            { dateFrom, dateTo },
            scope,
          ),
        });
      }
      return NextResponse.json({
        report: await getProfitAndLoss(apiKey.businessId, { dateFrom, dateTo }, scope),
      });
    }
    if (key === "cash_flow") {
      if (compare) {
        return NextResponse.json({
          comparison: await getCashFlowComparison(apiKey.businessId, { dateFrom, dateTo }, scope),
        });
      }
      return NextResponse.json({
        report: await getCashFlow(apiKey.businessId, { dateFrom, dateTo }, scope),
      });
    }
    if (key === "balance_sheet") {
      if (compare) {
        const previousAsOfDate = searchParams.get("previousAsOfDate") ?? undefined;
        return NextResponse.json({
          comparison: await getBalanceSheetComparison(
            apiKey.businessId,
            dateTo,
            previousAsOfDate,
            scope,
          ),
        });
      }
      return NextResponse.json({
        report: await getBalanceSheet(apiKey.businessId, dateTo, scope),
      });
    }

    // The retail trades' own reports, scoped to the key's own branch.
    if (reportShape(definition) !== "rows") {
      const report = await runTradeReport(key, {
        businessId: apiKey.businessId,
        locationId: branchLocationId ?? null,
        industry: industry ?? "food_service",
        filters: { dateFrom, dateTo },
      });
      if (report) return NextResponse.json({ report });
    }

    const rows = await runStandardReportRows(key, apiKey.businessId, scope, { dateFrom, dateTo });
    return NextResponse.json({ rows });
  },
);
