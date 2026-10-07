"use client";

/**
 * Phase 42b — «موجودی انبار»: the per-warehouse stock level on the RETAIL
 * model. One row per active sellable item of the selected warehouse:
 * quantity and running cost from `item_stock` (for a batch-tracked item, the
 * 0078 rollup of its batches), value = quantity × cost, and a low/out badge
 * from the item's reorder point. Search and the status chips filter
 * client-side over the warehouse's items; the footer totals (units and
 * value) come from the server.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useDeferredValue,
} from "react";
import { RotateCwIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, inputClass } from "../ui";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "../page-chrome";
import { type Warehouse, warehouseErrorMessage } from "./warehouses-section";
import {
  DataTable,
  DataTableBody,
  DataTableFoot,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";

interface StockItem {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
  reorderPoint: string;
  valueRial: number;
  level: "out" | "low" | "ok";
}

interface StockTotals {
  count: number;
  lowStockCount: number;
  outOfStockCount?: number;
  totalUnits: string;
  totalValueRial: string;
}

interface StockLevelsResponse {
  locationId: string;
  items: StockItem[];
  totals: StockTotals;
}

type StatusFilter = "all" | "low" | "out" | "ok";

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
      : "border-border bg-card text-foreground  hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"
  }`;

const STATUS_META: Record<
  "out" | "low" | "ok",
  { label: string; tone: "danger" | "active" | "neutral" }
> = {
  out: { label: "ناموجود", tone: "danger" },
  low: { label: "کم‌موجودی", tone: "active" },
  ok: { label: "کافی", tone: "neutral" },
};

const TRACKING_LABELS: Record<string, string> = {
  none: "عادی",
  batch: "بچ‌محور",
  serial: "سریالی",
  weight: "وزنی",
};

export function StockLevelsSection({
  locationId: controlledLocationId,
}: {
  locationId?: string | null;
}) {
  const money = useMoney();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [locationId, setLocationId] = useState(controlledLocationId ?? "");
  const [data, setData] = useState<StockLevelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const loadWarehouses = useCallback(() => {
    api<{ warehouses: Warehouse[]; error?: string }>(
      "/api/stock/warehouses",
    ).then(({ ok, data }) => {
      if (ok && Array.isArray(data.warehouses)) {
        setWarehouses(data.warehouses);
      }
    });
  }, []);

  useEffect(() => {
    loadWarehouses();
  }, [loadWarehouses]);

  useEffect(() => {
    if (controlledLocationId) {
      setLocationId(controlledLocationId);
    }
  }, [controlledLocationId]);

  // Default to the first active warehouse once the list lands.
  useEffect(() => {
    if (!locationId && warehouses.length > 0) {
      const active = warehouses.find((w) => w.is_active) ?? warehouses[0];
      if (active) setLocationId(active.id);
    }
  }, [warehouses, locationId]);

  const loadStock = useCallback(() => {
    if (!locationId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError("");
    api<StockLevelsResponse & { error?: string }>(
      `/api/stock/stock-levels?locationId=${encodeURIComponent(locationId)}`,
    ).then(({ ok, data }) => {
      setLoading(false);
      if (ok && data) {
        setData(data);
      } else {
        setData(null);
        setError(
          warehouseErrorMessage(data?.error) ||
            "خطا در دریافت موجودی انبار. دوباره تلاش کنید.",
        );
      }
    });
  }, [locationId]);

  useEffect(() => {
    loadStock();
  }, [loadStock]);

  const counts = useMemo(() => {
    if (!data?.items) return { all: 0, low: 0, out: 0, ok: 0 };
    let low = 0;
    let out = 0;
    let ok = 0;
    for (const item of data.items) {
      if (item.level === "low") low++;
      else if (item.level === "out") out++;
      else ok++;
    }
    return { all: data.items.length, low, out, ok };
  }, [data]);

  // ⚡ Bolt: Pre-compute the searchable string for each item to avoid
  // running expensive string allocations and normalization on every keystroke.
  const normalizedItems = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => {
      const searchable = [
        item.name,
        item.sku ?? "",
        TRACKING_LABELS[item.tracking] ?? item.tracking,
      ]
        .filter(Boolean)
        .join(" ");
      return { item, searchableText: normalizePosSearchText(searchable) };
    });
  }, [data]);

  // ⚡ Bolt: Use deferred search query to prevent UI blocking on slow text inputs.
  // Re-uses pre-computed searchable text for fast `.includes()` checking.
  const visibleItems = useMemo(() => {
    if (!normalizedItems) return [];
    const normalizedQuery = normalizePosSearchText(deferredSearch);
    return normalizedItems
      .filter(({ item, searchableText }) => {
        if (statusFilter !== "all" && item.level !== statusFilter) return false;
        if (!normalizedQuery) return true;
        return searchableText.includes(normalizedQuery);
      })
      .map(({ item }) => item);
  }, [normalizedItems, deferredSearch, statusFilter]);

  const selectedWarehouse = useMemo(
    () => warehouses.find((w) => w.id === locationId) ?? null,
    [warehouses, locationId],
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              انبارها
            </p>
            <h2 className="mt-1 font-semibold text-foreground">موجودی انبار</h2>
          </div>
        }
        description="موجودی هر کالا در انبار انتخاب‌شده؛ برای کالای بچ‌محور، جمع موجودی بچ‌های آن است."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={loadStock}
            disabled={loading || !locationId}
            className="gap-1.5"
            aria-label="به‌روزرسانی موجودی"
          >
            <RotateCwIcon
              className={`size-3.5 ${loading ? "opacity-60" : ""}`}
              aria-hidden="true"
            />
            <span>{loading ? "در حال بارگذاری…" : "به‌روزرسانی"}</span>
          </Button>
        }
      >
        <ErrorBox>{error}</ErrorBox>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-64">
            <SearchableSelect
              value={locationId}
              onChange={setLocationId}
              options={[
                { value: "", label: "انبار را انتخاب کنید…" },
                ...warehouses.map((w) => ({
                  value: w.id,
                  label: w.is_active ? w.name : `${w.name} (غیرفعال)`,
                })),
              ]}
              ariaLabel="انتخاب انبار"
            />
          </div>
          <div className="relative min-w-[200px] flex-1">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              className={`${inputClass} ps-9 pe-8`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجوی نام، کد یا ردیابی کالا…"
              aria-label="جستجوی کالا"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40"
                aria-label="پاک کردن جستجو"
                title="پاک کردن جستجو"
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label="فیلتر وضعیت موجودی"
        >
          <button
            type="button"
            className={chipClass(statusFilter === "all")}
            aria-pressed={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          >
            همه {data ? `(${toPersianDigits(String(counts.all))})` : ""}
          </button>
          <button
            type="button"
            className={chipClass(statusFilter === "low")}
            aria-pressed={statusFilter === "low"}
            onClick={() => setStatusFilter("low")}
          >
            کم‌موجودی {data ? `(${toPersianDigits(String(counts.low))})` : ""}
          </button>
          <button
            type="button"
            className={chipClass(statusFilter === "out")}
            aria-pressed={statusFilter === "out"}
            onClick={() => setStatusFilter("out")}
          >
            ناموجود {data ? `(${toPersianDigits(String(counts.out))})` : ""}
          </button>
          <button
            type="button"
            className={chipClass(statusFilter === "ok")}
            aria-pressed={statusFilter === "ok"}
            onClick={() => setStatusFilter("ok")}
          >
            کافی {data ? `(${toPersianDigits(String(counts.ok))})` : ""}
          </button>
        </div>
      </SectionCard>

      <SectionCard flush>
        {!locationId ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {warehouses.length === 0
                ? "هنوز انباری ثبت نشده است. از بخش «افزودن انبار» اولین انبار را بسازید."
                : "برای مشاهده موجودی، یک انبار انتخاب کنید."}
            </EmptyState>
          </div>
        ) : loading && !data ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton
              rows={5}
              label={`در حال بارگذاری موجودی${selectedWarehouse?.name ? ` انبار ${selectedWarehouse.name}` : ""}`}
            />
          </div>
        ) : data && data.items.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              این انبار کالایی ندارد. از صفحهٔ مدیریت کالاهای صنف، کالا اضافه
              کنید.
            </EmptyState>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>کالایی با این فیلترها پیدا نشد.</EmptyState>
          </div>
        ) : (
          <DataTable
            caption="موجودی کالاها و نقطه سفارش"
            tableClassName="min-w-[760px]"
          >
            <DataTableHead>
              <Th>کالا</Th>
              <Th>ردیابی</Th>
              <Th>موجودی و نقطه سفارش</Th>
              <Th numeric>بهای تمام‌شده</Th>
              <Th numeric>ارزش کل</Th>
              <Th>وضعیت</Th>
            </DataTableHead>
            <DataTableBody>
              {visibleItems.map((item) => (
                <DataTableRow key={item.id}>
                  <Td className="sm:px-5">
                    <span className="font-medium text-foreground">
                      {item.name}
                    </span>
                    {item.sku ? (
                      <span className="ms-2 inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {item.sku}
                      </span>
                    ) : null}
                  </Td>
                  <Td muted className="text-xs">
                    {TRACKING_LABELS[item.tracking] ?? item.tracking}
                  </Td>
                  <Td nowrap className="tabular-nums">
                    <div className="font-medium text-foreground">
                      {formatQuantity(item.quantity)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {Number(item.reorderPoint) > 0
                        ? `نقطه سفارش: ${formatQuantity(item.reorderPoint)}`
                        : "یادآوری سفارش خاموش"}
                    </div>
                  </Td>
                  <Td numeric nowrap muted>
                    {item.unitCost == null || item.unitCost === 0
                      ? Number(item.quantity) > 0
                        ? "بها ثبت نشده"
                        : "—"
                      : money.format(item.unitCost)}
                  </Td>
                  <Td numeric nowrap className="font-semibold">
                    {money.format(item.valueRial)}
                  </Td>
                  <Td className="sm:pe-5">
                    <StatusBadge tone={STATUS_META[item.level].tone}>
                      {STATUS_META[item.level].label}
                    </StatusBadge>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
            {data ? (
              <DataTableFoot className="text-xs sm:text-sm">
                <tr>
                  <Td muted className="font-semibold sm:px-5">
                    {visibleItems.length !== data.items.length
                      ? `نمایش ${toPersianDigits(String(visibleItems.length))} از ${toPersianDigits(String(data.totals.count))} کالا`
                      : `${toPersianDigits(String(data.totals.count))} کالا`}
                    {counts.low > 0
                      ? ` · ${toPersianDigits(String(counts.low))} کم‌موجودی`
                      : ""}
                    {counts.out > 0
                      ? ` · ${toPersianDigits(String(counts.out))} ناموجود`
                      : ""}
                  </Td>
                  <Td muted className="text-xs sm:px-5">
                    جمع واحدها:
                  </Td>
                  <Td numeric nowrap className="font-semibold">
                    {formatQuantity(data.totals.totalUnits)}
                  </Td>
                  <Td muted className="text-xs sm:px-5">
                    جمع ارزش:
                  </Td>
                  <Td
                    colSpan={2}
                    numeric
                    nowrap
                    className="font-semibold sm:pe-5"
                  >
                    {money.format(Number(data.totals.totalValueRial))}
                  </Td>
                </tr>
              </DataTableFoot>
            ) : null}
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
