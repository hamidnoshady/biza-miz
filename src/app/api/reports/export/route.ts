import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { getPrimaryLocation, resolveActiveLocation } from "@/lib/setup-state";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { parseReportOrderFilters } from "@/lib/report-order-filters";
import { reportConfigIsMoney, reportConfigLabels, validateReportConfig, type ReportConfig } from "@/lib/reports";
import { shiftOrdersExportTable } from "@/lib/shift-orders-export";
import { getShiftOrdersReport } from "@/lib/shift-orders-service";
import type { ShiftOrder } from "@/lib/shift-orders";
import { CASH_FLOW_ACTIVITY_LABELS, getBalanceSheet, getCashFlow, getProfitAndLoss, getBusinessOverview, runCustomReportQuery } from "@/lib/reports-service";
import { formatMoney, formatMoneyText, moneyToInput, type MoneyUnit } from "@/lib/money";
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
import { getTrialBalance } from "@/lib/ledger-reports-service";
import type { AccountType } from "@/lib/coa-template";
import { isValidIsoDate } from "@/lib/iso-date";
import {
  filterTrialBalanceRows,
  type TrialBalanceAccountStatus,
  type TrialBalanceDisplayFilters,
  type TrialBalancePresentation,
} from "@/lib/trial-balance";

type ExportFormat = "csv" | "excel" | "pdf";

interface TrialBalanceExportOptions {
  presentation?: TrialBalancePresentation;
  search?: string;
  accountType?: AccountType | "all";
  accountStatus?: TrialBalanceAccountStatus;
  includeZeroBalances?: boolean;
}

interface ExportBody {
  format?: ExportFormat;
  title?: string;
  kind?:
    | "chart"
    | "pnl"
    | "balance_sheet"
    | "cash_flow"
    | "business_overview"
    | "trial_balance"
    | "shift_orders";
  config?: ReportConfig;
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  trialBalanceOptions?: TrialBalanceExportOptions;
  /**
   * The shift screen's own query string (`/api/reports/shift-orders?...`).
   * Parsed here by `parseReportOrderFilters` — the same validator that route
   * uses — so an export can never widen or reinterpret what was on screen.
   */
  query?: string;
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

/**
 * Exports a report (custom or standard chart config, or P&L/Balance Sheet) as
 * CSV, Excel, or PDF.
 *
 * ## Authorization (issue #819)
 *
 * `reports.export` gates every *file* — that is the capability's meaning, and
 * it is checked here once rather than through a per-kind copy.
 *
 * The consolidated `business_overview` kind additionally requires
 * `reports.business_wide`, checked inside its branch below: it is the only kind
 * whose numbers span every branch, and without the second check the export
 * endpoint would be a way around the branch-comparison route's own gate. The
 * `chart` kind is branch-scoped with the same resolved location the query route
 * uses, so the file and the screen are the same report.
 */
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

  if (kind === "trial_balance") {
    // Exporting this accounting report requires both the existing export grant
    // (checked above) and the same ledger-view grant as its on-screen route.
    const { error: ledgerViewError } = await requirePermission(PERMISSIONS.ledgerView);
    if (ledgerViewError) return ledgerViewError;

    const asOf = body.asOf;
    const dateFrom = body.dateFrom;
    const dateTo = body.dateTo;
    if (
      (asOf !== undefined &&
        (!isValidIsoDate(asOf) || dateFrom !== undefined || dateTo !== undefined)) ||
      (asOf === undefined &&
        (!isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo) || dateFrom! > dateTo!))
    ) {
      return NextResponse.json({ error: "invalid_report_scope" }, { status: 400 });
    }

    const requestedOptions = body.trialBalanceOptions ?? {};
    const validTypes = new Set<AccountType>(["asset", "liability", "equity", "revenue", "expense"]);
    if (
      (requestedOptions.presentation !== undefined &&
        requestedOptions.presentation !== "detailed" && requestedOptions.presentation !== "closing") ||
      (requestedOptions.accountType !== undefined &&
        requestedOptions.accountType !== "all" && !validTypes.has(requestedOptions.accountType)) ||
      (requestedOptions.accountStatus !== undefined &&
        !["all", "active", "archived"].includes(requestedOptions.accountStatus)) ||
      (requestedOptions.includeZeroBalances !== undefined &&
        typeof requestedOptions.includeZeroBalances !== "boolean") ||
      (requestedOptions.search !== undefined &&
        (typeof requestedOptions.search !== "string" || requestedOptions.search.length > 200))
    ) {
      return NextResponse.json({ error: "invalid_trial_balance_filter" }, { status: 400 });
    }

    const report = await getTrialBalance(
      session.businessId,
      asOf !== undefined ? { asOf } : { dateFrom: dateFrom!, dateTo: dateTo! },
    );
    const presentation: TrialBalancePresentation = report.mode;
    const displayFilters: TrialBalanceDisplayFilters = {
      ...requestedOptions,
      presentation,
      includeZeroBalances: requestedOptions.includeZeroBalances ?? false,
    };
    const accounts = filterTrialBalanceRows(report.accounts, displayFilters);
    const title = body.title?.trim() || "تراز آزمایشی";
    const generatedAt = new Date();
    const generatedLabel = toPersianDigits(formatJalali(generatedAt, { withMonthName: true }));
    const scopeLabel = report.mode === "closing"
      ? `مانده در تاریخ ${toPersianDigits(formatJalali(report.periodTo))} — دفتر تجمیعی همهٔ شعب`
      : `${periodLabel(report.periodFrom ?? undefined, report.periodTo)} — دفتر تجمیعی همهٔ شعب`;
    // Lines, not entries: a journal header that arrived with no lines leaves
    // both columns at zero, and zero equals zero is not a verdict.
    const trialBalanceLabel = report.activity.lineCount === 0
      ? "بدون سند تا تاریخ گزارش؛ تراز هنوز قابل تأیید نیست"
      : report.trialBalanceBalanced ? "مانده‌های پایان دوره برابر است" : "مانده‌های پایان دوره نامتوازن است";
    const ledgerHealthLabel = report.integrity.ledgerHealthy
      ? "دفتر سالم است"
      : `دفتر نیازمند بازبینی: ${toPersianDigits(report.integrity.unbalancedEntryCount)} سند نامتوازن، ${toPersianDigits(report.integrity.invalidEntryCount)} سند ناقص`;
    const accountTypeLabels: Record<AccountType, string> = {
      asset: "دارایی", liability: "بدهی", equity: "حقوق صاحبان سرمایه", revenue: "درآمد", expense: "هزینه",
    };
    const accountLevelLabels: Record<string, string> = {
      group: "گروه", kol: "کل", moein: "معین", tafsili: "تفصیلی",
    };
    const activeLabel = (active: boolean) => active ? "فعال" : "بایگانی‌شده";
    const emptyAmounts = {
      openingDebit: "", openingCredit: "", periodDebit: "", periodCredit: "",
      closingDebit: "", closingCredit: "",
    };
    const reportRows: Record<string, unknown>[] = accounts.map((account) => ({
      code: account.code,
      name: account.name,
      type: accountTypeLabels[account.type],
      level: accountLevelLabels[account.level],
      status: activeLabel(account.isActive),
      openingDebit: account.openingDebit,
      openingCredit: account.openingCredit,
      periodDebit: account.periodDebit,
      periodCredit: account.periodCredit,
      closingDebit: account.closingDebit,
      closingCredit: account.closingCredit,
    }));
    const totalRow: Record<string, unknown> = {
      code: "جمع حساب‌های نمایش‌داده‌شده",
      name: "",
      type: "",
      level: "",
      status: "",
      ...reportRows.reduce<Record<string, string>>((sum, row) => {
        for (const key of Object.keys(emptyAmounts)) {
          sum[key] = (BigInt(sum[key] || "0") + BigInt(String(row[key] || "0"))).toString();
        }
        return sum;
      }, { ...emptyAmounts }),
    };
    const statusRows: Record<string, unknown>[] = [
      { code: "وضعیت تراز کل گزارش", name: trialBalanceLabel, type: "", level: "", status: "", ...emptyAmounts },
      { code: "سلامت دفتر", name: ledgerHealthLabel, type: "", level: "", status: "", ...emptyAmounts },
    ];
    const metadataRows: Record<string, unknown>[] = [
      { code: "کسب‌وکار", name: report.businessName, type: "", level: "", status: "", ...emptyAmounts },
      { code: "گزارش", name: title, type: "", level: "", status: "", ...emptyAmounts },
      { code: "بازه", name: scopeLabel, type: "", level: "", status: "", ...emptyAmounts },
      { code: "تاریخ تولید", name: generatedLabel, type: "", level: "", status: "", ...emptyAmounts },
    ];
    /*
     * One column set, labelled with the unit its cells actually carry.
     *
     * CSV and Excel get **integer Rial as text**, deliberately: a spreadsheet
     * stores numbers as IEEE doubles, so writing a balance above
     * `Number.MAX_SAFE_INTEGER` as a numeric cell would silently round a Rial
     * away — the exact failure the report exists to avoid. Text keeps every
     * digit. The PDF is for reading, so it is rendered in the business's own
     * display unit through the same BigInt-safe formatter the screen uses.
     */
    const unitLabel = unit === "rial" ? "ریال" : "تومان";
    const amountColumns = (labelUnit: string) => [
      ...(presentation === "detailed"
        ? [
            { key: "openingDebit", label: `مانده افتتاحیه بدهکار (${labelUnit})` },
            { key: "openingCredit", label: `مانده افتتاحیه بستانکار (${labelUnit})` },
            { key: "periodDebit", label: `گردش بدهکار دوره (${labelUnit})` },
            { key: "periodCredit", label: `گردش بستانکار دوره (${labelUnit})` },
          ]
        : []),
      { key: "closingDebit", label: `مانده پایان بدهکار (${labelUnit})` },
      { key: "closingCredit", label: `مانده پایان بستانکار (${labelUnit})` },
    ];
    const identityColumns = [
      { key: "code", label: "کد حساب" },
      { key: "name", label: "نام حساب" },
      { key: "type", label: "نوع حساب" },
      { key: "level", label: "سطح" },
      { key: "status", label: "وضعیت" },
    ];

    if (format === "pdf") {
      const pdfRows = [...reportRows, totalRow, ...statusRows].map((row) => {
        const formatted = { ...row };
        for (const key of Object.keys(emptyAmounts)) {
          if (typeof formatted[key] === "string" && formatted[key]) {
            formatted[key] = formatMoneyText(String(formatted[key]), unit);
          }
        }
        return formatted;
      });
      const html = renderReportTableHtml({
        business: await getBusinessInfo(session.businessId),
        title,
        generatedAt,
        filterSummary: `${scopeLabel} — ${trialBalanceLabel} — ${ledgerHealthLabel}`,
        columns: [...identityColumns, ...amountColumns(unitLabel)],
        rows: pdfRows,
      });
      return fileResponse(await renderHtmlToPdf(html), "application/pdf", `${title}.pdf`);
    }

    const table: ReportTable = {
      columns: [...identityColumns, ...amountColumns("ریال")],
      rows: [...metadataRows, ...reportRows, totalRow, ...statusRows],
    };
    return respondWithTable(table, title, format, session.businessId);
  }

  if (kind === "chart") {
    if (!body.config) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const errors = validateReportConfig(body.config);
    if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });

    const { dimensionLabel, metricLabel, viewLabel } = reportConfigLabels(body.config);
    // Issue #819: the export must be the same report the screen showed, which
    // means the same branch. Phase 14's branch isolation is enforced by the
    // application, so the resolved active location is passed exactly as the
    // query route passes it — the file cannot aggregate a sibling branch the
    // member may not report on. Never read a location from the body.
    const location = await resolveActiveLocation(session);
    const rows = await runCustomReportQuery(session.businessId, body.config, location?.id);
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

  if (kind === "shift_orders") {
    // The detailed shift file (issue #819): every page of the shift report,
    // not just the 25 rows the screen is showing. The screen's filters are
    // re-parsed with the same validator its API uses, and the file is scoped
    // to the same resolved branch.
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 400 });

    const parsed = parseReportOrderFilters(new URLSearchParams(body.query ?? ""));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const filters = { ...parsed.filters, timeZone: location.timezone };
    const orders: ShiftOrder[] = [];
    let page = 1;
    let pageCount = 1;
    do {
      const report = await getShiftOrdersReport(location.id, { ...filters, page, pageSize: 100 });
      if (!report) return NextResponse.json({ error: "shift_not_found" }, { status: 404 });
      orders.push(...report.orders);
      pageCount = report.pageCount;
      page += 1;
    } while (page <= pageCount);

    const title = body.title?.trim() || "سفارش‌های شیفت";
    // A printed page cannot hold 21 columns legibly; the PDF drops the free-text
    // context columns the spreadsheets keep (issue #819).
    return respondWithTable(
      shiftOrdersExportTable(orders, unit, { layout: format === "pdf" ? "pdf" : "full" }),
      title,
      format,
      session.businessId,
      {
        dateFrom: parsed.filters.dateFrom,
        dateTo: parsed.filters.dateTo,
      },
    );
  }

  if (kind === "business_overview") {
    // The one kind whose numbers span branches: the same capability that opens
    // the branch-comparison screen gates its file (issue #819).
    const wide = await requirePermission(PERMISSIONS.reportsBusinessWide);
    if (wide.error) return wide.error;

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
