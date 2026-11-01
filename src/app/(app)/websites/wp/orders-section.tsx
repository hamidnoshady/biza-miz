"use client";

/**
 * «سفارش‌ها» — what arrived from the store, and the two things anyone does
 * about an order: change its status, or refund it.
 *
 * The counts and the status picker come from the server's facets (the whole
 * mirror), not from the page on screen, so choosing a status never shrinks the
 * picker to that one status and the summary does not describe "this page of
 * 25" as if it were the store. The status picker offers the store's own custom
 * statuses beside WooCommerce's seven.
 *
 * Every write is queued, never applied inline — see woo-store-sections.tsx.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { api, ErrorBox, InfoBox, errorMessageOrRaw, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatPersianNumber, formatPersianNumericText, normalizeNumericText } from "@/lib/digits";
import { formatDateTime } from "./format";
import { ListPager } from "./list-pager";
import { orderStatusChoices, orderStatusLabel, type OrderBadgeTone } from "./order-status";
import { OrderStatusBadge } from "./order-status-badge";
import { WooOrderDetailModal } from "./woo-order-detail-modal";

const INGEST_STATUS_LABELS: Record<string, string> = {
  processed: "ثبت شد",
  duplicate: "تکراری",
  failed: "خطا",
  pending: "در انتظار",
  none: "—",
};

const PAGE_SIZES = [10, 25, 50] as const;
const SEARCH_DEBOUNCE_MS = 350;

export interface OrdersSectionProps {
  connectionId: string;
  /**
   * The store's registered status names (`wc_get_order_statuses()` as the
   * plugin reported them), so a custom status reads the way its owner named it
   * and the picker offers every status this store accepts — including one it
   * has not used yet (#1215 / P1‑3). Empty for a plugin that predates it.
   */
  statusRegistry?: ReadonlyMap<string, string> | null;
  /** True while any request for this connection is in flight. */
  busy: boolean;
  /** The panel's request helper, so a failure shows in the panel's own banner. */
  call: <T extends Record<string, unknown>>(
    path: string,
    method?: string,
    body?: unknown,
    options?: { successNotice?: string | null },
  ) => Promise<T | null>;
}

interface StoreOrderOperation {
  type: "order_status" | "refund_create";
  status: string;
  targetStatus: string | null;
  amount: string | null;
  reason: string | null;
  error: string | null;
}

interface StoreOrder {
  remoteId: string;
  localOrderId: string | null;
  localOrderNumber: number | null;
  number: string;
  status: string;
  total: string;
  currency: string;
  dateCreated: string | null;
  customer: string;
  paymentMethod: string;
  /** The gateway's own name; falls back to the bare code when the store sent none. */
  paymentMethodTitle: string;
  ingestStatus: string;
  ingestError: string | null;
  lineCount: number;
  operations: StoreOrderOperation[];
}

interface OrderFacets {
  total: number;
  imported: number;
  unrecorded: number;
  queued: number;
  attention: number;
  statuses: { value: string; count: number }[];
}

const EMPTY_FACETS: OrderFacets = { total: 0, imported: 0, unrecorded: 0, queued: 0, attention: 0, statuses: [] };

type OrderView = "" | "imported" | "unrecorded" | "queued" | "attention";

const VIEW_CHIPS: { key: OrderView; label: string; count: (facets: OrderFacets) => number }[] = [
  { key: "", label: "همه", count: (facets) => facets.total },
  { key: "imported", label: "ثبت‌شده در حسابداری", count: (facets) => facets.imported },
  { key: "unrecorded", label: "ثبت‌نشده", count: (facets) => facets.unrecorded },
  { key: "queued", label: "عملیات در صف", count: (facets) => facets.queued },
  { key: "attention", label: "نیازمند بررسی", count: (facets) => facets.attention },
];

const ATTENTION_OPERATION_STATES = new Set(["failed", "dead"]);
const ACTIVE_OPERATION_STATES = new Set(["pending", "processing"]);

function ingestTone(status: string): OrderBadgeTone {
  if (status === "processed") return "positive";
  if (status === "pending") return "active";
  if (status === "failed") return "danger";
  return "neutral";
}

function operationTone(status: string): OrderBadgeTone {
  if (status === "pending" || status === "processing") return "active";
  if (status === "failed" || status === "dead") return "danger";
  return "neutral";
}

function cleanStoreAmount(amount: string | null | undefined): string {
  const normalized = normalizeNumericText(String(amount ?? ""), {
    allowDecimal: true,
    allowNegative: true,
    grouping: true,
  });
  if (!normalized) return "";
  return normalized.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "");
}

function isPositiveStoreAmount(amount: string): boolean {
  const normalized = cleanStoreAmount(amount);
  return /^\d+(?:\.\d+)?$/.test(normalized) && Number(normalized) > 0;
}

function storeCurrencyLabel(currency: string | null | undefined): string {
  const code = String(currency ?? "").trim().toUpperCase();
  if (!code) return "";
  if (code === "IRT" || code === "TOMAN") return "تومان";
  if (code === "IRR" || code === "RIAL") return "ریال";
  return code;
}

function formatStoreMoney(amount: string | null | undefined, currency: string | null | undefined): string {
  const normalized = cleanStoreAmount(amount);
  if (!normalized) return "—";
  const text = formatPersianNumericText(normalized, { allowDecimal: true, allowNegative: true, grouping: true });
  const label = storeCurrencyLabel(currency);
  return label ? `${text} ${label}` : text;
}

function operationSummary(
  operation: StoreOrderOperation,
  currency: string,
  statusRegistry: ReadonlyMap<string, string> | null,
): string {
  if (operation.type === "order_status") {
    const status = operation.targetStatus ?? "";
    return `تغییر وضعیت به ${status ? orderStatusLabel(status, statusRegistry) : "—"}`;
  }
  return `برگشت وجه ${formatStoreMoney(operation.amount, currency)}`;
}

function operationStatusLabel(status: string): string {
  return (
    {
      pending: "در صف",
      processing: "در حال ارسال",
      failed: "ناموفق",
      dead: "متوقف",
      sent: "ارسال‌شده",
    }[status] ?? status
  );
}

function orderNeedsAttention(order: StoreOrder): boolean {
  return order.ingestStatus === "failed" || order.operations.some((operation) => ATTENTION_OPERATION_STATES.has(operation.status));
}

function orderHasQueuedWork(order: StoreOrder): boolean {
  return order.operations.some((operation) => ACTIVE_OPERATION_STATES.has(operation.status));
}

function syncResultText(result: { queued?: boolean; imported?: number; duplicates?: number; failed?: number; total?: number }): string {
  if (result.queued) {
    return "درخواست بازخوانی سفارش‌ها در صف افزونه قرار گرفت؛ پس از اجرای افزونه، سفارش‌ها همین‌جا به‌روز می‌شوند.";
  }
  return [
    `همگام‌سازی سفارش‌ها تمام شد: ${formatPersianNumber(Number(result.total ?? 0))} سفارش خوانده شد`,
    `${formatPersianNumber(Number(result.imported ?? 0))} مورد ثبت/به‌روز شد`,
    `${formatPersianNumber(Number(result.duplicates ?? 0))} تکراری بود`,
    `${formatPersianNumber(Number(result.failed ?? 0))} خطا داشت`,
  ].join("، ");
}

export function StoreOrdersSection({ connectionId, busy, call, statusRegistry = null }: OrdersSectionProps) {
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [facets, setFacets] = useState<OrderFacets>(EMPTY_FACETS);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPageSize, setOrdersPageSize] = useState<number>(25);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // `searchDraft` is what the field shows; `query` is what the list reads. The
  // list only follows the draft after the typing pauses, so every keystroke is
  // not a request and the field is never replaced by a loading state.
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [view, setView] = useState<OrderView>("");
  const [loadError, setLoadError] = useState("");
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ page: String(ordersPage), pageSize: String(ordersPageSize) });
    if (query.trim()) params.set("search", query.trim());
    if (statusFilter) params.set("status", statusFilter);
    if (view) params.set("view", view);
    const { ok, data, aborted } = await api<{
      orders?: StoreOrder[];
      total?: number;
      page?: number;
      pageSize?: number;
      facets?: OrderFacets;
      error?: string;
    }>(`/api/integrations/connections/${connectionId}/store/orders?${params.toString()}`, { signal: controller.signal });
    if (request !== loadRequestRef.current || aborted) return;
    if (ok) {
      setOrders(data.orders ?? []);
      setOrdersTotal(Number(data.total ?? data.orders?.length ?? 0));
      setOrdersPage(Number(data.page ?? ordersPage));
      setOrdersPageSize(Number(data.pageSize ?? ordersPageSize));
      setFacets(data.facets ?? EMPTY_FACETS);
    } else {
      setLoadError(errorMessageOrRaw(data.error) || "بارگذاری سفارش‌های فروشگاه ممکن نشد.");
    }
    setLoading(false);
  }, [connectionId, ordersPage, ordersPageSize, query, statusFilter, view]);

  useEffect(() => {
    setDetailFor(null);
    setOrders([]);
    setFacets(EMPTY_FACETS);
    setOrdersPage(1);
    setStatusFor(null);
    setRefundFor(null);
    setAmount("");
    setReason("");
    setSearchDraft("");
    setQuery("");
    setStatusFilter("");
    setView("");
    setLocalError("");
    setNotice("");
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => loadAbortRef.current?.abort(), []);

  useEffect(() => {
    if (searchDraft.trim() === query.trim()) return;
    const timer = setTimeout(() => {
      setOrdersPage(1);
      setQuery(searchDraft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, query]);

  const statusChoices = orderStatusChoices(
    facets.statuses.map((entry) => entry.value),
    statusRegistry,
  );
  const hasOrderFilter = Boolean(query.trim() || statusFilter || view);

  function clearFilters() {
    setSearchDraft("");
    setQuery("");
    setStatusFilter("");
    setView("");
    setOrdersPage(1);
  }

  async function runSync() {
    setSyncing(true);
    setLocalError("");
    setNotice("");
    try {
      const result = await call<{ queued?: boolean; imported?: number; duplicates?: number; failed?: number; total?: number }>(
        `/api/integrations/connections/${connectionId}/sync/orders`,
        "POST",
      );
      if (result) {
        setNotice(syncResultText(result));
        await load();
      }
    } finally {
      setSyncing(false);
    }
  }

  async function changeStatus(order: Pick<StoreOrder, "remoteId" | "number" | "status">, status: string): Promise<boolean> {
    if (status === order.status) return false;
    setLocalError("");
    setNotice("");
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/orders`,
      "POST",
      { action: "status", remoteId: order.remoteId, status },
    );
    if (!result) return false;
    setStatusFor(null);
    setNotice(`درخواست تغییر وضعیت سفارش #${order.number} به «${orderStatusLabel(status, statusRegistry)}» در صف قرار گرفت.`);
    await load();
    return true;
  }

  function openRefund(order: StoreOrder) {
    const open = refundFor !== order.remoteId;
    setRefundFor(open ? order.remoteId : null);
    setStatusFor(null);
    setLocalError("");
    setNotice("");
    setAmount(open ? cleanStoreAmount(order.total) : "");
    setReason("");
  }

  async function submitRefund(order: StoreOrder) {
    const normalizedAmount = cleanStoreAmount(amount);
    if (!isPositiveStoreAmount(normalizedAmount)) {
      setLocalError("مبلغ برگشت وجه باید عددی مثبت در واحد فروشگاه باشد.");
      return;
    }
    const confirmed = window.confirm(
      `برگشت وجه ${formatStoreMoney(normalizedAmount, order.currency)} برای سفارش #${order.number} در صف فروشگاه ثبت شود؟`,
    );
    if (!confirmed) return;
    setLocalError("");
    setNotice("");
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/orders`,
      "POST",
      { action: "refund", remoteId: order.remoteId, amount: normalizedAmount, reason },
    );
    if (result) {
      setRefundFor(null);
      setAmount("");
      setReason("");
      setNotice(`درخواست برگشت وجه سفارش #${order.number} در صف قرار گرفت.`);
      await load();
    }
  }

  const detailOrder = detailFor ? orders.find((order) => order.remoteId === detailFor) : undefined;

  return (
    <SectionCard
      title="سفارش‌ها"
      description="سفارش‌های رسیده از ووکامرس، حتی پرداخت‌نشده یا خطادار؛ تغییر وضعیت و برگشت وجه از مسیر صف امن افزونه/REST انجام می‌شود."
      actions={
        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:flex sm:flex-wrap">
          <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" disabled={loading || busy} onClick={() => void load()}>
            تازه‌سازی
          </Button>
          <Button type="button" size="sm" className="w-full sm:w-auto" disabled={busy || syncing} onClick={() => void runSync()}>
            {syncing ? "در حال درخواست…" : "همگام‌سازی سفارش‌ها"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {detailFor ? (
          <WooOrderDetailModal
            key={`${connectionId}:${detailFor}`}
            connectionId={connectionId}
            remoteId={detailFor}
            onClose={() => setDetailFor(null)}
            statusChoices={statusChoices}
            statusRegistry={statusRegistry}
            canChangeStatus={!busy}
            onChangeStatus={async (status) => {
              const target = detailOrder ?? { remoteId: detailFor, number: detailFor, status: "" };
              return changeStatus(target, status);
            }}
            onRefund={() => {
              if (detailOrder) openRefund(detailOrder);
              setDetailFor(null);
            }}
          />
        ) : null}

        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          <SearchField
            label="جست‌وجو در سفارش‌های ووکامرس"
            placeholder="شماره سفارش، نام مشتری، تلفن یا ایمیل…"
            value={searchDraft}
            onChange={setSearchDraft}
          />
          <FilterChipRow label="فیلتر کار سفارش‌ها">
            {VIEW_CHIPS.map((chip) => (
              <FilterChip
                key={chip.key || "all"}
                selected={view === chip.key}
                onClick={() => {
                  setOrdersPage(1);
                  setView(chip.key);
                }}
              >
                {chip.label} <span className="tabular-nums opacity-70">{formatPersianNumber(chip.count(facets))}</span>
              </FilterChip>
            ))}
          </FilterChipRow>
          {facets.statuses.length > 0 ? (
            <FilterChipRow label="فیلتر وضعیت سفارش ووکامرس">
              <FilterChip
                selected={!statusFilter}
                onClick={() => {
                  setOrdersPage(1);
                  setStatusFilter("");
                }}
              >
                همهٔ وضعیت‌ها
              </FilterChip>
              {facets.statuses.map((entry) => (
                <FilterChip
                  key={entry.value}
                  selected={statusFilter === entry.value}
                  onClick={() => {
                    setOrdersPage(1);
                    setStatusFilter(statusFilter === entry.value ? "" : entry.value);
                  }}
                >
                  {orderStatusLabel(entry.value, statusRegistry)} <span className="tabular-nums opacity-70">{formatPersianNumber(entry.count)}</span>
                </FilterChip>
              ))}
            </FilterChipRow>
          ) : null}
          {hasOrderFilter ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span aria-live="polite">{formatPersianNumber(ordersTotal)} سفارش با این فیلتر</span>
              <Button type="button" size="xs" variant="ghost" onClick={clearFilters}>
                پاک‌کردن فیلترها
              </Button>
            </div>
          ) : null}
        </div>

        <ErrorBox>{loadError || localError}</ErrorBox>
        {notice ? (
          <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-6 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
            {notice}
          </p>
        ) : null}

        {loading && orders.length === 0 ? <LoadingSkeleton rows={4} label="در حال بارگذاری سفارش‌های ووکامرس" /> : null}

        {!loading && orders.length === 0 ? (
          <EmptyState>
            {hasOrderFilter
              ? "سفارشی با این جست‌وجو یا فیلتر پیدا نشد."
              : "هنوز سفارشی از فروشگاه دریافت نشده است. «همگام‌سازی سفارش‌ها» را بزنید یا وب‌هوک/افزونهٔ وردپرس را بررسی کنید."}
          </EmptyState>
        ) : null}

        {orders.length > 0 ? (
          <ul className={`space-y-3 transition-opacity ${loading ? "opacity-60" : ""}`} aria-label="فهرست سفارش‌های ووکامرس" aria-busy={loading}>
            {orders.map((order) => (
              <li
                key={order.remoteId}
                className={`${cardClass} p-3 sm:p-4`}
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest("button, a, input, select, textarea")) setDetailFor(order.remoteId);
                }}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-bold text-foreground" dir="ltr">
                        #{order.number}
                      </span>
                      <OrderStatusBadge status={order.status} registry={statusRegistry} />
                      {orderHasQueuedWork(order) ? <StatusBadge tone="active">عملیات در صف</StatusBadge> : null}
                      {orderNeedsAttention(order) ? <StatusBadge tone="danger">نیازمند بررسی</StatusBadge> : null}
                    </div>
                    <p className="truncate text-sm font-medium text-foreground">{order.customer || "مشتری بدون نام"}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(order.dateCreated)}
                      {order.paymentMethodTitle || order.paymentMethod
                        ? ` • ${order.paymentMethodTitle || order.paymentMethod}`
                        : ""}
                      {` • ${formatPersianNumber(order.lineCount)} قلم`}
                    </p>
                  </div>
                  <div className="shrink-0 space-y-1 sm:text-end">
                    <p className="text-base font-bold text-foreground">{formatStoreMoney(order.total, order.currency)}</p>
                    <p className="text-xs text-muted-foreground">
                      {order.localOrderNumber !== null ? `فاکتور ${formatPersianNumber(order.localOrderNumber)}` : "در حسابداری ثبت نشده"}
                    </p>
                    {order.ingestStatus !== "processed" && order.ingestStatus !== "none" ? (
                      <StatusBadge tone={ingestTone(order.ingestStatus)}>
                        {INGEST_STATUS_LABELS[order.ingestStatus] ?? order.ingestStatus}
                      </StatusBadge>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                  <Button type="button" size="sm" onClick={() => setDetailFor(order.remoteId)}>
                    جزئیات
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-expanded={statusFor === order.remoteId}
                    disabled={busy}
                    onClick={() => {
                      setStatusFor(statusFor === order.remoteId ? null : order.remoteId);
                      setRefundFor(null);
                      setLocalError("");
                      setNotice("");
                    }}
                  >
                    تغییر وضعیت
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-expanded={refundFor === order.remoteId}
                    disabled={busy}
                    onClick={() => openRefund(order)}
                  >
                    ثبت برگشت وجه
                  </Button>
                </div>

                {order.ingestError ? (
                  <p className="mt-3 break-words rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs leading-5 text-destructive" dir="ltr">
                    {order.ingestError}
                  </p>
                ) : null}

                {order.operations.length > 0 ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs leading-5 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                    <p className="font-semibold">عملیات فروشگاه</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {order.operations.map((operation, index) => (
                        <span key={`${operation.type}-${index}`} className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-card/70 px-2 py-1">
                          <StatusBadge tone={operationTone(operation.status)}>{operationStatusLabel(operation.status)}</StatusBadge>
                          <span>{operationSummary(operation, order.currency, statusRegistry)}</span>
                          {operation.error ? <span className="break-all text-destructive" dir="ltr">{operation.error}</span> : null}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {statusFor === order.remoteId ? (
                  <div className="mt-3 rounded-xl border border-border/70 bg-muted/50 p-3">
                    <p className="text-xs leading-5 text-muted-foreground">
                      وضعیت جدید را انتخاب کنید. درخواست در صف قرار می‌گیرد و بعد از اجرای افزونه یا REST روی فروشگاه اعمال می‌شود.
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" role="group" aria-label={`تغییر وضعیت سفارش ${order.number}`}>
                      {statusChoices.map((status) => (
                        <Button
                          key={status}
                          type="button"
                          size="xs"
                          variant={status === order.status ? "secondary" : "ghost"}
                          className="min-h-8 whitespace-normal sm:whitespace-nowrap"
                          disabled={busy || status === order.status}
                          aria-current={status === order.status ? "true" : undefined}
                          onClick={() => void changeStatus(order, status)}
                        >
                          {orderStatusLabel(status, statusRegistry)}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {refundFor === order.remoteId ? (
                  <div className="mt-3 space-y-3 rounded-xl border border-border/70 bg-muted/50 p-3">
                    <div className="grid gap-2 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] md:items-end">
                      <label className="grid gap-1 text-xs font-medium text-foreground">
                        مبلغ برگشتی ({storeCurrencyLabel(order.currency) || "واحد فروشگاه"})
                        <PersianNumberInput
                          className={inputClass}
                          value={amount}
                          allowDecimal
                          allowNegative={false}
                          placeholder="مثلاً ۲۵٬۰۰۰"
                          onChange={(event) => setAmount(event.target.value)}
                        />
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-foreground">
                        دلیل (اختیاری)
                        <input
                          className={inputClass}
                          placeholder="مثلاً مرجوعی مشتری"
                          value={reason}
                          maxLength={500}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </label>
                      <Button type="button" size="sm" variant="destructive" className="w-full md:w-auto" disabled={busy} onClick={() => void submitRefund(order)}>
                        ثبت در صف
                      </Button>
                    </div>
                    <InfoBox>
                      این عملیات فقط برگشت وجه را در فروشگاه ثبت می‌کند و درخواست درگاه پرداخت نمی‌فرستد؛ اگر باید پول به کارت مشتری برگردد، تأیید نهایی در ووکامرس/درگاه انجام می‌شود.
                    </InfoBox>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <ListPager
          page={ordersPage}
          total={ordersTotal}
          pageSize={ordersPageSize}
          pageSizeOptions={PAGE_SIZES}
          onPage={setOrdersPage}
          onPageSize={(size) => {
            setOrdersPage(1);
            setOrdersPageSize(size);
          }}
          noun="سفارش"
        />

        <InfoBox>
          این صفحه سفارش‌ها را صفحه‌بندی‌شده از آینهٔ محلی نشان می‌دهد. سفارش پرداخت‌نشده ممکن است «ثبت نشده» باشد، اما برای پیگیری وب‌هوک و تغییر وضعیت همچنان نمایش داده می‌شود.
        </InfoBox>
      </div>
    </SectionCard>
  );
}
