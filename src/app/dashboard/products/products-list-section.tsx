"use client";

/**
 * Phase 42 — «لیست محصولات»: the trade's variant board as the reference's
 * product table — a KPI summary over the catalogue, then one card with a
 * search/status/Woo/page-size/CSV toolbar, the shared table and a numbered
 * pager, plus the per-row panels.
 *
 * Issue #1207 §B compacted it. The old table was eleven columns and every
 * eligible row carried a five-line WooCommerce block, so a phone showed a table
 * it could not read and a desktop row stacked more chrome than product. It is
 * now four columns — the product, one primary stock/price state, small source
 * and connection chips, and one primary action — with the verbose facts (barcode,
 * unit, cost, Woo ids, receive/acknowledge times, store management, the
 * publish-content editor) in one expandable details area per row. `DataTable`
 * already turns that table into stacked cards below `sm`, so the same markup is
 * the mobile view.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue, type ReactNode } from "react";
import {
  BanIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  DownloadIcon,
  PackageIcon,
  PackageSearchIcon,
  RefreshCwIcon,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  buildProductsCsv,
  isVariantParent,
  normalizeListSearch,
  pageWindow,
  productKpis,
  productStatus,
  variantMatchesNeedle,
  variantMatchesStatusFilter,
  variantSearchNeedles,
  type ProductStatusFilter,
} from "@/lib/product-list";
import { api, errorMessage, Field, inputClass } from "../ui";
import { cn } from "@/lib/utils";
import { itemSourceLabel } from "@/lib/item-source";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  KpiRowSkeleton,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "../page-chrome";
import type { VariantSummary } from "@/lib/accessories-service";
import { SearchField } from "@/app/dashboard/filters";
import { PRODUCT_PUBLISH_STATUS_LABELS } from "@/lib/product-content";
import { ProductContentFields, type ProductContentValue } from "./product-content-fields";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import type { ProductWooLink } from "@/lib/integrations/product-links-service";
import { ProductStoreActionButton, ProductPublicationPanel } from "./product-publication-panel";
import { ProductDuplicatePanel } from "./product-duplicate-panel";
import { normaliseSku } from "@/lib/duplicate-items";
import {
  PRODUCT_WOO_FILTERS,
  STORE_LINK_STATE_LABEL,
  STORE_LINK_STATE_TONE,
  matchesWooFilter,
  productLinkState,
  productRowAction,
  storeLinkState,
  type ProductLinkState,
  type ProductWooFilter,
} from "@/lib/product-row-actions";

const PAGE_SIZES = [10, 20, 50] as const;

/** The status dropdown — `all` plus the three statuses the KPI row counts. */
const STATUS_FILTERS: readonly { value: ProductStatusFilter; label: string }[] = [
  { value: "all", label: "همه وضعیت‌ها" },
  { value: "in_stock", label: "موجود" },
  { value: "out_of_stock", label: "ناموجود" },
  { value: "non_sellable", label: "غیر قابل فروش" },
];

const PRODUCT_COLUMNS = 4;

/** The one expanded area a row may show at a time. */
type ProductPanelKind = "store" | "details" | "stock" | "content" | "duplicate";

type ProductWooLinkLoadState = "loading" | "ready" | "unavailable" | "error";

/** «۱۴۰۵/۰۸/۰۹ ۱۴:۳۰» — Shamsi everywhere, never a raw ISO string. */
function displayLinkTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatJalali(date, { withTime: true, timeZone: "Asia/Tehran" });
}

export function ProductsListSection({ apiBase }: { apiBase: string }) {
  const [items, setItems] = useState<VariantSummary[] | null>(null);
  // A failed read used to leave the skeleton on screen forever with no way
  // out; keep the failure explicit so the card can offer a retry instead.
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>("all");
  const [wooFilter, setWooFilter] = useState<ProductWooFilter>("all");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(0);
  const [panelFor, setPanelFor] = useState<{ id: string; kind: ProductPanelKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [wooLinks, setWooLinks] = useState<ProductWooLink[]>([]);
  const [wooLinksState, setWooLinksState] = useState<ProductWooLinkLoadState>("loading");
  // Which SKUs the duplicate report flags as needing a decision. Only the SKUs:
  // the evidence is read per row, when somebody opens its review.
  const [duplicateSkus, setDuplicateSkus] = useState<ReadonlySet<string>>(new Set());
  const [duplicateState, setDuplicateState] = useState<ProductWooLinkLoadState>("loading");
  const money = useMoney();

  const loadWooLinks = useCallback(async () => {
    setWooLinksState("loading");
    setDuplicateState("loading");
    // One round trip for both: the link badges and the duplicate flags are the
    // same "what does the store know about this row" question.
    const [linksResult, duplicateResult] = await Promise.all([
      api<{ links: ProductWooLink[]; error?: string }>("/api/products/woo-links"),
      api<{ skus?: string[]; error?: string }>("/api/products/duplicates?summary=1"),
    ]);
    if (!linksResult.ok) {
      setWooLinks([]);
      setWooLinksState(linksResult.data.error === "forbidden" ? "unavailable" : "error");
    } else {
      // A 2xx that says nothing (or omits `links`) is "no links", never a
      // crash: this read is decoration over the catalogue, and a missing body
      // must not take the whole products screen down with it.
      setWooLinks(Array.isArray(linksResult.data.links) ? linksResult.data.links : []);
      setWooLinksState("ready");
    }
    if (!duplicateResult.ok) {
      setDuplicateSkus(new Set());
      setDuplicateState(duplicateResult.data.error === "forbidden" ? "unavailable" : "error");
    } else {
      setDuplicateSkus(new Set(Array.isArray(duplicateResult.data.skus) ? duplicateResult.data.skus : []));
      setDuplicateState("ready");
    }
  }, []);

  const load = useCallback(() => {
    setLoadError(false);
    api<{ items: VariantSummary[] }>(`${apiBase}/items`).then(({ ok, data }) => {
      if (ok) {
        setItems(data.items);
      } else {
        setLoadError(true);
      }
    });
  }, [apiBase]);
  useEffect(load, [load]);
  useEffect(() => {
    void loadWooLinks();
  }, [loadWooLinks]);

  const wooLinksByLocalId = useMemo(() => {
    const grouped = new Map<string, ProductWooLink[]>();
    for (const link of wooLinks) {
      const rows = grouped.get(link.localId) ?? [];
      rows.push(link);
      grouped.set(link.localId, rows);
    }
    return grouped;
  }, [wooLinks]);

  /** Per-row state both the filter and the badges read, computed once. */
  const linkStateByLocalId = useMemo(() => {
    const states = new Map<string, ProductLinkState>();
    for (const [localId, links] of wooLinksByLocalId) states.set(localId, productLinkState(links));
    return states;
  }, [wooLinksByLocalId]);

  const isDuplicate = useCallback(
    (item: VariantSummary) => {
      const sku = normaliseSku(item.sku);
      return Boolean(sku && duplicateSkus.has(sku));
    },
    [duplicateSkus],
  );

  // Performance optimization: Pre-compute the search needles to avoid O(N)
  // recalculations per keystroke. This index depends only on the base dataset;
  // needles are digit-folded so a Persian-keyboard query («۱۰۱۳») matches the
  // Latin SKUs/barcodes the catalogue stores.
  const searchIndex = useMemo(() => {
    if (!items) return null;
    return items.map((item) => ({ item, needles: variantSearchNeedles(item) }));
  }, [items]);

  // Performance optimization: We depend on deferredSearch so typing remains
  // snappy while filtering happens in the background. Field-level needles
  // avoid false-positive cross-boundary matches. Search, the status filter and
  // the store/duplicate filter combine with AND: «Gliss» + «موجود» + «متصل» is
  // only the linked, in-stock Gliss rows.
  const needle = normalizeListSearch(deferredSearch);
  const filtered = useMemo(() => {
    if (!items || !searchIndex) return null;
    return searchIndex
      .filter(
        ({ item, needles }) =>
          (!needle || variantMatchesNeedle(needles, needle)) &&
          variantMatchesStatusFilter(item, statusFilter) &&
          matchesWooFilter(linkStateByLocalId.get(item.id) ?? "unlinked", isDuplicate(item), wooFilter),
      )
      .map(({ item }) => item);
  }, [items, searchIndex, needle, statusFilter, wooFilter, linkStateByLocalId, isDuplicate]);

  // Any narrowing of the list returns the pager to the first page — staying
  // on page 7 of a result that now has one page shows an empty table.
  useEffect(() => setPage(0), [deferredSearch, statusFilter, wooFilter, pageSize]);

  const searching = needle.length > 0;
  const filtering = searching || statusFilter !== "all" || wooFilter !== "all";
  const pageCount = filtered ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered?.slice(safePage * pageSize, safePage * pageSize + pageSize) ?? [];
  const pages = pageWindow(safePage + 1, pageCount);
  const rangeStart = safePage * pageSize + 1;
  const rangeEnd = filtered ? Math.min((safePage + 1) * pageSize, filtered.length) : 0;

  // The headline numbers describe the whole catalogue, not the filtered slice
  // — «کل محصولات» stays the truth about the business while the list narrows.
  const kpis = useMemo(() => (items ? productKpis(items) : null), [items]);

  function downloadCsv() {
    if (!filtered) return;
    const blob = new Blob([buildProductsCsv(filtered, money.unit)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "products.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setWooFilter("all");
    setPage(0);
  }

  /** The link/outbox badges and the duplicate flags, after something changed. */
  function refreshStoreState() {
    void loadWooLinks();
    load();
  }

  const description =
    filtered === null
      ? loadError
        ? "خواندن کالاها ممکن نشد"
        : "در حال خواندن کالاها…"
      : filtering
        ? `${toPersianDigits(filtered.length)} نتیجه از ${toPersianDigits(items?.length ?? 0)} کالا`
        : `${toPersianDigits(filtered.length)} کالا در فهرست`;

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      {loadError ? null : kpis ? (
        <div data-tour-id="products.kpis">
        <KpiRow>
          <KpiCard
            icon={PackageIcon}
            label="کل محصولات"
            value={toPersianDigits(kpis.total)}
            hint="خانواده‌ها و تنوع‌های ثبت‌شده"
          />
          <KpiCard
            icon={CircleCheckIcon}
            label="موجود"
            value={toPersianDigits(kpis.inStock)}
            hint="تنوع‌های قابل فروش با موجودی"
          />
          <KpiCard
            icon={CircleXIcon}
            label="ناموجود"
            value={toPersianDigits(kpis.outOfStock)}
            hint="تنوع‌های قابل فروش بدون موجودی"
          />
          <KpiCard
            icon={BanIcon}
            label="غیر قابل فروش"
            value={toPersianDigits(kpis.nonSellable)}
            hint="تنوع‌های غیرفعال از فروش"
          />
        </KpiRow>
        </div>
      ) : (
        <KpiRowSkeleton label="در حال خواندن نشانگرهای محصولات" />
      )}

      <SectionCard title="لیست محصولات" description={description} flush>
        {/*
          The toolbar: search takes the wide area, the dropdowns and the two
          exports stay grouped after it. On a phone each control takes its own
          full-width row (search first) instead of squeezing into one clipped
          strip.
        */}
        <div
          data-tour-id="products.toolbar"
          className="flex flex-wrap items-center gap-2 border-b border-border/80 bg-muted/30 px-4 py-3 sm:gap-3 sm:px-5"
        >
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="جستجو در نام محصول، کد کالا یا بارکد…"
            label="جستجوی محصول"
            className="w-full min-w-0 sm:w-auto sm:flex-1"
          />
          <label className="flex w-full shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-auto">
            وضعیت
            <select
              className={`${inputClass} w-auto`}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as ProductStatusFilter)}
              aria-label="فیلتر وضعیت محصولات"
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-full shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-auto">
            فروشگاه
            <select
              className={`${inputClass} w-auto`}
              value={wooFilter}
              // The flags arrive with the link read; filtering on a state that
              // has not loaded yet would show an empty list for no reason.
              disabled={wooLinksState === "loading" || duplicateState === "loading"}
              onChange={(event) => setWooFilter(event.target.value as ProductWooFilter)}
              aria-label="فیلتر پیوند فروشگاه و تکراری"
            >
              {PRODUCT_WOO_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-full shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-auto">
            ردیف در صفحه
            <select
              className={`${inputClass} w-auto`}
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              aria-label="تعداد ردیف در صفحه"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {toPersianDigits(size)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-9 shrink-0"
            onClick={refreshStoreState}
            disabled={wooLinksState === "loading"}
          >
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            تازه‌سازی وضعیت ارسال
          </Button>
          <Button
            type="button"
            size="sm"
            data-tour-id="products.export"
            className="min-h-9 shrink-0"
            onClick={downloadCsv}
            disabled={!filtered || filtered.length === 0}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            دانلود CSV
          </Button>
        </div>

        {/*
          Issue #909 §6 — a refresh after an edit (`onSaved` below) reused
          `load()` as-is, which never cleared `items` on failure — so the
          table correctly kept showing the stock just edited, but `loadError`
          itself was only ever read inside the `filtered === null` branch
          below. A refresh that failed here was therefore silent: the table
          looked fine and nothing told the reader their latest figures might
          be the old ones. This banner is that same retry, just not gated on
          the table being empty.
        */}
        {loadError && filtered !== null ? (
          <div className="border-b border-border/80 bg-rose-50 px-4 py-3 text-sm dark:bg-rose-500/10 sm:px-5">
            <p role="alert" className="text-rose-600 dark:text-rose-400">
              به‌روزرسانی فهرست محصولات ناموفق بود؛ ردیف‌های نمایش‌داده‌شده ممکن است قدیمی باشند.
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-2 min-h-9" onClick={load}>
              تلاش دوباره
            </Button>
          </div>
        ) : null}

        {filtered === null ? (
          loadError ? (
            <div className="p-4 sm:p-5">
              <div
                role="alert"
                className="rounded-xl border border-dashed border-rose-300 py-6 text-center text-sm dark:border-rose-500/40"
              >
                <p className="text-rose-600 dark:text-rose-400">کالاها خوانده نشد؛ اتصال را بررسی کنید.</p>
                <Button type="button" variant="outline" size="sm" className="mt-3 min-h-9" onClick={load}>
                  تلاش دوباره
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-4 sm:p-5">
              <LoadingSkeleton rows={6} label="در حال خواندن کالاها" />
            </div>
          )
        ) : filtered.length === 0 ? (
          <div className="p-4 sm:p-5">
            {filtering ? (
              <EmptyState
                icon={PackageSearchIcon}
                title="محصولی با این فیلتر پیدا نشد"
                action={
                  <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={clearFilters}>
                    پاک کردن فیلترها
                  </Button>
                }
              >
                عبارت جستجو یا وضعیت را تغییر دهید.
              </EmptyState>
            ) : (
              <EmptyState>کالایی ثبت نشده است؛ از «افزودن محصول» اولین کالا را ثبت کنید.</EmptyState>
            )}
          </div>
        ) : (
          <div data-tour-id="products.table">
          <DataTable caption="فهرست کالاها، موجودی و قیمت‌ها">
            <DataTableHead>
              <Th>محصول</Th>
              <Th>وضعیت و موجودی</Th>
              <Th>منبع و پیوند فروشگاه</Th>
              <Th aria-label="عملیات" />
            </DataTableHead>
            <DataTableBody>
              {rows.map((item, index) => (
                <ProductRow
                  key={item.id}
                  item={item}
                  index={safePage * pageSize + index + 1}
                  apiBase={apiBase}
                  wooLinks={wooLinksByLocalId.get(item.id) ?? []}
                  wooLinksState={wooLinksState}
                  duplicate={isDuplicate(item)}
                  duplicateState={duplicateState}
                  onRetryWooLinks={() => void loadWooLinks()}
                  busy={busy}
                  setBusy={setBusy}
                  panel={panelFor?.id === item.id ? panelFor.kind : null}
                  onTogglePanel={(kind) => {
                    setNotice("");
                    setPanelFor((current) => (current?.id === item.id && current.kind === kind ? null : { id: item.id, kind }));
                  }}
                  onStoreStateChanged={refreshStoreState}
                  onSaved={() => {
                    setNotice("ذخیره شد.");
                    load();
                  }}
                />
              ))}
            </DataTableBody>
          </DataTable>
          </div>
        )}
        {filtered && filtered.length > 0 ? (
          <nav
            aria-label="صفحه‌بندی لیست محصولات"
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 bg-muted/40 px-4 py-3 sm:px-5"
          >
            <p className="text-xs text-muted-foreground">
              نمایش {toPersianDigits(rangeStart)} تا {toPersianDigits(rangeEnd)} از{" "}
              {toPersianDigits(filtered.length)} محصول
            </p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label="صفحهٔ قبل"
              >
                <ChevronRightIcon aria-hidden="true" className="size-4" />
              </Button>
              {pages.map((pageNumber) => {
                const active = pageNumber - 1 === safePage;
                return (
                  <Button
                    key={pageNumber}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`صفحهٔ ${toPersianDigits(pageNumber)}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setPage(pageNumber - 1)}
                    className={cn(
                      "size-8 p-0 text-xs tabular-nums",
                      active &&
                        "border-amber-200 bg-amber-100 font-semibold text-amber-950 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/20 dark:hover:text-amber-200",
                    )}
                  >
                    {toPersianDigits(pageNumber)}
                  </Button>
                );
              })}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label="صفحهٔ بعد"
              >
                <ChevronLeftIcon aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </nav>
        ) : null}
      </SectionCard>
      {notice ? (
        <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function ProductRow({
  item,
  index,
  apiBase,
  wooLinks,
  wooLinksState,
  duplicate,
  duplicateState,
  onRetryWooLinks,
  busy,
  setBusy,
  panel,
  onTogglePanel,
  onStoreStateChanged,
  onSaved,
}: {
  item: VariantSummary;
  index: number;
  apiBase: string;
  wooLinks: ProductWooLink[];
  wooLinksState: ProductWooLinkLoadState;
  /** The row's SKU is flagged as a probable duplicate. */
  duplicate: boolean;
  duplicateState: ProductWooLinkLoadState;
  onRetryWooLinks: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  panel: ProductPanelKind | null;
  onTogglePanel: (kind: ProductPanelKind) => void;
  /** A store decision landed: re-read links, outbox state and duplicate flags. */
  onStoreStateChanged: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const isFamily = isVariantParent(item);
  const status = productStatus(item);
  const inStock = status === "in_stock";
  const sourceLabel = itemSourceLabel(item.source);
  const action = productRowAction({ links: wooLinks, duplicate });
  return (
    <>
      {/* The amber "selected" wash ties the expanded panel to its row. */}
      <DataTableRow className={isFamily ? "bg-muted/60" : undefined} selected={panel !== null}>
        <Td>
          {/*
            One cell, three scan lines at most: which row this is (number, name,
            publish status), its code, and — for a variant — the family and
            attributes that distinguish it. The status has its own column.
          */}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] text-muted-foreground tabular-nums">{toPersianDigits(index)}</span>
              <span className="min-w-0 font-medium text-foreground">{item.name}</span>
              {isFamily ? <StatusBadge tone="neutral">خانواده</StatusBadge> : null}
              {item.publishStatus === "draft" || item.publishStatus === "private" ? (
                <StatusBadge tone="neutral">{PRODUCT_PUBLISH_STATUS_LABELS[item.publishStatus]}</StatusBadge>
              ) : null}
            </div>
            <p dir="ltr" className="mt-0.5 text-xs text-muted-foreground">
              {item.sku ?? "بدون کد کالا"}
            </p>
            {(!isFamily && item.parentName) || item.attributes.length > 0 ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {!isFamily && item.parentName ? (
                  <span className="text-xs text-muted-foreground">{item.parentName}</span>
                ) : null}
                {item.attributes.map((attribute) => (
                  <span
                    key={attribute.name}
                    className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                  >
                    {attribute.name}: {attribute.value}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </Td>
        <Td>
          {/*
            §B: one primary stock/price state per row, not three competing
            columns. A family has no stock of its own, so it says so instead of
            inventing a zero.
          */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge
              tone={
                status === "in_stock"
                  ? "positive"
                  : status === "non_sellable"
                    ? "danger"
                    : "neutral"
              }
            >
              {status === "family" ? "خانواده" : status === "in_stock" ? "موجود" : status === "out_of_stock" ? "ناموجود" : "غیر قابل فروش"}
            </StatusBadge>
            {isFamily ? (
              <span className="text-xs text-muted-foreground">بدون موجودی مستقل</span>
            ) : (
              <>
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    inStock ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {formatQuantity(item.quantity)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.unitPrice != null ? money.format(item.unitPrice) : "قیمت تعیین نشده"}
                </span>
              </>
            )}
          </div>
        </Td>
        <Td>
          {/*
            Small chips: who owns the row, which store(s) know it and how their
            last delivery ended, and whether it is a duplicate candidate. The
            ids, timestamps and history moved into the row's details area.
          */}
          <div className="flex flex-wrap items-center gap-1.5">
            {sourceLabel ? (
              <span
                className="rounded-full border border-border/80 bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                title="منبع این ردیف"
              >
                {sourceLabel}
              </span>
            ) : null}
            {duplicate && duplicateState === "ready" ? (
              <StatusBadge tone="danger">احتمال تکراری</StatusBadge>
            ) : null}
            {wooLinksState === "loading" ? (
              <span className="text-xs text-muted-foreground">در حال بررسی پیوندها…</span>
            ) : wooLinksState === "unavailable" ? (
              <span className="text-xs text-muted-foreground">برای دیدن پیوند فروشگاه، دسترسی اتصال‌ها لازم است.</span>
            ) : wooLinksState === "error" ? (
              <div className="space-y-1">
                <span className="block text-muted-foreground">وضعیت پیوندها دریافت نشد.</span>
                <Button type="button" variant="outline" size="sm" className="min-h-8 px-2 text-xs" onClick={onRetryWooLinks}>
                  تلاش دوباره
                </Button>
              </div>
            ) : wooLinks.length === 0 ? (
              <StatusBadge tone="neutral">بدون پیوند ووکامرس</StatusBadge>
            ) : (
              wooLinks.map((link) => {
                const state = storeLinkState(link);
                return (
                  <span
                    key={`${link.connectionId}:${link.remoteId}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/80 bg-card px-2 py-0.5 text-[11px]"
                    title={`${link.storeName} · Woo ID ${link.remoteId}`}
                  >
                    <span className="max-w-24 truncate text-foreground">{link.storeName}</span>
                    <StatusBadge tone={STORE_LINK_STATE_TONE[state]}>{STORE_LINK_STATE_LABEL[state]}</StatusBadge>
                  </span>
                );
              })
            )}
          </div>
        </Td>
        <Td>
          {/*
            §B: one primary action, plus the details disclosure (and, on a
            linked duplicate, the review that must not be lost behind it).
          */}
          <div className="flex flex-wrap items-center gap-1.5">
            <ProductStoreActionButton
              links={wooLinks}
              duplicate={duplicate}
              open={panel === "store"}
              controls={`store-panel-${item.id}`}
              onToggle={() => onTogglePanel("store")}
              onReviewDuplicate={() => onTogglePanel("duplicate")}
            />
            {action.kind === "manual_update" && duplicate && duplicateState === "ready" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-8 whitespace-nowrap px-2 text-xs"
                aria-expanded={panel === "duplicate"}
                aria-controls={`duplicate-panel-${item.id}`}
                onClick={() => onTogglePanel("duplicate")}
              >
                بررسی تکراری
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-8 whitespace-nowrap px-2 text-xs"
              aria-expanded={panel === "details"}
              aria-controls={`details-panel-${item.id}`}
              onClick={() => onTogglePanel("details")}
            >
              جزئیات
              <ChevronDownIcon
                aria-hidden="true"
                className={cn("size-3.5 transition-transform", panel === "details" && "rotate-180")}
              />
            </Button>
          </div>
        </Td>
      </DataTableRow>
      {panel === "store" ? (
        <DataTableRow>
          <Td colSpan={PRODUCT_COLUMNS}>
            <PanelShell id={`store-panel-${item.id}`}>
              <PanelFrame itemName={item.name}>
                <ProductPublicationPanel
                  localId={item.id}
                  links={wooLinks}
                  duplicate={duplicate}
                  open
                  onQueued={() => {
                    onStoreStateChanged();
                  }}
                />
              </PanelFrame>
            </PanelShell>
          </Td>
        </DataTableRow>
      ) : null}
      {panel === "duplicate" ? (
        <DataTableRow>
          <Td colSpan={PRODUCT_COLUMNS}>
            <PanelShell id={`duplicate-panel-${item.id}`}>
              <PanelFrame itemName={item.name}>
                <ProductDuplicatePanel
                  sku={item.sku ?? ""}
                  onDecision={() => {
                    onStoreStateChanged();
                  }}
                />
              </PanelFrame>
            </PanelShell>
          </Td>
        </DataTableRow>
      ) : null}
      {panel === "details" ? (
        <DataTableRow>
          <Td colSpan={PRODUCT_COLUMNS}>
            <PanelShell id={`details-panel-${item.id}`}>
              <ProductDetailsPanel
                item={item}
                wooLinks={wooLinks}
                wooLinksState={wooLinksState}
                onRetryWooLinks={onRetryWooLinks}
                duplicate={duplicate}
                busy={busy}
                onOpenPanel={onTogglePanel}
              />
            </PanelShell>
          </Td>
        </DataTableRow>
      ) : null}
      {panel === "stock" ? (
        <DataTableRow>
          <Td colSpan={PRODUCT_COLUMNS}>
            <PanelShell id={`stock-panel-${item.id}`}>
              <StockPanel item={item} busy={busy} setBusy={setBusy} onSaved={onSaved} apiBase={apiBase} />
            </PanelShell>
          </Td>
        </DataTableRow>
      ) : null}
      {panel === "content" ? (
        <DataTableRow>
          <Td colSpan={PRODUCT_COLUMNS}>
            <PanelShell id={`content-panel-${item.id}`}>
              <ContentPanel item={item} busy={busy} setBusy={setBusy} onSaved={onSaved} />
            </PanelShell>
          </Td>
        </DataTableRow>
      ) : null}
    </>
  );
}

/**
 * The expanded row lives inside the wide table, which scrolls sideways on
 * small screens — an uncapped panel is as wide as the table and a phone user
 * has to scroll sideways to reach its fields. Cap it at the scroll container's
 * *visible* width, measured directly: viewport math cannot know the sidebar and
 * page padding at every breakpoint, and RTL horizontal sticky positioning is
 * unreliable across browsers.
 */
function PanelShell({ id, children }: { id?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    const scroller = ref.current?.closest("div.overflow-x-auto");
    if (!(scroller instanceof HTMLElement)) return;
    const fit = () => {
      if (scroller.clientWidth > 0) setAvailable(scroller.clientWidth);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return (
    // 12px: the cell's own inline-end padding, so the panel's far edge stays
    // off the scroll edge. Hidden until the first measure to avoid a flash of
    // table-wide panel on narrow screens. `sticky start-0` then keeps the
    // width-capped panel glued to the table's visible start edge even when
    // the user had scrolled the table to reach the row's toggle button —
    // without it the panel would reopen off-screen under the user's finger.
    <div
      id={id}
      ref={ref}
      className={available == null ? "invisible" : "sticky start-0"}
      style={available != null ? { maxWidth: available - 12 } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The amber panel skin every expanded row shares. `title` is optional: the
 * store and duplicate reviews carry their own heading, and a second one
 * stacked under it would say the same thing twice.
 */
function PanelFrame({ title, itemName, children }: { title?: string; itemName: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 sm:p-4 dark:border-amber-500/25 dark:bg-amber-500/10">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {title ? <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">{title}</p> : null}
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{itemName}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * §B's expandable per-product details: the columns the compact table gave up
 * (barcode, unit, cost), each store's remote id and its two *separate* times —
 * the last catalogue receive and the last acknowledged send — plus the handles
 * that used to crowd the row.
 */
function ProductDetailsPanel({
  item,
  wooLinks,
  wooLinksState,
  onRetryWooLinks,
  duplicate,
  busy,
  onOpenPanel,
}: {
  item: VariantSummary;
  wooLinks: ProductWooLink[];
  wooLinksState: ProductWooLinkLoadState;
  onRetryWooLinks: () => void;
  duplicate: boolean;
  busy: boolean;
  onOpenPanel: (kind: ProductPanelKind) => void;
}) {
  const money = useMoney();
  const isFamily = isVariantParent(item);
  return (
    <PanelFrame title="جزئیات محصول" itemName={item.name}>
      <div className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="کد کالا" value={item.sku ?? "—"} mono />
        <Detail label="بارکد" value={item.barcode ?? "—"} mono />
        <Detail label="واحد اصلی" value={item.unit ?? "عدد"} />
        <Detail label="قیمت فروش" value={isFamily ? "—" : item.unitPrice != null ? money.format(item.unitPrice) : "تعیین نشده"} />
        <Detail label="قیمت خرید" value={isFamily ? "—" : item.unitCost != null ? money.format(item.unitCost) : "تعیین نشده"} />
        <Detail label="وضعیت انتشار" value={PRODUCT_PUBLISH_STATUS_LABELS[item.publishStatus]} />
      </div>

      <div className="mt-4 space-y-3">
        <p className="text-xs font-medium text-foreground">فروشگاه ووکامرس</p>
        {wooLinksState === "loading" ? (
          <p className="text-xs text-muted-foreground">در حال بررسی پیوندها…</p>
        ) : wooLinksState === "unavailable" ? (
          <p className="text-xs text-muted-foreground">برای دیدن پیوند فروشگاه، دسترسی اتصال‌ها لازم است.</p>
        ) : wooLinksState === "error" ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">وضعیت پیوندها دریافت نشد.</p>
            <Button type="button" variant="outline" size="sm" className="min-h-8 px-2 text-xs" onClick={onRetryWooLinks}>
              تلاش دوباره
            </Button>
          </div>
        ) : wooLinks.length === 0 ? (
          <div className="space-y-1">
            <StatusBadge tone="neutral">بدون پیوند ووکامرس</StatusBadge>
            <p className="text-xs text-muted-foreground">
              این ردیف محلی است؛ برای ارسال به فروشگاه از «انتشار در فروشگاه» استفاده کنید.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {wooLinks.map((link) => {
              const state = storeLinkState(link);
              return (
                <li key={`${link.connectionId}:${link.remoteId}`} className="space-y-1 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone={STORE_LINK_STATE_TONE[state]}>{STORE_LINK_STATE_LABEL[state]}</StatusBadge>
                    <span className="font-medium text-foreground">WooCommerce · {link.storeName}</span>
                    <span className="text-muted-foreground" dir="ltr">
                      Woo ID: {link.remoteId}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                    <span>آخرین دریافت کاتالوگ: {displayLinkTime(link.lastCatalogueSyncAt)}</span>
                    {link.lastOutboundStatus ? (
                      <span>آخرین تأیید ارسال: {displayLinkTime(link.lastOutboundSentAt)}</span>
                    ) : null}
                  </div>
                  {link.lastOutboundError ? (
                    <p className="text-rose-600 dark:text-rose-400">آخرین خطای ارسال: {link.lastOutboundError}</p>
                  ) : null}
                  <Link
                    className="inline-block text-[11px] text-primary underline-offset-4 hover:underline"
                    href={`/websites/wp/products?store=${encodeURIComponent(link.connectionId)}`}
                  >
                    مدیریت این فروشگاه
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {!isFamily ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-8 whitespace-nowrap px-2 text-xs"
            onClick={() => onOpenPanel("stock")}
            disabled={busy}
            aria-controls={`stock-panel-${item.id}`}
          >
            ورود کالا / قیمت
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-8 whitespace-nowrap px-2 text-xs"
          onClick={() => onOpenPanel("content")}
          disabled={busy}
          aria-controls={`content-panel-${item.id}`}
        >
          توضیحات و انتشار
        </Button>
        {duplicate ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-8 whitespace-nowrap px-2 text-xs"
            onClick={() => onOpenPanel("duplicate")}
            disabled={busy}
            aria-controls={`duplicate-panel-${item.id}`}
          >
            بررسی محصول تکراری
          </Button>
        ) : null}
      </div>
    </PanelFrame>
  );
}

/** One labelled fact in the details grid. */
function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("break-all text-xs text-foreground", mono && "tabular-nums")}>{value}</p>
    </div>
  );
}

/**
 * The same receipt/price panel the old «کالاها» board carried — stock and the
 * shelf price stay one write path with the trade's own stock route.
 */
function StockPanel({
  item,
  busy,
  setBusy,
  onSaved,
  apiBase,
}: {
  item: VariantSummary;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSaved: () => void;
  apiBase: string;
}) {
  const money = useMoney();
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [unitPrice, setUnitPrice] = useState(
    item.unitPrice != null ? String(money.toInput(item.unitPrice)) : "",
  );
  const [error, setError] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const quantityText = quantity.trim();
    const unitCostText = unitCost.trim();
    const unitPriceText = unitPrice.trim();

    // Client-side copies of the server's rules (validateStockReceipt in
    // lib/accessories.ts): checking them here keeps a no-op submit from being
    // announced as a success and keeps an empty «بهای تمام‌شده» from being
    // silently coerced to ۰ — which used to roll the weighted-average cost
    // down to zero while looking like a valid receipt.
    if (!quantityText && !unitPriceText && !unitCostText) {
      setError("تعداد ورودی یا قیمت فروش را وارد کنید.");
      return;
    }
    const quantityValue = quantityText ? Number(quantityText) : null;
    if (quantityValue != null && (!Number.isFinite(quantityValue) || quantityValue <= 0)) {
      setError("تعداد ورودی باید بزرگ‌تر از صفر باشد.");
      return;
    }
    if (quantityText && !unitCostText) {
      setError("بهای تمام‌شده برای ورود کالا لازم است.");
      return;
    }
    if (!quantityText && unitCostText) {
      setError("برای ثبت بهای تمام‌شده، تعداد ورودی را هم وارد کنید.");
      return;
    }
    const unitCostValue = unitCostText ? Number(unitCostText) : null;
    if (unitCostValue != null && !Number.isFinite(unitCostValue)) {
      setError("بهای تمام‌شده نامعتبر است.");
      return;
    }
    const unitPriceValue = unitPriceText ? Number(unitPriceText) : null;
    if (unitPriceValue != null && !Number.isFinite(unitPriceValue)) {
      setError("قیمت فروش نامعتبر است.");
      return;
    }

    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`${apiBase}/items/${item.id}/stock`, {
      method: "POST",
      body: JSON.stringify({
        quantity: quantityText || undefined,
        unitCost: quantityText ? money.fromInput(Math.round(unitCostValue ?? 0)) : undefined,
        unitPrice: unitPriceText ? money.fromInput(Math.round(unitPriceValue ?? 0)) : undefined,
      }),
    });
    setBusy(false);
    if (!ok) {
      // The stock routes answer validation failures with a free-text Persian
      // `message` («تعداد ورودی باید بزرگ‌تر از صفر باشد.»); surface it.
      // Coded failures (session, industry, …) go through the shared message
      // map instead of falling back to a bare «try again».
      setError(data.message?.trim() || errorMessage(data.error));
      return;
    }
    // Clear the receipt fields so a distracted second click does not receive
    // the same stock twice; the price field already shows what was saved.
    setQuantity("");
    setUnitCost("");
    onSaved();
  }

  return (
    <form
      onSubmit={save}
      className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 sm:p-4 dark:border-amber-500/25 dark:bg-amber-500/10"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">ورود کالا / قیمت</p>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.name}</p>
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label="تعداد ورودی" hint="برای ثبت فقط قیمت، خالی بگذارید.">
          <PersianNumberInput
            className={inputClass}
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value);
              setError("");
            }}
            inputMode="decimal"
            allowNegative={false}
            autoFocus
          />
        </Field>
        <Field label={`بهای تمام‌شده هر واحد (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            value={unitCost}
            onChange={(event) => {
              setUnitCost(event.target.value);
              setError("");
            }}
            inputMode="numeric"
            allowNegative={false}
          />
        </Field>
        <Field label={`قیمت فروش هر واحد (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            value={unitPrice}
            onChange={(event) => {
              setUnitPrice(event.target.value);
              setError("");
            }}
            inputMode="numeric"
            allowNegative={false}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} size="sm" className="min-h-9 px-4 font-semibold">
          {busy ? "در حال ذخیره…" : "ذخیره"}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Publish status and the two descriptions of one product — saved through the
 * same `/api/products/items/[id]/meta` write path the add form's fields end up
 * in, so a family's text is edited on its parent row like any other item.
 */
function ContentPanel({
  item,
  busy,
  setBusy,
  onSaved,
}: {
  item: VariantSummary;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<ProductContentValue>({
    publishStatus: item.publishStatus,
    shortDescription: item.shortDescription ?? "",
    longDescription: item.longDescription ?? "",
  });
  const [error, setError] = useState("");
  const dirty =
    value.publishStatus !== item.publishStatus ||
    value.shortDescription !== (item.shortDescription ?? "") ||
    value.longDescription !== (item.longDescription ?? "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; field?: string; message?: string }>(
      `/api/products/items/${item.id}/meta`,
      {
        method: "PATCH",
        body: JSON.stringify({
          publishStatus: value.publishStatus,
          shortDescription: value.shortDescription,
          longDescription: value.longDescription,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(
        data.error === "text_too_long"
          ? "یکی از متن‌ها از حد مجاز بلندتر است."
          : data.message?.trim() || errorMessage(data.error),
      );
      return;
    }
    onSaved();
  }

  return (
    <form
      onSubmit={save}
      className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 sm:p-4 dark:border-amber-500/25 dark:bg-amber-500/10"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">توضیحات و انتشار</p>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.name}</p>
      </div>
      <ProductContentFields
        value={value}
        onChange={(patch) => {
          setError("");
          setValue((current) => ({ ...current, ...patch }));
        }}
        facts={{
          name: item.parentName && item.kind === "variant_child" ? `${item.parentName} — ${item.name}` : item.name,
          sku: item.sku ?? undefined,
          unit: item.unit ?? undefined,
          attributes: item.attributes,
        }}
        disabled={busy}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !dirty} size="sm" className="min-h-9 px-4 font-semibold">
          {busy ? "در حال ذخیره…" : "ذخیره"}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
