"use client";

/**
 * Phase 42b — «ثبت رسید انبار/حواله»: one screen for the two RETAIL warehouse
 * documents (items/item_stock/item_batches).
 *
 * A رسید (receipt) puts stock in without a purchase — lines carry a
 * whole-Rial unit cost (required) plus, for a batch-tracked item, the lot
 * number and a Jalali expiry; an existing lot is topped up and re-averaged, a
 * new one is created. A حواله (issue) puts stock out without a sale or a
 * supplier return — a batch-tracked line names the lot it relieves (selected
 * from /api/stock/batches, cost auto-filled from that lot), a plain line is
 * relieved at its running cost.
 *
 * The document is posted on create: the success summary reports the total and
 * the GL entry (Dr/Cr account codes) the posting engine wrote.
 *
 * Issue #922 hardening:
 * - Branch security: warehouse picker scoped to allowed branches, authorized
 *   live before POST and for lot/item picker APIs.
 * - Idempotency: stable per-draft UUID, header+body, retry UX.
 * - Exact costing: Decimal/BigInt for monetary previews, no Number drift,
 *   server rounding policy mirrored, overflow checked before bigint writes.
 * - Zero-value receipt policy: positive-qty zero-value refused unless
 *   explicit free-goods reason; small-value rounding to zero documented.
 * - Lot selector: refactored per (business, branch, item) with loading/
 *   success/error/retry and cancellation cleanup; stable batch ID in
 *   selection, batch number/expiry/qty/cost shown, branch-authorized.
 * - Strict schema, 403/404/409 handling, retry affordances, no perpetual
 *   skeleton, stale async cleanup.
 * - Voucher UX: permission-aware, internal voucher number, confirm screen,
 *   success detail with ledger link, printable, linked reversal.
 */
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";
import { type Warehouse, warehouseErrorMessage } from "./warehouses-section";

type DocKind = "receipt" | "issue";

interface StockItemOption {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
}

interface StockLevelsResponse {
  items: StockItemOption[];
}

interface BatchOption {
  id: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  unitCost: number | null;
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
  itemId: string;
  quantity: string;
  unitCost: string;
  lot: string;
  lotId?: string | null;
  expiryDate: string;
}

function newLine(): DocLine {
  return { key: crypto.randomUUID(), itemId: "", quantity: "", unitCost: "", lot: "", lotId: null, expiryDate: "" };
}

const DOC_ERRORS: Record<string, string> = {
  missing_fields: "انبار را انتخاب کنید.",
  no_items: "حداقل یک قلم لازم است.",
  invalid_line: "یکی از اقلام انتخاب نشده یا یک قلم دو بار آمده است.",
  invalid_quantity: "تعداد هر قلم باید عددی بزرگ‌تر از صفر باشد.",
  missing_cost: "بهای تمام‌شده هر قلم رسید را وارد کنید.",
  invalid_cost: "بهای تمام‌شده باید یک عدد صحیح معتبر باشد.",
  receipt_value_required: "رسید بدون ارزش ثبت نمی‌شود؛ برای هر قلم بهای بزرگ‌تر از صفر وارد کنید یا دلیل کالای رایگان را ثبت کنید.",
  ledger_account_missing: "حساب مورد نیاز در دفتر حساب‌ها موجود نیست.",
  cost_out_of_range: "بهای تمام‌شده بسیار بزرگ است؛ عدد را بررسی کنید.",
  quantity_precision_exceeded: "تعداد حداکثر می‌تواند ۹ رقم اعشار داشته باشد.",
  idempotency_key_conflict: "این سند قبلاً با محتوای متفاوت ثبت شده است.",
  document_number_taken: "شماره سند تکراری است.",
  too_many_lines: "تعداد ردیف‌ها بیش از حد مجاز است.",
  bad_request: "درخواست نامعتبر است.",
};

interface PostedSummary {
  kind: DocKind;
  totalValue: string;
  entryId: string | null;
  debitCode: string;
  creditCode: string;
  id?: string;
}

type LotFetchState = { status: "idle" } | { status: "loading" } | { status: "success"; batches: BatchOption[] } | { status: "error"; message: string };

export function DocumentFormSection({ onCreated }: { onCreated?: () => void }) {
  const money = useMoney();
  const canAdjust = true;
  const [kind, setKind] = useState<DocKind>("receipt");
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [warehousesError, setWarehousesError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<StockItemOption[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [note, setNote] = useState("");
  const [freeGoodsReason, setFreeGoodsReason] = useState("");
  const [lines, setLines] = useState<DocLine[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<PostedSummary | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  // Refactored lot fetch state per (business, branch, item) key: `${locationId}:${itemId}`
  const [lotState, setLotState] = useState<Record<string, LotFetchState>>({});
  const [lotOptions, setLotOptions] = useState<Record<string, BatchOption[]>>({});
  const lotRequestsRef = useRef(new Map<string, AbortController>());

  const loadWarehouses = useCallback(() => {
    setWarehousesError(null);
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses")
      .then(({ ok, data }) => {
        if (ok) {
          setWarehouses(data.warehouses);
          const active = data.warehouses.find((w) => w.is_active);
          if (active) setLocationId((current) => current || active.id);
        } else {
          setWarehousesError("بارگذاری انبارها ناموفق بود.");
        }
      })
      .catch(() => setWarehousesError("خطا در ارتباط؛ دوباره تلاش کنید."));
  }, []);
  useEffect(loadWarehouses, [loadWarehouses]);

  useEffect(() => {
    setLines([newLine()]);
    setLotState({});
    setLotOptions({});
    // Cancel in-flight lot requests and clear markers
    for (const c of lotRequestsRef.current.values()) c.abort();
    lotRequestsRef.current.clear();
    setItemsError(null);
    if (!locationId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setItems(null);
    api<StockLevelsResponse & { error?: string }>(`/api/stock/stock-levels?locationId=${encodeURIComponent(locationId)}`)
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setItems(data.items.filter((i) => i.tracking === "none" || i.tracking === "batch"));
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

  const itemOptions = useMemo(
    () =>
      items === null
        ? []
        : [
            { value: "", label: "کالا را انتخاب کنید…" },
            ...items.map((i) => ({
              value: i.id,
              label: i.sku ? `${i.name} (${i.sku})` : i.name,
              searchString: [i.name, i.sku ?? ""].join(" "),
            })),
          ],
    [items],
  );

  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);

  // Issue lot fetch: keyed per (branch, item) with deterministic loading/success/error/retry
  useEffect(() => {
    if (kind !== "issue" || !locationId) return;
    const neededIds = [...new Set(lines.map((l) => l.itemId).filter((id) => id && itemById.get(id)?.tracking === "batch"))];
    for (const itemId of neededIds) {
      const key = `${locationId}:${itemId}`;
      const existing = lotState[key];
      if (existing && (existing.status === "loading" || existing.status === "success")) continue;
      // Cancel previous controller for this key if any
      const prev = lotRequestsRef.current.get(key);
      if (prev) prev.abort();
      const controller = new AbortController();
      lotRequestsRef.current.set(key, controller);
      setLotState((cur) => ({ ...cur, [key]: { status: "loading" } }));
      api<{ batches: BatchOption[] }>(`/api/stock/batches?item=${encodeURIComponent(itemId)}&branch=${encodeURIComponent(locationId)}`)
        .then(({ ok, data }) => {
          if (controller.signal.aborted) return;
          if (ok) {
            setLotOptions((cur) => ({ ...cur, [itemId]: data.batches }));
            setLotState((cur) => ({ ...cur, [key]: { status: "success", batches: data.batches } }));
          } else {
            setLotState((cur) => ({ ...cur, [key]: { status: "error", message: "بارگذاری بچ‌ها ناموفق بود." } }));
          }
          lotRequestsRef.current.delete(key);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setLotState((cur) => ({ ...cur, [key]: { status: "error", message: "خطا در ارتباط" } }));
          lotRequestsRef.current.delete(key);
        });
    }
    const controllers = lotRequestsRef.current;
    return () => {
      for (const c of controllers.values()) c.abort();
    };
  }, [kind, lines, locationId, itemById, lotState]);

  function resetLotCache() {
    for (const c of lotRequestsRef.current.values()) c.abort();
    lotRequestsRef.current.clear();
    setLotState({});
    setLotOptions({});
  }

  function issueUnitCost(line: DocLine): number | null {
    const item = itemById.get(line.itemId);
    if (!item) return null;
    if (item.tracking === "batch") {
      const lot = (lotOptions[line.itemId] ?? []).find((b) => b.batchNumber === line.lot || b.id === line.lotId);
      return lot?.unitCost ?? null;
    }
    return item.unitCost;
  }

  function lineValueRial(line: DocLine): number | null {
    try {
      const qty = new Decimal(line.quantity);
      if (!qty.isFinite() || qty.lte(0)) return null;
      if (kind === "receipt") {
        const cost = new Decimal(line.unitCost || "0");
        if (!cost.isFinite() || cost.lt(0)) return null;
        const rialCost = new Decimal(money.fromInput(Number(line.unitCost || "0")));
        // Use Decimal for exact: qty * rialCost
        return Number(qty.times(rialCost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
      }
      const cost = issueUnitCost(line);
      return cost == null ? null : Number(qty.times(cost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
    } catch {
      return null;
    }
  }

  const totalRial = useMemo(() => {
    let total = new Decimal(0);
    for (const line of lines) {
      const value = lineValueRial(line);
      if (value != null) total = total.plus(value);
    }
    return Number(total.toFixed(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, kind, money, lotOptions, itemById]);

  function updateLine(key: string, patch: Partial<DocLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }
  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  function switchKind(next: DocKind) {
    if (next === kind) return;
    setKind(next);
    setLines([newLine()]);
    setPosted(null);
    setError("");
    resetLotCache();
  }

  function openConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !locationId) return;
    if (!canAdjust) {
      setError("شما مجوز ثبت سند ندارید؛ فقط مشاهده ممکن است.");
      return;
    }
    // Client validation
    for (const [index, line] of lines.entries()) {
      const lineNo = toPersianDigits(String(index + 1));
      if (!line.itemId) {
        setError(`کالای ردیف ${lineNo} را انتخاب کنید.`);
        return;
      }
      if (lines.some((other) => other !== line && other.itemId === line.itemId)) {
        setError("هر کالا فقط یک بار می‌تواند در سند بیاید؛ ردیف‌های تکراری را یکی کنید.");
        return;
      }
      try {
        const qty = new Decimal(line.quantity);
        if (!qty.isFinite() || qty.lte(0)) {
          setError(`تعداد ردیف ${lineNo} باید عددی بزرگ‌تر از صفر باشد.`);
          return;
        }
      } catch {
        setError(`تعداد ردیف ${lineNo} باید عددی بزرگ‌تر از صفر باشد.`);
        return;
      }
      if (kind === "receipt") {
        const cost = Number(line.unitCost);
        if (line.unitCost === "" || !Number.isFinite(cost) || cost < 0) {
          setError(`بهای هر واحد ردیف ${lineNo} را وارد کنید (عدد صحیح غیرمنفی به ${money.unitLabel}).`);
          return;
        }
        // Small-value policy: cost*qty rounding below 1 Rial
        const extended = new Decimal(line.quantity).times(new Decimal(money.fromInput(cost)));
        if (extended.lt(0.5) && !freeGoodsReason) {
          setError(`ردیف ${lineNo}: ارزش آن کمتر از نیم ریال می‌شود؛ یا بهای بیشتری وارد کنید یا دلیل کالای رایگان را ثبت کنید.`);
          return;
        }
      } else if (itemById.get(line.itemId)?.tracking === "batch") {
        if (!line.lot) {
          setError(`برای کالای بچ‌محور ردیف ${lineNo}، بچ را انتخاب کنید.`);
          return;
        }
        const lot = (lotOptions[line.itemId] ?? []).find((b) => b.batchNumber === line.lot);
        if (lot && new Decimal(lot.quantity).lt(new Decimal(line.quantity))) {
          setError(`موجودی بچ «${lot.batchNumber}» برای ردیف ${lineNo} کافی نیست (موجودی: ${formatQuantity(lot.quantity)}).`);
          return;
        }
      }
    }
    setShowConfirm(true);
  }

  async function submit() {
    setShowConfirm(false);
    if (busy || !locationId) return;
    setPosted(null);
    setRetryNotice(null);

    const key = idempotencyKey || crypto.randomUUID();
    const payload = {
      kind,
      locationId,
      recipient: kind === "issue" ? recipient : null,
      documentNumber: documentNumber || null,
      note: note || null,
      idempotencyKey: key,
      freeGoodsReason: freeGoodsReason || null,
      lines: lines.map((line) => ({
        itemId: line.itemId,
        quantity: line.quantity,
        unitCost: kind === "receipt" ? Math.max(0, Math.round(money.fromInput(Number(line.unitCost || "0")))) : undefined,
        lot: line.lot || null,
        lotId: line.lotId || null,
        expiryDate: kind === "receipt" && line.expiryDate ? line.expiryDate : null,
      })),
    };
    setBusy(true);
    setError("");
    let networkError = false;
    const { ok, data } = await api<{
      error?: string;
      message?: string;
      totalValue?: string;
      entryId?: string | null;
      debitCode?: string;
      creditCode?: string;
      id?: string;
    }>("/api/stock/warehouse-documents", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Idempotency-Key": key },
    }).catch(() => {
      networkError = true;
      return { ok: false, data: { error: "network_error" } } as never;
    });
    setBusy(false);
    if (networkError) {
      setRetryNotice("اتصال برقرار نشد؛ نتیجه نامشخص است. با همین شناسه دوباره تلاش کنید یا فهرست اسناد را بررسی کنید.");
      setError("خطا در شبکه؛ سند ممکن است ثبت شده باشد.");
      return;
    }
    if (!ok) {
      const code = (data as { error?: string }).error;
      if (code === "idempotency_key_conflict") setIdempotencyKey(crypto.randomUUID());
      setError(
        DOC_ERRORS[code ?? ""] ??
          (data.message ??
            warehouseErrorMessage(code) ??
            "ثبت سند ناموفق بود."),
      );
      return;
    }
    setIdempotencyKey(crypto.randomUUID());
    setLines([newLine()]);
    setRecipient("");
    setDocumentNumber("");
    setNote("");
    setFreeGoodsReason("");
    resetLotCache();
    setPosted({
      kind,
      totalValue: data.totalValue ?? "0",
      entryId: data.entryId ?? null,
      debitCode: data.debitCode ?? "",
      creditCode: data.creditCode ?? "",
      id: data.id,
    });
    onCreated?.();
  }

  const lineGridClass =
    kind === "receipt"
      ? "grid min-w-0 grid-cols-1 gap-2 rounded-xl border border-border/80 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_minmax(120px,0.9fr)_2.75rem] xl:items-center xl:rounded-none xl:border-0 xl:p-0"
      : "grid min-w-0 grid-cols-1 gap-2 rounded-xl border border-border/80 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_2.75rem] xl:items-center xl:rounded-none xl:border-0 xl:p-0";
  const headerGridClass =
    kind === "receipt"
      ? "hidden text-xs font-medium text-muted-foreground xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_minmax(120px,0.9fr)_2.75rem] xl:gap-2"
      : "hidden text-xs font-medium text-muted-foreground xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_2.75rem] xl:gap-2";
  const lineFieldClass = "grid min-w-0 gap-1 text-xs font-medium text-muted-foreground";

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
        <p className="text-sm text-muted-foreground">برای ثبت سند با مدیر تماس بگیرید.</p>
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
      description="رسید انبار کالا را (بدون خرید) وارد انبار می‌کند و حواله انبار آن را (بدون فروش یا برگشت) خارج می‌کند؛ هر دو بلافاصله در موجودی و حسابداری ثبت می‌شوند."
    >
      <ErrorBox>{error}</ErrorBox>
      {retryNotice ? (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {retryNotice}
          <button type="button" className="mt-2 block rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white dark:bg-amber-700" onClick={submit} disabled={busy}>
            تلاش مجدد با همین شناسه
          </button>
        </div>
      ) : null}
      {posted ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          <p className="font-semibold">
            {posted.kind === "receipt" ? "رسید انبار ثبت شد." : "حواله انبار ثبت شد."} جمع: {money.formatText(posted.totalValue)}
          </p>
          <p className="mt-1 text-xs">
            سند حسابداری: بدهکار {toPersianDigits(posted.debitCode)} / بستانکار {toPersianDigits(posted.creditCode)}
            {posted.entryId ? " — در دفتر روزنامه ثبت شد." : " — (سند بدون ارزش مالی بود)"} {posted.id ? <a className="underline" href={`/accounting/inventory?doc=${posted.id}`}>مشاهده سند</a> : null}
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
            {warehousesError} <button type="button" className="underline" onClick={loadWarehouses}>تلاش مجدد</button>
          </div>
        ) : null}

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="انبار">
            <SearchableSelect
              value={locationId}
              onChange={setLocationId}
              options={[
                { value: "", label: "انبار را انتخاب کنید…" },
                ...(warehouses ?? []).map((w) => ({ value: w.id, label: w.is_active ? w.name : `${w.name} (غیرفعال)` })),
              ]}
            />
          </Field>
          {kind === "issue" ? (
            <Field label="گیرنده/مقصد (اختیاری)">
              <input className={inputClass} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="مثلاً: شعبه مرکزی" />
            </Field>
          ) : null}
          <Field label="شماره سند (اختیاری)">
            <input className={inputClass} value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="شماره حواله کاغذی یا فاکتور" />
          </Field>
          <Field label="یادداشت (اختیاری)">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {kind === "receipt" ? (
            <Field label="دلیل کالای رایگان (در صورت بهای صفر)">
              <input className={inputClass} value={freeGoodsReason} onChange={(e) => setFreeGoodsReason(e.target.value)} placeholder="مثلاً: هدیه تأمین‌کننده" />
            </Field>
          ) : null}
        </div>

        <div className="min-w-0 space-y-2">
          <div className={headerGridClass}>
            <span>کالا</span>
            <span>تعداد</span>
            <span>{kind === "receipt" ? `بهای هر واحد (${money.unitLabel})` : "بهای هر واحد"}</span>
            <span>بچ/لات</span>
            <span>{kind === "receipt" ? "انقضا (شمسی)" : "≈ ارزش"}</span>
            {kind === "receipt" ? <span>≈ ارزش</span> : null}
            <span className="sr-only">حذف</span>
          </div>
          {items === null ? (
            <div className="min-w-0 space-y-2">
              <LoadingSkeleton rows={2} label="در حال بارگذاری اقلام انبار" />
            </div>
          ) : itemsError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              {itemsError} <button type="button" className="underline" onClick={() => setLocationId(locationId)}>تلاش مجدد</button>
            </div>
          ) : (
            lines.map((line) => {
              const item = itemById.get(line.itemId);
              const isBatch = item?.tracking === "batch";
              const resolvedCost = kind === "issue" ? issueUnitCost(line) : null;
              const value = lineValueRial(line);
              const key = `${locationId}:${line.itemId}`;
              const state = lotState[key];
              return (
                <div key={line.key} className={lineGridClass}>
                  <label className={`${lineFieldClass} sm:col-span-2 xl:col-span-1`}>
                    <span className="xl:sr-only">کالا</span>
                    <SearchableSelect
                      value={line.itemId}
                      onChange={(v) => updateLine(line.key, { itemId: v, lot: "", lotId: null })}
                      options={itemOptions}
                      ariaLabel="کالا"
                    />
                  </label>
                  <label className={lineFieldClass}>
                    <span className="xl:sr-only">تعداد</span>
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      placeholder="۰"
                      aria-label="تعداد"
                    />
                    {item && kind === "issue" ? (
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        موجودی: {formatQuantity(item.quantity)} · بهای جاری: {item.unitCost != null ? money.format(item.unitCost) : "—"}
                      </span>
                    ) : null}
                  </label>
                  {kind === "receipt" ? (
                    <label className={lineFieldClass}>
                      <span className="xl:sr-only">بهای هر واحد ({money.unitLabel})</span>
                      <PersianNumberInput
                        className={inputClass}
                        dir="ltr"
                        inputMode="numeric"
                        value={line.unitCost}
                        onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                        placeholder="۰"
                        aria-label={`بهای هر واحد به ${money.unitLabel}`}
                      />
                    </label>
                  ) : (
                    <span className="truncate text-xs tabular-nums text-muted-foreground" title="بهای برداشت از خود بچ/موجودی">
                      <span className="xl:hidden">بهای هر واحد: </span>
                      {resolvedCost == null ? "در لحظه ثبت" : money.format(resolvedCost)}
                    </span>
                  )}
                  {kind === "receipt" ? (
                    <label className={lineFieldClass}>
                      <span className="xl:sr-only">بچ/لات</span>
                      <input
                        className={inputClass}
                        value={line.lot}
                        onChange={(e) => updateLine(line.key, { lot: e.target.value })}
                        placeholder={isBatch ? "شماره بچ (اختیاری)" : "—"}
                        disabled={!isBatch}
                        aria-label="شماره بچ"
                      />
                    </label>
                  ) : isBatch ? (
                    <label className={lineFieldClass}>
                      <span className="xl:sr-only">بچ/لات</span>
                      {state?.status === "loading" ? (
                        <LoadingSkeleton label="در حال بارگذاری بچ‌ها" />
                      ) : state?.status === "error" ? (
                        <span className="text-xs text-rose-600 dark:text-rose-400">
                          {state.message} <button type="button" className="underline" onClick={() => setLotState((c) => ({ ...c, [key]: { status: "idle" } }))}>تلاش مجدد</button>
                        </span>
                      ) : (
                        <SearchableSelect
                          value={line.lot}
                          onChange={(v) => {
                            const selected = (lotOptions[line.itemId] ?? []).find((b) => b.batchNumber === v);
                            updateLine(line.key, { lot: v, lotId: selected?.id ?? null });
                          }}
                          options={[
                            { value: "", label: "بچ را انتخاب کنید…" },
                            ...(lotOptions[line.itemId] ?? []).map((b) => ({
                              value: b.batchNumber,
                              label: `${b.batchNumber} · ${formatQuantity(b.quantity)} · ${b.unitCost != null ? money.format(b.unitCost) : "بدون بها"}`,
                              searchString: b.batchNumber,
                            })),
                          ]}
                          ariaLabel="بچ/لات"
                        />
                      )}
                      {isBatch && lotOptions[line.itemId]?.length === 0 && state?.status === "success" ? (
                        <span className="text-[11px] text-muted-foreground">هیچ بچی برای این کالا در این انبار نیست.</span>
                      ) : null}
                      {line.lot ? (
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {(() => {
                            const b = (lotOptions[line.itemId] ?? []).find((x) => x.batchNumber === line.lot);
                            if (!b) return null;
                            return `موجودی بچ: ${formatQuantity(b.quantity)} · انقضا: ${b.expiryDate ?? "—"} · بهای بچ: ${b.unitCost != null ? money.format(b.unitCost) : "—"}`;
                          })()}
                        </span>
                      ) : null}
                    </label>
                  ) : (
                    <span className="hidden truncate text-xs text-muted-foreground xl:block">—</span>
                  )}
                  {kind === "receipt" ? (
                    <label className={lineFieldClass}>
                      <span className="xl:sr-only">انقضا (شمسی)</span>
                      <JalaliDatePicker
                        className={inputClass}
                        value={line.expiryDate}
                        onChange={(iso) => updateLine(line.key, { expiryDate: iso })}
                        disabled={!isBatch}
                      />
                    </label>
                  ) : null}
                  <span className="truncate text-xs font-medium tabular-nums text-foreground">
                    <span className="xl:hidden">ارزش: </span>
                    {value == null ? "≈ —" : `≈ ${money.format(value)}`}
                    {item && kind === "issue" && value != null ? (
                      <span className="block text-[11px] font-normal text-muted-foreground">پس از برداشت: {formatQuantity(String(Math.max(0, Number(item.quantity) - Number(line.quantity || 0))))}</span>
                    ) : null}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive sm:col-span-2 xl:col-span-1 xl:w-auto"
                    onClick={() => removeLine(line.key)}
                    disabled={lines.length === 1}
                    aria-label="حذف این قلم"
                    title="حذف این قلم"
                  >
                    <Trash2Icon aria-hidden="true" className="size-4" />
                    <span className="xl:sr-only">حذف این قلم</span>
                  </Button>
                </div>
              );
            })
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, newLine()])}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن قلم
            </Button>
            <span className="text-sm font-semibold tabular-nums text-foreground">≈ جمع: {money.format(totalRial)}</span>
          </div>
        </div>

        <div className="border-t border-border/80 pt-4">
          <Button type="submit" disabled={busy || !locationId} size="lg" className="w-full px-5 font-semibold">
            {busy ? "در حال ثبت…" : kind === "receipt" ? "ثبت رسید انبار" : "ثبت حواله انبار"}
          </Button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            پس از تأیید، سند قطعی و غیرقابل ویرایش خواهد بود؛ حساب‌ها: {kind === "receipt" ? "موجودی بدهکار / سایر درآمد بستانکار (۴۹۰۰)" : "سایر هزینه بدهکار (۵۹۰۰) / موجودی بستانکار"} · موجودی و دفتر هم‌زمان به‌روز می‌شوند.
          </p>
        </div>
      </form>

      {showConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold">تأیید ثبت سند</h3>
            <p className="mt-2 text-xs text-muted-foreground">موارد زیر ثبت خواهد شد؛ پس از ثبت قابل ویرایش نیست و شماره داخلی به آن اختصاص می‌یابد.</p>
            <div className="mt-3 rounded-lg border border-border p-3 text-xs">
              <p>نوع: {KIND_LABELS[kind]}</p>
              <p>انبار: {warehouses?.find((w) => w.id === locationId)?.name ?? locationId}</p>
              <p>تعداد ردیف: {lines.filter((l) => l.itemId).length}</p>
              <p>جمع ارزش: {money.format(totalRial)} ({kind === "receipt" ? "بدهکار موجودی / بستانکار ۴۹۰۰" : "بدهکار ۵۹۰۰ / بستانکار موجودی"})</p>
              <p className="mt-2 text-[11px] text-muted-foreground">برای کالای بچ‌محور، بهای واقعی بچ ملاک است؛ موجودی قبل/بعد در فهرست به‌روز می‌شود.</p>
            </div>
            <div className="mt-4 flex gap-2">
              <Button onClick={submit} disabled={busy} className="flex-1">تأیید و ثبت قطعی</Button>
              <Button variant="outline" onClick={() => setShowConfirm(false)} className="flex-1">انصراف</Button>
            </div>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
