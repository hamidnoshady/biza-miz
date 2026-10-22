"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { compareUnsignedDecimalText, validateQuantityText } from "@/lib/numeric-validation";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { api, Field, inputClass } from "../ui";
import { apiOrQueue } from "../offline-queue";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { InventoryItem, Runner } from "./inventory-manager";
import { LoadingSkeleton, EmptyState, SectionCard } from "../page-chrome";

interface WasteEntry {
  id: string;
  inventory_item_id: string;
  inventory_item_name: string;
  unit: string;
  quantity: string | number;
  total_cost: string;
  waste_reason: string;
  note: string | null;
  occurred_at: string;
}

export function buildWasteRequestBody(inventoryItemId: string, quantity: string, reason: string, note: string) {
  return { inventoryItemId, quantity, reason, note };
}

const REASON_LABELS: Record<string, string> = {
  spoilage: "فساد",
  prep_error: "خطای آماده‌سازی",
  customer_return: "برگشت از مشتری",
  staff_meal: "غذای کارکنان",
  other: "سایر",
};

export function WasteSection({ items, busy, run }: { items: InventoryItem[]; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [entries, setEntries] = useState<WasteEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("spoilage");
  const [note, setNote] = useState("");
  const [quantityTouched, setQuantityTouched] = useState(false);
  const [queuedInfo, setQueuedInfo] = useState(false);

  const loadEntries = useCallback(() => {
    setLoadFailed(false);
    void api<{ entries: WasteEntry[] }>("/api/inventory/waste")
      .then(({ ok, data }) => {
        if (!ok) throw new Error("waste_history_failed");
        setEntries(data.entries);
      })
      .catch(() => {
        setEntries([]);
        setLoadFailed(true);
      });
  }, []);
  useEffect(loadEntries, [loadEntries]);

  const activeItems = items.filter((i) => i.is_active);
  const selectedItem = activeItems.find((item) => item.id === inventoryItemId);
  const quantityValidation = validateQuantityText(quantity.trim());
  const validQuantity = quantityValidation.valid;
  const exceedsStock = Boolean(
    selectedItem
      && validQuantity
      && compareUnsignedDecimalText(quantity.trim(), String(selectedItem.stock)) > 0,
  );
  const quantityError = quantityTouched && !validQuantity ? quantityValidation.message : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const qty = quantity.trim();
    setQuantityTouched(true);
    // Keep this in step with the API's exact decimal contract. In particular,
    // exponent notation and values beyond the database's 9-place scale fail.
    if (!inventoryItemId || !validateQuantityText(qty).valid) return;
    setQueuedInfo(false);
    // Section 5 offline-queue-extension: a LAN drop no longer loses a waste
    // submission — apiOrQueue queues it locally (src/lib/offline-db.ts) and
    // it flushes to the same server handler once reconnected, same as an
    // order action. The item name is shown in the queue panel's description
    // (StatusBadge on the Devices settings tab), not looked up here.
    let wasQueued = false;
    const ok = await run(async () => {
      const { ok, queued, data } = await apiOrQueue<{ error?: string }>(
        "/api/inventory/waste",
        { method: "POST", body: buildWasteRequestBody(inventoryItemId, qty, reason, note) },
        {
          type: "inventory.waste.recorded",
          payload: { inventoryItemId, quantity: qty, reason, note: note || undefined },
          description: "ثبت ضایعات",
        },
      );
      wasQueued = queued;
      return { ok, data };
    });
    if (ok) {
      setQuantity("");
      setQuantityTouched(false);
      setNote("");
      setQueuedInfo(wasQueued);
      if (!wasQueued) loadEntries();
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات انبار</p>
            <h2 className="mt-1 font-semibold text-foreground">ثبت ضایعات</h2>
          </div>
        }
        description="ضایعات مستقل از فروش است و تنها موجودی را کاهش می‌دهد؛ در ارقام فروش اثری ندارد."
      >
        {queuedInfo ? (
          <p
            className="mb-3 rounded-xl border border-amber-500/25 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-300"
            role="status"
          >
            اتصال به سرور محلی قطع است — این ضایعات ذخیره شد و پس از اتصال مجدد ارسال می‌شود (صف همگام‌سازی محلی، تنظیمات ← دستگاه‌ها).
          </p>
        ) : null}
        <form onSubmit={submit} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="قلم انبار">
            <SearchableSelect
              value={inventoryItemId}
              onChange={setInventoryItemId}
              options={[
                { value: "", label: "قلم انبار را انتخاب کنید…" },
                ...activeItems.map((i) => ({
                  value: i.id,
                  label: `${i.name} (${i.unit})`,
                  searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                })),
              ]}
            />
          </Field>
          <Field label="مقدار">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="decimal"
              allowNegative={false}
              title="عدد بزرگ‌تر از صفر با حداکثر ۹ رقم اعشار"
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                setQuantityTouched(true);
              }}
              onBlur={() => setQuantityTouched(true)}
              aria-invalid={quantityError ? true : undefined}
              aria-describedby={quantityError ? "waste-quantity-error waste-stock-help" : "waste-stock-help"}
            />
            {quantityError ? (
              <span id="waste-quantity-error" className="text-xs font-medium text-destructive" role="alert">
                {quantityError}
              </span>
            ) : null}
            <span
              id="waste-stock-help"
              className={`text-xs ${exceedsStock ? "font-medium text-destructive" : "text-muted-foreground"}`}
              role={exceedsStock ? "alert" : undefined}
            >
              {selectedItem
                ? exceedsStock
                  ? `این مقدار از موجودی فعلی (${formatQuantity(selectedItem.stock)} ${selectedItem.unit}) بیشتر است و موجودی را منفی می‌کند.`
                  : `موجودی فعلی: ${formatQuantity(selectedItem.stock)} ${selectedItem.unit}`
                : "ابتدا قلم انبار را انتخاب کنید."}
            </span>
          </Field>
          <Field label="دلیل ضایعات">
            <SearchableSelect
              value={reason}
              onChange={setReason}
              options={Object.entries(REASON_LABELS).map(([key, label]) => ({ value: key, label }))}
            />
          </Field>
          <Field label="یادداشت">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy || activeItems.length === 0 || !inventoryItemId || !validQuantity} size="lg" className="w-full px-5 font-semibold">
              ثبت ضایعات
            </Button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
            <h2 className="mt-1 font-semibold text-foreground">ضایعات اخیر</h2>
          </div>
        }
        flush
      >
        {entries === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={4} label="در حال بارگذاری ضایعات اخیر" />
          </div>
        ) : loadFailed ? (
          <div className="flex flex-col items-center gap-3 p-4 text-center sm:p-5" role="alert">
            <p className="text-sm text-destructive">سوابق ضایعات بارگذاری نشد. اتصال را بررسی و دوباره تلاش کنید.</p>
            <Button type="button" variant="outline" onClick={loadEntries}>تلاش دوباره</Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز ضایعاتی ثبت نشده است.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {entries.map((e) => (
              <li key={e.id} className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 break-words">
                  <span className="font-medium text-foreground">{e.inventory_item_name}</span>
                  {" — "}
                  {formatQuantity(e.quantity)} {e.unit}
                  <span className="text-muted-foreground"> ({REASON_LABELS[e.waste_reason] ?? e.waste_reason})</span>
                  {e.note ? <span className="mt-1 block text-xs text-muted-foreground">{e.note}</span> : null}
                </span>
                <span className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground sm:block sm:text-end">
                  <span className="font-medium text-foreground">{money.formatText(e.total_cost)}</span>
                  <span className="sm:mt-1 sm:block">{formatJalali(e.occurred_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
