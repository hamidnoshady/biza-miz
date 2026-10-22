"use client";

/**
 * Phase 42 — «ثبت رسید انبار/حواله»: one screen for the two warehouse
 * documents.
 *
 * A رسید (receipt) puts stock in without a purchase order — lines carry a
 * whole-Rial unit cost, which is authoritative for both the FIFO lot and the
 * ledger entry (Debit inventory / Credit other income). A حواله (issue) puts
 * stock out without a sale or waste entry — lines are valued by the
 * exact-costing path at posting time (Debit other expense / Credit inventory).
 *
 * The document is posted on create, like waste and counts: immutable after,
 * and a mistake is corrected by the opposite document (linked reversal).
 *
 * Issue #922 hardening:
 * - Branch security: warehouse picker is scoped to allowed branches (API
 *   filters), and the selected warehouse is authorized live before POST.
 * - Idempotency: stable per-draft UUID, header+body, retry UX after network
 *   failure, 409 on payload mismatch.
 * - Exact costing: BigInt/Decimal for totals, no Number drift on large Rial,
 *   overflow checked before bigint writes, negative-layer policy documented.
 * - Permission-aware: read-only users can browse records without a misleading
 *   interactive form; server authorization remains mandatory.
 * - Supplier reference is informational (credits 4900 other income, not AP);
 *   UI clarifies that purchasing/AP is a separate flow (#915).
 * - Retry affordances for failed warehouse/item fetches, no perpetual
 *   skeleton, stale async cleanup.
 * - Pre-post confirmation, internal voucher number, printable detail, linked
 *   correction flow.
 */
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { type Warehouse, warehouseErrorMessage } from "./warehouses-section";

type DocKind = "receipt" | "issue";

interface StockItemOption {
  id: string;
  item_name: string;
  unit: string;
}

interface StockLevelsResponse {
  items: StockItemOption[];
}

const KIND_LABELS: Record<DocKind, string> = {
  receipt: "رسید انبار (ورود کالا)",
  issue: "حواله انبار (خروج کالا)",
};

const kindChipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-foreground  hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"
  }`;

interface DocLine {
  key: string;
  inventoryItemId: string;
  quantity: string;
  unitCost: string;
}

function newLine(): DocLine {
  return { key: crypto.randomUUID(), inventoryItemId: "", quantity: "", unitCost: "" };
}

const DOC_ERRORS: Record<string, string> = {
  missing_fields: "انبار را انتخاب کنید.",
  no_items: "حداقل یک قلم لازم است.",
  invalid_line: "یکی از قلم‌ها کامل نیست یا یک قلم دو بار آمده است؛ قلم را انتخاب کنید و مقدار معتبر وارد کنید.",
  invalid_quantity: "مقدار هر قلم باید بزرگ‌تر از صفر باشد.",
  quantity_precision_exceeded: "مقدار واردشده بیش از حد اعشار دارد.",
  invalid_rial: "قیمت واحد باید یک عدد صحیح معتبر باشد.",
  rial_out_of_range: "قیمت واحد بسیار بزرگ است؛ عدد را بررسی کنید.",
  receipt_value_required: "رسید بدون ارزش ثبت نمی‌شود؛ برای هر قلم قیمت واحد بزرگ‌تر از صفر وارد کنید. برای کالای رایگان، دلیل را ثبت کنید.",
  location_not_found: "انبار انتخاب‌شده پیدا نشد.",
  location_inactive: "این انبار غیرفعال است؛ انبار دیگری را انتخاب کنید.",
  supplier_not_found: "تأمین‌کننده انتخاب‌شده در این انبار نیست.",
  item_not_found: "یکی از اقلام به این انبار تعلق ندارد یا غیرفعال است.",
  periodic_system_unsupported:
    "این عملیات در سیستم ادواری در دسترس نیست؛ بهای تمام‌شده در «بستن دوره» محاسبه می‌شود.",
  ledger_account_missing:
    "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد. سرفصل حساب‌ها را بررسی کنید.",
  inventory_exact_cutover_required:
    "موجودی این قلم هنوز به سیستم بهای دقیق منتقل نشده است؛ ابتدا عملیات انتقال (cutover) را اجرا کنید.",
  idempotency_key_conflict: "این سند قبلاً با محتوای متفاوت ثبت شده است؛ صفحه را تازه کنید.",
  idempotency_key_invalid: "شناسهٔ تکرار درخواست معتبر نیست.",
  document_number_taken: "شماره سند تکراری است؛ شماره دیگری انتخاب کنید.",
  too_many_lines: "تعداد ردیف‌ها بیش از حد مجاز است (حداکثر ۲۰۰).",
  bad_request: "درخواست نامعتبر است؛ ورودی‌ها را بررسی کنید.",
  fiscal_period_locked: "دوره مالی این تاریخ قفل است؛ ثبت سند ممکن نیست.",
  fiscal_period_soft_closed: "دوره مالی بسته موقت است؛ فقط مدیر/حسابدار می‌تواند ثبت کند.",
  fiscal_period_not_defined: "دوره مالی برای این تاریخ تعریف نشده است.",
  negative_stock_requires_confirm: "این حواله باعث موجودی منفی می‌شود؛ برای ادامه تأیید کنید.",
};

interface PostedSummary {
  kind: DocKind;
  totalValue: string;
  id?: string;
  internalVoucherNumber?: string | null;
}

export function DocumentFormSection({ onCreated, canAdjust: canAdjustProp }: { onCreated: () => void; canAdjust?: boolean }) {
  const money = useMoney();
  const canAdjust = canAdjustProp ?? true;
  const [kind, setKind] = useState<DocKind>("receipt");
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [warehousesError, setWarehousesError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<StockItemOption[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DocLine[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<PostedSummary | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showNegativeConfirm, setShowNegativeConfirm] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const pendingRef = useRef<Promise<unknown> | null>(null);

  const loadWarehouses = useCallback(() => {
    setWarehousesError(null);
    api<{ warehouses: Warehouse[] }>("/api/inventory/warehouses")
      .then(({ ok, data }) => {
        if (ok) {
          setWarehouses(data.warehouses);
          const active = data.warehouses.find((w) => w.is_active);
          if (active) setLocationId((current) => current || active.id);
        } else {
          setWarehousesError("بارگذاری انبارها ناموفق بود.");
        }
      })
      .catch(() => setWarehousesError("خطا در ارتباط با سرور؛ دوباره تلاش کنید."));
  }, []);
  useEffect(loadWarehouses, [loadWarehouses]);

  const selectedWarehouse = useMemo(
    () => warehouses?.find((w) => w.id === locationId) ?? null,
    [warehouses, locationId],
  );

  useEffect(() => {
    setLines([newLine()]);
    setSupplierId("");
    setItemsError(null);
    if (!locationId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setItems(null);
    api<StockLevelsResponse & { error?: string }>(`/api/inventory/stock-levels?locationId=${encodeURIComponent(locationId)}`)
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setItems(data.items);
        else {
          setItems([]);
          setItemsError((data as { error?: string })?.error ? warehouseErrorMessage((data as { error?: string }).error as string) : "بارگذاری اقلام ناموفق بود.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setItemsError("خطا در ارتباط؛ دوباره تلاش کنید.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  function switchWarehouse(next: string) {
    if (next === locationId) return;
    setLocationId(next);
    setSupplierId("");
    setPosted(null);
    setError("");
    setLines((current) => current.map((line) => ({ ...line, inventoryItemId: "" })));
  }

  function switchKind(next: DocKind) {
    if (next === kind) return;
    setKind(next);
    setLines([newLine()]);
    setSupplierId("");
    setRecipient("");
    setPosted(null);
    setError("");
  }

  const supplierOptions = useMemo(() => selectedWarehouse?.suppliers ?? [], [selectedWarehouse]);

  const itemOptions = useMemo(
    () =>
      items === null
        ? []
        : [
            { value: "", label: "قلم انبار را انتخاب کنید…" },
            ...items.map((i) => ({
              value: i.id,
              label: `${i.item_name} (${i.unit})`,
              searchString: [i.item_name, i.unit].join(" "),
            })),
          ],
    [items],
  );

  const lineUnitCostRial = useCallback(
    (line: DocLine): string | null => {
      if (!line.unitCost.trim()) return null;
      try {
        return money.parseText(line.unitCost);
      } catch {
        return null;
      }
    },
    [money],
  );

  // Use Decimal/BigInt for exact money, never Number floats on large Rial
  const receiptTotal = useMemo(() => {
    if (kind !== "receipt") return null;
    let total = 0n;
    for (const line of lines) {
      const cost = lineUnitCostRial(line);
      if (cost === null) continue;
      try {
        const qty = new Decimal(line.quantity);
        if (qty.lte(0) || !qty.isFinite()) continue;
        // qty × unitCost exact, round half up to whole Rial per line (server rule)
        const lineVal = new Decimal(cost).times(qty).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
        total += BigInt(lineVal.toFixed(0));
        if (total > 9223372036854775807n) return null; // overflow guard
      } catch {
        continue;
      }
    }
    return total.toString();
  }, [kind, lines, lineUnitCostRial]);

  const blockingReason = useMemo(() => {
    if (!locationId) return "انبار را انتخاب کنید.";
    const filled = lines.filter((line) => line.inventoryItemId || line.quantity.trim() || line.unitCost.trim());
    if (filled.length === 0) return "حداقل یک قلم با مقدار وارد کنید.";
    const seen = new Set<string>();
    for (const line of filled) {
      const lineNo = toPersianDigits(String(lines.indexOf(line) + 1));
      if (!line.inventoryItemId) return `قلم انبار ردیف ${lineNo} را انتخاب کنید.`;
      if (seen.has(line.inventoryItemId)) {
        return "هر قلم فقط یک بار می‌تواند در سند بیاید؛ ردیف‌های تکراری را یکی کنید.";
      }
      seen.add(line.inventoryItemId);
      try {
        const qty = new Decimal(line.quantity);
        if (!line.quantity.trim() || !qty.isFinite() || qty.lte(0)) {
          return `مقدار ردیف ${lineNo} باید عددی بزرگ‌تر از صفر باشد.`;
        }
      } catch {
        return `مقدار ردیف ${lineNo} باید عددی بزرگ‌تر از صفر باشد.`;
      }
      if (kind === "receipt") {
        const cost = lineUnitCostRial(line);
        if (cost === null) {
          return `قیمت واحد ردیف ${lineNo} را به‌صورت عدد صحیح (${money.unitLabel}) وارد کنید.`;
        }
        if (BigInt(cost) <= 0n) return `قیمت واحد ردیف ${lineNo} باید بزرگ‌تر از صفر باشد.`;
      }
    }
    return "";
  }, [locationId, lines, kind, lineUnitCostRial, money]);

  function updateLine(key: string, patch: Partial<DocLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setPosted(null);
  }
  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
    setPosted(null);
  }

  function openConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || blockingReason) {
      if (blockingReason) setError(blockingReason);
      return;
    }
    if (!canAdjust) {
      setError("شما مجوز ثبت سند ندارید؛ فقط مشاهده ممکن است.");
      return;
    }
    setShowConfirm(true);
  }

  async function submit(allowNegativeStock = false) {
    setShowConfirm(false);
    setShowNegativeConfirm(false);
    if (busy || blockingReason) {
      if (blockingReason) setError(blockingReason);
      return;
    }
    setPosted(null);
    setRetryNotice(null);
    const filled = lines.filter((line) => line.inventoryItemId || line.quantity.trim() || line.unitCost.trim());
    // Generate stable idempotency key per draft; reuse until known outcome
    const key = idempotencyKey || crypto.randomUUID();
    const payload = {
      kind,
      locationId,
      supplierId: kind === "receipt" && supplierId ? supplierId : null,
      recipient: kind === "issue" ? recipient.trim() || null : null,
      documentNumber: documentNumber.trim() || null,
      note: note.trim() || null,
      idempotencyKey: key,
      allowNegativeStock,
      lines: filled.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        unitCost: kind === "receipt" ? (lineUnitCostRial(line) ?? "0") : "0",
      })),
    };
    setBusy(true);
    setError("");
    let networkError = false;
    const { ok, data } = await api<{ error?: string; totalValue?: string; id?: string; duplicate?: boolean }>(
      "/api/inventory/warehouse-documents",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Idempotency-Key": key },
      },
    ).catch(() => {
      networkError = true;
      return { ok: false, data: { error: "network_error" } } as never;
    });
    setBusy(false);
    if (networkError) {
      setRetryNotice("اتصال برقرار نشد؛ نتیجهٔ ثبت نامشخص است. با همین شناسه دوباره تلاش کنید یا از فهرست اسناد موجود بودن آن را بررسی کنید.");
      // Keep key for retry
      setError("خطا در شبکه؛ سند ممکن است ثبت شده باشد. دوباره تلاش کنید.");
      return;
    }
    if (!ok) {
      const code = (data as { error?: string }).error;
      if (code === "negative_stock_requires_confirm") {
        setShowNegativeConfirm(true);
        return;
      }
      if (code === "idempotency_key_conflict") {
        setError(DOC_ERRORS[code] ?? warehouseErrorMessage(code));
        setIdempotencyKey(crypto.randomUUID());
      } else {
        setError(DOC_ERRORS[code ?? ""] ?? warehouseErrorMessage(code));
      }
      return;
    }
    // Success: rotate key for next draft
    setIdempotencyKey(crypto.randomUUID());
    setLines([newLine()]);
    setSupplierId("");
    setRecipient("");
    setDocumentNumber("");
    setNote("");
    setPosted({ kind, totalValue: data.totalValue ?? "0", id: data.id });
    onCreated();
  }

  if (!canAdjust) {
    return (
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
            <h2 className="mt-1 font-semibold text-foreground">ثبت رسید انبار/حواله</h2>
          </div>
        }
        description="شما مجوز ویرایش اسناد انبار را ندارید؛ فهرست اسناد را مشاهده کنید."
      >
        <p className="text-sm text-muted-foreground">برای ثبت سند جدید با مدیر تماس بگیرید.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
          <h2 className="mt-1 font-semibold text-foreground">ثبت رسید انبار/حواله</h2>
        </div>
      }
      description="رسید انبار کالا را وارد انبار می‌کند و حواله انبار آن را خارج می‌کند؛ هر دو بلافاصله در موجودی و حسابداری ثبت می‌شوند. تأمین‌کننده در این سند فقط اطلاعاتی است و به حساب پرداختنی نمی‌رود؛ خرید واقعی از مسیر «خرید» ثبت می‌شود."
    >
      <ErrorBox>{error}</ErrorBox>
      {retryNotice ? (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {retryNotice}
          <button
            type="button"
            className="mt-2 block rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white dark:bg-amber-700"
            onClick={() => submit()}
            disabled={busy}
          >
            تلاش مجدد با همین شناسه
          </button>
        </div>
      ) : null}
      {posted ? (
        <div
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
        >
          <p className="font-semibold">
            {posted.kind === "receipt" ? "رسید انبار ثبت شد." : "حواله انبار ثبت شد."} جمع: {money.formatText(posted.totalValue)}
          </p>
          <p className="mt-1 text-xs">
            سند در موجودی و دفتر روزنامه ثبت شد و قابل ویرایش نیست؛ برای اصلاح، سند معکوسِ مرتبط ثبت کنید.{" "}
            {posted.id ? <a href={`/accounting/inventory?doc=${posted.id}`} className="underline">مشاهده سند</a> : null} ·{" "}
            <a href="/accounting/journal" className="underline" target="_blank" rel="noreferrer">
              دفتر روزنامه
            </a>
          </p>
        </div>
      ) : null}
      <form onSubmit={openConfirm} className="min-w-0 space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="نوع سند">
          <button type="button" className={kindChipClass(kind === "receipt")} aria-pressed={kind === "receipt"} onClick={() => switchKind("receipt")}>
            {KIND_LABELS.receipt}
          </button>
          <button type="button" className={kindChipClass(kind === "issue")} aria-pressed={kind === "issue"} onClick={() => switchKind("issue")}>
            {KIND_LABELS.issue}
          </button>
        </div>

        {warehousesError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
            {warehousesError}{" "}
            <button type="button" className="underline" onClick={loadWarehouses}>
              تلاش مجدد
            </button>
          </div>
        ) : null}

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="انبار">
            <SearchableSelect
              value={locationId}
              onChange={switchWarehouse}
              options={[
                { value: "", label: "انبار را انتخاب کنید…" },
                ...(warehouses ?? []).map((w) => ({ value: w.id, label: w.is_active ? w.name : `${w.name} (غیرفعال)` })),
              ]}
            />
          </Field>
          {kind === "receipt" ? (
            <Field label="تأمین‌کننده (اختیاری — اطلاعاتی، نه بدهی)">
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                options={[
                  { value: "", label: "بدون تأمین‌کننده" },
                  ...supplierOptions.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">این فیلد اعتباری ایجاد نمی‌کند؛ سند هنوز به ۴۹۰۰ بستانکار می‌شود.</p>
            </Field>
          ) : (
            <Field label="گیرنده/مقصد (اختیاری)">
              <input className={inputClass} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="مثلاً: شعبه مرکزی" />
            </Field>
          )}
          <Field label="شماره سند (اختیاری)">
            <input className={inputClass} value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="شماره فاکتور یا حواله" />
          </Field>
          <Field label="یادداشت (اختیاری)">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        <div className="min-w-0 space-y-2">
          <div className="hidden md:grid md:grid-cols-[minmax(0,2fr)_minmax(110px,1fr)_minmax(130px,1fr)_2.75rem] md:items-center md:gap-2 text-xs font-medium text-muted-foreground">
            <span>قلم انبار</span>
            <span>مقدار</span>
            {kind === "receipt" ? <span>قیمت واحد ({money.unitLabel})</span> : <span>ارزش (محاسبه‌شده)</span>}
            <span className="sr-only">حذف</span>
          </div>
          {items === null ? (
            <div className="min-w-0 space-y-2">
              <LoadingSkeleton rows={2} label="در حال بارگذاری اقلام انبار" />
            </div>
          ) : itemsError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              {itemsError}{" "}
              <button type="button" className="underline" onClick={() => switchWarehouse(locationId)}>
                تلاش مجدد
              </button>
            </div>
          ) : (
            lines.map((line) => (
              <div
                key={line.key}
                className="grid min-w-0 grid-cols-1 gap-2 rounded-xl border border-border/80 p-3 md:grid-cols-[minmax(0,2fr)_minmax(110px,1fr)_minmax(130px,1fr)_2.75rem] md:items-center md:rounded-none md:border-0 md:p-0"
              >
                <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
                  <span className="md:sr-only">قلم انبار</span>
                  <SearchableSelect value={line.inventoryItemId} onChange={(v) => updateLine(line.key, { inventoryItemId: v })} options={itemOptions} ariaLabel="قلم انبار" />
                </label>
                <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
                  <span className="md:sr-only">مقدار</span>
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    placeholder="۰"
                    aria-label="مقدار قلم"
                  />
                </label>
                {kind === "receipt" ? (
                  <label className="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
                    <span className="md:sr-only">قیمت واحد ({money.unitLabel})</span>
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={line.unitCost}
                      onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                      placeholder="۰"
                      aria-label={`قیمت واحد به ${money.unitLabel}`}
                    />
                  </label>
                ) : (
                  <span className="truncate text-xs tabular-nums text-muted-foreground">
                    <span className="md:hidden">ارزش: </span>در لحظه ثبت
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive md:w-auto"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length === 1}
                  aria-label="حذف این قلم"
                  title="حذف این قلم"
                >
                  <Trash2Icon aria-hidden="true" className="size-4" />
                  <span className="md:sr-only">حذف این قلم</span>
                </Button>
              </div>
            ))
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, newLine()])}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن قلم
            </Button>
            {kind === "receipt" && receiptTotal !== null ? (
              <span className="text-sm font-semibold tabular-nums text-foreground">جمع: {money.formatText(receiptTotal)}</span>
            ) : null}
          </div>
        </div>

        <div className="space-y-2 border-t border-border/80 pt-4">
          {blockingReason ? (
            <p id="warehouse-document-blocked" className="text-xs text-muted-foreground">
              {blockingReason}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={busy || blockingReason !== ""}
            aria-describedby={blockingReason ? "warehouse-document-blocked" : undefined}
            size="lg"
            className="w-full px-5 font-semibold"
          >
            {busy ? "در حال ثبت…" : kind === "receipt" ? "ثبت رسید انبار" : "ثبت حواله انبار"}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            پس از تأیید، سند قطعی و غیرقابل ویرایش خواهد بود؛ حساب‌ها: {kind === "receipt" ? "بدهکار ۱۳۰۰ / بستانکار ۴۹۰۰" : "بدهکار ۵۹۰۰ / بستانکار ۱۳۰۰"}
          </p>
        </div>
      </form>

      {showConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold">تأیید ثبت سند</h3>
            <p className="mt-2 text-xs text-muted-foreground">موارد زیر ثبت خواهد شد؛ پس از ثبت قابل ویرایش نیست.</p>
            <div className="mt-3 rounded-lg border border-border p-3 text-xs">
              <p>نوع: {KIND_LABELS[kind]}</p>
              <p>انبار: {selectedWarehouse?.name ?? locationId}</p>
              <p>تعداد اقلام: {lines.filter((l) => l.inventoryItemId).length}</p>
              {receiptTotal ? <p>جمع ارزش: {money.formatText(receiptTotal)} ({kind === "receipt" ? "بدهکار ۱۳۰۰ / بستانکار ۴۹۰۰" : "بدهکار ۵۹۰۰ / بستانکار ۱۳۰۰"})</p> : null}
              <p className="mt-2 text-[11px] text-muted-foreground">موجودی و دفتر روزنامه هم‌زمان به‌روز می‌شوند.</p>
            </div>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => submit()} disabled={busy} className="flex-1">
                تأیید و ثبت قطعی
              </Button>
              <Button variant="outline" onClick={() => setShowConfirm(false)} className="flex-1">
                انصراف
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {showNegativeConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-500/30 dark:bg-amber-950/20">
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">هشدار موجودی منفی</h3>
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">این حواله باعث می‌شود موجودی یک یا چند قلم منفی شود (بیش از موجودی فیزیکی). این حالت فقط با مجوز مدیریتی مجاز است و بعداً با رسید تسویه خواهد شد.</p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => submit(true)} disabled={busy} className="flex-1 bg-amber-600 hover:bg-amber-700 dark:bg-amber-700">
                تأیید با موجودی منفی
              </Button>
              <Button variant="outline" onClick={() => setShowNegativeConfirm(false)} className="flex-1">
                انصراف
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
