"use client";

/**
 * Phase 42b — the «خرید» tab: the purchase-receiving form and the recent
 * purchases list, extracted from the former retail stock workspace (Phase 27
 * Wave 8's retail purchasing) into the warehouse module's «اقلام و عملیات»
 * group. The POST payload is the original's; the form itself now uses the
 * shared combobox/date pickers and a fully responsive, labelled line builder.
 */
import Decimal from "decimal.js";
import { retailQuantity, retailRial } from "@/lib/retail-purchase-input";
import { roundRial } from "@/lib/inventory-exact";
import { useRetailRequest } from "./use-retail-request";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
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
  total: string;
  supplierName: string | null;
  lineCount: number;
  receivedAt: string;
}

export function PurchasesSection({ canManage = false, requestScope }: { canManage?: boolean; requestScope?: string }) {
  const money = useMoney();
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [page, setPage] = useState(1);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyTotal, setHistoryTotal] = useState("0");
  const [search, setSearch] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const load = useCallback(() => setReload(n => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    const params = new URLSearchParams({ page: String(page), q: search, supplierId: filterSupplier, dateFrom, dateTo });
    Promise.all([
      api<{ items: StockItem[] }>("/api/stock/items", { signal: controller.signal }),
      api<{ purchases: PurchaseRow[]; suppliers: Supplier[]; count: number; total: string }>(`/api/stock/purchases?${params}`, { signal: controller.signal }),
    ]).then(([stock, history]) => {
      if (controller.signal.aborted) return;
      if (!stock.ok || !history.ok || !stock.data.items || !history.data.purchases || !history.data.suppliers) {
        setLoadError("خواندن اطلاعات خرید ناموفق بود. دوباره تلاش کنید.");
        return;
      }
      setItems(stock.data.items);
      setPurchases(history.data.purchases);
      setHistoryCount(history.data.count ?? history.data.purchases.length);
      setHistoryTotal(history.data.total ?? "0");
      setSuppliers(history.data.suppliers);
    }).catch(() => { if (!controller.signal.aborted) setLoadError("خواندن اطلاعات خرید ناموفق بود."); });
    return () => controller.abort();
  }, [reload, page, search, filterSupplier, dateFrom, dateTo]);
  useEffect(() => setPage(1), [search, filterSupplier, dateFrom, dateTo]);
  if (loadError) return <div><ErrorBox>{loadError}</ErrorBox><Button onClick={load}>تلاش دوباره</Button></div>;

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
      {canManage ? <PurchaseForm
        requestScope={requestScope}
        items={items}
        suppliers={suppliers}
        onDone={(m) => {
          setDone(m);
          load();
        }}
        onError={setError}
      /> : null}

      {/* Feedback sits with the form, not under the list a screenful away. */}
      <ErrorBox>{error}</ErrorBox>
      {done ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{done}</p>
      ) : null}

      <SectionCard title="سوابق خرید" bodyClassName="space-y-3" description="جمع مربوط به همهٔ نتایج فیلترشده است.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="جستجوی سند، کالا یا SKU"><input className={inputClass} value={search} onChange={e => setSearch(e.target.value)} /></Field>
          <Field label="تأمین‌کننده"><SearchableSelect value={filterSupplier} onChange={setFilterSupplier} options={[
            { value: "", label: "همه" }, ...suppliers.map(s => ({ value: s.id, label: s.name })),
          ]} /></Field>
          <Field label="از تاریخ"><JalaliDatePicker value={dateFrom} onChange={setDateFrom} /></Field>
          <Field label="تا تاریخ"><JalaliDatePicker value={dateTo} onChange={setDateTo} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{formatPersianNumber(historyCount)} خرید · {money.formatText(historyTotal)}</span>
          <Button variant="outline" disabled={page <= 1} onClick={() => setPage(n => n - 1)}>قبلی</Button>
          <span>صفحه {formatPersianNumber(page)}</span>
          <Button variant="outline" disabled={page * 25 >= historyCount} onClick={() => setPage(n => n + 1)}>بعدی</Button>
        </div>
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
                  {money.formatText(p.total)}
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
  requestScope,
  items,
  suppliers,
  onDone,
  onError,
}: {
  requestScope?: string;
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
  // Issue #795 — serial-tracked items (watches): the receipt names the exact
  // physical serials, one per unit, plus the warranty default they will be
  // sold with. Quantity is derived from the serial count, never typed.
  const [serialNumbers, setSerialNumbers] = useState("");
  const [serialWarrantyMonths, setSerialWarrantyMonths] = useState("0");
  const [lines, setLines] = useState<
    {
      itemId: string;
      quantity: string;
      unitCost: string;
      batchNumber: string | null;
      manufactureDate: string | null;
      supplierReference: string | null;
      expiryDate: string | null;
      serials: { serialNumber: string; warrantyMonths?: number }[] | null;
    }[]
  >([]);
  const [settlementMethod, setSettlementMethod] = useState<"cash" | "bank" | "credit">("credit");
  const request = useRetailRequest<{ supplierId: string | null; settlementMethod: "cash" | "bank" | "credit"; lines: typeof lines }>(requestScope, "purchase");
  const busy = request.busy;

  const selectedItem = items.find((i) => i.id === itemId) ?? null;
  const isBatchItem = selectedItem?.tracking === "batch";
  const isSerialItem = selectedItem?.tracking === "serial";

  function addLine() {
    if (!itemId || !unitCost.trim() || request.pending) return;
    let cost: string;
    try { cost = retailRial(money.parseText(unitCost)); } catch {
      onError("بهای هر واحد باید عدد صحیح غیرمنفی و در محدودهٔ مجاز باشد.");
      return;
    }

    let serials: { serialNumber: string; warrantyMonths?: number }[] | null = null;
    let lineQuantity = quantity;
    if (isSerialItem) {
      const parsed = serialNumbers
        .split(/[\n,،]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parsed.length === 0) {
        onError("برای کالای سریالی، شماره سریال هر دستگاه را وارد کنید (هر خط یک سریال).");
        return;
      }
      if (new Set(parsed).size !== parsed.length) {
        onError("شماره سریال تکراری در فهرست وجود دارد.");
        return;
      }
      const months = Number(serialWarrantyMonths || 0);
      if (!Number.isSafeInteger(months) || months < 0 || months > 600) {
        onError("مدت گارانتی باید عدد صحیح بین صفر و ۶۰۰ ماه باشد.");
        return;
      }
      serials = parsed.map((serialNumber) => ({ serialNumber, warrantyMonths: months }));
      lineQuantity = String(parsed.length);
    } else {
      try { lineQuantity = retailQuantity(quantity); } catch {
        onError("تعداد باید مثبت و با حداکثر ۹ رقم اعشار باشد.");
        return;
      }
    }
    onError("");
    setLines((prev) => [
      ...prev,
      {
        itemId,
        quantity: lineQuantity,
        unitCost: cost,
        // Lot fields only mean something for a batch-tracked item; they are
        // cleared for every other kind so a stale value can never be sent.
        batchNumber: isBatchItem ? batchNumber.trim() || null : null,
        manufactureDate: isBatchItem ? manufactureDate || null : null,
        supplierReference: isBatchItem ? supplierReference.trim() || null : null,
        expiryDate: expiry || null,
        serials,
      },
    ]);
    setItemId("");
    setQuantity("1");
    setUnitCost("");
    setExpiry("");
    setBatchNumber("");
    setManufactureDate("");
    setSupplierReference("");
    setSerialNumbers("");
    setSerialWarrantyMonths("0");
  }

  function removeLine(index: number) {
    if (request.pending || busy) return;
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    if (!request.pending && (lines.length === 0 || (settlementMethod === "credit" && !supplierId))) {
      onError("حداقل یک ردیف و برای خرید نسیه تأمین‌کننده را انتخاب کنید.");
      return;
    }
    if (!request.pending && !window.confirm("دریافت کالا و ثبت سند حسابداری قطعی شود؟")) return;
    onError("");
    const result = await request.submit({ supplierId: supplierId || null, settlementMethod, lines });
    if (!result.ok) { if (result.message) onError(result.message); }
    else {
      setLines([]);
      setSupplierId("");
      onDone("خرید دریافت شد و سند حسابداری با روش تسویهٔ انتخاب‌شده ثبت شد.");
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

  const linesTotal = lines.reduce((sum, l) => sum + BigInt(roundRial(new Decimal(l.quantity).times(l.unitCost))), 0n).toString();

  return (
    <SectionCard title="دریافت خرید" bodyClassName="space-y-3">
      {request.pending ? <p role="status" className="text-sm text-muted-foreground">یک درخواست حل‌نشده دارید. تلاش دوباره دقیقاً همان اطلاعات قبلی را پیگیری می‌کند، نه تغییرات فرم.</p> : null}
      <Field label="روش تسویه"><SearchableSelect value={settlementMethod} onChange={v => setSettlementMethod(v as typeof settlementMethod)} options={[
        { value: "credit", label: "نسیه (حساب پرداختنی)" }, { value: "cash", label: "نقدی" }, { value: "bank", label: "بانکی" },
      ]} /></Field>
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
          <Field
            label="تعداد"
            hint={isSerialItem ? "برای کالای سریالی از شمار سریال‌ها محاسبه می‌شود." : undefined}
          >
            <PersianNumberInput
              inputMode="decimal"
              allowNegative={false}
              className={inputClass}
              dir="ltr"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={isSerialItem}
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
        {isSerialItem ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field
                label="شماره سریال دستگاه‌ها"
                hint="هر خط (یا با ویرگول) یک سریال — به ازای هر واحد دقیقاً یک سریال."
              >
                <textarea
                  className={`${inputClass} min-h-[88px]`}
                  dir="ltr"
                  value={serialNumbers}
                  onChange={(e) => setSerialNumbers(e.target.value)}
                  placeholder={"SN-1001\nSN-1002"}
                />
              </Field>
            </div>
            <Field label="گارانتی پیش‌فرض (ماه)">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                allowNegative={false}
                value={serialWarrantyMonths}
                onChange={(e) => setSerialWarrantyMonths(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
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
                        {l.serials ? ` · ${toPersianDigits(String(l.serials.length))} سریال` : ""}
                        {l.expiryDate ? ` · انقضا ${formatJalali(l.expiryDate)}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {money.formatText(roundRial(new Decimal(l.quantity).times(l.unitCost)))}
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
              جمع فهرست: {money.formatText(linesTotal)}
            </p>
          </div>
        ) : null}
        <Button
          type="button"
          disabled={busy || (!request.pending && lines.length === 0)}
          onClick={() => void submit()}
          className="min-h-11 w-full"
        >
          {busy ? "در حال ثبت…" : request.pending ? "پیگیری درخواست قبلی" : "ثبت خرید"}
        </Button>
      </div>
    </SectionCard>
  );
}
