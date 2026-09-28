"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Editing or removing an order that has already been paid for.
 *
 * The panel deliberately looks nothing like the open-order controls above it:
 * every change here is a restatement of a settled bill, so it is composed as a
 * whole (quantities, removals, additions, discount, tender) with a mandatory
 * reason, reviewed against the amount it will re-post, and submitted once —
 * rather than the running, per-tap edits an open order allows.
 */
import { useEffect, useMemo, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { PaymentMethodView } from "@/lib/payment-methods";
import { api, errorMessage } from "../ui";
import { LoadingSkeleton } from "../page-chrome";
import { usePaymentMethods } from "../payment-ways";
import {
  DANGER_BUTTON,
  OPS_INPUT,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  STEPPER_BUTTON,
} from "./ops-styles";

/**
 * The ways the amendment can restate a settled bill as.
 *
 * An amendment re-posts the corrected sale as settled *one* way (it is a
 * restatement, not a new split), so the options are the business's payment
 * ways collapsed to the settlements behind them — two card terminals are one
 * choice here, named after the first of them.
 */
function amendmentMethodOptions(methods: readonly PaymentMethodView[]) {
  const options = [{ value: "", label: "همان روش قبلی" }];
  for (const method of methods) {
    if (options.some((option) => option.value === method.settlement)) continue;
    options.push({ value: method.settlement, label: method.name });
  }
  return options;
}

const KIND_LABELS: Record<string, string> = { edit: "ویرایش", void: "حذف" };

export interface AmendableItem {
  id: string;
  name: string;
  quantity: number;
  status: string;
}

export interface MenuOption {
  id: string;
  name: string;
}

interface AmendmentHistoryRow {
  id: string;
  kind: "edit" | "void";
  reason: string;
  previousTotal: number;
  newTotal: number;
  entryDate: string;
  createdAt: string;
  createdByName: string | null;
}

interface Draft {
  orderItemId: string;
  name: string;
  quantity: number;
  removed: boolean;
}

export function ClosedOrderAmendment({
  orderId,
  items,
  menuItems,
  discountType: initialDiscountType,
  discountValue: initialDiscountValue,
  onDone,
}: {
  orderId: string;
  items: AmendableItem[];
  menuItems: MenuOption[];
  discountType: "percent" | "amount" | null;
  discountValue: number | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [additions, setAdditions] = useState<
    { menuItemId: string; quantity: number }[]
  >([]);
  const [addItemId, setAddItemId] = useState("");
  const money = useMoney();
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(
    initialDiscountType ?? "",
  );
  const [discountValue, setDiscountValue] = useState(
    initialDiscountValue
      ? String(
          initialDiscountType === "amount"
            ? money.toInput(initialDiscountValue)
            : initialDiscountValue,
        )
      : "",
  );
  const [method, setMethod] = useState("");
  const {
    methods: paymentMethods,
    loaded: paymentMethodsLoaded,
    error: paymentMethodsError,
    reload: reloadPaymentMethods,
  } = usePaymentMethods();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [history, setHistory] = useState<AmendmentHistoryRow[] | null>(null);

  const liveItems = useMemo(
    () => items.filter((item) => item.status !== "voided"),
    [items],
  );

  useEffect(() => {
    setDraft(
      liveItems.map((item) => ({
        orderItemId: item.id,
        name: item.name,
        quantity: item.quantity,
        removed: false,
      })),
    );
  }, [liveItems]);

  const loadHistory = useMemo(
    () => () => {
      api<{ amendments: AmendmentHistoryRow[] }>(`/api/orders/${orderId}/amend`)
        .then(({ ok, data }) => setHistory(ok ? data.amendments : []))
        .catch(() => setHistory([]));
    },
    [orderId],
  );
  useEffect(loadHistory, [loadHistory]);

  const keptLines = draft.filter((line) => !line.removed);
  const nothingLeft = keptLines.length === 0 && additions.length === 0;

  function setQuantity(orderItemId: string, quantity: number) {
    setDraft((rows) =>
      rows.map((row) =>
        row.orderItemId === orderItemId
          ? { ...row, quantity: Math.max(1, quantity) }
          : row,
      ),
    );
  }

  async function submit(kind: "edit" | "void") {
    setBusy(true);
    setError("");
    setInfo("");
    const body =
      kind === "void"
        ? { kind, reason }
        : {
            kind,
            reason,
            lines: [
              ...keptLines.map((line) => ({
                orderItemId: line.orderItemId,
                quantity: line.quantity,
              })),
              ...additions,
            ],
            discount: discountType
              ? {
                  type: discountType,
                  value:
                    discountType === "amount"
                      ? money.fromInput(Math.max(0, Math.round(Number(discountValue) || 0)))
                      : Number(discountValue) || 0,
                }
              : { type: null },
            paymentMethod: method || undefined,
          };
    const { ok, data } = await api<{ error?: string; newTotal?: number }>(
      `/api/orders/${orderId}/amend`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(
      kind === "void"
        ? "سفارش حذف شد؛ همهٔ اثرهای حسابداری، انبار و صندوق آن برگشت خورد."
        : `سفارش اصلاح شد؛ مبلغ جدید ${money.format(Number(data.newTotal ?? 0))} در همان تاریخ فروش ثبت شد.`,
    );
    setOpen(false);
    setReason("");
    setAdditions([]);
    loadHistory();
    onDone();
  }

  return (
    <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold text-destructive">اصلاح سفارش بسته‌شده</h3>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            ویرایش یا حذف این سفارش، سند فروش، مالیات، بهای تمام‌شده، موجودی
            انبار و صندوق را در
            <b> همان تاریخ فروش </b>
            برگشت می‌زند و مقدار جدید را جایگزین می‌کند. اگر آن دوره مالی بسته
            شده باشد، عملیات انجام نمی‌شود.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={busy}
          className={`${DANGER_BUTTON} shrink-0`}
        >
          {open ? "بستن" : "اصلاح یا حذف"}
        </button>
      </div>

      {error ? (
        <p
          className="mt-3 rounded-xl border border-destructive/25 bg-card px-3 py-2.5 text-sm text-destructive"
          role="status"
        >
          {error}
        </p>
      ) : null}
      {info ? (
        <p
          className="mt-3 rounded-xl border border-amber-500/25 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 px-3 py-2.5 text-sm leading-6 text-amber-800 dark:text-amber-300"
          role="status"
        >
          {info}
        </p>
      ) : null}

      {open ? (
        <div className="mt-4 space-y-4 border-t border-destructive/30 pt-4">
          <ul className="divide-y divide-destructive/10 overflow-hidden rounded-xl border border-destructive/30 bg-card">
            {draft.map((line) => (
              <li
                key={line.orderItemId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm"
              >
                <span
                  className={
                    line.removed
                      ? "min-w-0 truncate text-muted-foreground line-through"
                      : "min-w-0 truncate font-semibold text-foreground"
                  }
                >
                  {line.name}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="کاهش تعداد"
                    onClick={() =>
                      setQuantity(line.orderItemId, line.quantity - 1)
                    }
                    disabled={busy || line.removed || line.quantity <= 1}
                    className={STEPPER_BUTTON}
                  >
                    <MinusIcon className="size-4" aria-hidden="true" />
                  </button>
                  <span className="w-7 text-center text-sm font-bold tabular-nums text-foreground">
                    {toPersianDigits(line.quantity)}
                  </span>
                  <button
                    type="button"
                    aria-label="افزایش تعداد"
                    onClick={() =>
                      setQuantity(line.orderItemId, line.quantity + 1)
                    }
                    disabled={busy || line.removed}
                    className={STEPPER_BUTTON}
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((rows) =>
                        rows.map((row) =>
                          row.orderItemId === line.orderItemId
                            ? { ...row, removed: !row.removed }
                            : row,
                        ),
                      )
                    }
                    disabled={busy}
                    className={line.removed ? SECONDARY_BUTTON : DANGER_BUTTON}
                  >
                    {line.removed ? "بازگرداندن" : "حذف قلم"}
                  </button>
                </div>
              </li>
            ))}
            {additions.map((addition, index) => (
              <li
                key={`addition-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 dark:bg-amber-500/15 px-3 py-2.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-foreground">
                    {menuItems.find((item) => item.id === addition.menuItemId)
                      ?.name ?? "—"}
                  </span>
                  <span className="ms-1.5 text-xs text-amber-700 dark:text-amber-300">
                    (افزوده‌شده)
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  <span className="w-7 text-center text-sm font-bold tabular-nums text-foreground">
                    {toPersianDigits(addition.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setAdditions((rows) => rows.filter((_, i) => i !== index))
                    }
                    disabled={busy}
                    className={DANGER_BUTTON}
                  >
                    حذف
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <SearchableSelect
                value={addItemId}
                onChange={setAddItemId}
                ariaLabel="افزودن قلم به سفارش بسته‌شده"
                className={OPS_INPUT}
                options={[
                  { value: "", label: "افزودن قلم…" },
                  ...menuItems.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                if (!addItemId) return;
                setAdditions((rows) => {
                  const existing = rows.findIndex(
                    (row) => row.menuItemId === addItemId,
                  );
                  if (existing === -1)
                    return [...rows, { menuItemId: addItemId, quantity: 1 }];
                  return rows.map((row, index) =>
                    index === existing
                      ? { ...row, quantity: row.quantity + 1 }
                      : row,
                  );
                });
                setAddItemId("");
              }}
              disabled={busy || !addItemId}
              className={`${SECONDARY_BUTTON} min-h-12 justify-center sm:min-w-28`}
            >
              افزودن
            </button>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <SearchableSelect
                value={discountType}
                onChange={(value) =>
                  setDiscountType(value as "" | "percent" | "amount")
                }
                ariaLabel="نوع تخفیف"
                className={OPS_INPUT}
                options={[
                  { value: "", label: "بدون تخفیف" },
                  { value: "percent", label: "درصدی" },
                  { value: "amount", label: "مبلغ ثابت" },
                ]}
              />
            </div>
            {discountType ? (
              <PersianNumberInput
                className={`${OPS_INPUT} sm:w-32`}
                dir="ltr"
                inputMode={discountType === "percent" ? "decimal" : "numeric"}
                aria-label="مقدار تخفیف"
                value={discountValue}
                onChange={(event) => setDiscountValue(event.target.value)}
                placeholder={discountType === "percent" ? "٪" : money.unitLabel}
              />
            ) : null}
            <div className="min-w-0 flex-1">
              {!paymentMethodsLoaded ? (
                <LoadingSkeleton rows={1} compact label="در حال بارگذاری روش‌های تسویه" />
              ) : paymentMethodsError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs" role="alert">
                  <p className="text-destructive">{paymentMethodsError.message}</p>
                  <button type="button" onClick={reloadPaymentMethods} className="mt-1 min-h-9 rounded-lg border px-3 font-bold">
                    تلاش دوباره
                  </button>
                </div>
              ) : (
                <SearchableSelect
                  value={method}
                  onChange={setMethod}
                  ariaLabel="روش تسویه"
                  className={OPS_INPUT}
                  options={amendmentMethodOptions(paymentMethods)}
                />
              )}
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">
              دلیل اصلاح{" "}
              <span className="font-normal text-muted-foreground">
                (الزامی، در گزارش حسابرسی ثبت می‌شود)
              </span>
            </span>
            <input
              className={`${OPS_INPUT} bg-card`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="مثلاً: یک فنجان سرو نشده بود"
            />
          </label>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => submit("edit")}
              disabled={busy || reason.trim().length < 3 || nothingLeft}
              className={PRIMARY_BUTTON}
            >
              {busy ? "در حال ثبت…" : "ثبت اصلاح"}
            </button>
            <button
              type="button"
              onClick={() => submit("void")}
              disabled={busy || reason.trim().length < 3}
              className={`${DANGER_BUTTON} min-h-12 w-full justify-center sm:w-auto sm:min-w-40`}
            >
              حذف کامل سفارش
            </button>
          </div>
          {nothingLeft ? (
            <p className="text-xs leading-6 text-muted-foreground">
              برای خالی کردن کامل سفارش، «حذف کامل سفارش» را بزنید.
            </p>
          ) : null}
        </div>
      ) : null}

      {history === null ? (
        <LoadingSkeleton rows={2} compact className="mt-4 border-t border-destructive/30 pt-3" />
      ) : history.length > 0 ? (
        <ul className="mt-4 space-y-1.5 border-t border-destructive/30 pt-3 text-xs leading-6 text-muted-foreground">
          {history.map((row) => (
            <li key={row.id}>
              {KIND_LABELS[row.kind]} در{" "}
              {toPersianDigits(formatJalali(row.createdAt))}
              {row.createdByName ? ` توسط ${row.createdByName}` : ""} —{" "}
              {money.format(row.previousTotal)} ← {money.format(row.newTotal)} —{" "}
              {row.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
