"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useDeferredValue, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatQuantity } from "@/lib/digits";
import { useInventorySearch } from "@/lib/inventory-search";
import { useMoney } from "@/components/money/money-context";
import { api, Field, inputClass } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";
import { EmptyState, SectionCard } from "../page-chrome";
import { supportingTextClass } from "../typography";
import { MediaImageField, mediaFileUrl } from "../media/media-picker";

export function ItemsSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState("");
  const [validationError, setValidationError] = useState("");
  const [reorderLevel, setReorderLevel] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("");
  const [purchaseFactor, setPurchaseFactor] = useState("1");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const visibleItems = useInventorySearch(items, deferredQuery);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setValidationError("");
    if (!name.trim() || !unit.trim()) {
      setValidationError("نام قلم و واحد پایه الزامی است.");
      return;
    }
    const reorder = reorderLevel.trim() ? Number(reorderLevel) : null;
    const factor = purchaseUnit.trim() ? Number(purchaseFactor) : 1;
    if (reorder !== null && (!Number.isFinite(reorder) || reorder < 0)) {
      setValidationError("آستانه سفارش مجدد نمی‌تواند منفی باشد.");
      return;
    }
    if (!Number.isFinite(factor) || factor <= 0) {
      setValidationError("ضریب تبدیل واحد خرید باید بزرگ‌تر از صفر باشد.");
      return;
    }
    const ok = await run(() =>
      api("/api/inventory/items", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          sku: sku.trim() || null,
          unit: unit.trim(),
          reorderLevel: reorder,
          purchaseUnit: purchaseUnit.trim() || null,
          purchaseUnitFactor: factor,
        }),
      }),
    );
    if (ok) {
      setName("");
      setSku("");
      setUnit("");
      setReorderLevel("");
      setPurchaseUnit("");
      setPurchaseFactor("1");
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <SectionCard
        className="order-2 md:order-1"
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت موجودی</p>
            <h2 className="mt-1 font-semibold text-foreground">اقلام انبار (مواد اولیه)</h2>
          </div>
        }
        description="فهرست مواد اولیه و تنظیمات واحدهای خرید آن‌ها."
        flush
      >
        <div className="relative border-b border-border/80 px-4 pb-4 sm:px-5">
          <SearchIcon className="pointer-events-none absolute start-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground sm:start-8" />
          <input
            className={`${inputClass} ps-9 ${query ? "pe-10" : ""}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="جستجوی قلم (نام، کد، واحد)…"
            aria-label="جستجوی قلم انبار"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute end-6 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:end-7"
              aria-label="پاک کردن جستجو"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>

        <ul className="divide-y divide-border/80">
          {visibleItems.map((it) => (
            <ItemRow key={it.id} item={it} busy={busy} run={run} />
          ))}
          {items.length === 0 ? (
            <li className="px-4 py-5 sm:px-5">
              <EmptyState>هنوز قلمی در انبار ثبت نشده است.</EmptyState>
            </li>
          ) : visibleItems.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
              موردی یافت نشد.
            </li>
          ) : null}
        </ul>
      </SectionCard>

      <aside className="order-1 min-w-0 md:order-2">
        <SectionCard
          className="md:sticky md:top-4"
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">افزودن</p>
              <h2 className="mt-1 font-semibold text-foreground">قلم انبار جدید</h2>
            </div>
          }
          description="اطلاعات پایهٔ قلم را وارد کنید؛ آستانه سفارش مجدد اختیاری است."
        >
          <form onSubmit={add} className="space-y-3">
            <Field label="نام قلم">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً قهوه"
                required
              />
            </Field>
            <Field label="کد کالا (SKU)">
              <input
                className={inputClass}
                dir="ltr"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="اختیاری؛ مثلاً COF-001"
                maxLength={100}
              />
            </Field>
            <Field label="واحد پایه">
              <input
                className={inputClass}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="g، ml، عدد…"
                required
              />
            </Field>
            <Field label="آستانه سفارش مجدد">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={reorderLevel}
                onChange={(e) => setReorderLevel(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="واحد خرید">
              <input
                className={inputClass}
                value={purchaseUnit}
                onChange={(e) => {
                  setPurchaseUnit(e.target.value);
                  if (!e.target.value.trim()) setPurchaseFactor("1");
                }}
                placeholder="اختیاری؛ مثلاً kg"
              />
            </Field>
            <Field label="ضریب تبدیل واحد خرید">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={purchaseFactor}
                onChange={(e) => setPurchaseFactor(e.target.value)}
                placeholder="مثلاً ۱۰۰۰"
                disabled={!purchaseUnit.trim()}
                aria-describedby="purchase-factor-help"
              />
              <span id="purchase-factor-help" className={`mt-1 block text-muted-foreground ${supportingTextClass}`}>
                تعداد واحد پایه در یک واحد خرید
              </span>
            </Field>
            {validationError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {validationError}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="w-full px-5 font-semibold"
            >
              افزودن قلم
            </Button>
          </form>
        </SectionCard>
      </aside>
    </div>
  );
}

function ItemRow({
  item,
  busy,
  run,
}: {
  item: InventoryItem;
  busy: boolean;
  run: Runner;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditItemRow
        item={item}
        busy={busy}
        run={run}
        onDone={() => setEditing(false)}
      />
    );
  }

  const reorderLevel =
    item.reorder_level === null ? null : Number(item.reorder_level);

  return (
    <li className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {item.image_media_id ? (
          <span className="mt-0.5 block size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
            { }
            <img
              src={mediaFileUrl(item.image_media_id)}
              alt={item.name}
              loading="lazy"
              className="size-full object-cover"
            />
          </span>
        ) : null}
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3
            className={`min-w-0 break-words font-semibold text-foreground ${item.is_active ? "" : "text-muted-foreground line-through"}`}
          >
            {item.name}
          </h3>
          {item.sku ? (
            <span className="text-xs text-muted-foreground">({item.sku})</span>
          ) : null}
          {item.is_produced ? (
            <span className="rounded-full bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 text-[0.7rem] font-medium text-amber-950 dark:text-amber-200">
              ساخت داخلی
            </span>
          ) : null}
          {!item.is_active ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[0.7rem] font-medium text-muted-foreground">
              غیرفعال
            </span>
          ) : null}
        </div>

        <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
          <MetaItem label="واحد پایه">{item.unit}</MetaItem>
          {reorderLevel !== null ? (
            <MetaItem label="آستانه سفارش مجدد">
              {formatQuantity(reorderLevel)} {item.unit}
            </MetaItem>
          ) : null}
          {item.purchase_unit ? (
            <MetaItem label="واحد خرید">
              {item.purchase_unit} = {formatQuantity(item.purchase_unit_factor)}{" "}
              {item.unit}
            </MetaItem>
          ) : null}
          <MetaItem label="موجودی فعلی">
            {formatQuantity(item.stock)} {item.unit}
          </MetaItem>
          <MetaItem label="میانگین بها">
            <ItemCost item={item} />
          </MetaItem>
        </dl>
      </div>
      </div>

      <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          ویرایش
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api(`/api/inventory/items/${item.id}`, {
                method: "PATCH",
                body: JSON.stringify({ isActive: !item.is_active }),
              }),
            )
          }
        >
          {item.is_active ? "غیرفعال" : "فعال"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `قلم «${item.name}» حذف شود؟ قلمی که سابقهٔ مصرف یا خرید دارد غیرفعال می‌شود.`,
              )
            )
              return;
            void run(() =>
              api(`/api/inventory/items/${item.id}`, { method: "DELETE" }),
            );
          }}
        >
          حذف
        </Button>
      </div>
    </li>
  );
}

function ItemCost({ item }: { item: InventoryItem }) {
  const money = useMoney();
  return <>{money.format(Number(item.avg_cost))}</>;
}

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-foreground/80">
        {children}
      </dd>
    </div>
  );
}

function EditItemRow({
  item,
  busy,
  run,
  onDone,
}: {
  item: InventoryItem;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [sku, setSku] = useState(item.sku ?? "");
  const [unit, setUnit] = useState(item.unit);
  const [validationError, setValidationError] = useState("");
  const [reorderLevel, setReorderLevel] = useState(
    item.reorder_level === null ? "" : String(Number(item.reorder_level)),
  );
  const [purchaseUnit, setPurchaseUnit] = useState(item.purchase_unit ?? "");
  const [purchaseFactor, setPurchaseFactor] = useState(
    String(Number(item.purchase_unit_factor)),
  );
  const [imageMediaId, setImageMediaId] = useState<string | null>(
    item.image_media_id,
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setValidationError("");
    if (!name.trim() || !unit.trim()) {
      setValidationError("نام قلم و واحد پایه الزامی است.");
      return;
    }
    const reorder = reorderLevel.trim() ? Number(reorderLevel) : null;
    const factor = purchaseUnit.trim() ? Number(purchaseFactor) : 1;
    if (reorder !== null && (!Number.isFinite(reorder) || reorder < 0)) {
      setValidationError("آستانه سفارش مجدد نمی‌تواند منفی باشد.");
      return;
    }
    if (!Number.isFinite(factor) || factor <= 0) {
      setValidationError("ضریب تبدیل واحد خرید باید بزرگ‌تر از صفر باشد.");
      return;
    }
    const ok = await run(() =>
      api(`/api/inventory/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          sku: sku.trim() || null,
          unit: unit.trim(),
          reorderLevel: reorder,
          purchaseUnit: purchaseUnit.trim() || null,
          purchaseUnitFactor: factor,
          imageMediaId,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="bg-amber-50/50 dark:bg-amber-500/15 px-4 py-4 sm:px-5">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-6"
      >
        <Field label="نام قلم">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="کد کالا (SKU)">
          <input
            className={inputClass}
            dir="ltr"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="اختیاری"
            maxLength={100}
          />
        </Field>
        <Field label="واحد پایه">
          <input
            className={inputClass}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            required
          />
        </Field>
        <Field label="آستانه سفارش مجدد">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <Field label="واحد خرید">
          <input
            className={inputClass}
            value={purchaseUnit}
            onChange={(e) => {
              setPurchaseUnit(e.target.value);
              if (!e.target.value.trim()) setPurchaseFactor("1");
            }}
            placeholder="اختیاری؛ مثلاً kg"
          />
        </Field>
        <Field label="ضریب تبدیل واحد خرید">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={purchaseFactor}
            onChange={(e) => setPurchaseFactor(e.target.value)}
            disabled={!purchaseUnit.trim()}
          />
        </Field>
        {validationError ? (
          <p role="alert" className="sm:col-span-2 xl:col-span-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {validationError}
          </p>
        ) : null}
        <div className="sm:col-span-2 xl:col-span-6">
          {/* The photo the visual stock counter matches against — pulled from
              the shared media library so one upload serves menu and counting. */}
          <MediaImageField
            label="تصویر قلم (برای شمارش تصویری)"
            value={imageMediaId}
            onChange={setImageMediaId}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row xl:col-span-6">
          <Button
            type="submit"
            disabled={busy}
            size="lg"
            className="px-5 font-semibold sm:w-40"
          >
            ذخیره
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onDone}
          >
            انصراف
          </Button>
        </div>
      </form>
    </li>
  );
}
