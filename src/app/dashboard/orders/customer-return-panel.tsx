"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { api, errorMessage } from "../ui";
import { CARD, OPS_INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./ops-styles";

interface ReturnOrder {
  id: string;
  order_number: number;
  status: "open" | "held" | "completed" | "voided";
  total: string | number;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}

interface ReturnableOrderItem {
  id: string;
  name_snapshot: string;
  quantity: number;
  status: string;
  unit_price: string | number;
}

interface HistoryLine {
  orderItemId: string;
  itemName: string;
  quantity: string;
  disposition: "restockable" | "discarded";
  recoveredQuantity: string;
  recoveredValueRial: string;
}

interface ReturnHistoryEntry {
  id: string;
  refundMethod: string;
  refundAmountRial: string;
  reason: string;
  createdAt: string;
  createdByName: string | null;
  inventoryPostingStatus: string | null;
  accountingPostingCount: number;
  recoveredValueRial: string;
  lines: HistoryLine[];
}

interface ReturnHistoryResponse {
  order: { totalRial: string; customerId: string | null; customerName: string | null; customerPhone: string | null };
  returns: ReturnHistoryEntry[];
  refundedTotalRial: string;
  refundCapacity: { saleRemainingRial: string; tenderRemainingRial: string; remainingRefundRial: string };
  timeZone: string;
  error?: string;
}

const METHOD_LABELS: Record<string, string> = {
  cash: "نقدی",
  card: "کارت‌خوان",
  card_to_card: "کارت‌به‌کارت",
  online: "پرداخت آنلاین",
};
const DISPOSITION_LABELS = {
  restockable: "قابل بازگشت به موجودی",
  discarded: "اسقاط / غیرقابل فروش",
} as const;

function timeLabel(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

function quantityNumber(value: string): number {
  const normalized = normalizePosSearchText(value);
  return normalized ? Number(normalized) : 0;
}

export function CustomerReturnPanel({
  order,
  items,
  canRefund,
  onChanged,
}: {
  order: ReturnOrder;
  items: ReturnableOrderItem[];
  canRefund: boolean;
  onChanged?: () => void;
}) {
  const money = useMoney();
  const [history, setHistory] = useState<ReturnHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [quantityDraft, setQuantityDraft] = useState<Record<string, string>>({});
  const [dispositionDraft, setDispositionDraft] = useState<Record<string, "restockable" | "discarded">>({});
  const [refundAmountInput, setRefundAmountInput] = useState("0");
  const [refundMethod, setRefundMethod] = useState<"cash" | "card" | "card_to_card" | "online">("cash");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const historyRequest = useRef(0);
  const intentKey = useRef<{ signature: string; key: string } | null>(null);
  const eligibleItems = useMemo(() => items.filter((item) => item.status !== "voided"), [items]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequest.current;
    setLoading(true);
    try {
      const { ok, data } = await api<ReturnHistoryResponse>(`/api/orders/${order.id}/returns`);
      if (requestId !== historyRequest.current) return;
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setHistory(data);
      setError("");
    } catch {
      if (requestId === historyRequest.current) setError("تاریخچهٔ برگشت‌ها بارگذاری نشد. دوباره تلاش کنید.");
    } finally {
      if (requestId === historyRequest.current) setLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    setHistory(null);
    setQuantityDraft({});
    setDispositionDraft({});
    setRefundAmountInput("0");
    setRefundMethod("cash");
    setReason("");
    setConfirming(false);
    intentKey.current = null;
    void loadHistory();
    return () => {
      historyRequest.current += 1;
    };
  }, [loadHistory]);

  const returnedByItem = useMemo(() => {
    const result = new Map<string, number>();
    for (const entry of history?.returns ?? []) {
      for (const line of entry.lines) {
        result.set(line.orderItemId, (result.get(line.orderItemId) ?? 0) + Number(line.quantity));
      }
    }
    return result;
  }, [history?.returns]);

  const selectedLines = useMemo(() => eligibleItems.flatMap((item) => {
    const quantity = quantityNumber(quantityDraft[item.id] ?? "");
    const alreadyReturned = returnedByItem.get(item.id) ?? 0;
    const remaining = Math.max(0, item.quantity - alreadyReturned);
    if (!Number.isFinite(quantity) || quantity <= 0) return [];
    return [{
      orderItemId: item.id,
      itemName: item.name_snapshot,
      quantity: (quantityDraft[item.id] ?? "").trim(),
      quantityNumber: quantity,
      remaining,
      disposition: dispositionDraft[item.id] ?? "restockable",
    }];
  }), [eligibleItems, quantityDraft, dispositionDraft, returnedByItem]);

  let refundAmountRial: string | null = null;
  try {
    refundAmountRial = money.parseText(refundAmountInput.trim() || "0");
  } catch {
    refundAmountRial = null;
  }
  const remainingRefund = history?.refundCapacity.remainingRefundRial ?? "0";
  const refundExceedsCapacity = refundAmountRial !== null && BigInt(refundAmountRial) > BigInt(remainingRefund);
  const refundIsNegative = refundAmountRial !== null && BigInt(refundAmountRial) < 0n;
  const quantityInvalid = eligibleItems.some((item) => {
    const raw = quantityDraft[item.id]?.trim();
    if (!raw) return false;
    const quantity = quantityNumber(raw);
    const remaining = Math.max(0, item.quantity - (returnedByItem.get(item.id) ?? 0));
    return !Number.isFinite(quantity) || quantity <= 0 || quantity > remaining;
  });
  const canStartReturn = canRefund && order.status === "completed" && Boolean(history) &&
    selectedLines.length > 0 && reason.trim().length > 0 && reason.trim().length <= 500 &&
    refundAmountRial !== null && !refundIsNegative && !refundExceedsCapacity && !quantityInvalid && !saving && !loading;

  function idempotencyKeyFor(signature: string): string {
    if (intentKey.current?.signature === signature) return intentKey.current.key;
    const key = crypto.randomUUID();
    intentKey.current = { signature, key };
    return key;
  }

  async function submitReturn() {
    if (!history || !canStartReturn || refundAmountRial === null) return;
    const lines = selectedLines.map((line) => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      disposition: line.disposition,
    }));
    const signature = JSON.stringify({
      orderId: order.id,
      refundMethod,
      refundAmountRial,
      reason: reason.trim(),
      lines: [...lines].sort((left, right) => left.orderItemId.localeCompare(right.orderItemId)),
    });
    const idempotencyKey = idempotencyKeyFor(signature);
    setSaving(true);
    setError("");
    try {
      const { ok, data } = await api<{ error?: string; duplicate?: boolean; refundAmount?: string }>(
        `/api/orders/${order.id}/returns`,
        {
          method: "POST",
          body: JSON.stringify({
            refundMethod,
            refundAmountRial,
            reason: reason.trim(),
            idempotencyKey,
            lines,
          }),
        },
      );
      if (!ok) {
        setError(errorMessage(data.error));
        setConfirming(false);
        return;
      }
      toast.success(data.duplicate ? "این برگشت قبلاً ثبت شده بود." : "برگشت وجه و اقلام ثبت شد.");
      setConfirming(false);
      setQuantityDraft({});
      setDispositionDraft({});
      setRefundAmountInput("0");
      setReason("");
      intentKey.current = null;
      await loadHistory();
      onChanged?.();
    } catch {
      // Preserve the form and intent key: the server may have committed before
      // the connection failed. Retrying the same intent is idempotent.
      setError("پاسخ ثبت برگشت دریافت نشد. وضعیت تراکنش را بررسی یا همین درخواست را دوباره ارسال کنید؛ مبلغ دوباره ثبت نخواهد شد.");
    } finally {
      setSaving(false);
    }
  }

  const timeZone = history?.timeZone ?? "Asia/Tehran";
  return (
    <div className="space-y-3">
      <section className={`${CARD} p-4`} aria-label="مشتری و سقف برگشت">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-foreground">مشتری و سقف برگشت</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {order.customer_name
                ? `${order.customer_name}${order.customer_phone ? ` · ${toPersianDigits(order.customer_phone)}` : ""}`
                : "مشتری ثبت‌شده‌ای برای این سفارش وجود ندارد."}
            </p>
          </div>
          <button type="button" onClick={() => void loadHistory()} disabled={loading || saving} className={`${SECONDARY_BUTTON} min-h-10`}>
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            تازه‌سازی
          </button>
        </div>
        {history ? (
          <dl className="mt-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl bg-muted px-3 py-2">
              <dt className="text-xs text-muted-foreground">سقف قابل‌برگشت</dt>
              <dd className="mt-1 font-bold text-foreground">{money.formatText(remainingRefund)}</dd>
            </div>
            <div className="rounded-xl bg-muted px-3 py-2">
              <dt className="text-xs text-muted-foreground">برگشت قبلی</dt>
              <dd className="mt-1 font-bold text-foreground">{money.formatText(history.refundedTotalRial)}</dd>
            </div>
            <div className="rounded-xl bg-muted px-3 py-2">
              <dt className="text-xs text-muted-foreground">جمع فاکتور (بدون انعام)</dt>
              <dd className="mt-1 font-bold text-foreground">{money.formatText(history.order.totalRial)}</dd>
            </div>
          </dl>
        ) : null}
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          سقف برگشت بر پایهٔ ماندهٔ مبلغ فروش و دریافتی غیرنسیه محاسبه می‌شود؛ انعام و اعتبار مشتری قابل‌برگشت نیست.
        </p>
      </section>

      {canRefund && order.status === "completed" ? (
        <section className={`${CARD} p-4`} aria-label="ثبت برگشت مشتری">
          <div className="flex items-center gap-2">
            <RotateCcwIcon className="size-4 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <h3 className="font-semibold text-foreground">ثبت برگشت کالا / وجه</h3>
          </div>
          {!history && loading ? <p className="mt-3 text-sm text-muted-foreground">در حال بررسی سقف و برگشت‌های قبلی…</p> : null}
          <div className="mt-3 space-y-3">
            {eligibleItems.length === 0 ? (
              <p className="rounded-xl bg-muted px-3 py-3 text-sm text-muted-foreground">قلم قابل‌برگشتی در سفارش وجود ندارد.</p>
            ) : eligibleItems.map((item) => {
              const alreadyReturned = returnedByItem.get(item.id) ?? 0;
              const remaining = Math.max(0, item.quantity - alreadyReturned);
              return (
                <div key={item.id} className="rounded-xl border border-border/80 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground">{item.name_snapshot}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        فروخته‌شده: {toPersianDigits(item.quantity)} · برگشت قبلی: {toPersianDigits(alreadyReturned)} · مانده: {toPersianDigits(remaining)}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-muted-foreground">{money.formatText(String(item.unit_price))} / واحد</span>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted-foreground">تعداد این برگشت</span>
                      <PersianNumberInput
                        className={OPS_INPUT}
                        dir="ltr"
                        inputMode="decimal"
                        value={quantityDraft[item.id] ?? ""}
                        onChange={(event) => setQuantityDraft((current) => ({ ...current, [item.id]: event.target.value }))}
                        placeholder="۰"
                        disabled={remaining <= 0 || saving}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-muted-foreground">وضعیت کالا</span>
                      <select
                        className={OPS_INPUT}
                        value={dispositionDraft[item.id] ?? "restockable"}
                        onChange={(event) => setDispositionDraft((current) => ({ ...current, [item.id]: event.target.value as "restockable" | "discarded" }))}
                        disabled={remaining <= 0 || saving}
                      >
                        <option value="restockable">{DISPOSITION_LABELS.restockable}</option>
                        <option value="discarded">{DISPOSITION_LABELS.discarded}</option>
                      </select>
                    </label>
                  </div>
                  {quantityDraft[item.id] && quantityNumber(quantityDraft[item.id]) > remaining ? (
                    <p className="mt-2 text-xs text-destructive">تعداد از ماندهٔ قابل‌برگشت بیشتر است.</p>
                  ) : null}
                </div>
              );
            })}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">مبلغ برگشت ({money.unitLabel}؛ صفر برای برگشت کالا بدون وجه)</span>
                <PersianNumberInput
                  className={OPS_INPUT}
                  dir="ltr"
                  inputMode="numeric"
                  value={refundAmountInput}
                  onChange={(event) => setRefundAmountInput(event.target.value)}
                  disabled={saving}
                />
                {refundExceedsCapacity ? <span className="mt-1 block text-xs text-destructive">مبلغ از سقف قابل‌برگشت بیشتر است.</span> : null}
                {refundIsNegative ? <span className="mt-1 block text-xs text-destructive">مبلغ برگشت نمی‌تواند منفی باشد.</span> : null}
                {refundAmountRial === null ? <span className="mt-1 block text-xs text-destructive">مبلغ ریالی معتبر وارد کنید.</span> : null}
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">روش پرداخت برگشت</span>
                <select className={OPS_INPUT} value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as typeof refundMethod)} disabled={saving}>
                  <option value="cash">نقدی</option>
                  <option value="card">کارت‌خوان</option>
                  <option value="card_to_card">کارت‌به‌کارت</option>
                  <option value="online">پرداخت آنلاین</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">دلیل برگشت (الزامی)</span>
              <textarea
                className={`${OPS_INPUT} min-h-24 resize-y`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                placeholder="شرح کوتاه و روشنِ علت برگشت"
                disabled={saving}
              />
              <span className="mt-1 block text-end text-xs text-muted-foreground">{toPersianDigits(reason.trim().length)} / ۵۰۰</span>
            </label>
            <button type="button" className={`${PRIMARY_BUTTON} w-full`} disabled={!canStartReturn} onClick={() => { setError(""); setConfirming(true); }}>
              بررسی و تأیید برگشت
            </button>
            {!canRefund ? <p className="text-xs text-muted-foreground">برای ثبت برگشت، دسترسی «برگشت وجه» لازم است.</p> : null}
          </div>
        </section>
      ) : null}

      {confirming ? (
        <section className="rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-4" role="alertdialog" aria-modal="false" aria-labelledby="customer-return-confirm-title">
          <h3 id="customer-return-confirm-title" className="font-bold text-foreground">تأیید نهایی برگشت</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            سفارش {toPersianDigits(order.order_number)} برای {order.customer_name || "مشتری حضوری"}؛ {toPersianDigits(selectedLines.length)} قلم، برگشت وجه {refundAmountRial === null ? "—" : money.formatText(refundAmountRial)} از روش {METHOD_LABELS[refundMethod]}.
          </p>
          <p className="mt-1 text-sm text-foreground">دلیل: {reason.trim()}</p>
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className={SECONDARY_BUTTON} onClick={() => setConfirming(false)} disabled={saving}>بازگشت</button>
            <button type="button" className={`${PRIMARY_BUTTON} sm:min-w-48`} onClick={() => void submitReturn()} disabled={!canStartReturn || saving}>
              {saving ? "در حال ثبت…" : "تأیید و ثبت برگشت"}
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="rounded-xl border border-destructive/20 bg-destructive/[0.035] px-3 py-2 text-sm text-destructive" role="status">{error}</p> : null}

      <section className={`${CARD} p-4`} aria-label="تاریخچهٔ برگشت سفارش">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold text-foreground">تاریخچهٔ برگشت‌ها</h3>
            <p className="mt-1 text-xs text-muted-foreground">{history ? `${toPersianDigits(history.returns.length)} برگشت ثبت‌شده` : ""}</p>
          </div>
        </div>
        {loading && !history ? <p className="mt-3 text-sm text-muted-foreground">در حال بارگذاری تاریخچه…</p> : null}
        {!loading && history?.returns.length === 0 ? <p className="mt-3 rounded-xl bg-muted px-3 py-4 text-sm text-muted-foreground">برای این سفارش برگشتی ثبت نشده است.</p> : null}
        {history?.returns.length ? (
          <ol className="mt-3 space-y-3">
            {history.returns.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-border/80 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-foreground">{money.formatText(entry.refundAmountRial)} · {METHOD_LABELS[entry.refundMethod] ?? entry.refundMethod}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{timeLabel(entry.createdAt, timeZone)} · {entry.createdByName || "کاربر ثبت‌نشده"}</p>
                  </div>
                  <div className="text-end text-xs text-muted-foreground">
                    <p>وضعیت موجودی: {entry.inventoryPostingStatus ?? "ثبت نشده"}</p>
                    <p className="mt-1">سند حسابداری: {toPersianDigits(entry.accountingPostingCount)}</p>
                  </div>
                </div>
                <p className="mt-2 text-sm leading-6 text-foreground">دلیل: {entry.reason}</p>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {entry.lines.map((line) => (
                    <li key={line.orderItemId} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                      <span>{line.itemName} · {toPersianDigits(line.quantity)} ({DISPOSITION_LABELS[line.disposition]})</span>
                      <span>بازیابی موجودی: {toPersianDigits(line.recoveredQuantity)} · ارزش: {money.formatText(line.recoveredValueRial)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs font-semibold text-muted-foreground">ارزش بازیابی‌شدهٔ کل: {money.formatText(entry.recoveredValueRial)}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </div>
  );
}
