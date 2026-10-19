"use client";

/**
 * Phase 42b — the «خرید» tab: the purchase-receiving form and the purchase
 * history, extracted from the former retail stock workspace (Phase 27
 * Wave 8's retail purchasing) into the warehouse module's «اقلام و عملیات»
 * group.
 *
 * Issue #915 hardening:
 *  - settlement (نسیه/نقدی/بانکی) and the supplier's invoice (number, date,
 *    VAT, terms/due date) ride the receive, so the posting credits the
 *    account the goods were actually paid from;
 *  - money crosses the wire as integer-Rial decimal text (exact past 2^53),
 *    never re-parsed through a float;
 *  - the history is server-side filtered and paginated (replacing the old
 *    LIMIT 100) and every receipt opens into a full detail view;
 *  - mutation controls follow the member's effective `purchases.manage`.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import Decimal from "decimal.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { canManagePurchases } from "@/lib/purchase-abilities";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { LoadingSkeleton, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";
import {
  draftVatRial,
  EMPTY_SUPPLIER_INVOICE_DRAFT,
  SupplierInvoiceFields,
  supplierInvoicePayload,
  type SupplierInvoiceDraft,
} from "../inventory/supplier-invoice-fields";

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
  /** Integer Rial as decimal text — exact past 2^53 (issue #915). */
  total: string;
  vatAmount: string;
  settlementMethod: string;
  supplierInvoiceNumber: string | null;
  supplierInvoiceDate: string | null;
  paymentDueDate: string | null;
  note: string | null;
  supplierName: string | null;
  lineCount: number;
  receivedAt: string;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

interface PurchaseDetail {
  purchase: {
    id: string;
    total: string;
    vatAmount: string;
    settlementMethod: string;
    supplierInvoiceNumber: string | null;
    supplierInvoiceDate: string | null;
    paymentTermsDays: number | null;
    paymentDueDate: string | null;
    note: string | null;
    receivedAt: string;
    supplierName: string | null;
    createdByName: string | null;
  };
  lines: {
    id: string;
    itemName: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unitCost: string;
    batchNumber: string | null;
    internalBatchNumber: boolean;
    expiryDate: string | null;
    serialNumber: string | null;
  }[];
}

const SETTLEMENT_LABELS: Record<string, string> = {
  credit: "نسیه (حساب‌های پرداختنی)",
  cash: "نقدی (صندوق)",
  bank: "بانک/کارت‌خوان",
};

const SETTLEMENT_DONE_MESSAGES: Record<string, string> = {
  credit: "خرید دریافت شد (بدهکار موجودی، بستانکار حساب‌های پرداختنی).",
  cash: "خرید دریافت شد (بدهکار موجودی، بستانکار صندوق).",
  bank: "خرید دریافت شد (بدهکار موجودی، بستانکار حساب در راهِ بانک).",
};

export function PurchasesSection({
  role,
  permissions,
}: {
  /** The signed-in member — mutation controls follow `purchases.manage` (issue #915). */
  role?: string;
  permissions?: readonly string[];
}) {
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [vatPercent, setVatPercent] = useState(0);
  // Issue #915 — a failed initial fetch must surface a retry, not an
  // endless skeleton (the data stays null forever otherwise).
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  // POST /api/stock/purchases requires `purchases.manage`; without it only
  // the history renders — never a form whose submit can only answer 403.
  const canManage = canManagePurchases(role ?? "", permissions);

  // Server-side history filters + page (issue #915). ISO strings compare
  // lexicographically, so an inverted range orders itself.
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterFrom, setFilterFromRaw] = useState("");
  const [filterTo, setFilterToRaw] = useState("");
  const [page, setPage] = useState(1);

  function setFilterFrom(value: string) {
    setFilterFromRaw(value);
    setFilterToRaw((to) => (value && to && to < value ? value : to));
    setPage(1);
  }
  function setFilterTo(value: string) {
    setFilterToRaw(value);
    setFilterFromRaw((from) => (value && from && from > value ? value : from));
    setPage(1);
  }

  const loadItems = useCallback(() => {
    api<{ items: StockItem[] }>("/api/stock/items").then(({ ok, data }) => {
      if (ok) setItems(data.items);
      else setLoadError("دریافت فهرست کالاها ناموفق بود.");
    });
  }, []);

  const loadPurchases = useCallback(() => {
    setLoadError("");
    const params = new URLSearchParams();
    if (filterSupplier) params.set("supplierId", filterSupplier);
    if (filterFrom) params.set("dateFrom", filterFrom);
    if (filterTo) params.set("dateTo", filterTo);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    api<{ purchases: PurchaseRow[]; suppliers: Supplier[]; vatPercent?: number; pagination: Pagination | null }>(
      `/api/stock/purchases${qs ? `?${qs}` : ""}`,
    ).then(({ ok, data }) => {
      if (ok) {
        setPurchases(data.purchases);
        setSuppliers(data.suppliers);
        setPagination(data.pagination);
        setVatPercent(typeof data.vatPercent === "number" ? data.vatPercent : 0);
      } else {
        setLoadError("دریافت فهرست خریدها ناموفق بود.");
      }
    });
  }, [filterSupplier, filterFrom, filterTo, page]);

  const load = useCallback(() => {
    loadItems();
    loadPurchases();
  }, [loadItems, loadPurchases]);
  useEffect(load, [load]);

  if (items === null || suppliers === null || purchases === null) {
    if (loadError) {
      return (
        <SectionCard title="دریافت خرید" bodyClassName="space-y-3">
          <p className="text-sm text-destructive" role="alert">{loadError}</p>
          <Button type="button" variant="outline" onClick={load}>
            تلاش دوباره
          </Button>
        </SectionCard>
      );
    }
    return (
      <div className="space-y-4">
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canManage ? (
        <PurchaseForm
          items={items}
          suppliers={suppliers}
          vatPercent={vatPercent}
          onDone={(m) => {
            setDone(m);
            loadPurchases();
          }}
          onError={setError}
        />
      ) : null}

      {/* Feedback sits with the form, not under the list a screenful away. */}
      <ErrorBox>{error}</ErrorBox>
      {done ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{done}</p>
      ) : null}

      <PurchaseHistory
        purchases={purchases}
        suppliers={suppliers}
        pagination={pagination}
        filterSupplier={filterSupplier}
        onFilterSupplier={(v) => {
          setFilterSupplier(v);
          setPage(1);
        }}
        filterFrom={filterFrom}
        onFilterFrom={setFilterFrom}
        filterTo={filterTo}
        onFilterTo={setFilterTo}
        page={page}
        onPage={setPage}
        onRetry={loadPurchases}
        listError={loadError}
      />
    </div>
  );
}

function PurchaseHistory({
  purchases,
  suppliers,
  pagination,
  filterSupplier,
  onFilterSupplier,
  filterFrom,
  onFilterFrom,
  filterTo,
  onFilterTo,
  page,
  onPage,
  onRetry,
  listError,
}: {
  purchases: PurchaseRow[];
  suppliers: Supplier[];
  pagination: Pagination | null;
  filterSupplier: string;
  onFilterSupplier: (v: string) => void;
  filterFrom: string;
  onFilterFrom: (v: string) => void;
  filterTo: string;
  onFilterTo: (v: string) => void;
  page: number;
  onPage: (p: number) => void;
  onRetry: () => void;
  listError: string;
}) {
  const money = useMoney();
  // Expanded receipt detail, keyed by purchase id. `null` = loading. The
  // token invalidates outstanding fetches: expanding one row and quickly
  // another (or collapsing during the flight) must not let an older response
  // paint itself into a newer row's panel (issue #915).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const detailRequestRef = useRef(0);

  const loadDetail = useCallback((id: string) => {
    const request = ++detailRequestRef.current;
    setDetail(null);
    setDetailError("");
    api<PurchaseDetail>(`/api/stock/purchases/${id}`)
      .then(({ ok, data }) => {
        if (request !== detailRequestRef.current) return;
        if (ok) setDetail(data);
        else setDetailError("خواندن جزئیات خرید ناموفق بود. اتصال را بررسی کنید.");
      })
      .catch(() => {
        if (request !== detailRequestRef.current) return;
        setDetailError("خواندن جزئیات خرید ناموفق بود. اتصال را بررسی کنید.");
      });
  }, []);

  function toggleExpanded(id: string) {
    if (expandedId === id) {
      detailRequestRef.current += 1;
      setExpandedId(null);
      setDetail(null);
      setDetailError("");
      return;
    }
    setExpandedId(id);
    loadDetail(id);
  }

  const supplierFilterOptions = useMemo(
    () => [
      { value: "", label: "همه تأمین‌کنندگان" },
      ...suppliers.map((s) => ({ value: s.id, label: s.name })),
    ],
    [suppliers],
  );

  const pages = pagination?.pages ?? 1;
  const total = pagination?.total ?? purchases.length;

  return (
    <SectionCard
      title="سوابق خرید"
      bodyClassName="space-y-3"
      description="فهرست از سرور فیلتر و صفحه‌بندی می‌شود؛ همهٔ سوابق در دسترس است."
    >
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label="تأمین‌کننده">
          <SearchableSelect value={filterSupplier} onChange={onFilterSupplier} options={supplierFilterOptions} />
        </Field>
        <Field label="از تاریخ">
          <JalaliDatePicker value={filterFrom} onChange={onFilterFrom} placeholder="بدون محدودیت" />
        </Field>
        <Field label="تا تاریخ">
          <JalaliDatePicker value={filterTo} onChange={onFilterTo} placeholder="بدون محدودیت" />
        </Field>
      </div>

      {listError ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">{listError}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            تلاش دوباره
          </Button>
        </div>
      ) : purchases.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {filterSupplier || filterFrom || filterTo ? "خریدی مطابق فیلترها یافت نشد." : "هنوز خریدی ثبت نشده است."}
        </p>
      ) : (
        <ul className="divide-y divide-border/80 text-sm">
          {purchases.map((p) => {
            const isExpanded = expandedId === p.id;
            return (
              <li key={p.id} className="py-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-foreground">
                      {p.supplierName ?? "بدون تأمین‌کننده"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {formatJalali(p.receivedAt)} · {SETTLEMENT_LABELS[p.settlementMethod] ?? p.settlementMethod}
                      {p.supplierInvoiceNumber ? (
                        <span dir="auto"> · فاکتور {toPersianDigits(p.supplierInvoiceNumber)}</span>
                      ) : null}
                      {p.paymentDueDate ? <> · سررسید {formatJalali(p.paymentDueDate)}</> : null}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                    <span>
                      {formatPersianNumber(p.lineCount)} قلم · {money.formatText(p.total)}
                      {p.vatAmount !== "0" ? <> + مالیات {money.formatText(p.vatAmount)}</> : null}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => toggleExpanded(p.id)}>
                      {isExpanded ? "بستن" : "جزئیات"}
                    </Button>
                  </span>
                </div>

                {isExpanded ? (
                  <div className="mt-2 rounded-xl border border-border bg-muted/30 p-3 text-xs">
                    {!detail && detailError ? (
                      <div className="space-y-2">
                        <p className="text-destructive" role="alert">{detailError}</p>
                        <Button type="button" variant="outline" size="sm" onClick={() => loadDetail(p.id)}>
                          تلاش دوباره
                        </Button>
                      </div>
                    ) : !detail ? (
                      <LoadingSkeleton rows={2} compact label="در حال بارگذاری جزئیات خرید" />
                    ) : (
                      <>
                        <ul className="divide-y divide-border/60">
                          {detail.lines.map((l) => (
                            <li key={l.id} className="flex items-start justify-between gap-3 py-1.5">
                              <span className="min-w-0 break-words">
                                {l.itemName}
                                {l.sku ? <span className="text-muted-foreground"> ({l.sku})</span> : null}
                                <span className="block text-[11px] text-muted-foreground">
                                  {l.batchNumber ? (
                                    <>بچ {l.batchNumber}{l.internalBatchNumber ? " (تولید سیستم)" : ""} · </>
                                  ) : null}
                                  {l.serialNumber ? <>سریال {l.serialNumber} · </> : null}
                                  {l.expiryDate ? <>انقضا {formatJalali(l.expiryDate)} · </> : null}
                                  × {formatQuantity(l.quantity)}
                                </span>
                              </span>
                              <span className="shrink-0 text-muted-foreground" dir="ltr">
                                {money.formatText(l.unitCost)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <dl className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2 sm:grid-cols-4">
                          <div>
                            <dt className="text-muted-foreground">تسویه</dt>
                            <dd className="mt-0.5">{SETTLEMENT_LABELS[detail.purchase.settlementMethod] ?? "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">شمارهٔ فاکتور</dt>
                            <dd className="mt-0.5 break-words" dir="auto">
                              {detail.purchase.supplierInvoiceNumber
                                ? toPersianDigits(detail.purchase.supplierInvoiceNumber)
                                : "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">تاریخ فاکتور</dt>
                            <dd className="mt-0.5">
                              {detail.purchase.supplierInvoiceDate ? formatJalali(detail.purchase.supplierInvoiceDate) : "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">مالیات بر ارزش افزوده</dt>
                            <dd className="mt-0.5">{money.formatText(detail.purchase.vatAmount)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">سررسید پرداخت</dt>
                            <dd className="mt-0.5">
                              {detail.purchase.paymentDueDate ? formatJalali(detail.purchase.paymentDueDate) : "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">ثبت‌کننده</dt>
                            <dd className="mt-0.5">{detail.purchase.createdByName ?? "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">یادداشت</dt>
                            <dd className="mt-0.5 break-words">{detail.purchase.note || "—"}</dd>
                          </div>
                        </dl>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            صفحهٔ قبل
          </Button>
          <span className="text-muted-foreground">
            صفحهٔ {formatPersianNumber(Math.min(page, pages))} از {formatPersianNumber(pages)} ·{" "}
            {formatPersianNumber(total)} خرید
          </span>
          <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            صفحهٔ بعد
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}

function PurchaseForm({
  items,
  suppliers,
  vatPercent,
  onDone,
  onError,
}: {
  items: StockItem[];
  suppliers: Supplier[];
  vatPercent: number;
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [supplierId, setSupplierId] = useState("");
  const [settlementMethod, setSettlementMethod] = useState<"credit" | "cash" | "bank">("credit");
  // Audit F11 parity with F&B — the supplier's invoice block.
  const [invoiceDraft, setInvoiceDraft] = useState<SupplierInvoiceDraft>(EMPTY_SUPPLIER_INVOICE_DRAFT);
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
      /** Integer Rial as decimal text — exact past 2^53 (issue #915). */
      unitCost: string;
      batchNumber: string | null;
      manufactureDate: string | null;
      supplierReference: string | null;
      expiryDate: string | null;
      serials: { serialNumber: string; warrantyMonths?: number }[] | null;
    }[]
  >([]);
  const [busy, setBusy] = useState(false);
  // Issue #915 — the stable request identity /api/stock/purchases dedupes
  // on. It is regenerated whenever the payload changes (a different payload
  // IS a different purchase) and after a success, but stays the same across
  // retries of an unchanged payload — so a retry after a lost response
  // returns the original receipt instead of double-posting stock and the
  // settlement entry.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, [lines, supplierId, settlementMethod, invoiceDraft]);

  const selectedItem = items.find((i) => i.id === itemId) ?? null;
  const isBatchItem = selectedItem?.tracking === "batch";
  const isSerialItem = selectedItem?.tracking === "serial";

  // The receipt's own date (received now) — the base for payment terms when
  // the invoice carries no date. Computed per render; it only moves at
  // midnight.
  const todayIso = new Date().toISOString().slice(0, 10);

  /** The lines' goods total, exact BigInt over Rial text. */
  const goodsRial = useMemo(() => {
    let sum = 0n;
    for (const l of lines) {
      try {
        sum += BigInt(new Decimal(l.quantity).times(l.unitCost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
      } catch {
        /* a malformed line was already refused in addLine */
      }
    }
    return sum.toString();
  }, [lines]);

  function addLine() {
    if (!itemId || !unitCost.trim()) return;
    // The typed cost (business display unit) → integer Rial text, BigInt-safe.
    let costRial: string;
    try {
      costRial = money.parseText(unitCost);
    } catch {
      onError("بهای هر واحد معتبر نیست.");
      return;
    }
    if (costRial.startsWith("-")) {
      onError("بهای هر واحد معتبر نیست.");
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
      const months = Math.max(0, Math.round(Number(serialWarrantyMonths || 0)));
      serials = parsed.map((serialNumber) => ({ serialNumber, warrantyMonths: months }));
      lineQuantity = String(parsed.length);
    } else {
      const qty = Number(quantity);
      if (!quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
        onError("تعداد باید عددی بزرگ‌تر از صفر باشد.");
        return;
      }
    }
    onError("");
    setLines((prev) => [
      ...prev,
      {
        itemId,
        quantity: lineQuantity,
        unitCost: costRial,
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
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit() {
    // Re-entrancy guard: a second tap while the first request is in flight
    // must not fire a second POST (the disabled button alone is not enough
    // — e.g. keyboard-submit races the re-render).
    if (busy) return;
    if (lines.length === 0) {
      onError("حداقل یک ردیف به فهرست خرید اضافه کنید.");
      return;
    }
    const vatRial = draftVatRial(invoiceDraft, goodsRial, vatPercent, money.parseText);
    if (vatRial === null) {
      onError("مبلغ مالیات بر ارزش افزوده معتبر نیست.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      const { ok, data } = await api<{ error?: string; message?: string }>(
        "/api/stock/purchases",
        {
          method: "POST",
          body: JSON.stringify({
            supplierId: supplierId || null,
            idempotencyKey,
            settlementMethod,
            invoice: supplierInvoicePayload(invoiceDraft, vatRial),
            lines,
          }),
        },
      );
      if (!ok) onError(data.message ?? "ثبت خرید ناموفق بود.");
      else {
        setLines([]);
        setSupplierId("");
        setSettlementMethod("credit");
        setInvoiceDraft(EMPTY_SUPPLIER_INVOICE_DRAFT);
        setIdempotencyKey(crypto.randomUUID());
        onDone(SETTLEMENT_DONE_MESSAGES[settlementMethod]);
      }
    } finally {
      setBusy(false);
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

  /** One line's exact Rial total (text), for display. */
  function lineTotalText(l: { quantity: string; unitCost: string }): string {
    try {
      return new Decimal(l.quantity).times(l.unitCost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
    } catch {
      return "0";
    }
  }

  return (
    <SectionCard title="دریافت خرید" bodyClassName="space-y-3">
      <div className="grid min-w-0 gap-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="تأمین‌کننده">
            <SearchableSelect
              value={supplierId}
              onChange={setSupplierId}
              options={supplierOptions}
            />
          </Field>
          {/* Issue #915 — how the goods are paid decides the posting's credit side. */}
          <Field label="روش تسویه">
            <SearchableSelect
              value={settlementMethod}
              onChange={(v) => setSettlementMethod(v as typeof settlementMethod)}
              options={Object.entries(SETTLEMENT_LABELS).map(([value, label]) => ({ value, label }))}
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
                        {money.formatText(lineTotalText(l))}
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
              جمع فهرست: {money.formatText(goodsRial)}
            </p>
          </div>
        ) : null}
        <SupplierInvoiceFields
          value={invoiceDraft}
          onChange={setInvoiceDraft}
          goodsRial={goodsRial}
          vatPercent={vatPercent}
          purchaseDate={todayIso}
        />
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
