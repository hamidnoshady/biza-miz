import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  fixedAssetExportTruncationNotice,
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
 * The accountant-grade outputs (issue #833): the filtered register, the
 * depreciation schedule, the disposals, the transfers and the estimate
 * changes, as one right-to-left Excel workbook — always over the whole
 * filtered dataset, never just the visible page. Each sheet is capped at
 * FIXED_ASSET_EXPORT_MAX_ROWS rows; when the cap bites, a Persian notice
 * sheet goes in front of the workbook (and the X-Export-Truncated header
 * says so for programmatic readers) rather than a silently short report.
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

  const { sheets, truncated, registerTotal, maxRows } = await fixedAssetsExportSheets(session.businessId, filters);
  const buffer = await sheetsToXlsxBuffer(
    truncated ? [fixedAssetExportTruncationNotice(registerTotal, maxRows), ...sheets] : sheets,
  );
  const response = xlsxResponse(buffer);
  if (truncated) response.headers.set("X-Export-Truncated", "1");
  return response;
});
