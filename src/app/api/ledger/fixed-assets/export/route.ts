import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  fixedAssetsExportSheets,
  type FixedAssetListFilters,
} from "@/lib/fixed-assets-service";
import { sheetsToXlsxBuffer } from "@/lib/data-transfer/codecs";
import { isValidIsoDate } from "@/lib/jalali";

export const dynamic = "force-dynamic";

/** filename carries Persian text — RFC 5987-encoded, ASCII fallback (same as the report exporter). */
function xlsxResponse(body: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="fixed-assets.xlsx"; filename*=UTF-8''${encodeURIComponent("دفتر-اموال.xlsx")}`,
    },
  });
}

/**
 * The accountant-grade outputs (issue #833): the full filtered register, the
 * depreciation schedule, the transfers and the estimate changes, as one
 * right-to-left Excel workbook. Always the *full* filtered dataset — never
 * just the visible page.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const depreciationState = params.get("depreciationState");
  const sortBy = params.get("sortBy");
  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  if (dateFrom && !isValidIsoDate(dateFrom)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  if (dateTo && !isValidIsoDate(dateTo)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });

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
    dateFrom,
    dateTo,
    includeArchived: params.get("includeArchived") === "1",
    sortBy:
      sortBy === "date_asc" || sortBy === "cost_desc" || sortBy === "book_value_desc"
        ? (sortBy as FixedAssetListFilters["sortBy"])
        : null,
  };

  const sheets = await fixedAssetsExportSheets(session.businessId, filters);
  const buffer = await sheetsToXlsxBuffer(sheets);
  return xlsxResponse(buffer);
});
