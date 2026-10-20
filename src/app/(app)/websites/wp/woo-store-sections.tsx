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
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, ErrorBox, InfoBox, errorMessageOrRaw, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatPersianNumber, formatPersianNumericText, normalizeNumericText } from "@/lib/digits";
import { formatMoneyText, parseToRialText, type MoneyUnit } from "@/lib/money";
import { describeWooError } from "./woo-errors";
import { formatDateTime } from "./format";
import type { WpManagerConnection } from "./wp-store-context";

export { formatDateTime } from "./format";

/** The unit word for a money amount, in the unit it is actually denominated in. */
function moneyUnitLabel(unit: MoneyUnit): string {
  return unit === "rial" ? "ریال" : "تومان";
}

/**
 * Integer-Rial text → the display unit, through the platform's one money
 * formatter (issue #943: the old local helper hardcoded «تومان» even for a
 * Rial-display business). Malformed legacy values must not crash the list.
 */
function moneyText(rialText: string | null, unit: MoneyUnit): string {
  if (rialText === null || rialText === "") return "—";
  try {
    return formatMoneyText(rialText, unit, { withUnit: false });
  } catch {
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

interface CatalogueQueueState {
  /** `failed` outranks `queued`: an event that needs a human is the news. */
  state: "idle" | "queued" | "failed";
  kinds: string[];
  pendingPatch: Record<string, unknown> | null;
  lastError: string | null;
  updatedAt: string | null;
  lastSentAt: string | null;
}

interface CatalogueConnectionInfo {
  currencyUnit: "rial" | "toman";
  linkMode: "rest_api" | "plugin";
  status: string;
  pushStock: boolean;
  pushPrices: boolean;
  syncProducts: boolean;
  lastCatalogueSyncAt: string | null;
  lastError: string | null;
}

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
  /** The store's own last-seen presentation (issue #943), null before the first sync that recorded it. */
  remoteStatus: string | null;
  remoteManageStock: boolean | null;
  remoteRegularPriceRial: string | null;
  remoteSalePriceRial: string | null;
  lastSyncedAt: string | null;
  /** The product's live outbox state — queued / failed / last acknowledged. */
  queue: CatalogueQueueState | null;
}

interface CatalogueResponse extends Record<string, unknown> {
  industry?: string;
  moneyUnit?: MoneyUnit;
  connection?: CatalogueConnectionInfo | null;
  summary?: Record<string, number> | null;
  /** Every product type in the whole catalogue — not just the visible page. */
  types?: string[];
  total?: number;
  totalPages?: number;
  page?: number;
  pageSize?: number;
  products?: CatalogueProduct[];
  error?: string;
}

interface SyncProductsResponse extends Record<string, unknown> {
  queued?: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  variations?: number;
  containers?: number;
  total?: number;
  failed?: number;
  failureIds?: string[];
  variationFetchFailures?: number;
  variationFailureIds?: string[];
  taxonomyError?: string | null;
  partial?: boolean;
}

const PRODUCT_STATUS_LABELS: Record<string, string> = {
  publish: "منتشرشده",
  draft: "پیش‌نویس",
  pending: "در انتظار بازبینی",
  private: "خصوصی",
};

const QUEUE_KIND_LABELS: Record<string, string> = {
  stock: "موجودی",
  price: "قیمت",
  product_update: "ویرایش محصول",
};

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const SEARCH_DEBOUNCE_MS = 350;

const EMPTY_DRAFT = {
  name: "",
  price: "",
  sale: "",
  stock: "",
  trackStock: false,
  endSale: false,
  status: "",
};

/** User money input (either digit style, with separators) → integer-Rial text, or null. */
function parseMoneyInput(input: string, unit: MoneyUnit): string | null {
  try {
    const rialText = parseToRialText(input, unit);
    if (!/^\d+$/.test(rialText)) return null;
    return rialText;
  } catch {
    return null;
  }
}

/** What the store will receive from the still-queued patch, in words. */
function pendingPatchText(patch: Record<string, unknown> | null, storeUnit: string): string | null {
  if (!patch) return null;
  const bits: string[] = [];
  if (typeof patch.name === "string" && patch.name) bits.push("نام");
  if (typeof patch.regular_price === "string" && patch.regular_price !== "") {
    bits.push(`قیمت ${formatPersianNumericText(patch.regular_price, { allowDecimal: true, grouping: true })} ${storeUnit}`);
  }
  if (typeof patch.sale_price === "string") {
    if (patch.sale_price === "") bits.push("پایان تخفیف");
    else bits.push(`تخفیف ${formatPersianNumericText(patch.sale_price, { allowDecimal: true, grouping: true })} ${storeUnit}`);
  }
  if (typeof patch.stock_quantity === "number") bits.push(`موجودی ${formatPersianNumber(patch.stock_quantity)}`);
  if (typeof patch.manage_stock === "boolean") bits.push(patch.manage_stock ? "پیگیری موجودی روشن" : "پیگیری موجودی خاموش");
  if (typeof patch.status === "string" && patch.status) {
    bits.push(`وضعیت «${PRODUCT_STATUS_LABELS[patch.status] ?? patch.status}»`);
  }
  return bits.length ? bits.join("، ") : null;
}

/** The honest wording of a product-sync result — including its partial form. */
export function syncProductsResultText(result: SyncProductsResponse): string {
  if (result.queued) {
    return "درخواست همگام‌سازی کاتالوگ در صف افزونه قرار گرفت؛ محصولات پس از اجرای افزونه (معمولاً چند دقیقه) همین‌جا به‌روز می‌شوند.";
  }
  const parts = [
    `${formatPersianNumber(Number(result.total ?? 0))} محصول خوانده شد`,
    `${formatPersianNumber(Number(result.created ?? 0))} جدید`,
    `${formatPersianNumber(Number(result.updated ?? 0))} به‌روز`,
    `${formatPersianNumber(Number(result.skipped ?? 0))} ردشده`,
    `${formatPersianNumber(Number(result.variations ?? 0))} تنوع`,
    `${formatPersianNumber(Number(result.containers ?? 0))} والد/گروه`,
  ];
  let text = `همگام‌سازی محصولات انجام شد: ${parts.join("، ")}.`;
  if (result.partial) {
    const problems: string[] = [];
    const failed = Number(result.failed ?? 0);
    if (failed > 0) {
      const ids = (result.failureIds ?? []).slice(0, 5).join("، ");
      problems.push(`${formatPersianNumber(failed)} محصول ناموفق${ids ? ` (شناسه‌ها: ${ids})` : ""}`);
    }
    const variationFetchFailures = Number(result.variationFetchFailures ?? 0);
    if (variationFetchFailures > 0) {
      problems.push(`دریافت تنوع‌های ${formatPersianNumber(variationFetchFailures)} والد ناموفق بود`);
    }
    if (result.taxonomyError) problems.push("همگام‌سازی دسته‌بندی‌ها ناموفق بود");
    text += ` ⚠ همگام‌سازی ناقص بود: ${problems.join("؛ ")}. برای جزئیات و تلاش مجدد «صف و رویدادها» را ببینید.`;
  }
  return text;
}

export function CatalogueSection({
  connectionId,
  busy,
  call,
  connection,
}: SectionProps & { connection?: WpManagerConnection | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Filters live in the URL (durable across reloads, shareable, and they
  // survive the store picker's own `store` param); the section derives them
  // instead of keeping a second copy in state that can drift.
  const query = searchParams.get("q") ?? "";
  const typeFilter = searchParams.get("type") ?? "";
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Number.parseInt(searchParams.get("size") ?? "25", 10) || 25;

  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [moneyUnit, setMoneyUnit] = useState<MoneyUnit>("toman");
  const [connInfo, setConnInfo] = useState<CatalogueConnectionInfo | null>(null);
  const [searchDraft, setSearchDraft] = useState(query);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [loadError, setLoadError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");
  const loadSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParamsRef.current.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      router.replace(`${pathname}${next.toString() ? `?${next.toString()}` : ""}`, { scroll: false });
    },
    [pathname, router],
  );

  // Switching stores must never leave the previous store's rows on screen
  // (issue #943): drop the data in flight and on screen, close the editor,
  // and reset the filters — the new store has its own catalogue and facets.
  useEffect(() => {
    loadSeqRef.current += 1;
    abortRef.current?.abort();
    setProducts([]);
    setSummary(null);
    setTypes([]);
    setTotal(0);
    setTotalPages(1);
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT });
    setValidationError("");
    setSyncNotice("");
    setLoadError("");
    setSearchDraft("");
    updateParams({ q: null, type: null, page: null, size: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    // Request sequencing + abort: rapid typing, paging or a store switch
    // issues overlapping fetches, and the last one *issued* must win — not
    // whichever one happens to answer last.
    const seq = ++loadSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query.trim()) params.set("search", query.trim());
    if (typeFilter) params.set("type", typeFilter);
    const { ok, data, aborted } = await api<CatalogueResponse>(
      `/api/integrations/connections/${connectionId}/catalogue?${params.toString()}`,
      { signal: controller.signal },
    );
    if (seq !== loadSeqRef.current || aborted) return;
    if (ok) {
      setProducts(data.products ?? []);
      setTotal(Number(data.total ?? data.products?.length ?? 0));
      setTotalPages(Number(data.totalPages ?? 1));
      setSummary(data.summary ?? null);
      setTypes(data.types ?? []);
      if (data.moneyUnit === "rial" || data.moneyUnit === "toman") setMoneyUnit(data.moneyUnit);
      setConnInfo(data.connection ?? null);
    } else {
      setProducts([]);
      setSummary(null);
      const code = String(data?.error ?? "");
      setLoadError(describeWooError(code) || errorMessageOrRaw(code) || "دریافت محصولات ناموفق بود.");
    }
    setLoading(false);
  }, [connectionId, page, pageSize, query, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced search: the URL query — and therefore the fetch — follows the
  // input by 350ms instead of on every keystroke.
  useEffect(() => {
    const normalized = searchDraft.trim();
    if (normalized === query.trim()) return;
    const timer = setTimeout(() => {
      updateParams({ q: normalized || null, page: null });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, query, updateParams]);

  // A back/forward navigation (or «clear filters») re-syncs the input.
  useEffect(() => {
    setSearchDraft((current) => (current.trim() === query ? current : query));
  }, [query]);

  const hasFilters = Boolean(query.trim() || typeFilter);
  const mappedTotal = Number(summary?.total ?? 0);
  const info: CatalogueConnectionInfo | null = connInfo ??
    (connection
      ? {
          currencyUnit: connection.currencyUnit ?? "toman",
          linkMode: connection.linkMode ?? "rest_api",
          status: connection.status ?? "active",
          pushStock: connection.pushStock ?? true,
          pushPrices: connection.pushPrices ?? true,
          syncProducts: connection.syncProducts ?? true,
          lastCatalogueSyncAt: connection.lastCatalogueSyncAt ?? null,
          lastError: connection.lastError ?? null,
        }
      : null);
  const storeUnitLabel = info?.currencyUnit === "rial" ? "ریال" : "تومان";
  const typeOptions = useMemo(() => {
    const all = new Set(types);
    if (typeFilter) all.add(typeFilter);
    return [...all].sort();
  }, [types, typeFilter]);

  function clearFilters() {
    setSearchDraft("");
    updateParams({ q: null, type: null, page: null });
  }

  async function runSync() {
    setSyncing(true);
    setSyncNotice("");
    const result = await call<SyncProductsResponse>(
      `/api/integrations/connections/${connectionId}/sync/products`,
      "POST",
    );
    setSyncing(false);
    if (!result) return; // the host banner already shows the mapped error
    setSyncNotice(syncProductsResultText(result));
    // In REST mode the pull already happened — re-read so the list, the
    // facets and the summary are the post-sync truth. In plugin mode the
    // rows arrive later, on the plugin's own schedule.
    if (!result.queued) await load();
  }

  async function push(product: CatalogueProduct) {
    setValidationError("");
    const fields: Record<string, unknown> = {};
    if (draft.name.trim()) fields.name = draft.name.trim().slice(0, 200);
    if (draft.status) fields.status = draft.status;
    if (draft.endSale) fields.sale_price = "";
    else if (draft.sale.trim()) {
      const rial = parseMoneyInput(draft.sale, moneyUnit);
      if (rial === null) {
        setValidationError("قیمت تخفیف باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      fields.salePriceRial = rial;
    }
    if (draft.price.trim()) {
      const rial = parseMoneyInput(draft.price, moneyUnit);
      if (rial === null) {
        setValidationError("قیمت باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      fields.priceRial = rial;
    }
    // Only a product the store already tracks (manage_stock) may receive a
    // bare quantity; for anything else the owner must deliberately opt in,
    // so the app never fabricates a tracked figure for an untracked product.
    const needsTrackOptIn = product.remoteManageStock !== true;
    if (draft.stock.trim()) {
      const canonical = normalizeNumericText(draft.stock, { allowDecimal: false, allowNegative: false });
      if (!canonical || !/^\d+$/.test(canonical) || !Number.isSafeInteger(Number(canonical))) {
        setValidationError("موجودی باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      if (needsTrackOptIn && !draft.trackStock) {
        setValidationError("فروشگاه موجودی این محصول را ردیابی نمی‌کند؛ برای ارسال مقدار، ابتدا «پیگیری موجودی» را روشن کنید.");
        return;
      }
      fields.stock_quantity = Number(canonical);
      if (needsTrackOptIn) fields.manage_stock = true;
    }
    if (Object.keys(fields).length === 0) {
      setValidationError("حداقل یک فیلد (نام، قیمت، تخفیف، موجودی یا وضعیت) را تغییر دهید.");
      return;
    }
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/products`,
      "POST",
      { remoteId: product.remoteId, fields },
    );
    if (result) {
      setEditing(null);
      setDraft({ ...EMPTY_DRAFT });
      // Re-read so the row's own badge shows the queued patch — the honest
      // «queued, not applied» state instead of a silently closed editor.
      await load();
    }
  }

  return (
    <section
      className="mt-2 space-y-4 rounded-xl bg-muted p-3 text-sm sm:p-4"
      aria-busy={loading}
      aria-label="فهرست محصولات ووکامرس"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || syncing || info?.status === "paused" || info?.syncProducts === false}
          onClick={() => void runSync()}
        >
          {syncing ? "در حال همگام‌سازی…" : "همگام‌سازی محصولات"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={loading || !connectionId} onClick={() => void load()}>
          تازه‌سازی
        </Button>
        <span className="text-[11px] text-muted-foreground">
          آخرین همگام‌سازی کاتالوگ: {formatDateTime(info?.lastCatalogueSyncAt ?? null)}
        </span>
        <Link
          className="text-[11px] text-primary underline-offset-4 hover:underline"
          href={`/websites/wp/queue?store=${connectionId}`}
        >
          صف و رویدادها
        </Link>
      </div>

      {info?.status === "paused" ? (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200">
          اتصال فروشگاه متوقف (paused) است؛ تا فعال‌شدن آن، همگام‌سازی و ارسال تغییرات انجام نمی‌شود.
        </p>
      ) : null}
      {info && info.syncProducts === false ? (
        <p className="rounded-lg border border-border/70 bg-card p-2 text-[11px] text-muted-foreground">
          همگام‌سازی محصولات در این اتصال غیرفعال است؛ برای خواندن کاتالوگ آن را در تنظیمات اتصال روشن کنید.
        </p>
      ) : null}
      {info?.lastError ? (
        <p role="alert" className="break-words rounded-lg border border-destructive/20 bg-destructive/5 p-2 text-[11px] text-destructive" dir="ltr">
          {info.lastError}
        </p>
      ) : null}
      {syncNotice ? (
        <p role="status" className="rounded-lg border border-teal-500/30 bg-teal-500/10 p-2 text-[11px] leading-5 text-teal-900 dark:text-teal-100">
          {syncNotice}
        </p>
      ) : null}

      {loading && products.length === 0 ? <LoadingSkeleton rows={5} compact /> : null}
      {!loading && loadError ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-red-700 sm:flex-row sm:items-center sm:justify-between dark:text-red-300"
        >
          <span>{loadError}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </div>
      ) : null}

      {!loading && summary ? (
        <div className="flex flex-wrap gap-2" aria-label="خلاصهٔ کاتالوگ">
          {[
            { label: "کل", value: summary.total ?? 0 },
            { label: "قابل فروش", value: summary.sellable ?? 0 },
            { label: "تنوع", value: summary.variations ?? 0 },
            { label: "والد/گروه", value: summary.containers ?? 0 },
            { label: "ناموجود", value: summary.outOfStock ?? 0 },
            { label: "بدون دسته", value: summary.uncategorised ?? 0 },
          ].map((chip) => (
            <span key={chip.label} className="rounded-full bg-card px-2 py-0.5 text-[11px] text-foreground/80">
              {chip.label}: {formatPersianNumber(Number(chip.value))}
            </span>
          ))}
        </div>
      ) : null}

      {/* The controls stay on screen whenever there is anything to filter OR
          a filter is active — a zero-result search must remain recoverable
          (the old rule hid the very «clear» button that escapes it). */}
      {!loading && summary && (mappedTotal > 0 || hasFilters) ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-xs font-medium">جست‌وجوی محصول</span>
            <input
              className={`${inputClass} w-full`}
              placeholder="نام، SKU، نوع، دسته یا ویژگی…"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium">نوع محصول</span>
            <select
              className={`${inputClass} w-full`}
              value={typeFilter}
              onChange={(e) => updateParams({ type: e.target.value || null, page: null })}
            >
              <option value="">همهٔ نوع‌ها</option>
              {typeOptions.map((type) => (
                <option key={type} value={type}>
                  {WOO_TYPE_LABELS[type] ?? type}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={!hasFilters} onClick={clearFilters}>
            پاک‌کردن فیلترها
          </Button>
          <p className="text-xs text-muted-foreground sm:col-span-3" aria-live="polite">
            {hasFilters
              ? `${formatPersianNumber(total)} محصول مطابق فیلتر، از ${formatPersianNumber(mappedTotal)} محصول نگاشت‌شده`
              : `${formatPersianNumber(mappedTotal)} محصول نگاشت‌شده`}
          </p>
        </div>
      ) : null}

      {!loading && !loadError && summary && mappedTotal === 0 ? (
        <EmptyState>
          هنوز محصولی برای این فروشگاه نگاشت نشده است. «همگام‌سازی محصولات» را بزنید تا کاتالوگ از فروشگاه خوانده
          شود.
          {info?.linkMode === "plugin"
            ? " در اتصال افزونه‌ای، محصولات پس از اجرای بعدی افزونهٔ وردپرس (معمولاً چند دقیقه) می‌رسند."
            : ""}
        </EmptyState>
      ) : null}

      {!loading && !loadError && mappedTotal > 0 && products.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border/70 bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground">محصولی با این جست‌وجو یا فیلتر پیدا نشد.</p>
          <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
            پاک‌کردن فیلترها
          </Button>
        </div>
      ) : null}

      {loading && products.length > 0 ? (
        // Refreshing over rows that are already on screen: the busy region
        // announces itself the design system's way (role="status" +
        // aria-label + skeleton), never as a lone visible sentence.
        <LoadingSkeleton rows={1} compact label="در حال به‌روزرسانی فهرست محصولات" />
      ) : null}

      {/* The server's page, rendered as it arrived: no second client-side
          filter with a disagreeing predicate (the old one excluded wooType
          and could hide rows the server had matched). */}
      <ul className="grid gap-2 lg:grid-cols-2">
        {products.map((product) => {
          const queue = product.queue ?? null;
          const patchText = queue?.state === "queued" ? pendingPatchText(queue.pendingPatch, storeUnitLabel) : null;
          const needsTrackOptIn = product.remoteManageStock !== true;
          return (
            <li key={product.remoteId} className="rounded-lg border border-border/70 bg-card p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{product.name}</span>
                <span className="flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground/80">
                    {WOO_TYPE_LABELS[product.wooType] ?? product.wooType}
                  </span>
                  {product.remoteStatus ? (
                    <StatusBadge tone={product.remoteStatus === "publish" ? "positive" : "neutral"}>
                      {PRODUCT_STATUS_LABELS[product.remoteStatus] ?? product.remoteStatus}
                    </StatusBadge>
                  ) : null}
                  {queue?.state === "queued" ? <StatusBadge tone="active">در صف</StatusBadge> : null}
                  {queue?.state === "failed" ? <StatusBadge tone="danger">ارسال ناموفق</StatusBadge> : null}
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

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>
                  قیمت محلی (حسابداری): {moneyText(product.priceRial, moneyUnit)} {moneyUnitLabel(moneyUnit)}
                </span>
                <span>
                  فروشگاه (آخرین همگام‌سازی): {moneyText(product.remoteRegularPriceRial, moneyUnit)}{" "}
                  {moneyUnitLabel(moneyUnit)}
                  {product.remoteSalePriceRial
                    ? ` — تخفیف ${moneyText(product.remoteSalePriceRial, moneyUnit)} ${moneyUnitLabel(moneyUnit)}`
                    : ""}
                </span>
                <span>
                  موجودی:{" "}
                  {product.quantity === null
                    ? "ردیابی نمی‌شود"
                    : `${formatPersianNumber(product.quantity)}${product.remoteManageStock === false ? " (در فروشگاه ردیابی نمی‌شود)" : ""}`}
                </span>
                {product.categories.length > 0 ? <span>دسته: {product.categories.join("، ")}</span> : null}
                {product.lastSyncedAt ? <span>آخرین همگام‌سازی: {formatDateTime(product.lastSyncedAt)}</span> : null}
              </div>

              {queue && queue.state !== "idle" ? (
                <div
                  className={`mt-2 rounded-lg border p-2 text-[11px] leading-5 ${
                    queue.state === "failed"
                      ? "border-destructive/25 bg-destructive/5 text-destructive"
                      : "border-amber-500/25 bg-amber-500/5 text-amber-900 dark:text-amber-200"
                  }`}
                >
                  <span className="font-medium">
                    {queue.state === "failed" ? "ارسال ناموفق: " : "در صف ارسال: "}
                  </span>
                  {queue.kinds.map((kind) => QUEUE_KIND_LABELS[kind] ?? kind).join("، ")}
                  {patchText ? ` — ${patchText}` : ""}
                  {queue.state === "failed" && queue.lastError ? (
                    <span className="block break-words" dir="ltr">
                      {queue.lastError}
                    </span>
                  ) : null}
                  <Link
                    className="text-primary underline-offset-4 hover:underline"
                    href={`/websites/wp/queue?store=${connectionId}`}
                  >
                    پیگیری در «صف و رویدادها»
                  </Link>
                </div>
              ) : null}
              {queue?.lastSentAt ? (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  آخرین ارسال تأییدشده به فروشگاه: {formatDateTime(queue.lastSentAt)}
                </p>
              ) : null}

              {product.sellable ? (
                editing === product.remoteId ? (
                  <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
                    <label className="grid gap-1 sm:col-span-2">
                      <span className="text-xs font-medium">نام محصول در فروشگاه</span>
                      <input
                        className={`${inputClass} w-full`}
                        value={draft.name}
                        maxLength={200}
                        placeholder={product.name}
                        onChange={(e) => {
                          setDraft({ ...draft, name: e.target.value });
                          setValidationError("");
                        }}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-xs font-medium">
                        قیمت جدید ({moneyUnitLabel(moneyUnit)})
                        {product.priceRial !== null ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            — الان {moneyText(product.priceRial, moneyUnit)}
                          </span>
                        ) : null}
                      </span>
                      <input
                        className={`${inputClass} w-full`}
                        placeholder={moneyUnit === "rial" ? "مثلاً ۱٬۵۰۰٬۰۰۰" : "مثلاً ۱۵۰٬۰۰۰"}
                        inputMode="numeric"
                        disabled={info?.pushPrices === false}
                        value={draft.price}
                        onChange={(e) => {
                          setDraft({ ...draft, price: e.target.value });
                          setValidationError("");
                        }}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-xs font-medium">قیمت تخفیف ({moneyUnitLabel(moneyUnit)})</span>
                      <input
                        className={`${inputClass} w-full`}
                        placeholder="خالی = بدون تغییر"
                        inputMode="numeric"
                        disabled={info?.pushPrices === false || draft.endSale}
                        value={draft.sale}
                        onChange={(e) => {
                          setDraft({ ...draft, sale: e.target.value });
                          setValidationError("");
                        }}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        disabled={info?.pushPrices === false}
                        checked={draft.endSale}
                        onChange={(e) => setDraft({ ...draft, endSale: e.target.checked, sale: "" })}
                      />
                      پایان تخفیف (حذف قیمت تخفیف در فروشگاه)
                    </label>
                    <label className="grid gap-1">
                      <span className="text-xs font-medium">
                        موجودی جدید
                        {product.quantity !== null ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            — الان {formatPersianNumber(product.quantity)}
                          </span>
                        ) : null}
                      </span>
                      <input
                        className={`${inputClass} w-full`}
                        placeholder="مثلاً ۱۲"
                        inputMode="numeric"
                        disabled={info?.pushStock === false || (needsTrackOptIn && !draft.trackStock)}
                        value={draft.stock}
                        onChange={(e) => {
                          setDraft({ ...draft, stock: e.target.value });
                          setValidationError("");
                        }}
                      />
                    </label>
                    {needsTrackOptIn ? (
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          disabled={info?.pushStock === false}
                          checked={draft.trackStock}
                          onChange={(e) => {
                            setDraft({ ...draft, trackStock: e.target.checked });
                            setValidationError("");
                          }}
                        />
                        روشن‌کردن پیگیری موجودی در فروشگاه (manage_stock)
                      </label>
                    ) : null}
                    <label className="grid gap-1">
                      <span className="text-xs font-medium">وضعیت انتشار</span>
                      <select
                        className={`${inputClass} w-full`}
                        value={draft.status}
                        onChange={(e) => {
                          setDraft({ ...draft, status: e.target.value });
                          setValidationError("");
                        }}
                      >
                        <option value="">بدون تغییر</option>
                        {Object.entries(PRODUCT_STATUS_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {info?.pushPrices === false ? (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300">
                        ارسال قیمت برای این فروشگاه خاموش است.
                      </p>
                    ) : null}
                    {info?.pushStock === false ? (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300">
                        ارسال موجودی برای این فروشگاه خاموش است.
                      </p>
                    ) : null}
                    {queue?.state === "queued" ? (
                      <p className="text-[11px] text-muted-foreground sm:col-span-2">
                        یک ویرایش در صف است؛ ارسالِ مجدد، فیلدهای تازه را با آن ادغام می‌کند و در فیلد مشترک مقدار
                        جدیدتر برنده است.
                      </p>
                    ) : null}
                    {validationError ? (
                      <p role="alert" className="text-xs text-red-600 sm:col-span-2 dark:text-red-400">
                        {validationError}
                      </p>
                    ) : null}
                    <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
                      <Button type="button" size="xs" disabled={busy} onClick={() => void push(product)}>
                        ارسال به فروشگاه
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setEditing(null);
                          setDraft({ ...EMPTY_DRAFT });
                          setValidationError("");
                        }}
                      >
                        انصراف
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground sm:col-span-2">
                      خالی بماند یعنی بدون تغییر؛ فقط فیلدهایی که پر کنید ارسال می‌شوند. این ویرایش‌ها override
                      فروشگاه‌اند — قیمت و موجودی محلی (حسابداری) از اپ حسابداری مدیریت می‌شوند.
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
                      setDraft({ ...EMPTY_DRAFT });
                      setValidationError("");
                    }}
                  >
                    ویرایش محصول (قیمت / موجودی / انتشار)
                  </Button>
                )
              ) : (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                  {product.wooType === "grouped"
                    ? "این ردیف یک «قفسهٔ گروهی» از محصولات دیگر است؛ خودش قیمت و موجودی ندارد و محصولاتش مستقل فروخته می‌شوند."
                    : "این ردیف والدِ تنوع‌هاست (محصول متغیر)؛ خودش فروخته نمی‌شود و قیمت و موجودی روی تنوع‌هایش است."}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {!loading && total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span aria-live="polite">
            صفحه {formatPersianNumber(page)} از {formatPersianNumber(Math.max(1, totalPages))} — نمایش{" "}
            {formatPersianNumber(products.length)} از {formatPersianNumber(total)} محصول
            {hasFilters ? " (مطابق فیلتر)" : ""}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              اندازهٔ صفحه
              <select
                className={`${inputClass} w-auto py-0.5 text-xs`}
                value={pageSize}
                onChange={(e) => updateParams({ size: e.target.value, page: null })}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {formatPersianNumber(size)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={page <= 1}
              onClick={() => updateParams({ page: page <= 2 ? null : String(page - 1) })}
            >
              قبلی
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) })}
            >
              بعدی
            </Button>
          </span>
        </div>
      ) : null}

      <InfoBox>
        تغییر قیمت، موجودی و وضعیت انتشار در صف قرار می‌گیرد و در اجرای بعدی (خودکار یا افزونهٔ وردپرس) به فروشگاه
        می‌رود؛ وضعیت هر ردیف (در صف / ارسال‌شده / ناموفق) روی خود محصول و در «صف و رویدادها» دیده می‌شود. کالای محلی
        و قیمت/موجودی حسابداری در اپ حسابداری ویرایش می‌شوند؛ این صفحه overrideهای مخصوص فروشگاه ووکامرس را صف
        می‌کند.
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
              <li key={order.remoteId} className={`${cardClass} p-3 sm:p-4`}>
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
