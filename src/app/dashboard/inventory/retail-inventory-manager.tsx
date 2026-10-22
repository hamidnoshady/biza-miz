"use client";

/**
 * The retail adapter for the unified inventory workspace (خرید و انبار).
 *
 * Phase 42b reshapes the menu around the warehouse module's own terms — the
 * same order the F&B module adopted in Phase 42, implemented on the RETAIL
 * stock model (items/item_stock/item_batches): the warehouses themselves
 * (add + list), the warehouse documents (register and list), then the levels,
 * the count (انبارگردانی) and the pre-existing retail operations (خرید،
 * حواله بازگشت، گزارش) — extracted into sections, not rebuilt.
 */
import {
  BoxesIcon,
  ClipboardCheckIcon,
  FilePlus2Icon,
  FileTextIcon,
  PlusIcon,
  ShoppingCartIcon,
  Undo2Icon,
  LineChartIcon,
  WarehouseIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SectionNav } from "../section-nav";
import { Button } from "@/components/ui/button";
import { api, errorMessage, ErrorBox } from "../ui";
import { LoadingSkeleton } from "../page-chrome";
import {
  StockCountSection,
  type CountableItem,
} from "../stock/stock-count-section";
import {
  AddWarehouseSection,
  WarehouseListSection,
} from "../stock/warehouses-section";
import { DocumentFormSection } from "../stock/document-form-section";
import { DocumentsSection } from "../stock/documents-section";
import { StockLevelsSection } from "../stock/stock-levels-section";
import { PurchasesSection } from "../stock/purchases-section";
import { ReturnsSection } from "../stock/returns-section";
import { ReportsSection } from "../stock/reports-section";

const TABS = [
  { key: "warehouse-new", label: "افزودن انبار", icon: PlusIcon },
  { key: "warehouses", label: "لیست انبارها", icon: WarehouseIcon },
  { key: "document-new", label: "ثبت رسید انبار/حواله", icon: FilePlus2Icon },
  { key: "documents", label: "رسید و حواله‌های انبار", icon: FileTextIcon },
  { key: "stock-levels", label: "موجودی انبار", icon: BoxesIcon },
  { key: "counts", label: "انبارگردانی", icon: ClipboardCheckIcon },
  { key: "purchases", label: "خرید", icon: ShoppingCartIcon },
  { key: "returns", label: "حواله بازگشت", icon: Undo2Icon },
  { key: "reports", label: "گزارش", icon: LineChartIcon },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const GROUPS = [
  { label: "انبارها", keys: ["warehouse-new", "warehouses"] as const },
  { label: "سند انبار", keys: ["document-new", "documents"] as const },
  {
    label: "اقلام و عملیات",
    keys: [
      "stock-levels",
      "counts",
      "purchases",
      "returns",
      "reports",
    ] as const,
  },
];

export function RetailInventoryManager() {
  // `?tab=` so another screen can send a person straight to one section of
  // this workspace; an unknown name is ignored rather than opening a section
  // that does not exist.
  const tabParam = useSearchParams().get("tab");
  const [tab, setTab] = useState<TabKey>(
    () => TABS.find((item) => item.key === tabParam)?.key ?? "warehouses",
  );
  // The warehouse the «موجودی انبار» panel is pointed at; the warehouses list
  // jumps here when a row is opened.
  const [stockLocationId, setStockLocationId] = useState<string | null>(null);
  // The count section counts the branch's own items; every other section
  // fetches its own data, so this load never blocks the rail.
  const [countItems, setCountItems] = useState<CountableItem[] | null>(null);
  const [countDone, setCountDone] = useState("");
  const [error, setError] = useState("");

  // An error from one tab shouldn't keep showing once the user has moved on
  // to look at something else.
  useEffect(() => {
    setError("");
    setCountDone("");
  }, [tab]);

  const loadItems = useCallback(() => {
    api<{ items: CountableItem[]; error?: string }>("/api/stock/items")
      .then(({ ok, data }) => {
        if (ok) setCountItems(data.items);
        else {
          setCountItems([]);
          setError(errorMessage(data.error));
        }
      })
      .catch(() => {
        setCountItems([]);
        setError("دریافت اقلام انبار ناموفق بود؛ دوباره تلاش کنید.");
      });
  }, []);
  useEffect(loadItems, [loadItems]);

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {tab === "counts" && error ? (
        <Button type="button" variant="outline" onClick={loadItems}>
          تلاش دوباره برای دریافت اقلام
        </Button>
      ) : null}
      {countDone ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">
          {countDone}
        </p>
      ) : null}

      <SectionNav
        idPrefix="stock"
        label="بخش‌های خرید و انبار"
        sections={TABS}
        groups={GROUPS}
        variant="rail"
        active={tab}
        onChange={setTab}
      >
        {tab === "warehouse-new" ? <AddWarehouseSection /> : null}
        {tab === "warehouses" ? (
          <WarehouseListSection
            onOpenStock={(locationId) => {
              setStockLocationId(locationId);
              setTab("stock-levels");
            }}
          />
        ) : null}
        {tab === "document-new" ? (
          <DocumentFormSection
            onCreated={() => {
              // Same follow-through as the F&B shell: a posted سند lands the
              // user on the list that now holds it, with fresh item stock.
              loadItems();
              setTab("documents");
            }}
          />
        ) : null}
        {tab === "documents" ? <DocumentsSection /> : null}
        {tab === "stock-levels" ? (
          <StockLevelsSection locationId={stockLocationId} />
        ) : null}
        {tab === "counts" ? (
          countItems === null ? (
            <LoadingSkeleton
              rows={4}
              label="در حال بارگذاری اقلام برای انبارگردانی"
            />
          ) : (
            <StockCountSection
              items={countItems}
              onDone={setCountDone}
              onError={setError}
              reload={loadItems}
            />
          )
        ) : null}
        {tab === "purchases" ? <PurchasesSection /> : null}
        {tab === "returns" ? <ReturnsSection /> : null}
        {tab === "reports" ? <ReportsSection /> : null}
      </SectionNav>
    </div>
  );
}
