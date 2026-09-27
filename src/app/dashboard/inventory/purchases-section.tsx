"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import Decimal from "decimal.js";
import { formatQuantity } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { InventoryItem, Runner, Supplier } from "./inventory-manager";
import {
  InvoiceOcrPanel,
  type InvoiceOcrApplyPayload,
} from "./invoice-ocr-panel";
import { SectionCard, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface Purchase {
  id: string;
  status: "draft" | "ordered" | "received" | "cancelled";
  total: string | number;
  note: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  /** The date entered for the purchase itself (ISO), independent of created_at. */
  purchase_date: string;
  ordered_at: string | null;
  received_at: string | null;
  created_at: string;
}

/** One stored line. quantity/unit_cost are in the item's *base* unit. */
interface PurchaseDetailItem {
  id: string;
  inventory_item_id: string;
  inventory_item_name: string;
  unit: string;
  purchase_unit: string | null;
  purchase_unit_factor: string | number;
  quantity: string | number;
  unit_cost: string | number;
  extended_cost: string | number;
  inventory_lot_id: string | null;
}

interface PurchaseDetail {
  purchase: Purchase & { created_by_name?: string | null };
  items: PurchaseDetailItem[];
}

interface DraftLine {
  inventoryItemId: string;
  purchaseQty: string;
  totalCost: string;
  /**
   * What this line held when the edit form opened: the exact stored Rial value
   * and the Toman text rendered from it. The form edits Toman, but Toman is a
   * lossy view of Rial (formatMoneyText floors by 10 in the Toman display), so a line the user never
   * touched is written back from `rial` verbatim rather than re-parsed — saving
   * an untouched purchase must not silently round its own amounts.
   * Unset on the create form, which has no prior value.
   */
  original?: { text: string; rial: string };
}

const STATUS_LABELS: Record<Purchase["status"], string> = {
  draft: "پیش‌نویس",
  ordered: "سفارش داده‌شده",
  received: "دریافت‌شده",
  cancelled: "لغوشده",
};

const STATUS_TONES: Record<Purchase["status"], "active" | "positive" | "neutral" | "danger"> = {
  draft: "active",
  ordered: "active",
  received: "positive",
  cancelled: "neutral",
};

const SETTLEMENT_LABELS: Record<string, string> = {
  credit: "نسیه (حساب‌های پرداختنی)",
  cash: "نقدی (صندوق)",
  bank: "بانک/کارت‌خوان",
};

const emptyLine = (): DraftLine => ({ inventoryItemId: "", purchaseQty: "", totalCost: "" });

/** Only an unreceived purchase may be edited — see the PUT handler's doc comment. */
function isEditable(status: Purchase["status"]) {
  return status === "draft" || status === "ordered";
}

/**
 * Stored base-unit quantity -> the purchase-unit quantity the user typed
 * (e.g. 5000 g back to 5 kg), so an edit form round-trips what was entered
 * rather than showing the converted value.
 */
function toPurchaseQty(quantity: string | number, factor: string | number): string {
  try {
    const f = new Decimal(String(factor));
    if (f.lte(0)) return String(quantity);
    return new Decimal(String(quantity)).div(f).toFixed();
  } catch {
    return String(quantity);
  }
}

export function PurchasesSection({
  items,
  suppliers,
  busy,
  run,
}: {
  items: InventoryItem[];
  suppliers: Supplier[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  // A failed list load keeps the last rows; this holds the message + retry.
  const [listError, setListError] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  // Set only by applying an OCR scan (invoice-ocr-panel.tsx); carried through
  // to POST /api/inventory/purchases so the draft keeps a durable pointer
  // back to the photo it was scanned from, mirroring an expense's receipt id.
  const [invoiceAssetId, setInvoiceAssetId] = useState<string | null>(null);
  const [settlementByPurchase, setSettlementByPurchase] = useState<Record<string, string>>({});
  const [supplierByPurchase, setSupplierByPurchase] = useState<Record<string, string>>({});

  // Filters. ISO date strings compare lexicographically, so an inverted range
  // (از بعد از تا) orders itself instead of silently matching nothing.
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterFrom, setFilterFromRaw] = useState("");
  const [filterTo, setFilterToRaw] = useState("");

  function setFilterFrom(value: string) {
    setFilterFromRaw(value);
    setFilterToRaw((to) => (value && to && to < value ? value : to));
  }
  function setFilterTo(value: string) {
    setFilterToRaw(value);
    setFilterFromRaw((from) => (value && from && from > value ? value : from));
  }

  // Expanded row detail, keyed by purchase id. `null` = loading.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  // Token invalidating outstanding detail fetches: expanding one row and
  // quickly another (or collapsing during the flight) must not let an older
  // response paint itself into a newer row's panel.
  const detailRequestRef = useRef(0);

  // Failures raised right where the action lives; the workspace ErrorBox sits
  // above the tab rail and is easy to miss on a phone.
  const [localError, setLocalError] = useState("");

  // Edit form state, populated from the detail when editing starts.
  const [editing, setEditing] = useState(false);
  const [editSupplierId, setEditSupplierId] = useState("");
  const [editPurchaseDate, setEditPurchaseDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLines, setEditLines] = useState<DraftLine[]>([]);
  const [returning, setReturning] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnSettlement, setReturnSettlement] = useState<"accounts_payable" | "cash" | "bank" | "supplier_receivable">("accounts_payable");
  const [returnQuantities, setReturnQuantities] = useState<Record<string, string>>({});
  /**
   * Idempotency key for the supplier-return POST. It is minted once when the
   * return form opens — NOT per submit attempt: after a response is lost in
   * flight, the operator's retry must be answered with the stored duplicate,
   * never a second goods-out. Reopening the form mints a new key, which is
   * what makes the next deliberate return distinct.
   */
  const [returnKey, setReturnKey] = useState("");

  const loadPurchases = useCallback(() => {
    const params = new URLSearchParams();
    if (filterStatus) params.set("status", filterStatus);
    if (filterSupplier) params.set("supplierId", filterSupplier);
    if (filterFrom) params.set("dateFrom", filterFrom);
    if (filterTo) params.set("dateTo", filterTo);
    const qs = params.toString();
    setListError("");
    api<{ purchases: Purchase[] }>(`/api/inventory/purchases${qs ? `?${qs}` : ""}`)
      .then(({ ok, data }) => {
        if (ok) setPurchases(data.purchases);
        else setListError("خواندن فهرست خریدها ناموفق بود. اتصال را بررسی کنید.");
      })
      .catch(() => setListError("خواندن فهرست خریدها ناموفق بود. اتصال را بررسی کنید."));
  }, [filterStatus, filterSupplier, filterFrom, filterTo]);
  useEffect(loadPurchases, [loadPurchases]);

  const loadDetail = useCallback((id: string) => {
    const request = ++detailRequestRef.current;
    setDetail(null);
    api<PurchaseDetail>(`/api/inventory/purchases/${id}`)
      .then(({ ok, data }) => {
        // A newer expand/collapse supersedes this response — drop it.
        if (request !== detailRequestRef.current) return;
        if (ok) setDetail(data);
      })
      .catch(() => {
        /* next interaction retries; the panel stays in its loading shape */
      });
  }, []);

  function toggleExpanded(id: string) {
    setEditing(false);
    setReturning(false);
    if (expandedId === id) {
      // Invalidate the in-flight fetch before the panel unmounts.
      detailRequestRef.current += 1;
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    loadDetail(id);
  }

  /**
   * `purchaseDate` comes from the list row rather than the loaded detail: the
   * list endpoint hands purchase_date back as ISO text, where the detail's
   * `SELECT p.*` would serialise the `date` column through the server's own
   * timezone and could prefill the picker a day off.
   */
  function startEditing(purchaseDate: string) {
    if (!detail) return;
    setEditSupplierId(detail.purchase.supplier_id ?? "");
    setEditPurchaseDate(purchaseDate);
    setEditNote(detail.purchase.note ?? "");
    setEditLines(
      detail.items.map((it) => {
        const rial = String(it.extended_cost);
        // Stored in Rial; the form edits Toman, the same unit the create form uses.
        const text = money.formatText(rial, { withUnit: false });
        return {
          inventoryItemId: it.inventory_item_id,
          purchaseQty: toPurchaseQty(it.quantity, it.purchase_unit_factor),
          totalCost: text,
          original: { text, rial },
        };
      }),
    );
    setEditing(true);
  }

  const activeItems = items.filter((i) => i.is_active);
  const activeSuppliers = suppliers.filter((s) => s.is_active);

  // ⚡ Bolt: Cache derived SearchableSelect options array.
  // Instead of recalculating identical options arrays on every render for every line,
  // we compute it once and pass it down. We depend on `items` directly and filter
  // inside useMemo so that the cache actually holds across renders.
  const activeItemsOptions = useMemo(() => {
    const active = items.filter((i) => i.is_active);
    return [
      { value: "", label: "قلم انبار را انتخاب کنید…" },
      ...active.map((it) => ({
        value: it.id,
        label: it.name,
        searchString: [it.name, it.sku, it.unit].filter(Boolean).join(" "),
      })),
    ];
  }, [items]);

  const activeSuppliersOptions = useMemo(() => {
    const active = suppliers.filter((s) => s.is_active);
    return [
      { value: "", label: "بدون تأمین‌کننده" },
      ...active.map((s) => ({ value: s.id, label: s.name })),
    ];
  }, [suppliers]);

  const activeSuppliersOptionsForPurchase = useMemo(() => {
    const active = suppliers.filter((s) => s.is_active);
    return [
      { value: "", label: "تأمین‌کننده را انتخاب کنید…" },
      ...active.map((s) => ({ value: s.id, label: s.name })),
    ];
  }, [suppliers]);

  const allSuppliersOptions = useMemo(() => {
    return [
      { value: "", label: "همه تأمین‌کنندگان" },
      ...suppliers.map((s) => ({ value: s.id, label: s.name })),
    ];
  }, [suppliers]);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  /** Shared by create and edit: drop blank rows and convert Toman -> Rial text. */
  function toPayloadLines(source: DraftLine[]) {
    return source
      .filter((l) => l.inventoryItemId && l.purchaseQty.trim())
      .map((l) => {
        let totalCostRial: string;
        if (l.original && l.totalCost === l.original.text) {
          // Untouched line — keep the stored Rial exactly (see DraftLine.original).
          totalCostRial = l.original.rial;
        } else {
          try {
            totalCostRial = money.parseText(l.totalCost || "0");
          } catch {
            totalCostRial = "";
          }
        }
        return { inventoryItemId: l.inventoryItemId, purchaseQty: l.purchaseQty, totalCost: totalCostRial };
      });
  }

  /** Guard against the silent no-op: every submit path explains instead. */
  function validatePayloadLines(payloadLines: ReturnType<typeof toPayloadLines>): string {
    if (payloadLines.length === 0) {
      return "حداقل یک ردیف با قلم و مقدار معتبر وارد کنید.";
    }
    if (payloadLines.some((l) => !l.totalCost)) {
      return "مبلغ کل یکی از ردیف‌ها معتبر نیست؛ دوباره وارد کنید.";
    }
    return "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payloadLines = toPayloadLines(lines);
    const invalid = validatePayloadLines(payloadLines);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError("");

    const ok = await run(
      () =>
        api("/api/inventory/purchases", {
          method: "POST",
          body: JSON.stringify({
            supplierId: supplierId || null,
            purchaseDate: purchaseDate || null,
            note,
            items: payloadLines,
            invoiceAssetId,
          }),
        }),
      setLocalError,
    );
    if (ok) {
      setNote("");
      setLines([emptyLine()]);
      setInvoiceAssetId(null);
      loadPurchases();
    }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!expandedId) return;
    const payloadLines = toPayloadLines(editLines);
    const invalid = validatePayloadLines(payloadLines);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError("");

    const ok = await run(
      () =>
        api(`/api/inventory/purchases/${expandedId}`, {
          method: "PUT",
          body: JSON.stringify({
            supplierId: editSupplierId || null,
            purchaseDate: editPurchaseDate || null,
            note: editNote,
            items: payloadLines,
          }),
        }),
      setLocalError,
    );
    if (ok) {
      setEditing(false);
      loadPurchases();
      loadDetail(expandedId);
    }
  }

  async function transition(id: string, status: string, settlementMethod?: string) {
    setLocalError("");
    const ok = await run(
      () =>
        api(`/api/inventory/purchases/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status, settlementMethod, supplierId: supplierByPurchase[id] || undefined }),
        }),
      setLocalError,
    );
    if (ok) {
      // The row's one-shot receive choices are spent once the status moves.
      setSettlementByPurchase((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSupplierByPurchase((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      loadPurchases();
      if (expandedId === id) loadDetail(id);
    }
  }

  function startReturning() {
    if (!detail) return;
    setReturnReason("");
    setReturnSettlement("accounts_payable");
    setReturnQuantities(Object.fromEntries(detail.items.map((it) => [it.id, ""])));
    setReturnKey(
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${expandedId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setReturning(true);
  }

  async function submitReturn(e: React.FormEvent) {
    e.preventDefault();
    if (!expandedId || !returnReason.trim() || !detail) return;
    // Validate in the unit the operator typed (base units) before the server
    // does: "0" is truthy as a string, and an over-return otherwise comes
    // back as a raw underflow error.
    for (const it of detail.items) {
      const raw = returnQuantities[it.id]?.trim();
      if (!raw) continue;
      let qty: Decimal;
      try {
        qty = new Decimal(raw);
      } catch {
        setLocalError(`مقدار برگشت «${it.inventory_item_name}» عدد معتبری نیست.`);
        return;
      }
      if (qty.lte(0)) {
        setLocalError(`مقدار برگشت «${it.inventory_item_name}» باید بزرگ‌تر از صفر باشد.`);
        return;
      }
      if (qty.gt(new Decimal(String(it.quantity)))) {
        setLocalError(
          `مقدار برگشت «${it.inventory_item_name}» از مقدار خرید (${formatQuantity(it.quantity)} ${it.unit}) بیشتر است.`,
        );
        return;
      }
    }
    const lines = detail.items
      .map((it) => ({
        purchaseItemId: it.id,
        inventoryLotId: it.inventory_lot_id,
        quantity: returnQuantities[it.id]?.trim() ?? "",
      }))
      .filter((line) => line.quantity);
    if (lines.length === 0) {
      setLocalError("حداقل برای یک قلم مقدار برگشت وارد کنید.");
      return;
    }
    setLocalError("");
    const ok = await run(
      () => api(`/api/inventory/supplier-returns`, {
        method: "POST",
        body: JSON.stringify({
          purchaseId: expandedId,
          settlementMethod: returnSettlement,
          reason: returnReason,
          idempotencyKey: returnKey,
          lines,
        }),
      }),
      setLocalError,
    );
    if (ok) {
      setReturning(false);
      loadDetail(expandedId);
      loadPurchases();
    }
  }

  async function removePurchase(id: string) {
    if (!window.confirm("این خرید حذف شود؟ دریافت‌نشده است و ردیف‌هایش برای همیشه پاک می‌شوند.")) return;
    const ok = await run(() => api(`/api/inventory/purchases/${id}`, { method: "DELETE" }), setLocalError);
    if (ok) {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        setEditing(false);
      }
      loadPurchases();
    }
  }

  /** The per-line editor row, shared by the create form and the edit form. */
  function lineRows(source: DraftLine[], onChange: (i: number, patch: Partial<DraftLine>) => void, onRemove: (i: number) => void) {
    return source.map((line, i) => {
      const invItem = items.find((it) => it.id === line.inventoryItemId);
      return (
        <div key={i} className="grid min-w-0 gap-3 rounded-xl border border-border p-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="قلم انبار">
            <SearchableSelect
              value={line.inventoryItemId}
              onChange={(value) => onChange(i, { inventoryItemId: value })}
                options={activeItemsOptions}
            />
          </Field>
          <Field label={`مقدار خرید (${invItem?.purchase_unit || invItem?.unit || "واحد"})`}>
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="decimal"
              allowNegative={false}
              value={line.purchaseQty}
              onChange={(e) => onChange(i, { purchaseQty: e.target.value })}
            />
          </Field>
          <Field label={`مبلغ کل (${money.unitLabel})`}>
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              allowNegative={false}
              value={line.totalCost}
              onChange={(e) => onChange(i, { totalCost: e.target.value })}
            />
          </Field>
          <span className="mb-4 self-end break-words text-xs text-muted-foreground">
            {invItem
              ? invItem.purchase_unit
                ? `= ${formatQuantity(invItem.purchase_unit_factor)} ${invItem.unit} به ازای هر واحد خرید`
                : `بدون واحد خرید؛ مقدار در واحد پایه (${invItem.unit}) ثبت می‌شود.`
              : ""}
          </span>
          <div className="mb-4 flex items-end">
            <Button type="button" variant="outline" onClick={() => onRemove(i)} disabled={source.length === 1}>
              حذف ردیف
            </Button>
          </div>
        </div>
      );
    });
  }

  function applyOcrDraft(payload: InvoiceOcrApplyPayload) {
    // Applying replaces the draft lines wholesale — sure up front when the
    // operator has already typed something, so a scan can't silently discard
    // hand-entered work.
    const draftHasContent =
      lines.some((l) => l.inventoryItemId || l.purchaseQty.trim() || l.totalCost.trim()) ||
      note.trim() !== "";
    if (
      draftHasContent &&
      payload.lines.length > 0 &&
      !window.confirm("ردیف‌ها و یادداشت فعلی فرم با نتیجهٔ فاکتور جایگزین می‌شوند. ادامه می‌دهید؟")
    ) {
      return;
    }
    if (payload.supplierId) setSupplierId(payload.supplierId);
    if (payload.purchaseDate) setPurchaseDate(payload.purchaseDate);
    if (payload.note) setNote(payload.note);
    if (payload.lines.length > 0) {
      setLines(
        payload.lines.map((l) => ({
          inventoryItemId: l.inventoryItemId,
          purchaseQty: l.purchaseQty,
          totalCost: l.totalCost,
        })),
      );
    }
    setInvoiceAssetId(payload.invoiceAssetId);
    setLocalError("");
    // Scroll the manual form into view so the operator sees the filled lines.
    if (typeof document !== "undefined") {
      document.getElementById("purchase-draft-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <InvoiceOcrPanel
        items={items}
        supplierOptions={activeSuppliersOptions}
        disabled={busy}
        onApply={applyOcrDraft}
      />

      <ErrorBox>{localError}</ErrorBox>

      <div id="purchase-draft-form">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات خرید</p>
            <h2 className="mt-1 font-semibold text-foreground">ثبت خرید (رسید ورود کالا)</h2>
          </div>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="تأمین‌کننده">
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                options={activeSuppliersOptions}
              />
            </Field>
            <Field label="تاریخ خرید">
              <JalaliDatePicker value={purchaseDate} onChange={setPurchaseDate} placeholder="امروز" />
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
            </Field>
          </div>

          <div className="space-y-2">{lineRows(lines, updateLine, removeLine)}</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={addLine}>افزودن ردیف</Button>
            <div className="w-full sm:w-52">
              <Button type="submit" size="lg" className="w-full px-5 font-semibold" disabled={busy}>ثبت پیش‌نویس خرید</Button>
            </div>
          </div>
        </form>
      </SectionCard>
      </div>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق خرید</p>
            <h2 className="mt-1 font-semibold text-foreground">خریدهای اخیر</h2>
          </div>
        }
        description="حداکثر ۱۰۰ خرید اخیر نمایش داده می‌شود؛ برای دیدن سوابق قدیمی‌تر از فیلترهای تاریخ، وضعیت یا تأمین‌کننده استفاده کنید."
      >
        <div className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="وضعیت">
            <SearchableSelect
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: "", label: "همه وضعیت‌ها" },
                ...(Object.keys(STATUS_LABELS) as Purchase["status"][]).map((s) => ({
                  value: s,
                  label: STATUS_LABELS[s],
                })),
              ]}
            />
          </Field>
          <Field label="تأمین‌کننده">
            <SearchableSelect
              value={filterSupplier}
              onChange={setFilterSupplier}
              options={allSuppliersOptions}
            />
          </Field>
          <Field label="از تاریخ">
            <JalaliDatePicker value={filterFrom} onChange={setFilterFrom} placeholder="بدون محدودیت" />
          </Field>
          <Field label="تا تاریخ">
            <JalaliDatePicker value={filterTo} onChange={setFilterTo} placeholder="بدون محدودیت" />
          </Field>
        </div>

        <ul className="divide-y divide-border rounded-lg border border-border">
          {(purchases ?? []).map((p) => {
            const isExpanded = expandedId === p.id;
            return (
              <li key={p.id} className="min-w-0 px-3 py-4 text-sm sm:px-4">
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <span className="min-w-0 break-words">
                    <StatusBadge tone={STATUS_TONES[p.status]}>{STATUS_LABELS[p.status]}</StatusBadge>{" "}
                    {p.supplier_name ?? "بدون تأمین‌کننده"} — {money.formatText(String(p.total))} —{" "}
                    <span className="text-xs text-muted-foreground">{formatJalali(p.purchase_date)}</span>
                  </span>
                  {/*
                    Actions and the settlement pickers. Selects get a full row
                    of their own on a phone (col-span-2) so they never shrink
                    below a readable width; buttons pair up two per row.
                  */}
                  <div className="grid w-full grid-cols-2 gap-2 lg:flex lg:w-auto lg:flex-wrap lg:items-end lg:justify-end">
                    {/* Every status opens — a cancelled purchase's contents are
                        still a record the operator may need to review. */}
                    <Button type="button" variant="outline" onClick={() => toggleExpanded(p.id)}>
                      {isExpanded ? "بستن" : "مشاهده جزئیات"}
                    </Button>
                    {p.status === "draft" || p.status === "ordered" ? (
                      <>
                        {p.status === "draft" ? (
                          <Button type="button" variant="outline" disabled={busy} onClick={() => transition(p.id, "ordered")}>
                            ثبت سفارش
                          </Button>
                        ) : null}
                        <label className="col-span-2 grid min-w-0 gap-1 text-xs font-medium lg:col-span-1 lg:w-44">
                          <span>روش تسویه</span>
                          <SearchableSelect
                            value={settlementByPurchase[p.id] ?? "credit"}
                            onChange={(value) => setSettlementByPurchase((prev) => ({ ...prev, [p.id]: value }))}
                            options={Object.entries(SETTLEMENT_LABELS).map(([key, label]) => ({
                              value: key,
                              label,
                            }))}
                          />
                        </label>
                        {!p.supplier_name && (settlementByPurchase[p.id] ?? "credit") === "credit" ? (
                          <div className="col-span-2 grid min-w-0 gap-1 text-xs font-medium lg:col-span-1 lg:w-44">
                            <span>تأمین‌کنندهٔ خرید نسیه</span>
                            <SearchableSelect
                              value={supplierByPurchase[p.id] ?? ""}
                              onChange={(v) => setSupplierByPurchase((prev) => ({ ...prev, [p.id]: v }))}
                              options={activeSuppliersOptionsForPurchase}
                            />
                          </div>
                        ) : null}
                        <Button type="button"
                          disabled={busy || (!p.supplier_name && (settlementByPurchase[p.id] ?? "credit") === "credit" && !supplierByPurchase[p.id])}
                          onClick={() => transition(p.id, "received", settlementByPurchase[p.id] ?? "credit")}
                        >
                          دریافت کالا
                        </Button>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => transition(p.id, "cancelled")}>
                          لغو
                        </Button>
                      </>
                    ) : null}
                    {p.status !== "received" ? (
                      <Button type="button" variant="destructive" disabled={busy} onClick={() => void removePurchase(p.id)}>
                        حذف
                      </Button>
                    ) : null}
                  </div>
                </div>

                {isExpanded ? (
                  <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
                    {!detail ? (
                      <LoadingSkeleton rows={3} compact />
                    ) : editing ? (
                      <form onSubmit={saveEdit} className="space-y-3">
                        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          <Field label="تأمین‌کننده">
                            <SearchableSelect
                              value={editSupplierId}
                              onChange={setEditSupplierId}
                              options={activeSuppliersOptions}
                            />
                          </Field>
                          <Field label="تاریخ خرید">
                            <JalaliDatePicker value={editPurchaseDate} onChange={setEditPurchaseDate} />
                          </Field>
                          <Field label="یادداشت">
                            <input className={inputClass} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="اختیاری" />
                          </Field>
                        </div>
                        <div className="space-y-2">
                          {lineRows(
                            editLines,
                            (i, patch) => setEditLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))),
                            (i) => setEditLines((prev) => prev.filter((_, idx) => idx !== i)),
                          )}
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button type="button" variant="outline" onClick={() => setEditLines((prev) => [...prev, emptyLine()])}>افزودن ردیف</Button>
                          <Button type="button" variant="outline" onClick={() => setEditing(false)}>انصراف</Button>
                          <div className="w-full sm:w-52">
                            <Button type="submit" size="lg" className="w-full px-5 font-semibold" disabled={busy}>ذخیره تغییرات</Button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <>
                        <DataTable caption="اقلام این فاکتور خرید" tableClassName="text-xs">
                          <DataTableHead>
                            <Th>قلم انبار</Th>
                            <Th numeric>مقدار</Th>
                            <Th numeric>بهای واحد</Th>
                            <Th numeric>مبلغ کل</Th>
                          </DataTableHead>
                          <DataTableBody>
                            {detail.items.map((it) => (
                              <DataTableRow key={it.id}>
                                <Td>{it.inventory_item_name}</Td>
                                <Td numeric nowrap>
                                  {formatQuantity(it.quantity)} {it.unit}
                                </Td>
                                <Td numeric nowrap muted>
                                  {/* unit_cost is numeric(24,9); formatText only accepts integer Rial. */}
                                  {money.formatText(new Decimal(String(it.unit_cost)).toFixed(0))}
                                </Td>
                                <Td numeric nowrap>{money.formatText(String(it.extended_cost))}</Td>
                              </DataTableRow>
                            ))}
                          </DataTableBody>
                        </DataTable>

                        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs sm:grid-cols-4">
                          <div>
                            <dt className="text-muted-foreground">تاریخ خرید</dt>
                            <dd className="mt-0.5">{formatJalali(p.purchase_date)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">ثبت</dt>
                            <dd className="mt-0.5">{formatJalali(detail.purchase.created_at)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">سفارش</dt>
                            <dd className="mt-0.5">{detail.purchase.ordered_at ? formatJalali(detail.purchase.ordered_at) : "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">دریافت</dt>
                            <dd className="mt-0.5">{detail.purchase.received_at ? formatJalali(detail.purchase.received_at) : "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">یادداشت</dt>
                            <dd className="mt-0.5 break-words">{detail.purchase.note || "—"}</dd>
                          </div>
                        </dl>

                        {returning ? (
                          <form onSubmit={submitReturn} className="mt-4 space-y-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/15 p-3">
                            <p className="text-sm font-semibold">برگشت کالا به تأمین‌کننده</p>
                            <p className="text-xs text-muted-foreground">مقدار برگشتی را در واحد پایه وارد کنید. قیمت‌ها در سیستم به ریال ذخیره می‌شوند و اینجا به تومان نمایش داده می‌شوند.</p>
                            <div className="space-y-2">
                              {detail.items.map((it) => (
                                <div key={it.id} className="grid gap-2 sm:grid-cols-[1fr_9rem] sm:items-end">
                                  <span className="text-sm">{it.inventory_item_name} <span className="text-xs text-muted-foreground">({formatQuantity(it.quantity)} {it.unit})</span></span>
                                  <Field label={`مقدار برگشت (${it.unit})`}>
                                    <PersianNumberInput className={inputClass} dir="ltr" inputMode="decimal" allowNegative={false} value={returnQuantities[it.id] ?? ""} onChange={(e) => setReturnQuantities((prev) => ({ ...prev, [it.id]: e.target.value }))} />
                                  </Field>
                                </div>
                              ))}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Field label="روش تسویه">
                                <SearchableSelect value={returnSettlement} onChange={(v) => setReturnSettlement(v as typeof returnSettlement)} options={[
                                  { value: "accounts_payable", label: "کاهش بدهی تأمین‌کننده" },
                                  { value: "cash", label: "نقدی" },
                                  { value: "bank", label: "بانکی" },
                                  { value: "supplier_receivable", label: "طلب از تأمین‌کننده" },
                                ]} />
                              </Field>
                              <Field label="دلیل برگشت">
                                <input className={inputClass} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="مثلاً کالای معیوب" required />
                              </Field>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                              <Button type="submit" size="lg" className="w-full px-5 font-semibold" disabled={busy}>ثبت برگشت</Button>
                              <Button type="button" variant="outline" onClick={() => setReturning(false)}>انصراف</Button>
                            </div>
                          </form>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {isEditable(p.status) ? (
                            <Button type="button" variant="outline" disabled={busy} onClick={() => startEditing(p.purchase_date)}>
                              ویرایش
                            </Button>
                          ) : p.status === "received" ? (
                            <>
                              <Button type="button" variant="outline" disabled={busy} onClick={startReturning}>
                                برگشت به تأمین‌کننده
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                خرید دریافت‌شده قابل ویرایش نیست؛ برای اصلاح از «برگشت به تأمین‌کننده» استفاده کنید.
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              خرید لغوشده فقط قابل مشاهده است و جایی برای اصلاح یا برگشت ندارد.
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
          {purchases === null && !listError ? (
            <li className="p-1">
              <LoadingSkeleton rows={3} compact label="در حال بارگذاری فهرست خریدها" />
            </li>
          ) : null}
          {listError ? (
            <li className="flex flex-col items-start gap-2 p-3 text-sm">
              <p className="text-destructive" role="alert">{listError}</p>
              <Button type="button" variant="outline" onClick={loadPurchases}>
                تلاش دوباره
              </Button>
            </li>
          ) : null}
          {purchases && purchases.length === 0 && !listError ? (
            <li className="p-3 text-sm text-muted-foreground">خریدی ثبت نشده است.</li>
          ) : null}
        </ul>
      </SectionCard>
    </div>
  );
}
