"use client";

/**
 * «محصولات» — the WooCommerce store's catalogue as the WP manager shows it:
 * **read-only**.
 *
 * A product is managed in exactly two places — Accounting's products workspace
 * (name, price, stock, status) and the store itself. This screen is the mirror
 * between them, so it deliberately has no price or stock editor and no
 * per-product push switches: it is where an owner finds a product (search,
 * category, tag, type, publish status, stock), sees what the store shows for it
 * (image, gallery, terms, price, stock) and whether the two sides agree, and
 * where the sync itself is started and its failures retried.
 *
 * The one store-side half this screen edits is the storefront text: the card's
 * «محتوا و تصاویر» opens `product-content-sheet.tsx`, which reads the store's
 * own short/long description from the last sync and writes a change only when
 * the owner presses «اعمال» — through the ordinary product outbox, never
 * automatically (issue #1215, P1-2). Imagery stays read-only there: replacing
 * a storefront image is blocked on #941's attachment transport.
 *
 * Filters live in the URL (durable across reloads, shareable, and they survive
 * the store picker's own `store` param); the section derives them instead of
 * keeping a second copy in state that can drift. The search box stays mounted
 * while its own fetch is in flight — unmounting it dropped focus after every
 * debounced keystroke.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ImageOffIcon, InfoIcon } from "lucide-react";
import { api, errorMessageOrRaw, inputClass } from "@/app/dashboard/ui";
import { EmptyState, LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, formatPersianNumericText } from "@/lib/digits";
import { formatMoneyText, type MoneyUnit } from "@/lib/money";
import { accountingProductsHref } from "@/lib/app-routes";
import { describeWooError } from "./woo-errors";
import { formatDateTime } from "./format";
import { ListPager } from "./list-pager";
import type { WpManagerConnection } from "./wp-store-context";
import { ProductContentSheet } from "./product-content-sheet";

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

const PRODUCT_STATUS_LABELS: Record<string, string> = {
  publish: "منتشرشده",
  draft: "پیش‌نویس",
  pending: "در انتظار بازبینی",
  private: "خصوصی",
};

const STOCK_FILTER_LABELS: Record<string, string> = {
  in: "موجود",
  out: "ناموجود",
  untracked: "بدون پیگیری موجودی",
};

const QUEUE_KIND_LABELS: Record<string, string> = {
  stock: "موجودی",
  price: "قیمت",
  product_update: "ویرایش محصول",
};

const PAGE_SIZE_OPTIONS = [12, 24, 48, 96] as const;
const DEFAULT_PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 350;
/** Gallery thumbnails shown on a card before «+N». */
const GALLERY_THUMBS = 4;

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
  tags?: string[];
  attributes: string[];
  /** The store's own last-seen presentation, null before the first sync that recorded it. */
  remoteStatus: string | null;
  remoteManageStock: boolean | null;
  remoteRegularPriceRial: string | null;
  remoteSalePriceRial: string | null;
  /** The store's primary product image at the last sync — a display-only mirror. */
  remoteImageSrc: string | null;
  remoteImageAlt: string | null;
  /** The store's gallery beyond the primary image — also a display-only mirror. */
  remoteGallery?: { src: string; alt: string }[];
  /** Whether this product's shape carries store stock at all; false ⇒ `quantity` is honestly null. */
  stockTracked: boolean;
  /** The last complete store read no longer saw this product — deleted or trashed remotely. */
  remoteMissing: boolean;
  lastSyncedAt: string | null;
  /** The product's live outbox state — queued / failed / last acknowledged. */
  queue: CatalogueQueueState | null;
}

interface FacetTerm {
  remoteId: string;
  name: string;
  count: number;
}

interface CatalogueResponse extends Record<string, unknown> {
  industry?: string;
  moneyUnit?: MoneyUnit;
  connection?: CatalogueConnectionInfo | null;
  summary?: Record<string, number> | null;
  /** Every product type in the whole catalogue — not just the visible page. */
  types?: string[];
  facets?: { categories?: FacetTerm[]; tags?: FacetTerm[]; statuses?: string[] };
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
  /** Mapped products the complete store read no longer saw — flagged, never deleted. */
  missingRemotely?: number;
  taxonomyError?: string | null;
  partial?: boolean;
}

interface SectionProps {
  connectionId: string;
  /**
   * The member may change store content (`woocommerce.manage`, or the store's
   * own ability set). The panel hands this down so the content sheet's editing
   * and its AI button can be disabled for a view-only member — the routes
   * re-check the same ability, so this is a courtesy, not the fence.
   */
  canEdit?: boolean;
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

function moneyUnitLabel(unit: MoneyUnit): string {
  return unit === "rial" ? "ریال" : "تومان";
}

/**
 * Integer-Rial text → the display unit, through the platform's one money
 * formatter. Malformed legacy values must not crash the list.
 */
function moneyText(rialText: string | null, unit: MoneyUnit): string {
  if (rialText === null || rialText === "") return "—";
  try {
    return formatMoneyText(rialText, unit, { withUnit: false });
  } catch {
    return "نامعتبر";
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
  // A complete, clean read that no longer saw some mapped products is not a
  // failure — it is news from the store (they were deleted or trashed there).
  // The rows stay, flagged; nothing local is removed (issue #943, item 5).
  const missing = Number(result.missingRemotely ?? 0);
  if (missing > 0) {
    text += ` ${formatPersianNumber(missing)} محصول نگاشت‌شده در این خوانشِ فروشگاه دیده نشد (احتمالاً در فروشگاه حذف شده‌اند) و با نشان «در فروشگاه دیده نشد» علامت خورد.`;
  }
  return text;
}

export function CatalogueSection({
  connectionId,
  busy,
  call,
  canEdit = false,
  connection,
}: SectionProps & { connection?: WpManagerConnection | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const query = searchParams.get("q") ?? "";
  const typeFilter = searchParams.get("type") ?? "";
  const categoryFilter = searchParams.get("cat") ?? "";
  const tagFilter = searchParams.get("tag") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const stockFilter = searchParams.get("stock") ?? "";
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Number.parseInt(searchParams.get("size") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;

  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [facets, setFacets] = useState<{ categories: FacetTerm[]; tags: FacetTerm[]; statuses: string[] }>({
    categories: [],
    tags: [],
    statuses: [],
  });
  const [moneyUnit, setMoneyUnit] = useState<MoneyUnit>("toman");
  const [connInfo, setConnInfo] = useState<CatalogueConnectionInfo | null>(null);
  const [searchDraft, setSearchDraft] = useState(query);
  const [loadError, setLoadError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");
  /** The product whose storefront content sheet is open, if any (#1215, P1-2). */
  const [contentFor, setContentFor] = useState<CatalogueProduct | null>(null);
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
  // (issue #943): drop the data in flight and on screen and reset the
  // filters — the new store has its own catalogue and facets. But the
  // initial mount is not a switch: a shared or reloaded URL
  // (?store=…&q=…&type=…&page=…) must survive it, so the reset only fires
  // when moving *between* two resolved stores — never from the unresolved
  // first render, where the selected id arrives asynchronously.
  const prevConnectionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConnectionIdRef.current;
    prevConnectionIdRef.current = connectionId;
    if (prev === null || prev === "" || prev === connectionId) return;
    loadSeqRef.current += 1;
    abortRef.current?.abort();
    setProducts([]);
    setSummary(null);
    setTypes([]);
    setFacets({ categories: [], tags: [], statuses: [] });
    setTotal(0);
    setSyncNotice("");
    setLoadError("");
    setContentFor(null);
    setSearchDraft("");
    updateParams({ q: null, type: null, cat: null, tag: null, status: null, stock: null, page: null, size: null });
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
    if (categoryFilter) {
      params.set("taxonomy", "product_cat");
      params.set("term", categoryFilter);
    } else if (tagFilter) {
      params.set("taxonomy", "product_tag");
      params.set("term", tagFilter);
    }
    if (statusFilter) params.set("status", statusFilter);
    if (stockFilter) params.set("stock", stockFilter);
    const { ok, data, aborted } = await api<CatalogueResponse>(
      `/api/integrations/connections/${connectionId}/catalogue?${params.toString()}`,
      { signal: controller.signal },
    );
    if (seq !== loadSeqRef.current || aborted) return;
    if (ok) {
      setProducts(data.products ?? []);
      setTotal(Number(data.total ?? data.products?.length ?? 0));
      setSummary(data.summary ?? null);
      setTypes(data.types ?? []);
      setFacets({
        categories: data.facets?.categories ?? [],
        tags: data.facets?.tags ?? [],
        statuses: data.facets?.statuses ?? [],
      });
      if (data.moneyUnit === "rial" || data.moneyUnit === "toman") setMoneyUnit(data.moneyUnit);
      setConnInfo(data.connection ?? null);
    } else {
      setProducts([]);
      setSummary(null);
      const code = String(data?.error ?? "");
      setLoadError(describeWooError(code) || errorMessageOrRaw(code) || "دریافت محصولات ناموفق بود.");
    }
    setLoading(false);
  }, [connectionId, page, pageSize, query, typeFilter, categoryFilter, tagFilter, statusFilter, stockFilter]);

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

  const hasFilters = Boolean(
    query.trim() || typeFilter || categoryFilter || tagFilter || statusFilter || stockFilter,
  );
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
  const categoryOptions = useMemo(
    () => [
      { value: "", label: "همهٔ دسته‌ها" },
      ...facets.categories.map((term) => ({
        value: term.remoteId,
        label: `${term.name} (${formatPersianNumber(term.count)})`,
        searchString: term.name,
      })),
    ],
    [facets.categories],
  );
  const tagOptions = useMemo(
    () => [
      { value: "", label: "همهٔ برچسب‌ها" },
      ...facets.tags.map((term) => ({
        value: term.remoteId,
        label: `${term.name} (${formatPersianNumber(term.count)})`,
        searchString: term.name,
      })),
    ],
    [facets.tags],
  );
  // The status chips offer what the catalogue holds, plus an active filter that
  // no longer matches anything (so it can still be switched off).
  const statusOptions = useMemo(() => {
    const all = new Set(facets.statuses);
    if (statusFilter) all.add(statusFilter);
    return [...all];
  }, [facets.statuses, statusFilter]);

  function clearFilters() {
    setSearchDraft("");
    updateParams({ q: null, type: null, cat: null, tag: null, status: null, stock: null, page: null });
  }

  async function runSync() {
    setSyncing(true);
    setSyncNotice("");
    // This section renders the sync's own outcome — queued wording in plugin
    // mode, the real counts (incl. partials) in REST mode — so the panel's
    // generic notice stays silent instead of contradicting it.
    const result = await call<SyncProductsResponse>(
      `/api/integrations/connections/${connectionId}/sync/products`,
      "POST",
      undefined,
      { successNotice: null },
    );
    setSyncing(false);
    if (!result) return; // the host banner already shows the mapped error
    setSyncNotice(syncProductsResultText(result));
    // In REST mode the pull already happened — re-read so the list, the
    // facets and the summary are the post-sync truth. In plugin mode the
    // rows arrive later, on the plugin's own schedule.
    if (!result.queued) await load();
  }

  /** The row's explicit human retry for parked queue events (issue #943, item 5). */
  async function retryQueue(product: CatalogueProduct) {
    const result = await call<{ retried?: number }>(
      `/api/integrations/connections/${connectionId}/store/products/retry`,
      "POST",
      { remoteId: product.remoteId },
    );
    if (result) await load();
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

      <p className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2.5 text-[11px] leading-5 text-muted-foreground">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          این فهرست فقط نمایش است. نام، قیمت، موجودی، وضعیت و توضیحات محصول را از{" "}
          <Link className="text-primary underline-offset-4 hover:underline" href={accountingProductsHref()}>
            محصولات حسابداری
          </Link>{" "}
          یا مستقیم در وردپرس تغییر دهید؛ قیمت و موجودی حسابداری خودکار به فروشگاه می‌رود.
        </span>
      </p>

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

      {summary ? (
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

      {/* The controls stay on screen whenever there is anything to filter OR a
          filter is active — a zero-result search must remain recoverable — and
          while a fetch is in flight, so typing never loses its field. */}
      {summary && (mappedTotal > 0 || hasFilters) ? (
        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <SearchField
              className="sm:col-span-2 lg:col-span-4"
              label="جست‌وجوی محصول"
              placeholder="نام، SKU، نوع، دسته، برچسب یا ویژگی…"
              value={searchDraft}
              onChange={setSearchDraft}
            />
            <label className="grid gap-1">
              <span className="text-xs font-medium">دسته‌بندی</span>
              <SearchableSelect
                ariaLabel="فیلتر دسته‌بندی"
                value={categoryFilter}
                options={categoryOptions}
                searchPlaceholder="جست‌وجوی دسته…"
                disabled={facets.categories.length === 0 && !categoryFilter}
                onChange={(value) => updateParams({ cat: value || null, tag: null, page: null })}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium">برچسب</span>
              <SearchableSelect
                ariaLabel="فیلتر برچسب"
                value={tagFilter}
                options={tagOptions}
                searchPlaceholder="جست‌وجوی برچسب…"
                disabled={facets.tags.length === 0 && !tagFilter}
                onChange={(value) => updateParams({ tag: value || null, cat: null, page: null })}
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
            <div className="flex items-end">
              <Button type="button" variant="outline" className="w-full" disabled={!hasFilters} onClick={clearFilters}>
                پاک‌کردن فیلترها
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
            <FilterChipRow label="فیلتر وضعیت انتشار">
              <FilterChip selected={!statusFilter} onClick={() => updateParams({ status: null, page: null })}>
                همهٔ وضعیت‌ها
              </FilterChip>
              {statusOptions.map((status) => (
                <FilterChip
                  key={status}
                  selected={statusFilter === status}
                  onClick={() => updateParams({ status: statusFilter === status ? null : status, page: null })}
                >
                  {PRODUCT_STATUS_LABELS[status] ?? status}
                </FilterChip>
              ))}
            </FilterChipRow>
            <FilterChipRow label="فیلتر موجودی">
              {Object.entries(STOCK_FILTER_LABELS).map(([value, label]) => (
                <FilterChip
                  key={value}
                  selected={stockFilter === value}
                  onClick={() => updateParams({ stock: stockFilter === value ? null : value, page: null })}
                >
                  {label}
                </FilterChip>
              ))}
            </FilterChipRow>
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
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
          filter with a disagreeing predicate. */}
      <ul className="grid gap-3 lg:grid-cols-2">
        {products.map((product) => (
          <ProductCard
            key={product.remoteId}
            product={product}
            moneyUnit={moneyUnit}
            storeUnitLabel={storeUnitLabel}
            connectionId={connectionId}
            busy={busy}
            onRetry={() => void retryQueue(product)}
            onOpenContent={() => setContentFor(product)}
          />
        ))}
      </ul>

      {contentFor ? (
        <ProductContentSheet
          connectionId={connectionId}
          remoteId={contentFor.remoteId}
          productName={contentFor.name}
          // Editing the store's text is the storefront ability, and a paused
          // connection has no writable half — the sheet stays readable.
          canWrite={canEdit && connInfo?.status !== "paused"}
          call={call}
          onQueued={() => void load()}
          onClose={() => setContentFor(null)}
        />
      ) : null}

      {!loading && total > 0 ? (
        <ListPager
          page={page}
          total={total}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPage={(next) => updateParams({ page: next <= 1 ? null : String(next) })}
          onPageSize={(size) => updateParams({ size: String(size), page: null })}
          noun="محصول"
        />
      ) : null}
    </section>
  );
}

function ProductCard({
  product,
  moneyUnit,
  storeUnitLabel,
  connectionId,
  busy,
  onRetry,
  onOpenContent,
}: {
  product: CatalogueProduct;
  moneyUnit: MoneyUnit;
  storeUnitLabel: string;
  connectionId: string;
  busy: boolean;
  onRetry: () => void;
  /** Open the storefront content sheet for this row (#1215, P1-2). */
  onOpenContent: () => void;
}) {
  const queue = product.queue ?? null;
  const patchText = queue?.state === "queued" ? pendingPatchText(queue.pendingPatch, storeUnitLabel) : null;
  const gallery = product.remoteGallery ?? [];
  const tags = product.tags ?? [];
  // Accounting and the store each remember a price. When both are known and
  // differ, the owner should see it without opening anything: either a push
  // is still on its way or somebody changed the price in WordPress.
  const priceDiffers =
    product.sellable &&
    product.priceRial !== null &&
    product.remoteRegularPriceRial !== null &&
    product.priceRial !== product.remoteRegularPriceRial;

  return (
    <li className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex gap-3">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
          {product.remoteImageSrc ? (
            // The store's own primary image, mirrored read-only at the last
            // sync. Nothing uploads from here — this mirror must never become
            // a second library of its own.
            <img
              src={product.remoteImageSrc}
              alt={product.remoteImageAlt || `تصویر محصول ${product.name}`}
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-muted-foreground" title="تصویری از فروشگاه دریافت نشده">
              <ImageOffIcon aria-hidden="true" className="size-5" />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
            <span className="min-w-0 font-semibold leading-6">{product.name}</span>
            <span className="flex flex-wrap items-center gap-1">
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground/80">
                {WOO_TYPE_LABELS[product.wooType] ?? product.wooType}
              </span>
              {product.remoteStatus ? (
                <StatusBadge tone={product.remoteStatus === "publish" ? "positive" : "neutral"}>
                  {PRODUCT_STATUS_LABELS[product.remoteStatus] ?? product.remoteStatus}
                </StatusBadge>
              ) : null}
              {product.remoteMissing ? (
                <span
                  className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-800 dark:text-amber-200"
                  title="آخرین خوانشِ کاملِ فروشگاه این محصول را ندید — احتمالاً در فروشگاه حذف یا زباله‌دان شده. ردیف محلی و تاریخچهٔ آن پاک نمی‌شود."
                >
                  در فروشگاه دیده نشد
                </span>
              ) : null}
              {queue?.state === "queued" ? <StatusBadge tone="active">در صف</StatusBadge> : null}
              {queue?.state === "failed" ? <StatusBadge tone="danger">ارسال ناموفق</StatusBadge> : null}
            </span>
          </div>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {product.sku ? <span dir="ltr">{product.sku}</span> : null}
            {product.parentRemoteId ? <span dir="ltr">والد #{product.parentRemoteId}</span> : null}
            {product.attributes.length > 0 ? <span>{product.attributes.join("، ")}</span> : null}
          </p>

          {product.categories.length > 0 || tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1" aria-label="دسته‌ها و برچسب‌ها">
              {product.categories.map((name) => (
                <li key={`c-${name}`} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                  {name}
                </li>
              ))}
              {tags.map((name) => (
                <li key={`t-${name}`} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                  # {name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
        <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
          <dt className="text-muted-foreground">قیمت در فروشگاه</dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {product.remoteSalePriceRial ? (
              <>
                <span>{moneyText(product.remoteSalePriceRial, moneyUnit)}</span>{" "}
                <s className="text-muted-foreground">{moneyText(product.remoteRegularPriceRial, moneyUnit)}</s>
              </>
            ) : (
              moneyText(product.remoteRegularPriceRial, moneyUnit)
            )}{" "}
            <span className="font-normal text-muted-foreground">{moneyUnitLabel(moneyUnit)}</span>
          </dd>
        </div>
        <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
          <dt className="text-muted-foreground">قیمت در حسابداری</dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {moneyText(product.priceRial, moneyUnit)}{" "}
            <span className="font-normal text-muted-foreground">{moneyUnitLabel(moneyUnit)}</span>
            {priceDiffers ? (
              <span
                className="ms-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-800 dark:text-amber-200"
                title="قیمت حسابداری با آخرین قیمتِ دیده‌شده در فروشگاه یکی نیست؛ یا ارسال در راه است یا قیمت در وردپرس عوض شده."
              >
                ناهمخوان
              </span>
            ) : null}
          </dd>
        </div>
        <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
          <dt className="text-muted-foreground">موجودی</dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {product.quantity === null
              ? "ردیابی نمی‌شود"
              : `${formatPersianNumber(product.quantity)}${product.remoteManageStock === false ? " (در فروشگاه ردیابی نمی‌شود)" : ""}`}
          </dd>
        </div>
      </dl>

      {gallery.length > 0 ? (
        <ul className="mt-2 flex items-center gap-1.5" aria-label={`گالری تصاویر ${product.name}`}>
          {gallery.slice(0, GALLERY_THUMBS).map((image, index) => (
            <li key={`${image.src}-${index}`} className="size-9 overflow-hidden rounded-md border border-border/60 bg-muted">
              <img src={image.src} alt={image.alt || `تصویر ${index + 2} ${product.name}`} loading="lazy" className="size-full object-cover" />
            </li>
          ))}
          {gallery.length > GALLERY_THUMBS ? (
            <li className="text-[11px] text-muted-foreground">+{formatPersianNumber(gallery.length - GALLERY_THUMBS)}</li>
          ) : null}
        </ul>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onOpenContent}>
          محتوا و تصاویر
        </Button>
        <span className="text-[10px] text-muted-foreground">متن و تصاویر همین محصول در فروشگاه</span>
      </div>

      {queue && queue.state !== "idle" ? (
        <div
          className={`mt-2 rounded-lg border p-2 text-[11px] leading-5 ${
            queue.state === "failed"
              ? "border-destructive/25 bg-destructive/5 text-destructive"
              : "border-amber-500/25 bg-amber-500/5 text-amber-900 dark:text-amber-200"
          }`}
        >
          <span className="font-medium">{queue.state === "failed" ? "ارسال ناموفق: " : "در صف ارسال: "}</span>
          {queue.kinds.map((kind) => QUEUE_KIND_LABELS[kind] ?? kind).join("، ")}
          {patchText ? ` — ${patchText}` : ""}
          {queue.state === "failed" && queue.lastError ? (
            <span className="block break-words" dir="ltr">
              {queue.lastError}
            </span>
          ) : null}
          <span className="mt-1 flex flex-wrap items-center gap-2">
            {queue.state === "failed" ? (
              // The explicit human retry (issue #943, item 5): the scheduled
              // refresh may never resurrect a parked push — this button,
              // pressed on purpose, is the one path that may, and the queue
              // page shows what it re-armed.
              <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRetry}>
                تلاش دوبارهٔ ارسال
              </Button>
            ) : null}
            <Link className="text-primary underline-offset-4 hover:underline" href={`/websites/wp/queue?store=${connectionId}`}>
              پیگیری در «صف و رویدادها»
            </Link>
          </span>
        </div>
      ) : null}
      {queue?.lastSentAt ? (
        <p className="mt-1 text-[10px] text-muted-foreground">آخرین ارسال تأییدشده به فروشگاه: {formatDateTime(queue.lastSentAt)}</p>
      ) : null}

      {!product.sellable ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
          {product.wooType === "grouped"
            ? "این ردیف یک «قفسهٔ گروهی» از محصولات دیگر است؛ خودش قیمت و موجودی ندارد و محصولاتش مستقل فروخته می‌شوند."
            : "این ردیف والدِ تنوع‌هاست (محصول متغیر)؛ خودش فروخته نمی‌شود و قیمت و موجودی روی تنوع‌هایش است."}
        </p>
      ) : null}

      {product.lastSyncedAt ? (
        <p className="mt-2 text-[10px] text-muted-foreground">آخرین همگام‌سازی: {formatDateTime(product.lastSyncedAt)}</p>
      ) : null}
    </li>
  );
}
