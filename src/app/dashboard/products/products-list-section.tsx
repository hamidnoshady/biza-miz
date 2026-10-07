"use client";

/**
 * Phase 42 — «لیست محصولات»: the trade's variant board as the reference's
 * product table — a KPI summary over the catalogue, then one card with a
 * search/status/page-size/CSV toolbar, the shared table and a numbered pager,
 * plus the per-row stock/price panel — composed from the platform's card, KPI,
 * badge, input and money primitives instead of the reference's blue chrome.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue, type ReactNode } from "react";
import { BanIcon, ChevronLeftIcon, ChevronRightIcon, CircleCheckIcon, CircleXIcon, DownloadIcon, PackageIcon, PackageSearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
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
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

const PAGE_SIZES = [10, 20, 50] as const;

/** The status dropdown — `all` plus the three statuses the KPI row counts. */
const STATUS_FILTERS: readonly { value: ProductStatusFilter; label: string }[] = [
  { value: "all", label: "همه وضعیت‌ها" },
  { value: "in_stock", label: "موجود" },
  { value: "out_of_stock", label: "ناموجود" },
  { value: "non_sellable", label: "غیر قابل فروش" },
];

const PRODUCT_COLUMNS = 10;

export function ProductsListSection({ apiBase }: { apiBase: string }) {
  const [items, setItems] = useState<VariantSummary[] | null>(null);
  // A failed read used to leave the skeleton on screen forever with no way
  // out; keep the failure explicit so the card can offer a retry instead.
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>("all");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(0);
  const [panelFor, setPanelFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

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
  // avoid false-positive cross-boundary matches. Search and the status filter
  // combine with AND: «Gliss» + «موجود» is only the Gliss rows in stock.
  const needle = normalizeListSearch(deferredSearch);
  const filtered = useMemo(() => {
    if (!items || !searchIndex) return null;
    return searchIndex
      .filter(
        ({ item, needles }) =>
          (!needle || variantMatchesNeedle(needles, needle)) &&
          variantMatchesStatusFilter(item, statusFilter),
      )
      .map(({ item }) => item);
  }, [items, searchIndex, needle, statusFilter]);

  // Any narrowing of the list returns the pager to the first page — staying
  // on page 7 of a result that now has one page shows an empty table.
  useEffect(() => setPage(0), [deferredSearch, statusFilter, pageSize]);

  const searching = needle.length > 0;
  const filtering = searching || statusFilter !== "all";
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
    const blob = new Blob([buildProductsCsv(filtered)], { type: "text/csv;charset=utf-8" });
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
    setPage(0);
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
      ) : (
        <KpiRowSkeleton label="در حال خواندن نشانگرهای محصولات" />
      )}

      <SectionCard title="لیست محصولات" description={description} flush>
        {/*
          The toolbar: search takes the wide area, the two dropdowns and the
          export stay grouped after it. On a phone each control takes its own
          full-width row (search first) instead of squeezing into one clipped
          strip.
        */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/80 bg-muted/30 px-4 py-3 sm:gap-3 sm:px-5">
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
            className="min-h-9 shrink-0"
            onClick={downloadCsv}
            disabled={!filtered || filtered.length === 0}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            دانلود CSV
          </Button>
        </div>

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
          <DataTable caption="فهرست کالاها، موجودی و قیمت‌ها" tableClassName="min-w-[52rem]">
            <DataTableHead>
              <Th>#</Th>
              <Th>نام محصول</Th>
              <Th>وضعیت</Th>
              <Th>کد کالا</Th>
              <Th>بارکد</Th>
              <Th>واحد اصلی</Th>
              <Th numeric>موجودی</Th>
              <Th numeric>قیمت فروش</Th>
              <Th numeric>قیمت خرید</Th>
              <Th aria-label="عملیات" />
            </DataTableHead>
            <DataTableBody>
              {rows.map((item, index) => (
                <ProductRow
                  key={item.id}
                  item={item}
                  index={safePage * pageSize + index + 1}
                  apiBase={apiBase}
                  busy={busy}
                  setBusy={setBusy}
                  panelOpen={panelFor === item.id}
                  onTogglePanel={() => {
                    setNotice("");
                    setPanelFor((current) => (current === item.id ? null : item.id));
                  }}
                  onSaved={() => {
                    setNotice("ذخیره شد.");
                    load();
                  }}
                />
              ))}
            </DataTableBody>
          </DataTable>
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
  busy,
  setBusy,
  panelOpen,
  onTogglePanel,
  onSaved,
}: {
  item: VariantSummary;
  index: number;
  apiBase: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const isFamily = isVariantParent(item);
  const status = productStatus(item);
  const inStock = status === "in_stock";
  const sourceLabel = itemSourceLabel(item.source);
  return (
    <>
      {/* The amber "selected" wash ties the expanded panel to its row. */}
      <DataTableRow className={isFamily ? "bg-muted/60" : undefined} selected={panelOpen}>
        <Td muted className="text-xs">{toPersianDigits(index)}</Td>
        <Td>
          {/*
            Two scan lines: the name, then the family it belongs to plus its
            attributes as quiet amber chips. The status used to live here as a
            fourth chip; it has its own column now.
          */}
          <div className="min-w-0">
            <span className="block font-medium text-foreground">{item.name}</span>
            {(!isFamily && (item.parentName || item.attributes.length > 0)) || sourceLabel ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {/*
                  Audit F13 — provenance: which integration owns this row.
                  Two rows with one name and SKU are told apart here.
                */}
                {sourceLabel ? (
                  <span className="text-[11px] text-muted-foreground" title="منبع این ردیف">
                    {sourceLabel}
                  </span>
                ) : null}
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
        </Td>
        <Td muted nowrap className="text-xs">{item.sku ?? "—"}</Td>
        <Td dir="ltr" muted nowrap className="text-xs">{item.barcode ?? "—"}</Td>
        <Td muted className="text-xs">{item.unit ?? "عدد"}</Td>
        <Td numeric className="text-xs">
          {isFamily ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span
              className={cn(
                inStock ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatQuantity(item.quantity)}
            </span>
          )}
        </Td>
        <Td numeric className="text-xs">
          {isFamily ? "—" : item.unitPrice != null ? money.format(item.unitPrice) : "تعیین نشده"}
        </Td>
        <Td numeric className="text-xs">
          {isFamily ? "—" : item.unitCost != null ? money.format(item.unitCost) : "تعیین نشده"}
        </Td>
        <Td>
          {!isFamily ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-8 whitespace-nowrap px-2 text-xs"
              onClick={onTogglePanel}
              disabled={busy}
              aria-expanded={panelOpen}
              aria-controls={`stock-panel-${item.id}`}
            >
              ورود کالا / قیمت
            </Button>
          ) : null}
        </Td>
      </DataTableRow>
      {panelOpen ? (
        <DataTableRow>
          <Td colSpan={PRODUCT_COLUMNS}>
            <PanelShell id={`stock-panel-${item.id}`}>
              <StockPanel item={item} busy={busy} setBusy={setBusy} onSaved={onSaved} apiBase={apiBase} />
            </PanelShell>
          </Td>
        </DataTableRow>
      ) : null}
    </>
  );
}

/**
 * The expanded row lives inside the wide table, which scrolls sideways on
 * small screens — an uncapped panel is as wide as the table (min-width 52rem)
 * and a phone user has to scroll sideways to reach its fields. Cap it at the
 * scroll container's *visible* width, measured directly: viewport math cannot
 * know the sidebar and page padding at every breakpoint, and RTL horizontal
 * sticky positioning is unreliable across browsers.
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
