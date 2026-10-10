import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getAccountDrillDown } from "@/lib/reports-service";
import { authorizedReportScope, reportScopeDenialResponse } from "@/lib/report-scope-service";

/**
 * Journal postings behind a report figure.
 *
 * Two callers, two scopes, and the permission is what tells them apart:
 *
 *  - The **financial-statement drill-down** (`reports.view`) is reached by
 *    clicking a P&L or balance-sheet line, so it must read the postings the
 *    statement was computed from — the caller's authorized branch
 *    (issue #819). It used to read every journal line in the business, so a
 *    branch-scoped manager could drill from a branch figure into the whole
 *    business's ledger.
 *  - The **trial-balance overlay** (`ledger.view`) is part of the accounting
 *    module, whose books are business-level by design (one chart of accounts,
 *    one journal, and a trial balance that is documented as «دفتر تجمیعی همهٔ
 *    شعب»). It keeps the whole-ledger scope it has always had.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const accountingView = searchParams.get("permissionScope") === "ledger";
  const { session, error } = await requirePermission(
    accountingView ? PERMISSIONS.ledgerView : PERMISSIONS.reportsView,
  );
  if (error) return error;

  const accountCode = searchParams.get("accountCode");
  if (!accountCode) return NextResponse.json({ error: "missing_account_code" }, { status: 400 });

  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;
  if (
    (dateFrom !== undefined && !isValidIsoDate(dateFrom)) ||
    (dateTo !== undefined && !isValidIsoDate(dateTo)) ||
    (dateFrom && dateTo && dateFrom > dateTo)
  ) {
    return NextResponse.json({ error: "invalid_date_range" }, { status: 400 });
  }

  const rawOffset = searchParams.get("offset");
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50_000_000) {
    return NextResponse.json({ error: "invalid_offset" }, { status: 400 });
  }

  const scope = accountingView
    ? null
    : await authorizedReportScope(session, {
        authorizeBusinessWide: async () => {
          const { error: wideError } = await requirePermission(PERMISSIONS.reportsBusinessWide);
          return !wideError;
        },
      });
  if (scope && !scope.ok) return reportScopeDenialResponse(scope.reason);

  const result = await getAccountDrillDown(session.businessId, accountCode, {
    dateFrom,
    dateTo,
    offset,
    limit: 200,
    locationId: scope?.ok ? scope.scope.locationId : undefined,
  });
  return NextResponse.json(result);
});
