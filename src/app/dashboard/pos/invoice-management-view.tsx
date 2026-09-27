"use client";

import { EmptyState, SectionCardSkeleton, StatusBadge, cardClass } from "../page-chrome";
import { useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { DownloadIcon, EyeIcon, RefreshCwIcon } from "lucide-react";
import { api, ErrorBox, errorMessage, inputClass } from "../ui";
import { JalaliDatePicker } from "../jalali-date-picker";
import { RetailInvoiceDetailModal } from "./retail-invoice-detail-modal";

/**
 * «مدیریت فاکتورها» — the sales history as a managed list: search by customer
 * or invoice number, filter by settlement method, paginate, export, and open an
 * invoice to inspect or reprint it. It reads the same order-backed document the
 * issue screen posts to (/api/sales/invoices), never a second record.
 */

interface InvoicePaymentMethodSummary {
  method: string;
  name: string;
}

interface InvoiceRow {
  id: string;
  orderNumber: number;
  status: "completed" | "voided";
  total: number;
  closedAt: string;
  customerName: string | null;
  lineCount: number;
  /** Every distinct way this invoice was settled with — see list-service.ts's own doc comment. */
  paymentMethods: InvoicePaymentMethodSummary[];
}

type MethodFilter = "" | "cash" | "bank" | "credit";
type StatusFilter = "" | "completed" | "voided";

interface InvoiceFilters {
  q: string;
  method: MethodFilter;
  status: StatusFilter;
  dateFrom: string;
  dateTo: string;
}

// A pure module-level helper (not a hook-scoped closure) so both the list
// fetch effect and both export actions build query params from the exact
// same rule without ESLint treating it as an unstable effect dependency.
function filterParams(f: InvoiceFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.method) params.set("method", f.method);
  if (f.status) params.set("status", f.status);
  if (f.dateFrom) params.set("dateFrom", f.dateFrom);
  if (f.dateTo) params.set("dateTo", f.dateTo);
  return params;
}

function fmtJalali(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  try {
    return toPersianDigits(formatJalali(iso, { timeZone }));
  } catch {
    return "—";
  }
}

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-foreground  hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"
  }`;

export function InvoiceManagementView({ canVoidInvoice = false }: { canVoidInvoice?: boolean } = {}) {
  const money = useMoney();
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<MethodFilter>("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [count, setCount] = useState(0);
  const [timeZone, setTimeZone] = useState("Asia/Tehran");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"page" | "all" | null>(null);
  const requestId = useRef(0);
  const pageSize = 20;

  useEffect(() => {
    setPage(1);
  }, [q, method, status, dateFrom, dateTo]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    const controller = new AbortController();
    const params = filterParams({ q, method, status, dateFrom, dateTo });
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    // Keep the previous page visible while a filter is loading. This avoids a
    // distracting flash of skeletons during normal cashier typing, while the
    // first load still gets a proper content-shaped placeholder.
    setLoading(true);
    const delay = q.trim() ? 250 : 0;
    const timer = window.setTimeout(() => {
      void api<{
        invoices: InvoiceRow[];
        count: number;
        timeZone?: string;
        error?: string;
      }>(`/api/sales/invoices?${params.toString()}`, { signal: controller.signal }).then(({ ok, data, aborted }) => {
        if (aborted || currentRequest !== requestId.current) return;
        if (ok) {
          setRows(data.invoices);
          setCount(data.count);
          setTimeZone(data.timeZone || "Asia/Tehran");
          setError("");
        } else {
          setError(errorMessage(data.error));
        }
      }).finally(() => {
        if (!controller.signal.aborted && currentRequest === requestId.current) setLoading(false);
      });
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [method, status, dateFrom, dateTo, page, q, refreshKey]);

  const pageCount = Math.max(Math.ceil(count / pageSize), 1);

  function openInvoice(id: string) {
    setSelectedInvoiceId(id);
  }

  /**
   * Both export actions hit the server's own CSV writer
   * (GET /api/sales/invoices?format=csv) instead of building a second,
   * hand-rolled CSV client-side: one codec, one formula-injection guard
   * (see report-export.ts), used by every export surface in the app.
   * `scope: "page"` sends the same page/pageSize the screen is showing;
   * `scope: "all"` drops pagination and asks the server for every row
   * matching the current filters (bounded by EXPORT_ROW_CAP).
   */
  async function exportCsv(scope: "page" | "all") {
    setExporting(scope);
    setError("");
    try {
      const params = filterParams({ q, method, status, dateFrom, dateTo });
      params.set("format", "csv");
      if (scope === "all") {
        params.set("all", "true");
      } else {
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
      }
      const res = await fetch(`/api/sales/invoices?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as { error?: string });
        setError(errorMessage(data.error));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = scope === "all" ? "invoices-all.csv" : "invoices.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("خطا در دریافت خروجی.");
    } finally {
      setExporting(null);
    }
  }

  const paymentMethodsLabel = (row: InvoiceRow) =>
    row.paymentMethods.length > 0 ? row.paymentMethods.map((m) => m.name).join("، ") : "روش نامشخص";
  const renderPayment = (row: InvoiceRow) => (
    <StatusBadge tone={row.paymentMethods.some((m) => m.method === "credit") ? "active" : "neutral"}>
      {paymentMethodsLabel(row)}
    </StatusBadge>
  );
  const renderStatus = (row: InvoiceRow) => (
    <StatusBadge tone={row.status === "voided" ? "danger" : "positive"}>
      {row.status === "voided" ? "باطل‌شده" : "تکمیل‌شده"}
    </StatusBadge>
  );

  return (
    <>
      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت فاکتور</p>
            <h2 className="mt-1 font-semibold text-foreground">همه فاکتورها</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              فهرست فاکتورهای ثبت‌شدهٔ این شعبه؛ جست‌وجو، فیلتر روش پرداخت، مشاهدهٔ جزئیات و چاپ مجدد.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <button
              type="button"
              onClick={() => setRefreshKey((key) => key + 1)}
              disabled={loading}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:flex-none"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              به‌روزرسانی
            </button>
            <button
              type="button"
              onClick={() => void exportCsv("page")}
              disabled={!rows || rows.length === 0 || loading || exporting !== null}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:flex-none"
              title="خروجی فاکتورهای همین صفحه"
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              {exporting === "page" ? "در حال تهیه…" : "خروجی این صفحه"}
            </button>
            <button
              type="button"
              onClick={() => void exportCsv("all")}
              disabled={count === 0 || loading || exporting !== null}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:flex-none"
              title="خروجی همهٔ فاکتورهای منطبق با فیلتر فعلی، صرف‌نظر از صفحه‌بندی"
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              {exporting === "all" ? "در حال تهیه…" : `خروجی کامل (${toPersianDigits(count)} فاکتور)`}
            </button>
          </div>
        </div>

        <ErrorBox>{error}</ErrorBox>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="روش پرداخت">
            <button type="button" aria-pressed={method === ""} className={chipClass(method === "")} onClick={() => setMethod("")}>همه</button>
            <button type="button" aria-pressed={method === "cash"} className={chipClass(method === "cash")} onClick={() => setMethod("cash")}>نقدی</button>
            <button type="button" aria-pressed={method === "bank"} className={chipClass(method === "bank")} onClick={() => setMethod("bank")}>بانکی</button>
            <button type="button" aria-pressed={method === "credit"} className={chipClass(method === "credit")} onClick={() => setMethod("credit")}>اعتباری</button>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="وضعیت فاکتور">
            <button type="button" aria-pressed={status === ""} className={chipClass(status === "")} onClick={() => setStatus("")}>همه وضعیت‌ها</button>
            <button type="button" aria-pressed={status === "completed"} className={chipClass(status === "completed")} onClick={() => setStatus("completed")}>تکمیل‌شده</button>
            <button type="button" aria-pressed={status === "voided"} className={chipClass(status === "voided")} onClick={() => setStatus("voided")}>باطل‌شده</button>
          </div>
          <div className="min-w-0 sm:ms-auto sm:w-64">
            <label htmlFor="invoice-history-search" className="sr-only">جست‌وجوی مشتری یا شماره فاکتور</label>
            <input
              id="invoice-history-search"
              className={`${inputClass} h-11 w-full`}
              placeholder="جست‌وجوی مشتری یا شماره فاکتور…"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 sm:max-w-md">
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از ابتدا" ariaLabel="از تاریخ" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
            <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا امروز" ariaLabel="تا تاریخ" />
          </label>
        </div>

        <div className="relative mt-4" aria-busy={loading}>
          {loading && rows ? (
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
            >
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
                در حال به‌روزرسانی…
              </span>
            </div>
          ) : null}
          {!rows && loading ? (
            <SectionCardSkeleton rows={5} label="در حال بارگذاری فاکتورها" />
          ) : !rows && error ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">فهرست فاکتورها بارگذاری نشد.</p>
              <button
                type="button"
                onClick={() => setRefreshKey((key) => key + 1)}
                className="mt-3 inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
              >
                تلاش دوباره
              </button>
            </div>
          ) : rows && rows.length === 0 ? (
            <EmptyState>فاکتوری با این مشخصات ثبت نشده است.</EmptyState>
          ) : rows ? (
            <>
              <div className="hidden overflow-x-auto rounded-xl border border-border/80 lg:block">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/60">
                      <th className="py-3 pe-3 ps-4 text-start text-xs font-medium text-muted-foreground">#</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">شماره فاکتور</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">مشتری</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">اقلام</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">وضعیت</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">روش پرداخت</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">مبلغ</th>
                      <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground">تاریخ ثبت</th>
                      <th className="py-3 pe-4 text-start text-xs font-medium text-muted-foreground">عملیات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={row.id} className="border-b border-border transition-colors last:border-b-0 hover:bg-muted">
                        <td className="py-3 pe-3 ps-4 text-muted-foreground">{toPersianDigits((page - 1) * pageSize + index + 1)}</td>
                        <td className="whitespace-nowrap py-3 pe-3 font-semibold">{toPersianDigits(row.orderNumber)}</td>
                        <td className="max-w-48 truncate py-3 pe-3 font-medium">{row.customerName ?? "بدون مشتری"}</td>
                        <td className="py-3 pe-3 text-muted-foreground">{toPersianDigits(row.lineCount)} قلم</td>
                        <td className="py-3 pe-3">{renderStatus(row)}</td>
                        <td className="py-3 pe-3">{renderPayment(row)}</td>
                        <td className="whitespace-nowrap py-3 pe-3 font-semibold">{money.format(row.total)}</td>
                        <td className="whitespace-nowrap py-3 pe-3 text-muted-foreground">{fmtJalali(row.closedAt, timeZone)}</td>
                        <td className="py-3 pe-4">
                          <button
                            type="button"
                            onClick={() => openInvoice(row.id)}
                            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:border-amber-300 hover:bg-amber-50 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10"
                          >
                            <EyeIcon aria-hidden="true" className="size-4" />
                            جزئیات و چاپ
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-3 lg:hidden">
                {rows.map((row) => (
                  <article key={row.id} className="rounded-xl border border-border/80 bg-muted p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold">{row.customerName ?? "بدون مشتری"}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          فاکتور {toPersianDigits(row.orderNumber)} · {toPersianDigits(row.lineCount)} قلم · {fmtJalali(row.closedAt, timeZone)}
                        </p>
                      </div>
                      <span className="whitespace-nowrap font-bold">{money.format(row.total)}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {renderStatus(row)}
                        {renderPayment(row)}
                      </div>
                      <button
                        type="button"
                        onClick={() => openInvoice(row.id)}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:border-amber-300 hover:bg-amber-50 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10"
                      >
                        <EyeIcon aria-hidden="true" className="size-4" />
                        جزئیات و چاپ
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  صفحهٔ {toPersianDigits(page)} از {toPersianDigits(pageCount)} — {toPersianDigits(count)} نتیجه
                </p>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <button
                    type="button"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((current) => current - 1)}
                    className="inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:flex-none"
                  >
                    قبلی
                  </button>
                  <button
                    type="button"
                    disabled={page >= pageCount || loading}
                    onClick={() => setPage((current) => current + 1)}
                    className="inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:flex-none"
                  >
                    بعدی
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <RetailInvoiceDetailModal
        invoiceId={selectedInvoiceId}
        open={selectedInvoiceId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedInvoiceId(null);
        }}
        canVoid={canVoidInvoice}
        onVoided={() => setRefreshKey((key) => key + 1)}
      />
    </>
  );
}
