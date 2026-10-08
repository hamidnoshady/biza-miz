"use client";

import { toPersianDigits } from "@/lib/digits";
import { formatJalali, formatShiftWindow } from "@/lib/jalali";

export interface ReportRow {
  dim: string | null;
  value: string | number | null;
}

export type ChartType = "line" | "bar" | "pie" | "number";
export type Aggregation = "sum" | "avg" | "count" | "count_distinct";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** dim comes back over JSON as a plain string — Jalali-format it if it looks like an ISO date, otherwise it's already an entity label (item name, staff name, …). */
export function formatDim(dim: string | null): string {
  if (dim === null) return "—";
  const window = formatShiftWindow(dim);
  if (window) return window;
  if (ISO_DATE_RE.test(dim)) return toPersianDigits(formatJalali(dim));
  return dim;
}

export function rowsToChartData(rows: ReportRow[]) {
  return rows.map((r) => ({ label: formatDim(r.dim), value: Number(r.value) || 0 }));
}

export interface ExportRequest {
  format: "csv" | "excel" | "pdf";
  title: string;
  kind?:
    | "chart"
    | "pnl"
    | "balance_sheet"
    | "cash_flow"
    | "business_overview"
    | "trial_balance"
    | "shift_orders";
  /**
   * The config the screen is showing, sent verbatim — a structured type like
   * the builder's `BuilderConfig` is fine here; the route validates it again.
   */
  config?: object;
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  trialBalanceOptions?: {
    presentation: "detailed" | "closing";
    search?: string;
    accountType?: "all" | "asset" | "liability" | "equity" | "revenue" | "expense";
    accountStatus?: "all" | "active" | "archived";
    includeZeroBalances?: boolean;
  };
  /** The shift screen's own query string; only read by the `shift_orders` kind. */
  query?: string;
}

/** POSTs /api/reports/export and triggers a browser download of the returned file. */
export async function triggerExport(req: ExportRequest): Promise<string | null> {
  try {
    const res = await fetch("/api/reports/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return data.error ?? "خطا در دریافت خروجی.";
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : `${req.title}.${req.format === "excel" ? "xlsx" : req.format}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch {
    return "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.";
  }
}
