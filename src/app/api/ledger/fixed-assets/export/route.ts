import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { fixedAssetsExportSheets, FixedAssetError, type FixedAssetListFilters } from "@/lib/fixed-assets-service";
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
 * posted depreciation schedule, the remaining-schedule forecast, the
 * disposals, the transfers, the estimate changes, and the category/branch
 * summaries plus the roll-forward — as one right-to-left Excel workbook,
 * always over the whole filtered dataset, never just the visible page and
 * never capped: a filter that admits the rows admits the whole workbook.
 * (The xlsx format's own ~1M-row ceiling is the only refusal, and it says
 * so in Persian rather than shipping a file Excel cannot open.)
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

  try {
    const { sheets } = await fixedAssetsExportSheets(session.businessId, filters);
    const buffer = await sheetsToXlsxBuffer(sheets);
    return xlsxResponse(buffer);
  } catch (err) {
    if (err instanceof FixedAssetError && err.message === "export_too_large") {
      return NextResponse.json({ error: "export_too_large" }, { status: 413 });
    }
    throw err;
  }
});
