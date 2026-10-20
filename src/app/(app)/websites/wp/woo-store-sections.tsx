"use client";

import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";

/**
 * Phase 38 — the four surfaces that turn «فروشگاه ووکامرس» from a connection
 * tester into somewhere an owner can actually work:
 *
 *   «کاتالوگ»             every synced product with its WooCommerce type, its
 *                         categories, its variation attributes and its live
 *                         stock — and a price/stock push from the row itself.
 *   «دسته‌بندی‌ها»          the store's taxonomy tree, including attribute
 *                         terms and custom taxonomies.
 *   «سفارش‌های فروشگاه»    what arrived from the store, and the two things
 *                         anyone does about an order: change its status,
 *                         or refund it.
 *   «تنظیمات همگام‌سازی»   what is pulled, how far back, and when it last ran.
 *
 * Every write here is queued, never applied inline — the response says so. In
 * plugin mode the app cannot reach the store at all, so an inline call would
 * simply fail there; through the outbox the same button works in both modes
 * and inherits retry, backoff and a visible trail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ErrorBox, InfoBox, errorMessageOrRaw, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatPersianNumber, formatPersianNumericText, normalizeNumericText } from "@/lib/digits";
import { formatDateTime } from "./format";
import { WooOrderDetailModal } from "./woo-order-detail-modal";

export { formatDateTime } from "./format";
/** Money in Toman, the way every other screen in the dashboard shows it. */
function rialToTomanText(rial: string | null): string {
  if (rial === null) return "—";
  try {
    const value = BigInt(rial);
    const toman = value / 10n;
    return toman.toLocaleString("fa-IR");
  } catch {
    // A malformed value from an old sync must not crash the whole catalogue.
    return "نامعتبر";
  }
}

/** Persian labels for the WooCommerce types a row can be. */
export const WOO_TYPE_LABELS: Record<string, string> = {
  simple: "ساده",
  variable: "متغیر (والد)",
  variation: "تنوع",
  grouped: "گروهی",
  external: "خارجی",
  bundle: "بسته",
  composite: "ترکیبی",
  subscription: "اشتراک",
  unknown: "نامشخص",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  processing: "در حال پردازش",
  "on-hold": "معلق",
  completed: "تکمیل‌شده",
  cancelled: "لغو شده",
  refunded: "برگشت خورده",
  failed: "ناموفق",
};

const INGEST_STATUS_LABELS: Record<string, string> = {
  processed: "ثبت شد",
  duplicate: "تکراری",
  failed: "خطا",
  pending: "در انتظار",
  none: "—",
};

interface SectionProps {
  connectionId: string;
  /** True while any request for this connection is in flight. */
  busy: boolean;
  /** The panel's request helper, so a failure shows in the panel's own banner. */
  call: <T extends Record<string, unknown>>(path: string, method?: string, body?: unknown) => Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface CatalogueProduct {
  remoteId: string;
  localId: string;
  name: string;
  sku: string | null;
  wooType: string;
  itemKind: string | null;
  sellable: boolean;
  priceRial: string | null;
  quantity: number | null;
  parentRemoteId: string | null;
  categories: string[];
  attributes: string[];
}

export function CatalogueSection({ connectionId, busy, call }: SectionProps) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ price: "", stock: "" });
  const [loadError, setLoadError] = useState("");
  const [validationError, setValidationError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query.trim()) params.set("search", query.trim());
    if (typeFilter) params.set("type", typeFilter);
    const { ok, data } = await api<{
      products?: CatalogueProduct[];
      summary?: Record<string, number>;
      total?: number;
      page?: number;
      pageSize?: number;
      error?: string;
    }>(`/api/integrations/connections/${connectionId}/catalogue?${params.toString()}`);
    if (ok) {
      setProducts(data.products ?? []);
      setTotal(Number(data.total ?? data.products?.length ?? 0));
      setPage(Number(data.page ?? page));
      setPageSize(Number(data.pageSize ?? pageSize));
      setSummary(data.summary ?? null);
    } else {
      setProducts([]);
      setSummary(null);
      setLoadError(String(data?.error ?? "دریافت محصولات ناموفق بود."));
    }
    setLoading(false);
  }, [connectionId, page, pageSize, query, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const types = [...new Set(products.map((p) => p.wooType))].sort();
  const needle = query.trim().toLowerCase();
  const visible = products.filter((p) => {
    if (typeFilter && p.wooType !== typeFilter) return false;
    if (!needle) return true;
    return (
      p.name.toLowerCase().includes(needle) ||
      (p.sku ?? "").toLowerCase().includes(needle) ||
      p.categories.some((c) => c.toLowerCase().includes(needle)) ||
      p.attributes.some((a) => a.toLowerCase().includes(needle))
    );
  });

  async function push(remoteId: string) {
    setValidationError("");
    const fields: Record<string, unknown> = {};
    if (draft.price.trim()) {
      // Persian/Arabic digits and pasted grouping separators are accepted.
      const canonical = normalizeNumericText(draft.price, { allowDecimal: false, allowNegative: false });
      if (!canonical || !/^\d+$/.test(canonical)) {
        setValidationError("قیمت باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      fields.priceRial = (BigInt(canonical) * 10n).toString();
    }
    if (draft.stock.trim()) {
      const canonical = normalizeNumericText(draft.stock, { allowDecimal: false, allowNegative: false });
      if (!canonical || !/^\d+$/.test(canonical)) {
        setValidationError("موجودی باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      const stock = Number(canonical);
      if (!Number.isSafeInteger(stock)) {
        setValidationError("موجودی واردشده بیش از حد بزرگ است.");
        return;
      }
      fields.stock_quantity = stock;
    }
    if (Object.keys(fields).length === 0) {
      setValidationError("حداقل قیمت یا موجودی جدید را وارد کنید.");
      return;
    }
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/products`,
      "POST",
      { remoteId, fields },
    );
    if (result) {
      setEditing(null);
      setDraft({ price: "", stock: "" });
    }
  }

  return (
    <section className="mt-2 space-y-4 rounded-xl bg-muted p-3 text-sm sm:p-4" aria-busy={loading} aria-label="فهرست محصولات ووکامرس">
      {loading ? <LoadingSkeleton rows={5} compact /> : null}
      {!loading && loadError ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-red-700 sm:flex-row sm:items-center sm:justify-between dark:text-red-300">
          <span>{loadError}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>تلاش دوباره</Button>
        </div>
      ) : null}

      {!loading && summary ? (
        <div className="flex flex-wrap gap-2">
          {[
            { label: "کل", value: summary.total ?? 0 },
            { label: "قابل فروش", value: summary.sellable ?? 0 },
            { label: "تنوع", value: summary.variations ?? 0 },
            { label: "والد/گروه", value: summary.containers ?? 0 },
            { label: "ناموجود", value: summary.outOfStock ?? 0 },
            { label: "بدون دسته", value: summary.uncategorised ?? 0 },
          ].map((chip) => (
            <span key={chip.label} className="rounded-full bg-card px-2 py-0.5 text-[11px] text-foreground/80">
              {chip.label}: {Number(chip.value).toLocaleString("fa-IR")}
            </span>
          ))}
        </div>
      ) : null}

      {!loading && products.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-xs font-medium">جست‌وجوی محصول</span>
            <input
              className={`${inputClass} w-full`}
              placeholder="نام، SKU، دسته یا ویژگی…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium">نوع محصول</span>
            <select
              className={`${inputClass} w-full`}
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
            >
            <option value="">همهٔ نوع‌ها</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {WOO_TYPE_LABELS[type] ?? type}
              </option>
            ))}
            </select>
          </label>
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={!query && !typeFilter} onClick={() => { setQuery(""); setTypeFilter(""); setPage(1); }}>
            پاک‌کردن فیلتر
          </Button>
          <p className="text-xs text-muted-foreground sm:col-span-3" aria-live="polite">
            نمایش {products.length.toLocaleString("fa-IR")} از {total.toLocaleString("fa-IR")} محصول
          </p>
        </div>
      ) : null}

      {!loading && !loadError && products.length === 0 ? (
        <p className="text-muted-foreground">
          هنوز محصولی همگام‌سازی نشده است. دکمهٔ «همگام‌سازی محصولات» را بزنید.
        </p>
      ) : null}

      {visible.length === 0 && !loading && products.length > 0 ? (
        <p className="text-muted-foreground">محصولی با این فیلتر پیدا نشد.</p>
      ) : null}

      <ul className="grid gap-2 lg:grid-cols-2">
        {visible.map((product) => (
          <li key={product.remoteId} className="rounded-lg border border-border/70 bg-card p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{product.name}</span>
              <span className="flex flex-wrap items-center gap-1">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground/80">
                  {WOO_TYPE_LABELS[product.wooType] ?? product.wooType}
                </span>
                {product.parentRemoteId ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" dir="ltr">
                    والد #{product.parentRemoteId}
                  </span>
                ) : null}
                {product.sku ? (
                  <span className="text-[10px] text-muted-foreground" dir="ltr">
                    {product.sku}
                  </span>
                ) : null}
              </span>
            </div>

            {product.attributes.length > 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{product.attributes.join("، ")}</p>
            ) : null}

            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>قیمت: {rialToTomanText(product.priceRial)} تومان</span>
              {product.quantity !== null ? <span>موجودی: {product.quantity.toLocaleString("fa-IR")}</span> : null}
              {product.categories.length > 0 ? <span>دسته: {product.categories.join("، ")}</span> : null}
            </div>

            {product.sellable ? (
              editing === product.remoteId ? (
                <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-xs font-medium">
                      قیمت جدید (تومان)
                      {product.priceRial !== null ? (
                        <span className="font-normal text-muted-foreground"> — الان {rialToTomanText(product.priceRial)}</span>
                      ) : null}
                    </span>
                    <input
                      className={`${inputClass} w-full`}
                      placeholder="مثلاً ۱۵۰٬۰۰۰"
                      inputMode="numeric"
                      value={draft.price}
                      onChange={(e) => { setDraft({ ...draft, price: e.target.value }); setValidationError(""); }}
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-medium">
                      موجودی جدید
                      {product.quantity !== null ? (
                        <span className="font-normal text-muted-foreground"> — الان {product.quantity.toLocaleString("fa-IR")}</span>
                      ) : null}
                    </span>
                    <input
                      className={`${inputClass} w-full`}
                      placeholder="مثلاً ۱۲"
                      inputMode="numeric"
                      value={draft.stock}
                      onChange={(e) => { setDraft({ ...draft, stock: e.target.value }); setValidationError(""); }}
                    />
                  </label>
                  {validationError ? <p role="alert" className="text-xs text-red-600 sm:col-span-2 dark:text-red-400">{validationError}</p> : null}
                  <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
                  <Button type="button" size="xs" disabled={busy} onClick={() => void push(product.remoteId)}>
                    ارسال به فروشگاه
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setDraft({ price: "", stock: "" });
                      setValidationError("");
                    }}
                  >
                    انصراف
                  </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground sm:col-span-2">
                    خالی بماند یعنی بدون تغییر؛ فقط فیلدهایی که پر کنید ارسال می‌شوند.
                  </p>
                </div>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="mt-2"
                  onClick={() => {
                    setEditing(product.remoteId);
                    setDraft({ price: "", stock: "" });
                    setValidationError("");
                  }}
                >
                  تغییر قیمت / موجودی
                </Button>
              )
            ) : (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                این ردیف والدِ تنوع‌هاست؛ خودش فروخته نمی‌شود و موجودی و قیمت ندارد.
              </p>
            )}
          </li>
        ))}
      </ul>
      {!loading && total > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            صفحه {page.toLocaleString("fa-IR")} از {Math.max(1, Math.ceil(total / pageSize)).toLocaleString("fa-IR")}
          </span>
          <span className="flex gap-2">
            <Button type="button" size="xs" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              قبلی
            </Button>
            <Button type="button" size="xs" variant="outline" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage((value) => value + 1)}>
              بعدی
            </Button>
          </span>
        </div>
      ) : null}
      <InfoBox>
        تغییر قیمت و موجودی در صف قرار می‌گیرد و در اجرای بعدی (خودکار یا افزونهٔ وردپرس) به فروشگاه می‌رود.
      </InfoBox>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

/**
 * «دسته‌بندی و ویژگی‌ها» is its own screen now — see taxonomies-section.tsx.
 * It is re-exported here so the existing import sites keep working; the
 * section outgrew the compact panel shape the rest of this file uses.
 */
export { TaxonomiesSection } from "./taxonomies-section";
export type { TermGroup, TermRow } from "./taxonomies-section";

// ---------------------------------------------------------------------------
// Store orders
// ---------------------------------------------------------------------------

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
  ingestStatus: string;
  ingestError: string | null;
  lineCount: number;
  operations: StoreOrderOperation[];
}

const ORDER_STATUS_OPTIONS = Object.keys(ORDER_STATUS_LABELS);
const ATTENTION_OPERATION_STATES = new Set(["failed", "dead"]);
const ACTIVE_OPERATION_STATES = new Set(["pending", "processing"]);

type BadgeTone = "active" | "positive" | "neutral" | "danger";

function statusRank(status: string): number {
  const index = ORDER_STATUS_OPTIONS.indexOf(status);
  return index === -1 ? ORDER_STATUS_OPTIONS.length : index;
}

function orderStatusTone(status: string): BadgeTone {
  if (status === "completed") return "positive";
  if (status === "pending" || status === "processing" || status === "on-hold") return "active";
  if (status === "cancelled" || status === "refunded" || status === "failed") return "danger";
  return "neutral";
}

function ingestTone(status: string): BadgeTone {
  if (status === "processed") return "positive";
  if (status === "pending") return "active";
  if (status === "failed") return "danger";
  return "neutral";
}

function operationTone(status: string): BadgeTone {
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

function operationSummary(operation: StoreOrderOperation, currency: string): string {
  if (operation.type === "order_status") {
    const status = operation.targetStatus ?? "";
    return `تغییر وضعیت به ${ORDER_STATUS_LABELS[status] ?? (status || "—")}`;
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

export function StoreOrdersSection({ connectionId, busy, call }: SectionProps) {
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPageSize, setOrdersPageSize] = useState(25);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [ingestFilter, setIngestFilter] = useState("");
  const [loadError, setLoadError] = useState("");
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ page: String(ordersPage), pageSize: String(ordersPageSize) });
    if (query.trim()) params.set("search", query.trim());
    if (statusFilter) params.set("status", statusFilter);
    if (ingestFilter) params.set("view", ingestFilter);
    const { ok, data, aborted } = await api<{ orders?: StoreOrder[]; total?: number; page?: number; pageSize?: number; error?: string }>(
      `/api/integrations/connections/${connectionId}/store/orders?${params.toString()}`,
    );
    if (request !== loadRequestRef.current || aborted) return;
    if (ok) {
      setOrders(data.orders ?? []);
      setOrdersTotal(Number(data.total ?? data.orders?.length ?? 0));
      setOrdersPage(Number(data.page ?? ordersPage));
      setOrdersPageSize(Number(data.pageSize ?? ordersPageSize));
    } else {
      setLoadError(errorMessageOrRaw(data.error) || "بارگذاری سفارش‌های فروشگاه ممکن نشد.");
    }
    setLoading(false);
  }, [connectionId, ordersPage, ordersPageSize, query, statusFilter, ingestFilter]);

  useEffect(() => {
    setDetailFor(null);
    setOrders([]);
    setOrdersPage(1);
    setStatusFor(null);
    setRefundFor(null);
    setAmount("");
    setReason("");
    setQuery("");
    setStatusFilter("");
    setIngestFilter("");
    setLocalError("");
    setNotice("");
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const statusOptions = useMemo(() => {
    return [...new Set(orders.map((order) => order.status).filter(Boolean))].sort(
      (a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b, "fa"),
    );
  }, [orders]);

  const summary = useMemo(
    () => ({
      total: orders.length,
      imported: orders.filter((order) => order.localOrderId).length,
      unrecorded: orders.filter((order) => !order.localOrderId).length,
      queued: orders.filter(orderHasQueuedWork).length,
      attention: orders.filter(orderNeedsAttention).length,
    }),
    [orders],
  );

  const visibleOrders = orders;
  const hasOrderFilter = Boolean(query.trim() || statusFilter || ingestFilter);

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

  async function changeStatus(order: StoreOrder, status: string) {
    if (status === order.status) return;
    setLocalError("");
    setNotice("");
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/orders`,
      "POST",
      { action: "status", remoteId: order.remoteId, status },
    );
    if (result) {
      setStatusFor(null);
      setNotice(`درخواست تغییر وضعیت سفارش #${order.number} به «${ORDER_STATUS_LABELS[status] ?? status}» در صف قرار گرفت.`);
      await load();
    }
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

  return (
    <SectionCard
      title="سفارش‌ها"
      description="آخرین سفارش‌های رسیده از ووکامرس، حتی سفارش‌های پرداخت‌نشده یا خطادار؛ تغییر وضعیت و برگشت وجه از مسیر صف امن افزونه/REST انجام می‌شود."
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
        {detailFor ? <WooOrderDetailModal key={`${connectionId}:${detailFor}`} connectionId={connectionId} remoteId={detailFor}
          onClose={() => setDetailFor(null)}
          onStatus={() => { setStatusFor(detailFor); setRefundFor(null); setDetailFor(null); }}
          onRefund={() => { const order = orders.find(o => o.remoteId === detailFor); if (order) openRefund(order); setDetailFor(null); }} /> : null}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: "دریافت‌شده", value: summary.total },
            { label: "ثبت‌شده داخلی", value: summary.imported },
            { label: "ثبت‌نشده", value: summary.unrecorded },
            { label: "عملیات در صف", value: summary.queued },
            { label: "نیازمند بررسی", value: summary.attention },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-border/70 bg-muted/40 p-3">
              <p className="text-[11px] text-muted-foreground">{item.label}</p>
              <p className="mt-1 text-lg font-bold text-foreground">{formatPersianNumber(item.value)}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_minmax(10rem,14rem)]">
          <input
            className={inputClass}
            aria-label="جست‌وجو در سفارش‌های ووکامرس"
            placeholder="جست‌وجو با شماره سفارش، مشتری، روش پرداخت یا خطا…"
            value={query}
            onChange={(event) => { setOrdersPage(1); setQuery(event.target.value); }}
          />
          <select
            className={inputClass}
            aria-label="فیلتر وضعیت سفارش ووکامرس"
            value={statusFilter}
            onChange={(event) => { setOrdersPage(1); setStatusFilter(event.target.value); }}
          >
            <option value="">همهٔ وضعیت‌ها</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {ORDER_STATUS_LABELS[status] ?? status}
              </option>
            ))}
          </select>
          <select
            className={inputClass}
            aria-label="فیلتر ثبت و صف سفارش"
            value={ingestFilter}
            onChange={(event) => { setOrdersPage(1); setIngestFilter(event.target.value); }}
          >
            <option value="">همهٔ ثبت‌ها</option>
            <option value="imported">ثبت‌شده در حسابداری</option>
            <option value="unrecorded">ثبت‌نشده در حسابداری</option>
            <option value="queued">دارای عملیات در صف</option>
            <option value="attention">نیازمند بررسی</option>
          </select>
        </div>

        <ErrorBox>{loadError || localError}</ErrorBox>
        {notice ? (
          <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-6 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
            {notice}
          </p>
        ) : null}

        {loading ? <LoadingSkeleton rows={4} label="در حال بارگذاری سفارش‌های ووکامرس" /> : null}

        {!loading && orders.length === 0 ? (
          <EmptyState>
            {hasOrderFilter
              ? "سفارشی با این جست‌وجو یا فیلتر پیدا نشد."
              : "هنوز سفارشی از فروشگاه دریافت نشده است. «همگام‌سازی سفارش‌ها» را بزنید یا وب‌هوک/افزونهٔ وردپرس را بررسی کنید."}
          </EmptyState>
        ) : null}

        {!loading && visibleOrders.length > 0 ? (
          <ul className="space-y-3" aria-label="فهرست سفارش‌های ووکامرس">
            {visibleOrders.map((order) => (
              <li key={order.remoteId} className={`${cardClass} p-3 sm:p-4`}
                onClick={event => { if (!(event.target as HTMLElement).closest("button, a, input, select, textarea")) setDetailFor(order.remoteId); }}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-bold text-foreground" dir="ltr">
                        #{order.number}
                      </span>
                      <StatusBadge tone={orderStatusTone(order.status)}>
                        {ORDER_STATUS_LABELS[order.status] ?? (order.status || "وضعیت نامشخص")}
                      </StatusBadge>
                      {orderHasQueuedWork(order) ? <StatusBadge tone="active">عملیات در صف</StatusBadge> : null}
                      {orderNeedsAttention(order) ? <StatusBadge tone="danger">نیازمند بررسی</StatusBadge> : null}
                    </div>

                    <dl className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
                      <div className="min-w-0 rounded-xl bg-muted/50 px-3 py-2">
                        <dt className="text-[11px] text-muted-foreground">مشتری</dt>
                        <dd className="mt-0.5 truncate font-medium text-foreground">{order.customer || "بدون نام"}</dd>
                      </div>
                      <div className="rounded-xl bg-muted/50 px-3 py-2">
                        <dt className="text-[11px] text-muted-foreground">مبلغ / اقلام</dt>
                        <dd className="mt-0.5 font-medium text-foreground">
                          {formatStoreMoney(order.total, order.currency)} • {formatPersianNumber(order.lineCount)} قلم
                        </dd>
                      </div>
                      <div className="rounded-xl bg-muted/50 px-3 py-2">
                        <dt className="text-[11px] text-muted-foreground">زمان سفارش</dt>
                        <dd className="mt-0.5 font-medium text-foreground">{formatDateTime(order.dateCreated)}</dd>
                      </div>
                      <div className="rounded-xl bg-muted/50 px-3 py-2">
                        <dt className="text-[11px] text-muted-foreground">ثبت داخلی</dt>
                        <dd className="mt-0.5 font-medium text-foreground">
                          {order.localOrderNumber !== null ? `فاکتور ${formatPersianNumber(order.localOrderNumber)}` : "ثبت نشده"}
                        </dd>
                      </div>
                      <div className="rounded-xl bg-muted/50 px-3 py-2">
                        <dt className="text-[11px] text-muted-foreground">ورود به سیستم</dt>
                        <dd className="mt-0.5">
                          <StatusBadge tone={ingestTone(order.ingestStatus)}>
                            {INGEST_STATUS_LABELS[order.ingestStatus] ?? order.ingestStatus}
                          </StatusBadge>
                        </dd>
                      </div>
                      <div className="min-w-0 rounded-xl bg-muted/50 px-3 py-2">
                        <dt className="text-[11px] text-muted-foreground">شناسه / پرداخت</dt>
                        <dd className="mt-0.5 truncate font-medium text-foreground" dir="ltr">
                          {order.remoteId}{order.paymentMethod ? ` • ${order.paymentMethod}` : ""}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
                    <Button type="button" size="sm" className="w-full sm:w-auto lg:w-36" onClick={() => setDetailFor(order.remoteId)}>مشاهده جزئیات</Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full sm:w-auto lg:w-36"
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
                      className="w-full sm:w-auto lg:w-36"
                      aria-expanded={refundFor === order.remoteId}
                      disabled={busy}
                      onClick={() => openRefund(order)}
                    >
                      ثبت برگشت وجه
                    </Button>
                  </div>
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
                          <span>{operationSummary(operation, order.currency)}</span>
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
                      {ORDER_STATUS_OPTIONS.map((status) => (
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
                          {ORDER_STATUS_LABELS[status]}
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

        {ordersTotal > ordersPageSize ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              صفحه {ordersPage.toLocaleString("fa-IR")} — نمایش {orders.length.toLocaleString("fa-IR")} از {ordersTotal.toLocaleString("fa-IR")} ردیف خوانده‌شده
            </span>
            <span className="flex gap-2">
              <Button type="button" size="xs" variant="outline" disabled={ordersPage <= 1} onClick={() => setOrdersPage((value) => Math.max(1, value - 1))}>
                قبلی
              </Button>
              <Button type="button" size="xs" variant="outline" disabled={orders.length < ordersPageSize || ordersPage * ordersPageSize >= ordersTotal} onClick={() => setOrdersPage((value) => value + 1)}>
                بعدی
              </Button>
            </span>
          </div>
        ) : null}

        <InfoBox>
          این صفحه سفارش‌ها را صفحه‌بندی‌شده از آینهٔ محلی نشان می‌دهد. سفارش پرداخت‌نشده ممکن است «ثبت نشده» باشد، اما برای پیگیری وب‌هوک و تغییر وضعیت همچنان نمایش داده می‌شود.
        </InfoBox>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Sync settings
// ---------------------------------------------------------------------------

export interface SyncSettingsConnection {
  id: string;
  linkMode: "rest_api" | "plugin";
  syncCategories: boolean;
  autoPullOrders: boolean;
  orderLookbackDays: number;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
}

export function SyncSettingsSection({
  connection,
  busy,
  call,
}: {
  connection: SyncSettingsConnection;
  busy: boolean;
  call: <T extends Record<string, unknown>>(path: string, method?: string, body?: unknown) => Promise<T | null>;
}) {
  const [lookback, setLookback] = useState(String(connection.orderLookbackDays));
  const [dirty, setDirty] = useState(false);

  const toggle = async (patch: Record<string, unknown>) => {
    await call(`/api/integrations/connections/${connection.id}`, "PATCH", patch);
  };

  return (
    <div className="mt-2 space-y-3 rounded-xl bg-muted p-2 text-xs">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={connection.autoPullOrders}
            disabled={busy}
            onChange={(e) => void toggle({ autoPullOrders: e.target.checked })}
          />
          <span>
            <span className="font-medium">دریافت دوره‌ای سفارش‌ها</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              {connection.linkMode === "plugin"
                ? "در حالت افزونه، خودِ افزونه سفارش‌ها را می‌فرستد؛ این گزینه یک بازخوانی کاملِ دوره‌ای هم درخواست می‌کند."
                : "علاوه بر وب‌هوک، سفارش‌های اخیر به‌طور دوره‌ای هم خوانده می‌شود؛ وب‌هوکی که تنظیم نشده باشد دیگر به معنای از دست رفتن فروش نیست."}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={connection.syncCategories}
            disabled={busy}
            onChange={(e) => void toggle({ syncCategories: e.target.checked })}
          />
          <span>
            <span className="font-medium">ساخت دسته‌بندی از فروشگاه</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              دسته‌های ووکامرس به دسته‌بندی‌های منو/کالا اضافه می‌شوند. به‌طور پیش‌فرض خاموش است، چون چیدمان موجود را
              تغییر می‌دهد.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <span className="mb-1 block text-[11px] text-muted-foreground">بازهٔ بازخوانی سفارش‌ها (روز)</span>
          <input
            className={inputClass}
            value={lookback}
            onChange={(e) => {
              setLookback(e.target.value);
              setDirty(true);
            }}
            inputMode="numeric"
            dir="ltr"
          />
        </div>
        <Button
          type="button"
          size="xs"
          disabled={busy || !dirty}
          onClick={async () => {
            const days = Math.min(365, Math.max(1, Math.round(Number(lookback) || 7)));
            setLookback(String(days));
            setDirty(false);
            await call(`/api/integrations/connections/${connection.id}`, "PATCH", { orderLookbackDays: days });
          }}
        >
          ذخیرهٔ بازه
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() =>
            call(`/api/integrations/connections/${connection.id}/sync/orders`, "POST", {
              sinceDays: Number(lookback) || undefined,
            })
          }
        >
          همگام‌سازی سفارش‌ها
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span>آخرین همگام‌سازی محصولات: {formatDateTime(connection.lastCatalogueSyncAt)}</span>
        <span>آخرین همگام‌سازی سفارش‌ها: {formatDateTime(connection.lastOrderSyncAt)}</span>
      </div>

      <InfoBox>
        در حالت افزونهٔ وردپرس، زمان‌بندی همگام‌سازی در خودِ وردپرس است: رویدادها هر ۵ دقیقه ارسال می‌شوند و
        بازسازی کاملِ کاتالوگ و سفارش‌ها طبق برنامه‌ای که در تنظیمات افزونه انتخاب کرده‌اید اجرا می‌شود.
      </InfoBox>
    </div>
  );
}
