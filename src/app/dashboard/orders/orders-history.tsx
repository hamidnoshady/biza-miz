"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, SearchIcon, ShoppingBagIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatQueueLabel } from "@/lib/orders";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { PageShell, cardClass } from "../page-chrome";
import { api } from "../ui";
import { OrderDetailModal } from "./order-detail-modal";

type OrderStatus = "open" | "held" | "completed" | "voided";
type OrderType = "dine_in" | "takeaway" | "delivery";

interface HistoryOrder {
  id: string;
  order_number: string;
  type: OrderType;
  status: OrderStatus;
  table_id: string | null;
  table_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total: string;
  opened_at: string;
  closed_at: string | null;
}

interface HistoryResponse {
  orders: HistoryOrder[];
  page: number;
  pageSize: number;
  pageCount: number;
  totalCount: number;
  statusCounts: Record<OrderStatus, number>;
  tables: { id: string; name: string }[];
  shifts: { id: string; employeeName: string; startedAt: string; endedAt: string | null }[];
  timeZone: string;
  error?: string;
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};
const TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};
const PAGE_SIZE = 25;

function openedLabel(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function shiftLabel(shift: HistoryResponse["shifts"][number], timeZone: string): string {
  const start = formatJalali(shift.startedAt, { withMonthName: true, withTime: true, timeZone });
  const end = shift.endedAt ? formatJalali(shift.endedAt, { withTime: true, timeZone }) : "در حال انجام";
  return `${shift.employeeName} · ${start} تا ${end}`;
}

export function OrdersHistory({
  canEdit,
  canTakePayment,
  canAmendClosed,
  canRefund,
  canReviewShifts,
}: {
  canEdit: boolean;
  canTakePayment: boolean;
  canAmendClosed: boolean;
  canRefund: boolean;
  canReviewShifts: boolean;
}) {
  const money = useMoney();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [type, setType] = useState<OrderType | "all">("all");
  const [tableId, setTableId] = useState("all");
  const [shiftId, setShiftId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const requestId = useRef(0);
  const deferredSearch = useDeferredValue(search);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    const q = deferredSearch.trim();
    if (q) params.set("q", q);
    if (status !== "all") params.set("status", status);
    if (type !== "all") params.set("type", type);
    if (tableId !== "all") params.set("tableId", tableId);
    if (shiftId !== "all") params.set("shiftId", shiftId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [deferredSearch, from, page, shiftId, status, tableId, to, type]);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await api<HistoryResponse>(`/api/orders/history?${queryString}`);
      if (currentRequest !== requestId.current) return;
      if (!ok) {
        setError(data.error || "بارگذاری تاریخچهٔ سفارش‌ها ناموفق بود.");
        return;
      }
      setResult(data);
    } catch {
      if (currentRequest === requestId.current) setError("ارتباط با تاریخچهٔ سفارش‌ها برقرار نشد.");
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  function clearFilters() {
    setSearch("");
    setStatus("all");
    setType("all");
    setTableId("all");
    setShiftId("all");
    setFrom("");
    setTo("");
    setPage(1);
  }

  const timeZone = result?.timeZone ?? "Asia/Tehran";
  const pageStart = result && result.totalCount > 0 ? (result.page - 1) * result.pageSize + 1 : 0;
  const pageEnd = result ? Math.min(result.page * result.pageSize, result.totalCount) : 0;

  return (
    <PageShell>
      <header className={`mb-3 flex flex-col gap-3 ${cardClass} p-4 sm:flex-row sm:items-center sm:justify-between`}>
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
            <ShoppingBagIcon className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-bold text-foreground">تاریخچهٔ سفارش‌ها</h1>
            <p className="mt-1 text-xs text-muted-foreground">جستجو و مرور همهٔ سفارش‌های شعبه، بر پایهٔ زمان ثبت سفارش</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/accounting/orders" className="flex min-h-11 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-xs font-bold text-foreground hover:bg-muted">
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            صف زنده
          </Link>
          <button type="button" onClick={() => void load()} disabled={loading} className="flex min-h-11 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-xs font-bold text-foreground hover:bg-muted disabled:opacity-60">
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            تازه‌سازی
          </button>
        </div>
      </header>

      <section className={`${cardClass} mb-3 space-y-3 p-4`} aria-label="فیلترهای تاریخچهٔ سفارش‌ها">
        <label className="relative block">
          <span className="sr-only">جستجو در شمارهٔ سفارش، مشتری یا شمارهٔ تماس</span>
          <SearchIcon className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            className="min-h-12 w-full rounded-xl border border-border/80 bg-muted py-2 pe-3 ps-10 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
            placeholder="شماره سفارش، نام یا تلفن مشتری…"
            maxLength={200}
          />
        </label>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">وضعیت</span>
            <SearchableSelect
              value={status}
              onChange={(value) => { setStatus(value as OrderStatus | "all"); setPage(1); }}
              className="min-h-11 w-full"
              ariaLabel="فیلتر وضعیت سفارش"
              options={[{ value: "all", label: "همهٔ وضعیت‌ها" }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))]}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">نوع سفارش</span>
            <SearchableSelect
              value={type}
              onChange={(value) => { setType(value as OrderType | "all"); setPage(1); }}
              className="min-h-11 w-full"
              ariaLabel="فیلتر نوع سفارش"
              options={[{ value: "all", label: "همهٔ انواع" }, ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))]}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">میز</span>
            <SearchableSelect
              value={tableId}
              onChange={(value) => { setTableId(value); setPage(1); }}
              className="min-h-11 w-full"
              ariaLabel="فیلتر میز سفارش"
              options={[{ value: "all", label: "همهٔ میزها" }, ...(result?.tables ?? []).map((table) => ({ value: table.id, label: table.name }))]}
            />
          </label>
          {canReviewShifts ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">شیفت (بر پایهٔ زمان ثبت)</span>
              <SearchableSelect
                value={shiftId}
                onChange={(value) => { setShiftId(value); setPage(1); }}
                className="min-h-11 w-full"
                ariaLabel="فیلتر شیفت"
                options={[{ value: "all", label: "همهٔ شیفت‌ها" }, ...(result?.shifts ?? []).map((shift) => ({ value: shift.id, label: shiftLabel(shift, timeZone) }))]}
              />
            </label>
          ) : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">از تاریخ ثبت</span>
            <JalaliDatePicker value={from} onChange={(value) => { setFrom(value); setPage(1); }} timeZone={timeZone} placeholder="بدون شروع" className="min-h-11 w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">تا تاریخ ثبت</span>
            <JalaliDatePicker value={to} onChange={(value) => { setTo(value); setPage(1); }} timeZone={timeZone} placeholder="بدون پایان" className="min-h-11 w-full" />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2" aria-label="تعداد سفارش‌ها به تفکیک وضعیت">
            {result ? Object.entries(STATUS_LABELS).map(([key, label]) => (
              <span key={key} className="rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                {label}: <b className="text-foreground">{toPersianDigits(result.statusCounts[key as OrderStatus])}</b>
              </span>
            )) : null}
          </div>
          <button type="button" onClick={clearFilters} className="min-h-10 rounded-lg px-3 text-xs font-bold text-amber-700 dark:text-amber-300 hover:bg-muted">پاک‌کردن فیلترها</button>
        </div>
      </section>

      {error ? <p className="mb-3 rounded-xl border border-destructive/20 bg-destructive/[0.035] px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
      <section className={`${cardClass} min-w-0 overflow-hidden`} aria-label="نتایج تاریخچهٔ سفارش‌ها">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 px-4 py-3">
          <h2 className="text-sm font-bold text-foreground">همهٔ سفارش‌ها</h2>
          <span className="text-xs text-muted-foreground">
            {loading ? "در حال بارگذاری…" : `${toPersianDigits(pageStart)} تا ${toPersianDigits(pageEnd)} از ${toPersianDigits(result?.totalCount ?? 0)}`}
          </span>
        </div>
        {loading && !result ? <div className="p-6 text-center text-sm text-muted-foreground">در حال بارگذاری تاریخچه…</div> : null}
        {!loading && result?.orders.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">سفارشی با این فیلترها پیدا نشد.</div> : null}
        {result?.orders.length ? (
          <div className="divide-y divide-border/80">
            {result.orders.map((order) => (
              <button key={order.id} type="button" onClick={() => { setDetailOrderId(order.id); setDetailOpen(true); }} className="flex min-h-[76px] w-full items-center justify-between gap-3 px-4 py-3 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/45">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <b className="text-foreground">{toPersianDigits(formatQueueLabel(order.type, Number(order.order_number)))}</b>
                    <span className={`rounded-lg px-2 py-1 text-[11px] font-bold ${order.status === "completed" ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : order.status === "voided" ? "bg-muted text-muted-foreground" : "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"}`}>{STATUS_LABELS[order.status]}</span>
                    {order.table_name ? <span className="rounded-lg border border-border/80 px-2 py-1 text-[11px] text-muted-foreground">{order.table_name}</span> : null}
                  </span>
                  <span className="mt-1 block truncate text-sm text-muted-foreground">
                    {[order.customer_name, order.customer_phone ? toPersianDigits(order.customer_phone) : null, TYPE_LABELS[order.type], openedLabel(order.opened_at, timeZone)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-end">
                  <span className="block font-bold text-foreground">{money.formatText(order.total)}</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">{order.closed_at ? openedLabel(order.closed_at, timeZone) : "هنوز تسویه نشده"}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-border/80 px-4 py-3">
          <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1} className="flex min-h-11 items-center gap-1 rounded-lg border border-border/80 px-3 text-xs font-bold disabled:opacity-40">
            <ChevronRightIcon className="size-4" aria-hidden="true" /> قبلی
          </button>
          <span className="text-xs text-muted-foreground">صفحهٔ {toPersianDigits(result?.page ?? page)} از {toPersianDigits(result?.pageCount ?? 1)}</span>
          <button type="button" onClick={() => setPage((current) => Math.min(result?.pageCount ?? current, current + 1))} disabled={loading || !result || page >= result.pageCount} className="flex min-h-11 items-center gap-1 rounded-lg border border-border/80 px-3 text-xs font-bold disabled:opacity-40">
            بعدی <ChevronLeftIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      </section>

      <OrderDetailModal
        orderId={detailOrderId}
        open={detailOpen}
        onOpenChange={(open) => { setDetailOpen(open); if (!open) setDetailOrderId(null); }}
        canEdit={canEdit}
        canTakePayment={canTakePayment}
        canAmendClosed={canAmendClosed}
        canRefund={canRefund}
        timeZone={timeZone}
        onChanged={() => void load()}
      />
    </PageShell>
  );
}
