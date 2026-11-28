import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/jalali";
import { IntangibleAssetError, getIntangibleReports, type IntangibleReportFilters } from "@/lib/intangible-assets-service";
import type { UsefulLifeType } from "@/lib/intangible-assets";

export const dynamic = "force-dynamic";

function filtersFrom(params: URLSearchParams): IntangibleReportFilters {
  const status = params.get("status");
  const lifeType = params.get("usefulLifeType");
  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  return {
    search: params.get("search"),
    status: status === "active" || status === "disposed" ? status : null,
    assetClass: params.get("assetClass"),
    usefulLifeType: lifeType === "finite" || lifeType === "indefinite" ? (lifeType as UsefulLifeType) : null,
    locationId: params.get("locationId"),
    dateFrom: dateFrom && isValidIsoDate(dateFrom) ? dateFrom : null,
    dateTo: dateTo && isValidIsoDate(dateTo) ? dateTo : null,
    periodFrom: params.get("periodFrom"),
    periodTo: params.get("periodTo"),
  };
}

/**
 * The six intangible-asset reports as JSON (issue #1326, ESH-163 phase 4):
 * register, period schedule, posted amortization history, impairment and
 * reversals, disposals, and register↔ledger reconciliation — over the same
 * filtered population the export route writes.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  try {
    const report = await getIntangibleReports(session.businessId, filtersFrom(request.nextUrl.searchParams));
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
