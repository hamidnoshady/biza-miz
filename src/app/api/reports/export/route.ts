import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { getPrimaryLocation } from "@/lib/setup-state";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { reportConfigIsMoney, reportConfigLabels, validateReportConfig, type ReportConfig } from "@/lib/reports";
import { CASH_FLOW_ACTIVITY_LABELS, getBalanceSheet, getCashFlow, getProfitAndLoss, getBusinessOverview, runCustomReportQuery } from "@/lib/reports-service";
import { moneyToInput, type MoneyUnit } from "@/lib/money";
import {
  customReportTable,
  moneyColumnLabel,
  moneyExportCell,
  rowsToCsv,
  rowsToXlsxBuffer,
  type ReportTable,
} from "@/lib/report-export";
import { renderReportLedgerHtml, renderReportTableHtml, type ReportPdfBusinessInfo } from "@/lib/report-pdf-template";
import { renderHtmlToPdf } from "@/lib/pdf-render";

type ExportFormat = "csv" | "excel" | "pdf";

interface ExportBody {
  format?: ExportFormat;
  title?: string;
  kind?: "chart" | "pnl" | "balance_sheet" | "cash_flow" | "business_overview";
  config?: ReportConfig;
  dateFrom?: string;
  dateTo?: string;
}

async function getBusinessInfo(businessId: string): Promise<ReportPdfBusinessInfo> {
  const { rows } = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [businessId]);
  const location = await getPrimaryLocation(businessId);
  return { name: rows[0]?.name ?? "", address: location?.address ?? null, phone: location?.phone ?? null };
}

/** filename carries Persian text — a bare `filename=` header value must be a ByteString (ASCII), so it's RFC 5987-encoded with an ASCII fallback for older clients. */
function fileResponse(body: string | Buffer, contentType: string, filename: string): NextResponse {
  const ext = filename.slice(filename.lastIndexOf("."));
  const encoded = encodeURIComponent(filename);
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="report${ext}"; filename*=UTF-8''${encoded}`,
    },
  });
}

function periodLabel(dateFrom?: string, dateTo?: string): string {
  if (dateFrom && dateTo) return `از ${toPersianDigits(formatJalali(dateFrom))} تا ${toPersianDigits(formatJalali(dateTo))}`;
  if (dateTo) return `تا تاریخ ${toPersianDigits(formatJalali(dateTo))}`;
  if (dateFrom) return `از تاریخ ${toPersianDigits(formatJalali(dateFrom))}`;
  return "تمام بازه‌ها";
}

/** Exports a report (custom or standard chart config, or P&L/Balance Sheet) as CSV, Excel, or PDF. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsExport);
  if (error) return error;
  const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs);
  const unit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";

  let body: ExportBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const format = body.format;
  if (format !== "csv" && format !== "excel" && format !== "pdf") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const kind = body.kind ?? "chart";

  if (kind === "chart") {
    if (!body.config) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const errors = validateReportConfig(body.config);
    if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });

    const { dimensionLabel, metricLabel, viewLabel } = reportConfigLabels(body.config);
    const rows = await runCustomReportQuery(session.businessId, body.config);
    // A money metric is stored in integer Rial; the file speaks the business's
    // selected unit and says which one in the header, like the statements do.
    const table: ReportTable = customReportTable(
      rows,
      { dimensionLabel, metricLabel },
      { isMoney: reportConfigIsMoney(body.config), unit, format },
    );
    const title = body.title?.trim() || viewLabel;
    return respondWithTable(table, title, format, session.businessId, body.config.filters);
  }

  if (kind === "pnl") {
    const report = await getProfitAndLoss(session.businessId, { dateFrom: body.dateFrom, dateTo: body.dateTo });
    const title = body.title?.trim() || "صورت سود و زیان";
    if (format === "pdf") {
      const html = renderReportLedgerHtml({
        business: await getBusinessInfo(session.businessId),
        title,
        generatedAt: new Date(),
        periodLabel: periodLabel(body.dateFrom, body.dateTo),
        sections: [
          { heading: "درآمدها", rows: report.revenue.map((l) => ({ code: l.accountCode, name: l.accountName, amount: l.amount })), totalLabel: "جمع درآمدها", totalAmount: report.totalRevenue },
          { heading: "هزینه‌ها", rows: report.expenses.map((l) => ({ code: l.accountCode, name: l.accountName, amount: l.amount })), totalLabel: "جمع هزینه‌ها", totalAmount: report.totalExpenses },
        ],
        grandTotalLabel: "سود (زیان) خالص",
        grandTotalAmount: report.netIncome,
        unit,
      });
      return fileResponse(await renderHtmlToPdf(html), "application/pdf", `${title}.pdf`);
    }
    const table = ledgerTable(
      [
        ["درآمدها", report.revenue],
        ["هزینه‌ها", report.expenses],
      ],
      [["جمع کل", "", report.netIncome]],
      unit,
    );
    return respondWithTable(table, title, format, session.businessId);
  }

  if (kind === "balance_sheet") {
    const report = await getBalanceSheet(session.businessId, body.dateTo);
    const title = body.title?.trim() || "ترازنامه";
    if (format === "pdf") {
      const html = renderReportLedgerHtml({
        business: await getBusinessInfo(session.businessId),
        title,
        generatedAt: new Date(),
        periodLabel: periodLabel(undefined, body.dateTo),
        sections: [
          { heading: "دارایی‌ها", rows: report.assets.map((l) => ({ code: l.accountCode, name: l.accountName, amount: l.amount })), totalLabel: "جمع دارایی‌ها", totalAmount: report.totalAssets },
          { heading: "بدهی‌ها", rows: report.liabilities.map((l) => ({ code: l.accountCode, name: l.accountName, amount: l.amount })), totalLabel: "جمع بدهی‌ها", totalAmount: report.totalLiabilities },
          { heading: "حقوق صاحبان سرمایه", rows: [...report.equity.map((l) => ({ code: l.accountCode, name: l.accountName, amount: l.amount })), { code: "", name: "سود انباشته (جاری)", amount: report.retainedEarnings }], totalLabel: "جمع حقوق صاحبان سرمایه", totalAmount: report.totalEquity },
        ],
        grandTotalLabel: "بدهی‌ها + حقوق صاحبان سرمایه",
        grandTotalAmount: report.totalLiabilities + report.totalEquity,
        unit,
      });
      return fileResponse(await renderHtmlToPdf(html), "application/pdf", `${title}.pdf`);
    }
    const table = ledgerTable(
      [
        ["دارایی‌ها", report.assets],
        ["بدهی‌ها", report.liabilities],
        ["حقوق صاحبان سرمایه", [...report.equity, { accountCode: "", accountName: "سود انباشته (جاری)", amount: report.retainedEarnings }]],
      ],
      [["جمع دارایی‌ها", "", report.totalAssets], ["جمع بدهی‌ها + حقوق صاحبان سرمایه", "", report.totalLiabilities + report.totalEquity]],
      unit,
    );
    return respondWithTable(table, title, format, session.businessId);
  }

  if (kind === "cash_flow") {
    const report = await getCashFlow(session.businessId, { dateFrom: body.dateFrom, dateTo: body.dateTo });
    const title = body.title?.trim() || "صورت گردش وجوه نقد";
    const activities = (["operating", "investing", "financing"] as const).map((activity) => ({
      activity,
      heading: CASH_FLOW_ACTIVITY_LABELS[activity],
      lines: report.lines.filter((l) => l.activity === activity),
      total: report.activities[activity],
    }));
    if (format === "pdf") {
      const html = renderReportLedgerHtml({
        business: await getBusinessInfo(session.businessId),
        title,
        generatedAt: new Date(),
        periodLabel: periodLabel(body.dateFrom, body.dateTo),
        sections: [
          ...activities.map((a) => ({
            heading: a.heading,
            rows: a.lines.map((l) => ({ code: "", name: l.label, amount: l.amount })),
            totalLabel: `جمع ${a.heading}`,
            totalAmount: a.total,
          })),
          {
            heading: "مانده و افشا",
            rows: [
              { code: "", name: "موجودی ابتدای دوره", amount: report.openingCash },
              { code: "", name: "تغییر وجوه در راه (جزو نقد نیست)", amount: report.clearingChange },
            ],
            totalLabel: "تغییر خالص وجه نقد",
            totalAmount: report.netChange,
          },
        ],
        grandTotalLabel: "موجودی پایان دوره",
        grandTotalAmount: report.closingCash,
        unit,
      });
      return fileResponse(await renderHtmlToPdf(html), "application/pdf", `${title}.pdf`);
    }
    const table = ledgerTable(
      activities.map((a) => [a.heading, a.lines.map((l) => ({ accountCode: "", accountName: l.label, amount: l.amount }))] as [string, { accountCode: string; accountName: string; amount: number }[]]),
      [
        ["موجودی ابتدای دوره", "", report.openingCash],
        ["موجودی پایان دوره", "", report.closingCash],
        ["تغییر خالص", "", report.netChange],
        ["تغییر وجوه در راه (جزو نقد نیست)", "", report.clearingChange],
      ],
      unit,
    );
    return respondWithTable(table, title, format, session.businessId);
  }

  if (kind === "business_overview") {
    const overview = await getBusinessOverview(session.businessId, {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
    });
    const title = body.title?.trim() || "مقایسهٔ عملکرد شعب";

    // Money columns: a spreadsheet gets the number in the selected unit with
    // the unit in its header; the PDF gets the formatted text. They used to
    // carry raw Rial under a unit-less header — ten times the Toman figure.
    const moneyLabel = (label: string) => (format === "pdf" ? label : moneyColumnLabel(label, unit));
    const tableColumns = [
      { key: "branch", label: "شعبه" },
      { key: "status", label: "وضعیت" },
      { key: "orderCount", label: "تعداد سفارش" },
      { key: "subtotal", label: moneyLabel("فروش ناخالص") },
      { key: "discount", label: moneyLabel("تخفیف") },
      { key: "tax", label: moneyLabel("مالیات") },
      { key: "total", label: moneyLabel("فروش خالص") },
      { key: "cogs", label: moneyLabel("بهای تمام‌شده") },
      { key: "wasteCost", label: moneyLabel("ضایعات") },
      { key: "grossProfit", label: moneyLabel("سود ناخالص") },
      { key: "margin", label: "حاشیه سود (%)" },
      { key: "avgTicket", label: moneyLabel("میانگین فاکتور") },
      { key: "share", label: "سهم از کل (%)" },
    ];

    const money = (rial: number) => moneyExportCell(rial, unit, format);

    const rows: Record<string, unknown>[] = overview.branches.map((b) => {
      const grossProfit = b.total - b.cogs;
      const margin = b.total > 0 ? ((grossProfit / b.total) * 100).toFixed(1) : "0";
      const avgTicket = b.orderCount > 0 ? Math.round(b.total / b.orderCount) : 0;
      const share =
        overview.consolidated.total > 0
          ? ((b.total / overview.consolidated.total) * 100).toFixed(1)
          : "0";

      return {
        branch: b.locationName,
        status: b.isActive ? "فعال" : "غیرفعال",
        orderCount: b.orderCount,
        subtotal: money(b.subtotal),
        discount: money(b.discount),
        tax: money(b.tax),
        total: money(b.total),
        cogs: money(b.cogs),
        wasteCost: money(b.wasteCost),
        grossProfit: money(grossProfit),
        margin: `${margin}%`,
        avgTicket: money(avgTicket),
        share: `${share}%`,
      };
    });

    const cGrossProfit = overview.consolidated.total - overview.consolidated.cogs;
    const cMargin =
      overview.consolidated.total > 0
        ? ((cGrossProfit / overview.consolidated.total) * 100).toFixed(1)
        : "0";
    const cAvgTicket =
      overview.consolidated.orderCount > 0
        ? Math.round(overview.consolidated.total / overview.consolidated.orderCount)
        : 0;

    rows.push({
      branch: "مجموع کسب‌وکار",
      status: "—",
      orderCount: overview.consolidated.orderCount,
      subtotal: money(overview.consolidated.subtotal),
      discount: money(overview.consolidated.discount),
      tax: money(overview.consolidated.tax),
      total: money(overview.consolidated.total),
      cogs: money(overview.consolidated.cogs),
      wasteCost: money(overview.consolidated.wasteCost),
      grossProfit: money(cGrossProfit),
      margin: `${cMargin}%`,
      avgTicket: money(cAvgTicket),
      share: "۱۰۰٪",
    });

    const table: ReportTable = {
      columns: tableColumns,
      rows,
    };

    return respondWithTable(table, title, format, session.businessId, {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
    });
  }

  return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
});

/**
 * The financial statements' shared CSV/Excel shape. Amounts are converted to
 * the business's display unit (the screen and the PDF already read in that
 * unit — the file formats used to carry raw Rial, so one report disagreed
 * with itself by a factor of ten across formats) and the column says which.
 */
function ledgerTable(
  sections: [string, { accountCode: string; accountName: string; amount: number }[]][],
  totals: [string, string, number][],
  unit: MoneyUnit,
): ReportTable {
  const inUnit = (amount: number) => moneyToInput(amount, unit);
  const unitLabel = unit === "rial" ? "ریال" : "تومان";
  const rows: Record<string, unknown>[] = [];
  for (const [heading, lines] of sections) {
    for (const l of lines) rows.push({ section: heading, code: l.accountCode, name: l.accountName, amount: inUnit(l.amount) });
  }
  for (const [label, , amount] of totals) rows.push({ section: label, code: "", name: "", amount: inUnit(amount) });
  return {
    columns: [
      { key: "section", label: "بخش" },
      { key: "code", label: "کد" },
      { key: "name", label: "حساب" },
      { key: "amount", label: `مبلغ (${unitLabel})` },
    ],
    rows,
  };
}

async function respondWithTable(
  table: ReportTable,
  title: string,
  format: ExportFormat,
  businessId: string,
  filters?: { dateFrom?: string; dateTo?: string },
): Promise<NextResponse> {
  if (format === "csv") {
    return fileResponse(rowsToCsv(table), "text/csv; charset=utf-8", `${title}.csv`);
  }
  if (format === "excel") {
    const buffer = await rowsToXlsxBuffer(table, title);
    return fileResponse(
      buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      `${title}.xlsx`,
    );
  }
  const html = renderReportTableHtml({
    business: await getBusinessInfo(businessId),
    title,
    generatedAt: new Date(),
    filterSummary: periodLabel(filters?.dateFrom, filters?.dateTo),
    columns: table.columns,
    rows: table.rows,
  });
  return fileResponse(await renderHtmlToPdf(html), "application/pdf", `${title}.pdf`);
}
