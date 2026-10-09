import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getTrialBalance } from "@/lib/ledger-reports-service";
import { parseDimensionFilter } from "@/lib/accounting-dimensions";

/**
 * Period-scoped trial balance. A caller must name either an inclusive custom
 * period (`dateFrom` + `dateTo`) or a compact closing date (`asOf`); an
 * accidental no-filter request must never mean "all time".
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  const asOf = params.get("asOf");
  const hasPeriod = dateFrom !== null || dateTo !== null;

  if (
    (asOf !== null && (hasPeriod || !isValidIsoDate(asOf))) ||
    (asOf === null &&
      (dateFrom === null || dateTo === null || !isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo)))
  ) {
    return NextResponse.json({ error: "invalid_report_scope" }, { status: 400 });
  }
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_date_range" }, { status: 400 });
  }
  // Issue #868: `?dimension=cost_center&value=<id|unassigned>` restricts the
  // whole report to one value of one kind. Absent means the whole ledger.
  const dimension = parseDimensionFilter(params.get("dimension"), params.get("value"));
  if (!dimension.ok) return NextResponse.json({ error: "invalid_dimension" }, { status: 400 });

  try {
    const report = await getTrialBalance(
      session.businessId,
      {
        ...(asOf !== null ? { asOf } : { dateFrom: dateFrom!, dateTo: dateTo! }),
        ...(dimension.filter ? { dimension: dimension.filter } : {}),
      },
    );
    return NextResponse.json(report);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "invalid_trial_balance_scope") {
      return NextResponse.json({ error: "invalid_report_scope" }, { status: 400 });
    }
    throw cause;
  }
});
