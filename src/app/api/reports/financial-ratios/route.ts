import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseReportScope } from "@/lib/report-scope";
import { authorizedReportScope, reportScopeDenialResponse } from "@/lib/report-scope-service";
import { parseDimensionFilter } from "@/lib/accounting-dimensions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getFinancialRatios } from "@/lib/financial-ratios-service";

/**
 * «تحلیل مالی» — the derived financial-ratio report.
 *
 * The scope follows the reporting contract exactly (issue #819): the caller's
 * authorized branch by default, or the consolidated books with an explicit
 * `?scope=business-wide` and `reports.business_wide`. A branch from the query
 * string is deliberately not accepted — a report is one branch because the
 * member is assigned to it, never because a URL said so.
 *
 * A dimension filter is a ledger-scoped read (`ledger.view`), the same door as
 * the dimension reports and the journal: it narrows to lines that carry an
 * attributable value, and the report's own warning says so.
 *
 * The calculation is read-only and re-derived on every request — there is no
 * cached balance to go stale after a posting or a reclassification. Dates are
 * required and inclusive, and `dateFrom <= dateTo`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";
  if (!isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo) || dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_report_scope" }, { status: 400 });
  }

  const parsedDimension = parseDimensionFilter(
    searchParams.get("dimensionKind"),
    searchParams.get("dimensionValue"),
  );
  if (!parsedDimension.ok) {
    return NextResponse.json({ error: "invalid_dimension" }, { status: 400 });
  }
  if (parsedDimension.filter) {
    const ledgerAccess = await requirePermission(PERMISSIONS.ledgerView);
    if (ledgerAccess.error) return ledgerAccess.error;
  }

  const requested = parseReportScope(searchParams.get("scope"));
  if (requested === null) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }
  const resolved = await authorizedReportScope(session, {
    requested,
    authorizeBusinessWide: async () => {
      const { error: wideError } = await requirePermission(PERMISSIONS.reportsBusinessWide);
      return !wideError;
    },
  });
  if (!resolved.ok) return reportScopeDenialResponse(resolved.reason);

  const rawTrend = Number(searchParams.get("trend"));
  const trendPeriods = Number.isInteger(rawTrend) && rawTrend > 0 ? Math.min(rawTrend, 12) : 0;

  const report = await getFinancialRatios(session.businessId, {
    dateFrom,
    dateTo,
    scope: resolved.scope,
    dimension: parsedDimension.filter,
    compare: searchParams.get("compare") === "1",
    trendPeriods,
  });
  return NextResponse.json({ report });
});
