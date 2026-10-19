import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getLedgerOverview } from "@/lib/ledger-reports-service";
import { parseLedgerOverviewFilters } from "@/lib/ledger-overview-filters";

/**
 * The Accounting app's dashboard, in one call.
 *
 * Read-only, like the trial balance it reports beside, and reading the same
 * `journal_lines` through the same helper (`ledger-reports-service.ts`), so the
 * dashboard cannot disagree with the books or with the trial balance.
 *
 * Owner/manager/accountant only: it is the ledger's own door.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  // Shareable, validated filters (#912 item 13): the same parser the UI uses
  // for the address bar, so a pasted link cannot widen or corrupt the scope.
  const { filters, droppedInvalid } = parseLedgerOverviewFilters(new URL(request.url).searchParams);
  if (droppedInvalid) {
    return NextResponse.json({ error: "invalid_overview_filter" }, { status: 400 });
  }
  try {
    const overview = await getLedgerOverview(session.businessId, {
      asOfDate: filters.asOf ?? undefined,
      fiscalYearId: filters.period === "auto" ? undefined : filters.period === "all" ? null : filters.period,
    });
    return NextResponse.json({ overview });
  } catch (err) {
    if (err instanceof Error && err.message === "fiscal_year_not_found") {
      return NextResponse.json({ error: "fiscal_year_not_found" }, { status: 404 });
    }
    throw err;
  }
});
