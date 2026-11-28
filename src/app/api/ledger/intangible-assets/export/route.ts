import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  IntangibleAssetError,
  intangibleAssetsExportSheets,
  type IntangibleListFilters,
} from "@/lib/intangible-assets-service";
import { sheetsToXlsxBuffer, type SheetData } from "@/lib/data-transfer/codecs";
import { rowsToCsv, type ReportTable } from "@/lib/report-export";
import { renderReportTableHtml, type ReportPdfBusinessInfo } from "@/lib/report-pdf-template";
import { renderHtmlToPdf } from "@/lib/pdf-render";
import { resolveBusinessBranding } from "@/lib/business-branding";
import { getPrimaryLocation } from "@/lib/setup-state";
import { isValidIsoDate } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";

export const dynamic = "force-dynamic";

/**
 * The six accountant reports, keyed by the `report` query parameter. The key
 * names the sheet it exports, so a CSV or PDF covers the same rows the xlsx
 * workbook carries in that sheet — never a second query with different rules.
 */
const REPORT_SHEETS = {
  register: 0,
  schedule: 1,
  history: 2,
  impairment: 3,
  disposal: 4,
  estimate: 5,
  reconciliation: 6,
} as const;

type ReportKey = keyof typeof REPORT_SHEETS;
type ExportFormat = "csv" | "xlsx" | "pdf";

function isReportKey(value: string | null): value is ReportKey {
  return value !== null && Object.prototype.hasOwnProperty.call(REPORT_SHEETS, value);
}

/** filename carries Persian text — RFC 5987-encoded, ASCII fallback. */
function fileResponse(body: string | Buffer, contentType: string, filename: string, fallback: string): NextResponse {
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

function sheetToTable(sheet: SheetData): ReportTable {
  return {
    columns: sheet.columns.map((column) => ({ key: column.key, label: column.label })),
    rows: sheet.rows,
  };
}

async function businessInfo(businessId: string): Promise<ReportPdfBusinessInfo> {
  const location = await getPrimaryLocation(businessId);
  const branding = await resolveBusinessBranding(businessId, location?.id ?? null);
  return {
    name: branding.businessName,
    legalName: branding.legalName,
    address: branding.address,
    phone: branding.phone,
    taxId: branding.taxId,
    email: branding.email,
    website: branding.website,
    logoDataUrl: branding.logoDataUrl,
    footer: branding.footer,
  };
}

function dateLabel(dateFrom: string | null, dateTo: string | null): string {
  if (dateFrom && dateTo) return `از ${toPersianDigits(formatJalali(dateFrom))} تا ${toPersianDigits(formatJalali(dateTo))}`;
  if (dateTo) return `تا تاریخ ${toPersianDigits(formatJalali(dateTo))}`;
  if (dateFrom) return `از تاریخ ${toPersianDigits(formatJalali(dateFrom))}`;
  return "تمام دوره‌ها";
}

/**
 * Exports the intangible-asset register and its reports as Excel, CSV or PDF
 * (issue #1326/ESH-163 phase 4).
 *
 * Read access (`ledger.view`) is the same capability the register screen and
 * its list route enforce, and every row comes from
 * `intangibleAssetsExportSheets` — the same read the screen performs. Branch
 * and date filters are the screen's own query parameters, so an export can
 * never widen the population the accountant was looking at, and the tenant is
 * taken from the session, never from a client value.
 *
 * `format=xlsx` (the default) writes the whole workbook: register, schedule,
 * posted history, impairment and reversals, disposals, estimate changes and
 * reconciliation. `format=csv` and `format=pdf` write the one `report` sheet
 * (default: the register).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const format = (params.get("format") ?? "xlsx").toLowerCase();
  if (format !== "csv" && format !== "xlsx" && format !== "pdf") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const requestedReport = params.get("report");
  const wantsAll = requestedReport === "all";
  if (requestedReport !== null && !wantsAll && !isReportKey(requestedReport)) {
    return NextResponse.json({ error: "invalid_report" }, { status: 400 });
  }
  if (wantsAll && format !== "xlsx") {
    // `all` is the workbook. A single CSV or PDF page cannot carry seven
    // sheets, so it is refused rather than silently exporting one of them.
    return NextResponse.json({ error: "invalid_report" }, { status: 400 });
  }
  const reportKey: ReportKey = isReportKey(requestedReport) ? requestedReport : "register";

  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  if (dateFrom && !isValidIsoDate(dateFrom)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  if (dateTo && !isValidIsoDate(dateTo)) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const status = params.get("status");
  const lifeType = params.get("usefulLifeType");
  const filters: IntangibleListFilters = {
    search: params.get("search"),
    status: status === "active" || status === "disposed" ? status : null,
    assetClass: params.get("assetClass"),
    usefulLifeType: lifeType === "finite" || lifeType === "indefinite" ? lifeType : null,
    locationId: params.get("locationId"),
    dateFrom,
    dateTo,
  };

  try {
    const { sheets: rawSheets } = await intangibleAssetsExportSheets(session.businessId, filters);
    // Money cells stay exact integer Rial — the register's storage unit and the
    // figure the API returns — so every money column says so in its label.
    const sheets = rawSheets.map((candidate) => ({
      ...candidate,
      columns: candidate.columns.map((column) =>
        column.type === "money" && !column.label.includes("(ریال)")
          ? { ...column, label: `${column.label} (ریال)` }
          : column,
      ),
    }));
    const sheet = sheets[REPORT_SHEETS[reportKey]];
    if (!sheet) return NextResponse.json({ error: "invalid_report" }, { status: 400 });

    if (format === "xlsx" || wantsAll) {
      const buffer = await sheetsToXlsxBuffer(sheets);
      return fileResponse(
        buffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "دارایی‌های-نامشهود.xlsx",
        "intangible-assets.xlsx",
      );
    }

    if (format === "csv") {
      return fileResponse(
        rowsToCsv(sheetToTable(sheet)),
        "text/csv; charset=utf-8",
        `${sheet.name}.csv`,
        "intangible-assets.csv",
      );
    }

    const html = renderReportTableHtml({
      business: await businessInfo(session.businessId),
      title: sheet.name,
      generatedAt: new Date(),
      filterSummary: dateLabel(dateFrom, dateTo),
      columns: sheet.columns.map((column) => ({ key: column.key, label: column.label })),
      rows: sheet.rows,
    });
    return fileResponse(
      await renderHtmlToPdf(html),
      "application/pdf",
      `${sheet.name}.pdf`,
      "intangible-assets.pdf",
    );
  } catch (err) {
    if (err instanceof IntangibleAssetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
