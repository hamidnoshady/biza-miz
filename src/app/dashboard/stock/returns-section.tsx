"use client";

/**
 * Issue #918 — the «حواله بازگشت» tab: a first-class return-voucher editor
 * plus the posted vouchers' register.
 *
 * A voucher is purchase-linked by default: the operator picks a received
 * purchase (and thereby its supplier and warehouse), chooses eligible receipt
 * lines, and the editor previews the supplier credit (invoice value) beside
 * the inventory carrying value relieved, with the variance spelled out before
 * the irreversible post. A deliberately purchase-less return names its
 * supplier explicitly instead — there is no default uncategorized AP debit.
 *
 * Kept separate from the warehouse document (حواله انبار) on purpose: a
 * return TO a supplier settles against the supplier, a warehouse issue does
 * not.
 */
import { EyeIcon, PlusIcon, PrinterIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "../ui";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import printStyles from "./returns-print.module.css";

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
  note: string | null;
  receivedAt: string;
  supplierId: string | null;
  supplierName: string | null;
  status: string;
  lineCount: number;
}

interface ReceiptLine {
  purchase_item_id: string;
  item_id: string;
  item_name: string;
  sku: string | null;
  tracking: string;
  quantity_received: string;
  unit_cost: string;
  batch_number: string | null;
  expiry_date: string | null;
  quantity_returned: string;
}

interface AvailableSerial {
  item_id: string;
  serial_id: string;
  serial_number: string;
  unit_cost: string | null;
}

interface PurchaseDetail {
  purchase: {
    id: string;
    supplier_id: string | null;
    supplier_name: string | null;
    status: string;
    location_id: string;
    location_name: string;
    note: string | null;
    total: string;
    received_at: string;
  };
  lines: ReceiptLine[];
  availableSerials: AvailableSerial[];
}

interface BatchOption {
  id: string;
  batchNumber: string;
  expiryDate: string | null;
  manufactureDate: string | null;
  quantity: string;
  unitCost: number | null;
  supplierReference: string | null;
  purchaseId: string | null;
  purchaseReceivedAt: string | null;
  supplierName: string | null;
}

const SETTLEMENT_OPTIONS = [
  {
    value: "accounts_payable",
    label: "کسر از بدهی به تأمین‌کننده",
    hint: "بدهی شما به این تأمین‌کننده کم می‌شود. نیازمند تأمین‌کنندهٔ مشخص است.",
    needsSupplier: true,
  },
  {
    value: "supplier_receivable",
    label: "طلب از تأمین‌کننده",
    hint: "مبلغ برگشت به‌عنوان طلب شما از تأمین‌کننده ثبت می‌شود. نیازمند تأمین‌کنندهٔ مشخص است.",
    needsSupplier: true,
  },
  {
    value: "cash",
    label: "دریافت نقدی",
    hint: "تأمین‌کننده مبلغ برگشت را نقداً برمی‌گرداند.",
    needsSupplier: false,
  },
  {
    value: "bank",
    label: "دریافت بانکی",
    hint: "تأمین‌کننده مبلغ برگشت را به حساب بانکی برمی‌گرداند.",
    needsSupplier: false,
  },
] as const;

type SettlementValue = (typeof SETTLEMENT_OPTIONS)[number]["value"];

const SETTLEMENT_LABELS: Record<string, string> = Object.fromEntries(
  SETTLEMENT_OPTIONS.map((o) => [o.value, o.label]),
);

interface VoucherLine {
  key: string;
  itemId: string;
  batchId: string;
  serialId: string;
  /** Unlinked serial returns: the scanned/typed number (no picker without a purchase). */
  serialNumber: string;
  purchaseItemId: string;
  quantity: string;
}

function newVoucherLine(): VoucherLine {
  return { key: crypto.randomUUID(), itemId: "", batchId: "", serialId: "", serialNumber: "", purchaseItemId: "", quantity: "1" };
}

interface PostedSummary {
  id: string;
  returnNumber: number;
  value: string;
  supplierCredit: string;
  variance: string;
  duplicate: boolean;
}

export function ReturnsSection() {
  // Bumped after every posted voucher so the register re-reads from the
  // server instead of trusting the form's memory of it.
  const [registerReloadKey, setRegisterReloadKey] = useState(0);
  return (
    <div className="space-y-4 sm:space-y-5">
      <ReturnVoucherForm onPosted={() => setRegisterReloadKey((k) => k + 1)} />
      <ReturnRegister reloadKey={registerReloadKey} />
    </div>
  );
}

function ReturnVoucherForm({ onPosted }: { onPosted: () => void }) {
  const money = useMoney();
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [itemsFailed, setItemsFailed] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [listsFailed, setListsFailed] = useState(false);
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [purchaseId, setPurchaseId] = useState("");
  const [purchaseDetail, setPurchaseDetail] = useState<PurchaseDetail | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseFailed, setPurchaseFailed] = useState(false);
  // Bumped after a posted voucher so the receipt's returned/remaining
  // quantities re-read instead of going stale under the next draft.
  const [purchaseReloadKey, setPurchaseReloadKey] = useState(0);
  const [supplierId, setSupplierId] = useState("");
  const [settlement, setSettlement] = useState<SettlementValue | "">("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<VoucherLine[]>([newVoucherLine()]);
  const [batchOptions, setBatchOptions] = useState<Record<string, BatchOption[]>>({});
  const batchRequestsRef = useRef(new Set<string>());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<PostedSummary | null>(null);
  // The stable client submission id: generated once per draft, reused on
  // retry after a timeout or lost response — that reuse is what turns a
  // retried POST into a replay instead of a second voucher.
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  const submitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => submitAbortRef.current?.abort(), []);

  const load = useCallback(() => {
    let cancelled = false;
    setItemsFailed(false);
    setListsFailed(false);
    api<{ items: StockItem[] }>("/api/stock/items").then(({ ok, data }) => {
      if (cancelled) return;
      // The old section left `items === null` (an eternal skeleton) when
      // this fetch failed; a visible error with a retry is the fix.
      setItemsFailed(!ok);
      setItems(ok ? data.items : []);
    });
    api<{ purchases: PurchaseRow[]; suppliers: Supplier[] }>("/api/stock/purchases").then(
      ({ ok, data }) => {
        if (cancelled) return;
        setListsFailed(!ok);
        setPurchases(ok ? data.purchases : []);
        setSuppliers(ok ? data.suppliers : []);
      },
    );
    // Writers hold inventory.adjust; everyone else gets the read-only
    // register further down. The server re-checks on POST regardless.
    api<{ canWrite?: boolean }>("/api/stock/returns?pageSize=1").then(({ ok, data }) => {
      if (!cancelled) setCanWrite(ok ? data.canWrite !== false : false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(load, [load, reloadKey]);

  // The voucher's receipt context: picking a purchase loads its lines with
  // received/previously-returned quantities and resets the voucher lines —
  // a line chosen for another purchase (or for no purchase) does not exist
  // in the new context. A repick flag distinguishes a fresh purchase from a
  // post-success refresh, which must not wipe the new draft's rows.
  const purchaseResetRef = useRef("");
  useEffect(() => {
    if (purchaseResetRef.current !== `${purchaseId}`) {
      purchaseResetRef.current = `${purchaseId}`;
      setLines([newVoucherLine()]);
      setBatchOptions({});
      batchRequestsRef.current = new Set();
      setPosted(null);
      setError("");
    }
    setPurchaseDetail(null);
    setPurchaseFailed(false);
    if (!purchaseId) return;
    let cancelled = false;
    setPurchaseLoading(true);
    api<PurchaseDetail>(`/api/stock/purchases/${encodeURIComponent(purchaseId)}`).then(
      ({ ok, data, aborted }) => {
        if (cancelled || aborted) return;
        setPurchaseLoading(false);
        if (ok) setPurchaseDetail(data);
        else setPurchaseFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [purchaseId, purchaseReloadKey]);

  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const weightCount = useMemo(() => (items ?? []).filter((i) => i.tracking === "weight").length, [items]);
  const itemOptions = useMemo(
    () => [
      { value: "", label: "کالا را انتخاب کنید…" },
      ...(items ?? [])
        .filter((i) => i.tracking !== "weight")
        .map((i) => ({
          value: i.id,
          label: i.sku ? `${i.name} (${i.sku})` : i.name,
          searchString: `${i.name} ${i.sku ?? ""}`,
        })),
    ],
    [items],
  );

  const purchaseOptions = useMemo(
    () => [
      { value: "", label: "بدون خرید مرتبط (برگشت مستقیم)…" },
      ...(purchases ?? [])
        .filter((p) => p.status === "received")
        .map((p) => ({
          value: p.id,
          label: `${p.supplierName ?? "بدون تأمین‌کننده"} · ${formatJalali(p.receivedAt)} · ${money.format(p.total)}`,
          searchString: `${p.supplierName ?? ""} ${p.note ?? ""}`,
        })),
    ],
    [purchases, money],
  );

  const supplierOptions = useMemo(
    () => [
      { value: "", label: "تأمین‌کننده را انتخاب کنید…" },
      ...(suppliers ?? []).map((s) => ({ value: s.id, label: s.name, searchString: s.name })),
    ],
    [suppliers],
  );

  // Batches load once per line item, on demand — the same guarded pattern the
  // warehouse issue form uses, so keystrokes never refire in-flight fetches.
  useEffect(() => {
    const missing = lines
      .map((l) => l.itemId)
      .filter((id) => id && itemById.get(id)?.tracking === "batch" && !batchRequestsRef.current.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    for (const itemId of [...new Set(missing)]) {
      batchRequestsRef.current.add(itemId);
      api<{ batches: BatchOption[] }>(`/api/stock/batches?item=${encodeURIComponent(itemId)}`).then(
        ({ ok, data }) => {
          if (cancelled) return;
          if (ok) setBatchOptions((current) => ({ ...current, [itemId]: data.batches }));
          else batchRequestsRef.current.delete(itemId);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [lines, itemById]);

  const receiptLinesByItem = useMemo(() => {
    const map = new Map<string, ReceiptLine[]>();
    for (const line of purchaseDetail?.lines ?? []) {
      const list = map.get(line.item_id) ?? [];
      list.push(line);
      map.set(line.item_id, list);
    }
    return map;
  }, [purchaseDetail]);

  const serialsByItem = useMemo(() => {
    const map = new Map<string, AvailableSerial[]>();
    for (const s of purchaseDetail?.availableSerials ?? []) {
      const list = map.get(s.item_id) ?? [];
      list.push(s);
      map.set(s.item_id, list);
    }
    return map;
  }, [purchaseDetail]);

  const resolvedSupplierName = purchaseId
    ? (purchaseDetail?.purchase.supplier_name ?? null)
    : (suppliers?.find((s) => s.id === supplierId)?.name ?? null);
  const resolvedSupplierId = purchaseId ? (purchaseDetail?.purchase.supplier_id ?? null) : supplierId || null;
  const settlementNeedsSupplier = SETTLEMENT_OPTIONS.find((o) => o.value === settlement)?.needsSupplier ?? false;

  function batchesForLine(line: VoucherLine): BatchOption[] {
    const all = batchOptions[line.itemId] ?? [];
    // A linked voucher only offers lots received under its own purchase —
    // anything else would be refused as a provenance mismatch on POST.
    if (purchaseId) return all.filter((b) => b.purchaseId === purchaseId);
    return all;
  }

  function receiptLinesForLine(line: VoucherLine): ReceiptLine[] {
    const all = receiptLinesByItem.get(line.itemId) ?? [];
    const item = itemById.get(line.itemId);
    if (item?.tracking === "batch" && line.batchId) {
      const batch = (batchOptions[line.itemId] ?? []).find((b) => b.id === line.batchId);
      if (batch) return all.filter((r) => r.batch_number === batch.batchNumber);
    }
    return all;
  }

  function remainingOf(receipt: ReceiptLine): number {
    return Math.max(0, Number(receipt.quantity_received) - Number(receipt.quantity_returned));
  }

  /** Preview math only — the server re-derives every Rial. */
  function linePreview(line: VoucherLine): { credit: number | null; carrying: number | null } {
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return { credit: null, carrying: null };
    const item = itemById.get(line.itemId);
    if (!item) return { credit: null, carrying: null };
    let carrying: number | null = null;
    if (item.tracking === "none") carrying = item.unitCost == null ? null : qty * item.unitCost;
    else if (item.tracking === "batch") {
      const batch = (batchOptions[line.itemId] ?? []).find((b) => b.id === line.batchId);
      carrying = batch?.unitCost == null ? null : qty * batch.unitCost;
    } else if (item.tracking === "serial") {
      if (purchaseId) {
        const serial = (serialsByItem.get(line.itemId) ?? []).find((s) => s.serial_id === line.serialId);
        carrying = serial?.unit_cost == null ? null : Number(serial.unit_cost);
      } else {
        // Unlinked: the scanned unit's cost basis is known only server-side.
        carrying = null;
      }
    }
    if (!purchaseId) return { credit: carrying, carrying };
    const receipts = receiptLinesForLine(line);
    const receipt = line.purchaseItemId
      ? receipts.find((r) => r.purchase_item_id === line.purchaseItemId)
      : receipts.length === 1
        ? receipts[0]
        : null;
    const credit = receipt ? qty * Number(receipt.unit_cost) : null;
    return { credit, carrying };
  }

  const totals = useMemo(() => {
    let credit = 0;
    let carrying = 0;
    let known = true;
    for (const line of lines) {
      const preview = linePreview(line);
      if (preview.credit == null || preview.carrying == null) {
        known = false;
        continue;
      }
      credit += preview.credit;
      carrying += preview.carrying;
    }
    return { credit, carrying, variance: carrying - credit, known };
    // linePreview closes over fetched lots/receipts; listed explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, batchOptions, purchaseDetail, itemById, purchaseId]);

  function updateLine(key: string, patch: Partial<VoucherLine>) {
    setPosted(null);
    setError("");
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function reselectItem(key: string, itemId: string) {
    // A new item resets the row's lot/serial/receipt choice: those belong to
    // the previous item, and a stale batch id would post a mismatch.
    setPosted(null);
    setError("");
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? { ...line, itemId, batchId: "", serialId: "", serialNumber: "", purchaseItemId: "", quantity: itemById.get(itemId)?.tracking === "serial" ? "1" : line.quantity }
          : line,
      ),
    );
  }

  function removeLine(key: string) {
    setPosted(null);
    setError("");
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  function resetForm() {
    setPurchaseId("");
    setSupplierId("");
    setSettlement("");
    setReason("");
    setLines([newVoucherLine()]);
    setConfirmed(false);
    setPosted(null);
    setError("");
    setDraftKey(crypto.randomUUID());
  }

  async function submit() {
    if (busy || canWrite === false) return;
    // Client-side validation names the row; the server re-checks everything.
    if (purchaseId && purchaseLoading) {
      setError("مشخصات خریدِ مبنا هنوز در حال بارگذاری است؛ لحظه‌ای صبر کنید.");
      return;
    }
    if (purchaseId && (purchaseFailed || !purchaseDetail)) {
      setError("مشخصات خریدِ مبنا بارگذاری نشد؛ خرید دیگری انتخاب کنید یا دوباره تلاش کنید.");
      return;
    }
    if (!purchaseId && !supplierId && SETTLEMENT_OPTIONS.find((o) => o.value === settlement)?.needsSupplier) {
      setError("برای این روش تسویه، تأمین‌کننده را مشخص کنید.");
      return;
    }
    if (purchaseId && purchaseDetail?.purchase.supplier_id == null && settlementNeedsSupplier) {
      setError("خریدِ انتخاب‌شده تأمین‌کننده ندارد؛ تسویه از بدهی/طلب تأمین‌کننده برای آن ممکن نیست.");
      return;
    }
    if (!settlement) {
      setError("روش تسویه را انتخاب کنید.");
      return;
    }
    if (!reason.trim()) {
      setError("دلیل برگشت را بنویسید.");
      return;
    }
    for (const [index, line] of lines.entries()) {
      const lineNo = toPersianDigits(String(index + 1));
      const item = itemById.get(line.itemId);
      if (!item) {
        setError(`کالای ردیف ${lineNo} را انتخاب کنید.`);
        return;
      }
      if (item.tracking === "serial") {
        if (purchaseId && !line.serialId) {
          setError(`دستگاه ردیف ${lineNo} را از فهرست سریال‌های این خرید انتخاب کنید.`);
          return;
        }
        if (!purchaseId && !line.serialNumber.trim()) {
          setError(`شماره سریال دستگاه ردیف ${lineNo} را وارد کنید (برگشت سریالی دستگاه‌به‌دستگاه است).`);
          return;
        }
      }
      if (item.tracking === "batch" && !line.batchId) {
        setError(`برای کالای بچ‌محور ردیف ${lineNo}، بچ را انتخاب کنید.`);
        return;
      }
      if (purchaseId) {
        const receipts = receiptLinesForLine(line);
        if (receipts.length === 0) {
          setError(`کالای ردیف ${lineNo} در خریدِ انتخاب‌شده وجود ندارد.`);
          return;
        }
        if (receipts.length > 1 && !line.purchaseItemId) {
          setError(`کالای ردیف ${lineNo} در این خرید چند قلم دارد؛ قلم دقیق خرید را مشخص کنید.`);
          return;
        }
      }
      const qty = Number(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`تعداد ردیف ${lineNo} باید عددی بزرگ‌تر از صفر باشد.`);
        return;
      }
    }
    if (!confirmed) {
      setError("ثبت حواله قطعی و غیرقابل ویرایش است؛ برای ادامه، تأیید نهایی را علامت بزنید.");
      return;
    }

    const controller = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = controller;
    setBusy(true);
    setError("");
    setPosted(null);
    const { ok, data, aborted } = await api<{
      error?: string;
      message?: string;
      id?: string;
      value?: string;
      supplierCredit?: string;
      variance?: string;
      returnNumber?: number;
      duplicate?: boolean;
    }>("/api/stock/returns", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        purchaseId: purchaseId || null,
        supplierId: purchaseId ? null : supplierId || null,
        settlementMethod: settlement,
        reason: reason.trim(),
        idempotencyKey: draftKey,
        lines: lines.map((line) => ({
          itemId: line.itemId,
          quantity: line.quantity.trim(),
          batchId: line.batchId || null,
          serialId: line.serialId || null,
          serialNumber: line.serialNumber.trim() || null,
          purchaseItemId: line.purchaseItemId || null,
        })),
      }),
    });
    if (aborted || controller.signal.aborted) return;
    submitAbortRef.current = null;
    setBusy(false);
    if (!ok) {
      // The server's Persian message when it has one, else the shared map —
      // never a raw code, never Postgres internals.
      setError(data.message ?? errorMessage(data.error));
      return;
    }
    setPosted({
      id: data.id ?? "",
      returnNumber: data.returnNumber ?? 0,
      value: data.value ?? "0",
      supplierCredit: data.supplierCredit ?? "0",
      variance: data.variance ?? "0",
      duplicate: data.duplicate ?? false,
    });
    // A posted draft is spent: the next voucher gets a fresh key so it can
    // never replay this one. The receipt context re-reads so its
    // returned/remaining quantities include the voucher just posted.
    setDraftKey(crypto.randomUUID());
    setLines([newVoucherLine()]);
    setReason("");
    setConfirmed(false);
    setPurchaseReloadKey((k) => k + 1);
    onPosted();
    load();
  }

  if (items === null || suppliers === null || purchases === null || canWrite === null) {
    return <SectionCardSkeleton rows={6} label="در حال بارگذاری فرم حواله بازگشت" />;
  }

  if (canWrite === false) {
    return (
      <SectionCard title="حواله بازگشت جدید">
        <InfoBox>ثبت حواله بازگشت نیازمند دسترسی «اصلاح انبار» است؛ دفتر حواله‌های ثبت‌شده را در ادامه می‌بینید.</InfoBox>
      </SectionCard>
    );
  }

  if (itemsFailed || listsFailed) {
    return (
      <SectionCard title="حواله بازگشت جدید">
        <EmptyState>
          <span className="block">دریافت اطلاعات لازم برای فرم (کالاها، خریدها، تأمین‌کنندگان) ناموفق بود.</span>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            تلاش دوباره
          </Button>
        </EmptyState>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="حواله بازگشت جدید"
      description="برگشت کالا به تأمین‌کننده با تسویهٔ مشخص. ثبت قطعی است و قابل ویرایش یا حذف نیست."
    >
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="خرید مبنا" hint="خرید دریافت‌شده‌ای که این کالا از آن آمده است.">
            <SearchableSelect
              value={purchaseId}
              onChange={setPurchaseId}
              options={purchaseOptions}
              placeholder="انتخاب خرید…"
              searchPlaceholder="جستجوی خرید…"
              ariaLabel="انتخاب خرید مبنا برای برگشت"
            />
          </Field>
          {!purchaseId ? (
            <Field label="تأمین‌کننده" hint="برگشت بدون خرید، تأمین‌کنندهٔ صریح می‌خواهد.">
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                options={supplierOptions}
                placeholder="انتخاب تأمین‌کننده…"
                searchPlaceholder="جستجوی تأمین‌کننده…"
                ariaLabel="انتخاب تأمین‌کننده برای برگشت مستقیم"
              />
            </Field>
          ) : (
            <Field label="تأمین‌کننده و انبار خرید">
              <div className={`${inputClass} flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1`} aria-live="polite">
                {purchaseLoading ? (
                  <span className="inline-block h-4 w-40 animate-pulse rounded bg-muted" role="status" aria-label="در حال خواندن مشخصات خرید" />
                ) : purchaseDetail ? (
                  <>
                    <span className="font-medium">{purchaseDetail.purchase.supplier_name ?? "بدون تأمین‌کننده"}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{purchaseDetail.purchase.location_name}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{formatJalali(purchaseDetail.purchase.received_at)}</span>
                  </>
                ) : (
                  <span className="text-destructive">بارگذاری نشد.</span>
                )}
              </div>
            </Field>
          )}
        </div>

        {!purchaseId ? (
          <InfoBox>
            برگشت مستقیم (بدون خرید مرتبط) فقط برای کالایی است که سابقهٔ خرید ثبت‌شده ندارد؛ تأمین‌کننده و تسویه صریح می‌خواهد و
            اعتبار تأمین‌کننده برابر بهای تمام‌شدهٔ خارج‌شده ثبت می‌شود.
          </InfoBox>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="روش تسویه" hint={SETTLEMENT_OPTIONS.find((o) => o.value === settlement)?.hint}>
            <SearchableSelect
              value={settlement}
              onChange={(v) => {
                setSettlement(v as SettlementValue | "");
                setPosted(null);
                setError("");
              }}
              options={[
                { value: "", label: "روش تسویه را انتخاب کنید…" },
                ...SETTLEMENT_OPTIONS.filter((o) => !o.needsSupplier || resolvedSupplierId != null).map((o) => ({
                  value: o.value,
                  label: o.label,
                  searchString: o.label,
                })),
              ]}
              ariaLabel="انتخاب روش تسویه برگشت"
            />
          </Field>
          <Field label="دلیل برگشت" hint="مثلاً: کالای معیوب، مغایرت با سفارش، انقضای نزدیک">
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setPosted(null);
                setError("");
              }}
              placeholder="دلیل را بنویسید…"
              maxLength={500}
            />
          </Field>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">اقلام برگشت</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPosted(null);
                setError("");
                setLines((current) => [...current, newVoucherLine()]);
              }}
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن ردیف
            </Button>
          </div>

          {weightCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {toPersianDigits(weightCount)} کالای وزنی در فهرست کالا پنهان است: برگشت طلای وزنی از مسیر وزن/عیار همان کالا ثبت
              می‌شود، نه از حواله بازگشت.
            </p>
          ) : null}

          {lines.map((line, index) => {
            const item = itemById.get(line.itemId);
            const isSerial = item?.tracking === "serial";
            const isBatch = item?.tracking === "batch";
            const receipts = purchaseId ? receiptLinesForLine(line) : [];
            const serials = serialsByItem.get(line.itemId) ?? [];
            const preview = linePreview(line);
            return (
              <div key={line.key} className="space-y-2 rounded-xl border border-border/80 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">ردیف {toPersianDigits(String(index + 1))}</span>
                  {lines.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeLine(line.key)}
                      aria-label={`حذف ردیف ${index + 1}`}
                    >
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="کالا">
                    <SearchableSelect
                      value={line.itemId}
                      onChange={(v) => reselectItem(line.key, v)}
                      options={itemOptions}
                      placeholder="انتخاب کالا…"
                      searchPlaceholder="جستجوی کالا…"
                      ariaLabel={`کالای ردیف ${index + 1}`}
                    />
                  </Field>
                  {isBatch ? (
                    <Field label="بچ / لات" hint="لاتِ خارج‌شونده با بهای خودش خارج می‌شود.">
                      <SearchableSelect
                        value={line.batchId}
                        onChange={(v) => updateLine(line.key, { batchId: v, purchaseItemId: "" })}
                        options={[
                          { value: "", label: "بچ را انتخاب کنید…" },
                          ...batchesForLine(line).map((b) => ({
                            value: b.id,
                            label: `${b.batchNumber} · موجودی ${formatQuantity(b.quantity)}${b.unitCost != null ? ` · ${money.format(b.unitCost)}` : " · بهای نامشخص"}`,
                            searchString: `${b.batchNumber} ${b.supplierName ?? ""} ${b.supplierReference ?? ""}`,
                          })),
                        ]}
                        placeholder="انتخاب بچ…"
                        searchPlaceholder="جستجوی بچ…"
                        ariaLabel={`بچ ردیف ${index + 1}`}
                      />
                    </Field>
                  ) : null}
                  {isSerial && purchaseId ? (
                    <Field label="دستگاه" hint="برگشت سریالی دستگاه‌به‌دستگاه است؛ فقط واحد موجود در انبار.">
                      <SearchableSelect
                        value={line.serialId}
                        onChange={(v) => updateLine(line.key, { serialId: v })}
                        options={[
                          { value: "", label: serials.length === 0 ? "سریال درانباری از این خرید نیست…" : "دستگاه را انتخاب کنید…" },
                          ...serials.map((s) => ({
                            value: s.serial_id,
                            label: `${s.serial_number}${s.unit_cost != null ? ` · ${money.formatText(s.unit_cost)}` : ""}`,
                            searchString: s.serial_number,
                          })),
                        ]}
                        placeholder="انتخاب دستگاه…"
                        searchPlaceholder="جستجوی سریال…"
                        ariaLabel={`دستگاه ردیف ${index + 1}`}
                      />
                    </Field>
                  ) : null}
                  {isSerial && !purchaseId ? (
                    <Field label="شماره سریال دستگاه" hint="سریال دقیق واحدی که برمی‌گردد؛ باید در انبار باشد.">
                      <input
                        className={inputClass}
                        dir="ltr"
                        value={line.serialNumber}
                        onChange={(e) => updateLine(line.key, { serialNumber: e.target.value })}
                        placeholder="SN-…"
                      />
                    </Field>
                  ) : null}
                  {purchaseId && receipts.length > 1 ? (
                    <Field label="قلم خرید" hint="این کالا در خرید مبنا چند قلم دارد؛ قلم دقیق را مشخص کنید.">
                      <SearchableSelect
                        value={line.purchaseItemId}
                        onChange={(v) => updateLine(line.key, { purchaseItemId: v })}
                        options={[
                          { value: "", label: "قلم خرید را انتخاب کنید…" },
                          ...receipts.map((r) => ({
                            value: r.purchase_item_id,
                            label: `دریافت ${formatQuantity(r.quantity_received)} · برگشت‌پذیر ${formatQuantity(String(remainingOf(r)))} · ${money.formatText(r.unit_cost)}`,
                            searchString: `${r.batch_number ?? ""}`,
                          })),
                        ]}
                        ariaLabel={`قلم خرید ردیف ${index + 1}`}
                      />
                    </Field>
                  ) : null}
                  <Field
                    label="تعداد"
                    hint={
                      isSerial
                        ? "برای کالای سریالی همیشه ۱ است."
                        : purchaseId && receipts.length === 1
                          ? `دریافت ${formatQuantity(receipts[0].quantity_received)} · قبلاً برگشت ${formatQuantity(receipts[0].quantity_returned)} · برگشت‌پذیر ${formatQuantity(String(remainingOf(receipts[0])))}`
                          : item
                            ? `موجودی انبار: ${formatQuantity(item.quantity)}`
                            : undefined
                    }
                  >
                    <PersianNumberInput
                      inputMode="decimal"
                      allowNegative={false}
                      className={inputClass}
                      dir="ltr"
                      value={isSerial ? "1" : line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      disabled={isSerial}
                      aria-label={`تعداد ردیف ${index + 1}`}
                    />
                  </Field>
                </div>
                {item && (preview.credit != null || preview.carrying != null) ? (
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    پیش‌نمایش: اعتبار تأمین‌کننده{" "}
                    {preview.credit != null ? money.format(Math.round(preview.credit)) : "نامشخص"} · بهای خارج‌شده از انبار{" "}
                    {preview.carrying != null ? money.format(Math.round(preview.carrying)) : "نامشخص"}
                    {preview.credit != null && preview.carrying != null && Math.round(preview.carrying - preview.credit) !== 0 ? (
                      <> · مغایرت {money.format(Math.round(preview.carrying - preview.credit))}</>
                    ) : null}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {totals.known && (totals.credit > 0 || totals.carrying > 0) ? (
          <div className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm" aria-live="polite">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                اعتبار تأمین‌کننده: <strong>{money.format(Math.round(totals.credit))}</strong>
              </span>
              <span>
                بهای خارج‌شده از انبار: <strong>{money.format(Math.round(totals.carrying))}</strong>
              </span>
              {Math.round(totals.variance) !== 0 ? (
                <span>
                  مغایرت بها:{" "}
                  <strong>
                    {money.format(Math.round(totals.variance))} (
                    {totals.variance > 0 ? "زیان — سایر هزینه‌ها" : "سود — سایر درآمدها"})
                  </strong>
                </span>
              ) : (
                <span className="text-muted-foreground">بدون مغایرت بها</span>
              )}
            </div>
          </div>
        ) : null}

        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-amber-600"
            checked={confirmed}
            onChange={(e) => {
              setConfirmed(e.target.checked);
              setPosted(null);
              setError("");
            }}
          />
          <span>
            تأیید می‌کنم این حواله قطعی است؛ پس از ثبت قابل ویرایش یا حذف نیست و هر اصلاحی فقط با عملیات معکوسِ جداگانه انجام
            می‌شود.
          </span>
        </label>

        <ErrorBox>{error}</ErrorBox>
        {posted ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
            {posted.duplicate
              ? "این ارسال قبلاً ثبت شده بود؛ همان حواله برگردانده شد (ارسال تکراری اثر دوباره ندارد)."
              : "حواله بازگشت ثبت و تسویه پست شد."}{" "}
            شماره حواله {toPersianDigits(String(posted.returnNumber))} · اعتبار تأمین‌کننده{" "}
            {money.formatText(posted.supplierCredit)} · بهای خارج‌شده {money.formatText(posted.value)}
            {posted.variance !== "0" ? <> · مغایرت {money.formatText(posted.variance.startsWith("-") ? posted.variance.slice(1) : posted.variance)}</> : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => void submit()} className="min-h-11 flex-1 sm:flex-none sm:px-8">
            {busy ? "در حال ثبت…" : "ثبت قطعی حواله بازگشت"}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={resetForm} className="min-h-11">
            فرم جدید
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

interface ReturnRow {
  id: string;
  return_number: string;
  purchase_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  location_id: string;
  location_name: string;
  settlement_method: string;
  total_value_rial: string;
  supplier_credit_rial: string;
  variance_rial: string;
  reason: string;
  status: string;
  created_at: string;
  created_by_name: string | null;
  line_count: number;
}

interface ReturnDetailResponse {
  document: ReturnRow & {
    purchase_note: string | null;
    purchase_received_at: string | null;
  };
  lines: {
    id: string;
    item_id: string;
    item_name: string;
    tracking: string;
    batch_id: string | null;
    batch_number: string | null;
    expiry_date: string | null;
    serial_id: string | null;
    serial_number: string | null;
    purchase_item_id: string | null;
    purchase_unit_cost: string | null;
    quantity: string;
    value_rial: string;
    supplier_credit_rial: string;
  }[];
  journal: {
    id: string;
    entry_date: string;
    memo: string | null;
    lines: { account_code: string; account_name: string; debit: string; credit: string }[];
  } | null;
}

function ReturnRegister({ reloadKey }: { reloadKey: number }) {
  const money = useMoney();
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [settlement, setSettlement] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReturnDetailResponse | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const detailRequestRef = useRef<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  // The voucher being printed: portalled onto <body> as the print sheet
  // (the platform's print pattern — globals.css hides the app on paper),
  // then window.print, then cleared on afterprint.
  const [printData, setPrintData] = useState<ReturnDetailResponse | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  useEffect(() => {
    if (!printData) return;
    const clear = () => setPrintData(null);
    const timer = window.setTimeout(() => window.print(), 60);
    window.addEventListener("afterprint", clear);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", clear);
    };
  }, [printData]);

  useEffect(() => {
    api<{ suppliers: Supplier[] }>("/api/stock/purchases").then(({ ok, data }) => {
      if (ok) setSuppliers(data.suppliers);
    });
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearchQuery(search.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", "20");
    if (settlement) params.set("settlement", settlement);
    if (supplierId) params.set("supplierId", supplierId);
    if (searchQuery) params.set("search", searchQuery);
    setLoadFailed(false);
    api<{ returns: ReturnRow[]; total: number }>(`/api/stock/returns?${params.toString()}`).then(
      ({ ok, data, aborted }) => {
        if (cancelled || aborted) return;
        setLoadFailed(!ok);
        setRows(ok ? data.returns : []);
        setTotal(ok ? data.total : 0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [page, settlement, supplierId, searchQuery, reloadKey, retryKey]);

  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailFailed(false);
    detailRequestRef.current = id;
    api<ReturnDetailResponse>(`/api/stock/returns/${encodeURIComponent(id)}`).then(({ ok, data }) => {
      if (detailRequestRef.current !== id) return;
      if (ok) setDetail(data);
      else setDetailFailed(true);
    });
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / 20));

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    try {
      // The whole filtered register, not just the visible page.
      const collected: ReturnRow[] = [];
      let exportPage = 1;
      for (;;) {
        const params = new URLSearchParams();
        params.set("page", String(exportPage));
        params.set("pageSize", "100");
        if (settlement) params.set("settlement", settlement);
        if (supplierId) params.set("supplierId", supplierId);
        if (searchQuery) params.set("search", searchQuery);
        const { ok, data } = await api<{ returns: ReturnRow[]; total: number }>(
          `/api/stock/returns?${params.toString()}`,
        );
        if (!ok) throw new Error("export_failed");
        collected.push(...data.returns);
        if (collected.length >= data.total || data.returns.length === 0 || exportPage >= 50) break;
        exportPage += 1;
      }
      const cell = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
      const csv = [
        "شماره,تاریخ,تأمین‌کننده,خرید مبنا,انبار,روش تسویه,اعتبار تأمین‌کننده (ریال),بهای خارج‌شده (ریال),مغایرت (ریال),ثبت‌کننده,دلیل",
        ...collected.map((r) =>
          [
            r.return_number,
            formatJalali(r.created_at),
            cell(r.supplier_name),
            r.purchase_id ? "خرید مرتبط" : "مستقیم",
            cell(r.location_name),
            SETTLEMENT_LABELS[r.settlement_method] ?? r.settlement_method,
            r.supplier_credit_rial,
            r.total_value_rial,
            r.variance_rial,
            cell(r.created_by_name),
            cell(r.reason),
          ].join(","),
        ),
      ].join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = "return-vouchers.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(anchor.href);
    } catch {
      setExportError("تهیهٔ خروجی ناموفق بود؛ دوباره تلاش کنید.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="دفتر حواله‌های بازگشت"
        description="حواله‌های ثبت‌شده با تأمین‌کننده، خرید مبنا، انبار، مبلغ و روش تسویه. برای جزئیات، سند و چاپ، یک ردیف را باز کنید."
        actions={
          <Button type="button" variant="outline" size="sm" disabled={exporting || (rows?.length ?? 0) === 0} onClick={() => void exportCsv()}>
            {exporting ? "در حال تهیه…" : "خروجی CSV"}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-56">
            <SearchableSelect
              value={settlement}
              onChange={(v) => {
                setSettlement(v);
                setPage(1);
              }}
              options={[
                { value: "", label: "همهٔ روش‌های تسویه" },
                ...SETTLEMENT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
              ]}
              ariaLabel="فیلتر بر اساس روش تسویه"
            />
          </div>
          <div className="w-full sm:w-56">
            <SearchableSelect
              value={supplierId}
              onChange={(v) => {
                setSupplierId(v);
                setPage(1);
              }}
              options={[
                { value: "", label: "همهٔ تأمین‌کنندگان" },
                ...suppliers.map((s) => ({ value: s.id, label: s.name, searchString: s.name })),
              ]}
              ariaLabel="فیلتر بر اساس تأمین‌کننده"
            />
          </div>
          <div className="relative w-full sm:w-64">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" />
            <input
              className={`${inputClass} ps-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجوی شماره / تأمین‌کننده / دلیل"
              aria-label="جستجوی حواله‌ها"
            />
          </div>
        </div>
        {exportError ? <p className="mt-2 text-xs text-destructive">{exportError}</p> : null}
      </SectionCard>

      <SectionCard flush>
        {rows === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={5} label="در حال بارگذاری حواله‌های بازگشت" />
          </div>
        ) : loadFailed ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              <span className="block">دریافت حواله‌ها ناموفق بود.</span>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setRetryKey((k) => k + 1)}>
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </EmptyState>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {settlement || supplierId || searchQuery
                ? "حواله‌ای با این فیلترها پیدا نشد."
                : "هنوز حواله بازگشتی ثبت نشده است. از فرم بالا اولین حواله را ثبت کنید."}
            </EmptyState>
          </div>
        ) : (
          <DataTable caption="حواله‌های بازگشت به تأمین‌کننده" tableClassName="min-w-[880px]">
            <DataTableHead>
              <Th>شماره</Th>
              <Th>تاریخ</Th>
              <Th>تأمین‌کننده</Th>
              <Th>خرید مبنا</Th>
              <Th>انبار</Th>
              <Th numeric>اعتبار</Th>
              <Th>تسویه</Th>
              <Th className="text-end">جزئیات</Th>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow
                  key={row.id}
                  onClick={() => openDetail(row.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDetail(row.id);
                    }
                  }}
                >
                  <Td nowrap className="tabular-nums">{toPersianDigits(row.return_number)}</Td>
                  <Td nowrap className="tabular-nums">{formatJalali(row.created_at)}</Td>
                  <Td>{row.supplier_name ?? "—"}</Td>
                  <Td>{row.purchase_id ? "خرید مرتبط" : "مستقیم"}</Td>
                  <Td>{row.location_name}</Td>
                  <Td numeric nowrap>{money.formatText(row.supplier_credit_rial)}</Td>
                  <Td>
                    <StatusBadge tone={row.settlement_method === "accounts_payable" ? "neutral" : "active"}>
                      {SETTLEMENT_LABELS[row.settlement_method] ?? row.settlement_method}
                    </StatusBadge>
                  </Td>
                  <Td className="text-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(row.id);
                      }}
                      aria-label={`جزئیات حواله ${toPersianDigits(row.return_number)}`}
                      title="جزئیات حواله"
                    >
                      <EyeIcon aria-hidden="true" className="size-4" />
                    </Button>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        {rows !== null && !loadFailed && total > 0 ? (
          <div className="flex items-center justify-between gap-2 border-t border-border/80 px-4 py-3 text-xs text-muted-foreground">
            <span>
              صفحهٔ {toPersianDigits(String(page))} از {toPersianDigits(String(pageCount))} ·{" "}
              {toPersianDigits(String(total))} حواله
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                قبلی
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                بعدی
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <Dialog
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            detailRequestRef.current = null;
          }
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>جزئیات حواله بازگشت</DialogTitle>
            <DialogDescription>
              {detail ? (
                <>
                  حوالهٔ {toPersianDigits(detail.document.return_number)} · {formatJalali(detail.document.created_at, { withTime: true })}
                </>
              ) : (
                "در حال بارگذاری…"
              )}
            </DialogDescription>
          </DialogHeader>
          {detailFailed ? (
            <EmptyState>دریافت جزئیات حواله ناموفق بود؛ پنجره را ببندید و دوباره تلاش کنید.</EmptyState>
          ) : !detail ? (
            <LoadingSkeleton rows={6} label="در حال بارگذاری جزئیات حواله" />
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">تأمین‌کننده</dt>
                  <dd className="font-medium">{detail.document.supplier_name ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">خرید مبنا</dt>
                  <dd className="font-medium">
                    {detail.document.purchase_id
                      ? `خرید ${formatJalali(detail.document.purchase_received_at ?? detail.document.created_at)}`
                      : "مستقیم (بدون خرید)"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">انبار</dt>
                  <dd className="font-medium">{detail.document.location_name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">روش تسویه</dt>
                  <dd className="font-medium">{SETTLEMENT_LABELS[detail.document.settlement_method] ?? detail.document.settlement_method}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">ثبت‌کننده</dt>
                  <dd className="font-medium">{detail.document.created_by_name ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">وضعیت</dt>
                  <dd className="font-medium">{detail.document.status === "reversed" ? "برگشت‌خورده" : "ثبت‌شده (قطعی)"}</dd>
                </div>
              </dl>
              <p className="text-sm">
                <span className="text-xs text-muted-foreground">دلیل: </span>
                {detail.document.reason}
              </p>

              <DataTable caption="اقلام حواله" tableClassName="min-w-[640px]">
                <DataTableHead>
                  <Th>کالا</Th>
                  <Th>بچ / سریال</Th>
                  <Th numeric>تعداد</Th>
                  <Th numeric>اعتبار تأمین‌کننده</Th>
                  <Th numeric>بهای خارج‌شده</Th>
                </DataTableHead>
                <DataTableBody>
                  {detail.lines.map((line) => (
                    <DataTableRow key={line.id}>
                      <Td>{line.item_name}</Td>
                      <Td dir="ltr" className="text-start">
                        {line.batch_number ?? line.serial_number ?? "—"}
                        {line.expiry_date ? <span className="text-xs text-muted-foreground"> · انقضا {formatJalali(line.expiry_date)}</span> : null}
                      </Td>
                      <Td numeric>{formatQuantity(line.quantity)}</Td>
                      <Td numeric nowrap>{money.formatText(line.supplier_credit_rial)}</Td>
                      <Td numeric nowrap>{money.formatText(line.value_rial)}</Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl bg-muted/40 p-3 text-sm">
                <span>
                  جمع اعتبار تأمین‌کننده: <strong>{money.formatText(detail.document.supplier_credit_rial)}</strong>
                </span>
                <span>
                  جمع بهای خارج‌شده: <strong>{money.formatText(detail.document.total_value_rial)}</strong>
                </span>
                <span>
                  مغایرت بها:{" "}
                  <strong>
                    {detail.document.variance_rial === "0"
                      ? "بدون مغایرت"
                      : money.formatText(
                          detail.document.variance_rial.startsWith("-")
                            ? detail.document.variance_rial.slice(1)
                            : detail.document.variance_rial,
                        )}
                  </strong>
                </span>
              </div>

              {detail.journal ? (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold">سند حسابداری مرتبط</h4>
                  <p className="text-xs text-muted-foreground">
                    {formatJalali(detail.journal.entry_date)} · {detail.journal.memo ?? ""}
                  </p>
                  <DataTable caption="آرتیکل‌های سند حواله" tableClassName="min-w-[520px]">
                    <DataTableHead>
                      <Th>حساب</Th>
                      <Th numeric>بدهکار</Th>
                      <Th numeric>بستانکار</Th>
                    </DataTableHead>
                    <DataTableBody>
                      {detail.journal.lines.map((line, i) => (
                        <DataTableRow key={`${line.account_code}-${i}`}>
                          <Td>
                            <span className="tabular-nums" dir="ltr">{toPersianDigits(line.account_code)}</span>{" "}
                            {line.account_name}
                          </Td>
                          <Td numeric nowrap>{money.formatText(line.debit)}</Td>
                          <Td numeric nowrap>{money.formatText(line.credit)}</Td>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">این حواله سند حسابداری ندارد (ارزش صفر).</p>
              )}

              <p className="text-xs text-muted-foreground">
                حوالهٔ ثبت‌شده قابل ویرایش نیست؛ هر اصلاحی فقط با عملیات معکوسِ جداگانه و حسابرسی‌شده انجام می‌شود.
              </p>

              <div className="flex justify-end">
                <Button type="button" variant="outline" size="sm" onClick={() => setPrintData(detail)}>
                  <PrinterIcon aria-hidden="true" className="size-4" />
                  چاپ / PDF
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {portalReady && printData
        ? createPortal(
            <div id="print-sheet-root" className={printStyles.sheet} aria-hidden="true">
              <header>
                <h1>حواله بازگشت به تأمین‌کننده</h1>
                <p>
                  شماره {toPersianDigits(printData.document.return_number)} ·{" "}
                  {toPersianDigits(formatJalali(printData.document.created_at, { withMonthName: true, withTime: true }))}
                </p>
                <p>
                  تأمین‌کننده: {printData.document.supplier_name ?? "—"} · انبار: {printData.document.location_name} · تسویه:{" "}
                  {SETTLEMENT_LABELS[printData.document.settlement_method] ?? printData.document.settlement_method}
                </p>
                <p>
                  خرید مبنا:{" "}
                  {printData.document.purchase_id
                    ? toPersianDigits(formatJalali(printData.document.purchase_received_at ?? printData.document.created_at))
                    : "مستقیم (بدون خرید)"}{" "}
                  · دلیل: {printData.document.reason}
                </p>
              </header>
              <table>
                <thead>
                  <tr>
                    <th>کالا</th>
                    <th>بچ / سریال</th>
                    <th>تعداد</th>
                    <th>اعتبار تأمین‌کننده (ریال)</th>
                    <th>بهای خارج‌شده (ریال)</th>
                  </tr>
                </thead>
                <tbody>
                  {printData.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.item_name}</td>
                      <td>{line.batch_number ?? line.serial_number ?? "—"}</td>
                      <td className={printStyles.num}>{formatQuantity(line.quantity)}</td>
                      <td className={printStyles.num}>{toPersianDigits(line.supplier_credit_rial)}</td>
                      <td className={printStyles.num}>{toPersianDigits(line.value_rial)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                جمع اعتبار: {toPersianDigits(printData.document.supplier_credit_rial)} ریال · جمع بهای خارج‌شده:{" "}
                {toPersianDigits(printData.document.total_value_rial)} ریال · مغایرت:{" "}
                {toPersianDigits(printData.document.variance_rial)} ریال
              </p>
              {printData.journal ? (
                <>
                  <h2>سند حسابداری</h2>
                  <table>
                    <thead>
                      <tr>
                        <th>حساب</th>
                        <th>بدهکار (ریال)</th>
                        <th>بستانکار (ریال)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {printData.journal.lines.map((line, i) => (
                        <tr key={`${line.account_code}-${i}`}>
                          <td>
                            {line.account_name} ({toPersianDigits(line.account_code)})
                          </td>
                          <td className={printStyles.num}>{toPersianDigits(line.debit)}</td>
                          <td className={printStyles.num}>{toPersianDigits(line.credit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
              <p>ثبت‌کننده: {printData.document.created_by_name ?? "—"}</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
