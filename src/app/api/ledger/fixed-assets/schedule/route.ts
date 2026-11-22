import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/jalali";
import {
  FixedAssetError,
  getPortfolioDepreciationSchedule,
  type FixedAssetListFilters,
} from "@/lib/fixed-assets-service";

export const dynamic = "force-dynamic";

/**
 * The portfolio projected depreciation schedule (issue #1325): the register's
 * own filters select the assets, and the response carries per-period posted
 * and forecast totals (never journaled), per-asset totals, and the
 * register↔GL reconciliation. Jalali month keys throughout.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const depreciationState = params.get("depreciationState");
  const filters: FixedAssetListFilters = {
    search: params.get("search"),
    status: status === "disposed" || status === "active" || status === "archived" ? status : null,
    depreciationState:
      depreciationState === "none" ||
      depreciationState === "partial" ||
      depreciationState === "fully" ||
      depreciationState === "open"
        ? depreciationState
        : null,
    category: params.get("category"),
    locationId: params.get("locationId"),
    dateFrom: params.get("dateFrom"),
    dateTo: params.get("dateTo"),
    includeArchived: params.get("includeArchived") === "1",
  };
  if (filters.dateFrom && !isValidIsoDate(filters.dateFrom)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (filters.dateTo && !isValidIsoDate(filters.dateTo)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  try {
    const schedule = await getPortfolioDepreciationSchedule(session.businessId, filters, {
      throughPeriodKey: params.get("through"),
    });
    return NextResponse.json(schedule);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
