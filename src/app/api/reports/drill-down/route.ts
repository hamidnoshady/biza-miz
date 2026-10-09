import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getAccountDrillDown } from "@/lib/reports-service";

/**
 * Journal postings behind a report figure. Financial-statement drill-downs use
 * `reports.view`; the trial-balance overlay uses the same reporting service and
 * table under `ledger.view`, which is the permission for that accounting page.
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

  const result = await getAccountDrillDown(session.businessId, accountCode, {
    dateFrom,
    dateTo,
    offset,
    limit: 200,
  });
  return NextResponse.json(result);
});
