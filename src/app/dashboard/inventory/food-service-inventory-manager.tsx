"use client";

/**
 * The inventory workspace.
 *
 * Phase 42 reshaped the menu around the warehouse module's own terms — the
 * same order the module's screens follow: the warehouses themselves (list +
 * add), the warehouse stock level, the warehouse documents (register and
 * list), and the physical count (انبارگردانی). The pre-existing F&B
 * sections (items, recipes, production, suppliers, purchases, waste,
 * transfers, barcodes) keep their place under «اقلام و عملیات».
 */
import {
  ArrowLeftRightIcon,
  BarcodeIcon,
  BookOpenIcon,
  BoxesIcon,
  ClipboardCheckIcon,
  FactoryIcon,
  FilePlus2Icon,
  FileTextIcon,
  PackageIcon,
  ShoppingCartIcon,
  Trash2Icon,
  TruckIcon,
  WarehouseIcon,
  type LucideIcon,
} from "lucide-react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import {
  INVENTORY_TABS,
  INVENTORY_TAB_GROUPS,
  visibleInventoryTabs,
  type InventoryTabKey as TabKey,
} from "./inventory-nav";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SectionNav } from "../section-nav";
import { api, ErrorBox } from "../ui";
import { ItemsSection } from "./items-section";
import { ProductionSection } from "./production-section";
import { RecipesSection } from "./recipes-section";
import { SuppliersSection } from "./suppliers-section";
import { PurchasesSection } from "./purchases-section";
import { WasteSection } from "./waste-section";
import { StockCountsSection } from "./stock-counts-section";
import { BarcodesSection } from "./barcodes-section";
import { TransfersSection } from "./transfers-section";
import { WarehousesSection } from "./warehouses-section";
import { DocumentFormSection } from "./document-form-section";
import { DocumentsSection } from "./documents-section";
import { StockSection } from "./stock-section";
import { PeriodicClosingsSection } from "./periodic-closings-section";
import styles from "./inventory-workspace.module.css";

export interface InventoryItem {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  reorder_level: string | number | null;
  avg_cost: string | number;
  purchase_unit: string | null;
  purchase_unit_factor: string | number;
  is_active: boolean;
  /** Made in-house through a production formula rather than bought (Phase 29). */
  is_produced: boolean;
  /** Reference photo from «کتابخانهٔ رسانه» — what the visual counter matches against (0149). */
  image_media_id: string | null;
  stock: number;
}
export interface Supplier {
  id: string;
  /** This branch's own copy — the display value for a row no party was linked to. */
  name: string;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
  /** The shared party this alias points at, and its live identity (0137, `parties`). */
  partyId?: string | null;
  partyName?: string | null;
  partyPhone?: string | null;
  partyActive?: boolean | null;
  /** `COALESCE(party, alias)` — what the row shows, resolved on the server. */
  displayName?: string | null;
  displayPhone?: string | null;
}
export interface MenuItemRef {
  id: string;
  name: string;
}
export interface ModifierRef {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
}
export interface RecipeLink {
  menu_item_id: string;
  inventory_item_id: string;
  quantity: string | number;
}
export interface ModifierRecipeLink {
  modifier_id: string;
  inventory_item_id: string;
  quantity_delta: string | number;
}

interface InventoryData {
  items: InventoryItem[];
  suppliers: Supplier[];
  menuItems: MenuItemRef[];
  modifiers: ModifierRef[];
  recipes: RecipeLink[];
  modifierRecipes: ModifierRecipeLink[];
  costingMethod: "fifo" | "lifo" | "weighted_average" | null;
  inventorySystem: "perpetual" | "periodic" | null;
}

// The section list and the دائمی/ادواری visibility rule live framework-free
// in inventory-nav.ts (unit-tested there); this component only dresses the
// entries with their icons, the way accounting-manager keeps its own icon map.
const TAB_ICONS: Record<TabKey, LucideIcon> = {
  warehouses: WarehouseIcon,
  stock: BoxesIcon,
  counts: ClipboardCheckIcon,
  "periodic-closings": ClipboardCheckIcon,
  "documents-new": FilePlus2Icon,
  documents: FileTextIcon,
  items: PackageIcon,
  production: FactoryIcon,
  recipes: BookOpenIcon,
  suppliers: TruckIcon,
  purchases: ShoppingCartIcon,
  waste: Trash2Icon,
  transfers: ArrowLeftRightIcon,
  barcodes: BarcodeIcon,
};

const TABS = INVENTORY_TABS.map((tab) => ({
  ...tab,
  icon: TAB_ICONS[tab.key],
}));

function visibleTabs(system: "perpetual" | "periodic" | null) {
  const visible = new Set(visibleInventoryTabs(system).map((t) => t.key));
  return TABS.filter((t) => visible.has(t.key));
}

const GROUPS = INVENTORY_TAB_GROUPS;

export function FoodServiceInventoryManager({
  role,
  permissions,
}: {
  role: string;
  /** The member's effective permission keys — the suppliers list's buttons follow them. */
  permissions?: readonly string[];
}) {
  const [data, setData] = useState<InventoryData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // `?tab=` so another app can send a person to one section of this workspace (the
  // shared party directory links here for a supplier's branch aliases); an unknown
  // name is ignored rather than opening a section that does not exist.
  const tabParam = useSearchParams().get("tab");
  const [tab, setTab] = useState<TabKey>(
    () => TABS.find((item) => item.key === tabParam)?.key ?? "warehouses",
  );
  // The warehouse the «موجودی انبار» panel is pointed at; the warehouses list
  // jumps here when a row is opened.
  const [stockLocationId, setStockLocationId] = useState<string | null>(null);

  // An error from one tab shouldn't keep showing once the user has moved on
  // to look at something else.
  useEffect(() => setError(""), [tab]);

  // A deep link can point at a perpetual-only section while the workspace is
  // periodic. Once the costing setting arrives, move to the first visible
  // section instead of rendering content that the navigation cannot reach.
  useEffect(() => {
    if (data && !visibleTabs(data.inventorySystem).some((item) => item.key === tab)) {
      setTab("warehouses");
    }
  }, [data, tab]);

  const load = useCallback(() => {
    api<InventoryData & { error?: string }>("/api/inventory")
      .then(({ ok, data }) => {
        if (ok) setData(data);
        else setError(errorMessage(data.error));
      })
      .catch(() => setError("دریافت اطلاعات انبار ناموفق بود؛ دوباره تلاش کنید."));
  }, []);
  useEffect(load, [load]);

  async function run(
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
    onError?: (message: string) => void,
  ) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      const message = errorMessage(data.error);
      setError(message);
      // The workspace-level ErrorBox sits above the tab rail — off-screen once
      // a section is scrolled into view. Sections that need the failure right
      // where the action happened («ثبت خرید» deep in a long form) carry their
      // own error box and pass it through here.
      onError?.(message);
      return false;
    }
    load();
    return true;
  }

  if (!data) {
    return (
      <div>
        {error ? (
          <div className="space-y-3">
            <ErrorBox>{error}</ErrorBox>
            <Button type="button" variant="outline" onClick={load}>
              تلاش دوباره
            </Button>
          </div>
        ) : (
          <LoadingSkeleton rows={3} />
        )}
      </div>
    );
  }

  return (
    <div className={`${styles.workspace} min-w-0 space-y-4 sm:space-y-5`}>
      <ErrorBox>{error}</ErrorBox>

      <SectionNav
        idPrefix="inventory"
        label="بخش‌های انبار"
        sections={visibleTabs(data.inventorySystem)}
        groups={GROUPS}
        variant="rail"
        active={tab}
        onChange={setTab}
      >
        {tab === "warehouses" ? (
          <WarehousesSection
            onOpenStock={(locationId) => {
              setStockLocationId(locationId);
              setTab("stock");
            }}
          />
        ) : null}
        {tab === "stock" ? <StockSection locationId={stockLocationId} /> : null}
        {tab === "counts" ? (
          <StockCountsSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "periodic-closings" ? (
          <PeriodicClosingsSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "documents-new" ? (
          <DocumentFormSection
            canAdjust={role === "owner" || Boolean(permissions?.includes("inventory.adjust"))}
            onCreated={() => {
              load();
              setTab("documents");
            }}
          />
        ) : null}
        {tab === "documents" ? <DocumentsSection /> : null}
        {tab === "items" ? (
          <ItemsSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "production" ? (
          <ProductionSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "recipes" ? (
          <RecipesSection
            items={data.items}
            menuItems={data.menuItems}
            modifiers={data.modifiers}
            recipes={data.recipes}
            modifierRecipes={data.modifierRecipes}
            busy={busy}
            run={run}
          />
        ) : null}
        {tab === "suppliers" ? (
          <SuppliersSection
            suppliers={data.suppliers}
            busy={busy}
            run={run}
            role={role}
            permissions={permissions}
          />
        ) : null}
        {tab === "purchases" ? (
          <PurchasesSection
            items={data.items}
            suppliers={data.suppliers}
            busy={busy}
            run={run}
          />
        ) : null}
        {tab === "waste" ? (
          <WasteSection items={data.items} busy={busy} run={run} />
        ) : null}
        {tab === "transfers" ? (
          <TransfersSection busy={busy} run={run} />
        ) : null}
        {tab === "barcodes" ? (
          <BarcodesSection items={data.items} busy={busy} />
        ) : null}
      </SectionNav>
    </div>
  );
}

export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  /** Also reported with the same mapped message the workspace ErrorBox shows. */
  onError?: (message: string) => void,
) => Promise<boolean>;

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    missing_fields: "فیلدهای الزامی را پر کنید.",
    invalid_reorder_level: "آستانه سفارش مجدد معتبر نیست.",
    invalid_purchase_unit_factor:
      "ضریب تبدیل واحد خرید باید بزرگ‌تر از صفر باشد.",
    not_found: "پیدا نشد.",
    item_not_found: "قلم انبار پیدا نشد.",
    supplier_not_found: "تأمین‌کننده پیدا نشد.",
    supplier_required: "برای دریافت نسیه، انتخاب تأمین‌کننده الزامی است.",
    no_items: "حداقل یک قلم لازم است.",
    invalid_item: "یکی از اقلام معتبر نیست.",
    invalid_quantity: "مقدار باید عددی بزرگ‌تر از صفر و حداکثر دارای ۹ رقم اعشار باشد.",
    invalid_waste_reason: "دلیل ضایعات را انتخاب کنید.",
    invalid_purchase_date: "تاریخ خرید معتبر نیست.",
    invalid_transition: "این تغییر وضعیت خرید مجاز نیست.",
    purchase_received_cannot_delete:
      "خرید دریافت‌شده برای حفظ موجودی و اسناد حسابداری قابل حذف نیست.",
    purchase_received_cannot_edit:
      "خرید دریافت‌شده قابل ویرایش نیست؛ برای اصلاح از «برگشت به تأمین‌کننده» استفاده کنید.",
    invalid_supplier_return: "اطلاعات برگشت به تأمین‌کننده کامل نیست.",
    // Codes the receive/return journal posting can surface from
    // fiscal-periods.ts when the entry date falls in a closed period.
    fiscal_period_locked: "دورهٔ مالی این تاریخ قفل شده و ثبت سند در آن ممکن نیست.",
    fiscal_period_soft_closed:
      "دورهٔ مالی این تاریخ بستهٔ موقت است؛ برای ثبت در آن، مجوز «بستن دورهٔ مالی» لازم است.",
    fiscal_period_not_defined:
      "این تاریخ در هیچ دورهٔ مالیِ تعریف‌شده‌ای قرار نمی‌گیرد. در حسابداری، بخش «سال‌ها و دوره‌های مالی»، سال شمسیِ مربوط را تعریف کنید؛ تا آن زمان ثبت سند پذیرفته نمی‌شود.",
    received_purchase_not_found: "خرید دریافت‌شده پیدا نشد.",
    supplier_return_purchase_item_not_found:
      "قلم انتخاب‌شده متعلق به این خرید نیست.",
    supplier_return_lot_required: "برای این قلم، لایهٔ موجودی معتبر پیدا نشد.",
    supplier_return_lot_not_found: "موجودی قابل برگشت برای این قلم پیدا نشد.",
    quantity_underflow: "مقدار برگشت از موجودی باقی‌مانده بیشتر است.",
    purchase_cancelled_cannot_edit: "خرید لغوشده قابل ویرایش نیست.",
    // Phase 29 — production
    output_item_not_found: "قلم انبارِ محصول پیدا نشد.",
    formula_name_taken: "فرمولی با این نام قبلاً ثبت شده است.",
    formula_not_found: "فرمول تولید پیدا نشد.",
    formula_inactive: "این فرمول غیرفعال است و امکان ثبت تولید با آن نیست.",
    formula_has_no_inputs: "برای این فرمول هنوز ماده‌ای ثبت نشده است.",
    formula_cycle:
      "این ماده خودش (به‌طور مستقیم یا غیرمستقیم) از همین محصول ساخته می‌شود و حلقه ایجاد می‌کند.",
    invalid_yield: "مقدار تولید معتبر نیست.",
    invalid_batches: "تعداد بار پخت معتبر نیست.",
    invalid_conversion_cost: "هزینهٔ تبدیل معتبر نیست.",
    run_not_found: "سند تولید پیدا نشد.",
    run_not_reversible: "این سند تولید قابل برگشت نیست.",
    already_reversed: "این سند تولید قبلاً برگشت خورده است.",
    production_output_consumed:
      "بخشی از محصول این تولید فروخته یا مصرف شده است؛ برای اصلاح از ضایعات یا شمارش انبار استفاده کنید.",
    consumption_layer_settled:
      "کسری یکی از مواد این تولید با خرید بعدی تسویه شده است و برگشت آن ممکن نیست.",
    production_reversal_inconsistent:
      "برگشت این تولید با ارقام ثبت‌شده هم‌خوان نیست.",
    // Guards these paths can surface but that had no Persian string, so they
    // fell through to «خطای غیرمنتظره» instead of naming what actually failed.
    quantity_precision_exceeded: "مقدار بیش از ۹ رقم اعشار دارد؛ عدد را گرد کنید.",
    // `invalid_quantity` is deliberately not repeated here: it is already
    // mapped above, with a message that states the rule («بزرگ‌تر از صفر و
    // حداکثر ۹ رقم اعشار») rather than only that something is wrong. A second
    // key in the same object literal is a TS1117 error, and the duplicate — the
    // vaguer of the two — is what silently won at runtime.
    invalid_rial: "مبلغ واردشده معتبر نیست.",
    periodic_system_unsupported:
      "این عملیات در سیستم ادواری در دسترس نیست؛ بهای تمام‌شده در «بستن دوره» محاسبه می‌شود.",
    // Phase 42 — warehouse documents. `periodic_system_unsupported`,
    // `quantity_precision_exceeded` and `invalid_quantity` are already mapped
    // above and cover this path too; only the codes unique to رسید/حواله are
    // added here (a repeated key is a TS1117 error, not an override).
    invalid_line:
      "یکی از سندها کامل نیست؛ قلم را انتخاب کنید و مقدار معتبر وارد کنید.",
    location_not_found: "انبار انتخاب‌شده پیدا نشد.",
    location_inactive: "این انبار غیرفعال است؛ انبار دیگری را انتخاب کنید.",
    receipt_value_required:
      "رسید بدون ارزش ثبت نمی‌شود؛ برای هر قلم قیمت واحد بزرگ‌تر از صفر وارد کنید.",
    rial_out_of_range: "مبلغ واردشده بسیار بزرگ است؛ عدد را بررسی کنید.",
    inventory_exact_cutover_required:
      "موجودی این قلم هنوز به سیستم بهای دقیق منتقل نشده است؛ ابتدا عملیات انتقال (cutover) را اجرا کنید.",
    no_location: "شعبه‌ای ثبت نشده است.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    ledger_account_missing:
      "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد. سرفصل حساب‌ها را بررسی کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
