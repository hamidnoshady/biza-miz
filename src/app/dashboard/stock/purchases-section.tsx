"use client";

/**
 * Phase 42b — the «خرید» tab: the purchase-receiving form and the recent
 * purchases list, extracted from the former retail stock workspace (Phase 27
 * Wave 8's retail purchasing) into the warehouse module's «اقلام و عملیات»
 * group. The POST payload is the original's; the form itself now uses the
 * shared combobox/date pickers and a fully responsive, labelled line builder.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";

interface StockItem {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
}

interface Supplier {
  id: string;
  name: string;
}

interface PurchaseRow {
  id: string;
  total: number;
  supplierName: string | null;
  lineCount: number;
  receivedAt: string;
}

export function PurchasesSection() {
  const money = useMoney();
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ items: StockItem[] }>("/api/stock/items").then(
      ({ ok, data }) => ok && setItems(data.items),
    );
    api<{ purchases: PurchaseRow[]; suppliers: Supplier[] }>(
      "/api/stock/purchases",
    ).then(({ ok, data }) => {
      if (ok) {
        setPurchases(data.purchases);
        setSuppliers(data.suppliers);
      }
    });
  }, []);
  useEffect(load, [load]);

  if (items === null || suppliers === null || purchases === null) {
    return (
      <div className="space-y-4">
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PurchaseForm
        items={items}
        suppliers={suppliers}
        onDone={(m) => {
          setDone(m);
          load();
        }}
        onError={setError}
      />

      {/* Feedback sits with the form, not under the list a screenful away. */}
      <ErrorBox>{error}</ErrorBox>
      {done ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{done}</p>
      ) : null}

      <SectionCard title="خریدهای اخیر" bodyClassName="space-y-3" description="حداکثر ۱۰۰ خرید اخیر نمایش داده می‌شود.">
        {purchases.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            هنوز خریدی ثبت نشده است.
          </p>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {purchases.map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block break-words font-medium text-foreground">
                    {p.supplierName ?? "بدون تأمین‌کننده"}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {formatJalali(p.receivedAt)}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatPersianNumber(p.lineCount)} قلم ·{" "}
                  {money.format(p.total)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function PurchaseForm({
  items,
  suppliers,
  onDone,
  onError,
}: {
  items: StockItem[];
  suppliers: Supplier[];
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [supplierId, setSupplierId] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [expiry, setExpiry] = useState("");
  // Issue #770 — batch-tracked cosmetics: the purchase receipt carries the
  // REAL manufacturer/supplier lot number (plus manufacture date and the
  // supplier's own reference when the delivery has them). The server only
  // generates an internal reference when a lot number is genuinely absent.
  const [batchNumber, setBatchNumber] = useState("");
  const [manufactureDate, setManufactureDate] = useState("");
  const [supplierReference, setSupplierReference] = useState("");
  const [lines, setLines] = useState<
    {
      itemId: string;
      quantity: string;
      unitCost: number;
      batchNumber: string | null;
      manufactureDate: string | null;
      supplierReference: string | null;
      expiryDate: string | null;
    }[]
  >([]);
  const [busy, setBusy] = useState(false);

  const selectedItem = items.find((i) => i.id === itemId) ?? null;
  const isBatchItem = selectedItem?.tracking === "batch";

  function addLine() {
    const qty = Number(quantity);
    const cost = Number(unitCost);
    if (!itemId || !quantity.trim() || !unitCost.trim()) return;
    if (!Number.isFinite(qty) || qty <= 0) {
      onError("تعداد باید عددی بزرگ‌تر از صفر باشد.");
      return;
    }
    if (!Number.isFinite(cost) || cost < 0) {
      onError("بهای هر واحد معتبر نیست.");
      return;
    }
    onError("");
    setLines((prev) => [
      ...prev,
      {
        itemId,
        quantity,
        unitCost: money.fromInput(Math.round(cost)),
        // Lot fields only mean something for a batch-tracked item; they are
        // cleared for every other kind so a stale value can never be sent.
        batchNumber: isBatchItem ? batchNumber.trim() || null : null,
        manufactureDate: isBatchItem ? manufactureDate || null : null,
        supplierReference: isBatchItem ? supplierReference.trim() || null : null,
        expiryDate: expiry || null,
      },
    ]);
    setItemId("");
    setQuantity("1");
    setUnitCost("");
    setExpiry("");
    setBatchNumber("");
    setManufactureDate("");
    setSupplierReference("");
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    if (lines.length === 0) {
      onError("حداقل یک ردیف به فهرست خرید اضافه کنید.");
      return;
    }
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      "/api/stock/purchases",
      {
        method: "POST",
        body: JSON.stringify({ supplierId: supplierId || null, lines }),
      },
    );
    setBusy(false);
    if (!ok) onError(data.message ?? "ثبت خرید ناموفق بود.");
    else {
      setLines([]);
      setSupplierId("");
      onDone("خرید دریافت شد (بدهکار موجودی، بستانکار حساب‌های پرداختنی).");
    }
  }

  const itemById = (id: string) => items.find((i) => i.id === id);

  // Stable across renders so SearchableSelect's internal normalization cache holds.
  const supplierOptions = useMemo(
    () => [
      { value: "", label: "بدون تأمین‌کننده" },
      ...suppliers.map((s) => ({ value: s.id, label: s.name })),
    ],
    [suppliers],
  );
  const itemOptions = useMemo(
    () => [
      { value: "", label: "کالا را انتخاب کنید…" },
      ...items.map((i) => ({
        value: i.id,
        label: i.name,
        searchString: [i.name, i.sku].filter(Boolean).join(" "),
      })),
    ],
    [items],
  );

  const linesTotal = lines.reduce((sum, l) => {
    const qty = Number(l.quantity);
    return sum + (Number.isFinite(qty) ? qty * l.unitCost : 0);
  }, 0);

  return (
    <SectionCard title="دریافت خرید" bodyClassName="space-y-3">
      <div className="grid min-w-0 gap-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field label="تأمین‌کننده">
            <SearchableSelect
              value={supplierId}
              onChange={setSupplierId}
              options={supplierOptions}
            />
          </Field>
          <Field label="کالا">
            <SearchableSelect
              value={itemId}
              onChange={setItemId}
              options={itemOptions}
            />
          </Field>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="تعداد">
            <PersianNumberInput
              inputMode="decimal"
              allowNegative={false}
              className={inputClass}
              dir="ltr"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label={`بهای هر واحد (${money.unitLabel})`}>
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              allowNegative={false}
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
            />
          </Field>
          <Field label="انقضا (اختیاری، شمسی)">
            <JalaliDatePicker value={expiry} onChange={setExpiry} />
          </Field>
          <div className="mb-4 flex items-end">
            <Button
              type="button"
              variant="outline"
              onClick={addLine}
              className="w-full"
            >
              افزودن ردیف
            </Button>
          </div>
        </div>
        {isBatchItem ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <Field label="شماره بچ/لات (ساخت کارخانه)">
              <input
                className={inputClass}
                dir="ltr"
                value={batchNumber}
                onChange={(e) => setBatchNumber(e.target.value)}
                placeholder="مثلاً LOT-2026-A17"
              />
            </Field>
            <Field label="تاریخ ساخت (اختیاری، شمسی)">
              <JalaliDatePicker
                value={manufactureDate}
                onChange={setManufactureDate}
              />
            </Field>
            <Field label="ارجاع تأمین‌کننده (اختیاری)">
              <input
                className={inputClass}
                dir="ltr"
                value={supplierReference}
                onChange={(e) => setSupplierReference(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        {lines.length > 0 ? (
          <div className="rounded-xl border border-border">
            <ul className="divide-y divide-border/80 text-sm">
              {lines.map((l, i) => {
                const item = itemById(l.itemId);
                return (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="min-w-0 break-words">
                      {item?.name ?? l.itemId}{" "}
                      <span className="text-xs text-muted-foreground">
                        × {formatPersianNumber(Number(l.quantity))}
                        {l.batchNumber ? ` · بچ ${l.batchNumber}` : ""}
                        {l.expiryDate ? ` · انقضا ${formatJalali(l.expiryDate)}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {money.format(Number(l.quantity) * l.unitCost)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`حذف ردیف ${item?.name ?? ""}`}
                        onClick={() => removeLine(i)}
                      >
                        حذف
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="border-t border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground">
              جمع فهرست: {money.format(linesTotal)}
            </p>
          </div>
        ) : null}
        <Button
          type="button"
          disabled={busy || lines.length === 0}
          onClick={() => void submit()}
          className="min-h-11 w-full"
        >
          {busy ? "در حال ثبت…" : "ثبت خرید"}
        </Button>
      </div>
    </SectionCard>
  );
}
