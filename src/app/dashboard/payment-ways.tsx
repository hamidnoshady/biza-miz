"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * The payment ways a cashier picks from, and the panel that splits a bill
 * across them. Shared by the POS and the order dialog so the two checkouts
 * can't drift — the ways, their order, and the arithmetic are the same thing
 * in both places (see src/lib/payment-draft.ts for the arithmetic).
 */
import { useCallback, useEffect, useState } from "react";
import {
  BanknoteIcon,
  CoinsIcon,
  CreditCardIcon,
  PlusIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  SmartphoneIcon,
  SplitIcon,
  WalletIcon,
  XIcon,
} from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import {
  draftDifference,
  draftReceivedRial,
  draftRemaining,
  draftRequiresCustomer,
  draftUsesManualAmount,
  newDraftRow,
  type PaymentDraft,
} from "@/lib/payment-draft";
import type { PaymentMethodView, PaymentSettlement } from "@/lib/payment-methods";
import { toPersianDigits } from "@/lib/digits";
import { api } from "./ui";
import { Skeleton } from "@/components/ui/skeleton";
import { UserIcon } from "lucide-react";

/** A settlement's icon — a way a business added is recognisable by how it settles. */
const SETTLEMENT_ICONS: Record<PaymentSettlement, typeof BanknoteIcon> = {
  cash: BanknoteIcon,
  card: CreditCardIcon,
  card_to_card: WalletIcon,
  online: SmartphoneIcon,
  credit: ReceiptTextIcon,
  cheque: ScrollTextIcon,
  snappfood: SmartphoneIcon,
};

export function paymentWayIcon(method: PaymentMethodView) {
  return SETTLEMENT_ICONS[method.settlement] ?? WalletIcon;
}

/**
 * The business's payment ways, fetched once per screen.
 *
 * `methods` is empty until the fetch lands, which is why every caller gates
 * its checkout button on it: paying with no way chosen is exactly the request
 * the server refuses, so the screen shouldn't offer it either.
 */
export type PaymentMethodsLoadError = {
  kind: "authorization" | "offline" | "server";
  message: string;
};

export function usePaymentMethods(enabled = true): {
  methods: PaymentMethodView[];
  loaded: boolean;
  loading: boolean;
  error: PaymentMethodsLoadError | null;
  reload: () => void;
} {
  const [methods, setMethods] = useState<PaymentMethodView[]>([]);
  const [loaded, setLoaded] = useState(!enabled);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<PaymentMethodsLoadError | null>(null);

  const reload = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    void api<{ paymentMethods?: PaymentMethodView[]; error?: string }>("/api/payment-methods")
      .then(({ ok, status, data }) => {
        if (ok) {
          setMethods(data.paymentMethods ?? []);
          return;
        }
        if (status === 401 || status === 403) {
          setError({
            kind: "authorization",
            message: "مجوز مشاهدهٔ روش‌های دریافت وجه برای این حساب فعال نیست.",
          });
        } else if (status === 0 || data.error === "network_error") {
          setError({
            kind: "offline",
            message: "ارتباط با سرویس محلی برقرار نشد. در نسخهٔ دسکتاپ، برنامهٔ محلی را بررسی کنید.",
          });
        } else {
          setError({
            kind: "server",
            message: "بارگذاری روش‌های دریافت وجه انجام نشد.",
          });
        }
      })
      .finally(() => {
        setLoaded(true);
        setLoading(false);
      });
  }, [enabled]);

  useEffect(reload, [reload]);
  return { methods, loaded, loading, error, reload };
}

const CHIP_ON = "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300";
const CHIP_OFF = "border-border/80 text-muted-foreground hover:bg-muted";

const AMOUNT_INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-border/80 bg-card px-2 text-sm tabular-nums outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-2 focus-visible:ring-amber-500/30 dark:focus-visible:ring-amber-400/45";

export interface PaymentWaysProps {
  methods: PaymentMethodView[];
  draft: PaymentDraft;
  onChange: (draft: PaymentDraft) => void;
  /** The bill the split has to cover, in Rial. */
  due: number;
  disabled?: boolean;
  /** False only during the hook's first request; prevents a false "no methods" state. */
  loaded?: boolean;
  loadError?: PaymentMethodsLoadError | null;
  onReload?: () => void;
  /** Distinguishes the ids of two panels rendered at once (the POS has a desktop and a sheet copy). */
  idPrefix?: string;
  /**
   * The sale's customer, for the under/over-payment rules: a difference
   * (بدهی/اعتبار) can only be booked against a named person. The panel itself
   * stays picker-free — `onChooseCustomer` opens the surface's own picker.
   */
  customer?: { id: string; name: string } | null;
  onChooseCustomer?: () => void;
}

export function PaymentWays({
  methods,
  draft,
  onChange,
  due,
  disabled,
  loaded = true,
  loadError = null,
  onReload,
  idPrefix = "pay",
  customer = null,
  onChooseCustomer,
}: PaymentWaysProps) {
  const money = useMoney();
  const remaining = draftRemaining(draft, due, money.unit);
  // The typed amount versus the bill — the whole underpay/overpay decision,
  // computed here so the cashier sees it before the ۴-second hold, not in an
  // error toast after. Only meaningful when the bill isn't being split.
  const manual = draftUsesManualAmount(draft);
  const receivedRial = draftReceivedRial(draft);
  const difference = draftDifference(receivedRial ?? due, due);
  const needsCustomer = draftRequiresCustomer(draft, methods, due) && !customer;
  const selectedMethod = methods.find((method) => method.id === draft.methodId) ?? null;

  /**
   * Tapping a way while splitting *adds* it, pre-filled with whatever is still
   * owed — the two-tap "۲۰۰٬۰۰۰ نقدی، rest on card" case, which is most of
   * them. Tapping it while not splitting just selects it, and does so whether
   * or not «مبلغ دریافتی» is open: the method stays editable while the amount
   * is being entered, which is the whole point of the entry living under it.
   */
  function chooseWay(methodId: string) {
    if (!draft.split) {
      onChange({ ...draft, methodId, rows: [newDraftRow(methodId)] });
      return;
    }
    const prefill = remaining > 0 ? String(money.toInput(remaining)) : "";
    onChange({ ...draft, rows: [...draft.rows, newDraftRow(methodId, prefill)] });
  }

  function toggleSplit() {
    if (draft.split) {
      // Collapsing keeps the way of the first slice, so the cashier doesn't
      // land back on an unrelated button.
      const methodId = draft.rows[0]?.methodId ?? draft.methodId;
      onChange({
        split: false,
        methodId,
        rows: [newDraftRow(methodId)],
        receivedAmount: "",
        manualReceived: false,
      });
      return;
    }
    const prefill = due > 0 ? String(money.toInput(due)) : "";
    // Turning the split on turns the manual amount off: the slices are the
    // amounts now, and leaving both live is how a bill gets charged twice.
    onChange({
      ...draft,
      split: true,
      manualReceived: false,
      receivedAmount: "",
      rows: [newDraftRow(draft.methodId, prefill)],
    });
  }

  /**
   * «مبلغ دریافتی» — the other half of the same choice, and its exact visual
   * peer. Opening it turns any split off (same reason as above) and pre-fills
   * the invoice total, so the common case is "adjust the figure", not "type
   * it from scratch". Closing it returns the sale to the ordinary one, where
   * the chosen way simply covers the whole invoice.
   */
  function toggleManualAmount() {
    if (manual) {
      onChange({ ...draft, manualReceived: false, receivedAmount: "" });
      return;
    }
    const methodId = draft.split ? (draft.rows[0]?.methodId ?? draft.methodId) : draft.methodId;
    onChange({
      ...draft,
      split: false,
      methodId,
      rows: [newDraftRow(methodId)],
      manualReceived: true,
      receivedAmount: due > 0 ? String(money.toInput(due)) : "",
    });
  }

  function patchRow(key: string, patch: { amount?: string; reference?: string }) {
    onChange({ ...draft, rows: draft.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  }

  function removeRow(key: string) {
    onChange({ ...draft, rows: draft.rows.filter((row) => row.key !== key) });
  }

  return (
    <div>
      {/*
        The two ways a bill can depart from "this way covers it all", as two
        peers of the same shape. «مبلغ دریافتی» used to be a permanently
        visible, full-width box — a third of the payment panel spent on a
        field that is empty in almost every sale, on the phone screen where
        that space is scarcest. It is now the same compact toggle its sibling
        «تقسیم بین چند روش» always was, and the entry it opens appears *under
        the selected way*, which stays visible and editable throughout.
      */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-bold text-muted-foreground">روش دریافت وجه</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={toggleManualAmount}
            disabled={disabled || methods.length === 0}
            aria-pressed={manual}
            aria-expanded={manual}
            aria-controls={idPrefix + "-received-panel"}
            className={
              "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2 text-xs font-bold transition disabled:opacity-55 " +
              (manual ? CHIP_ON : CHIP_OFF)
            }
          >
            <CoinsIcon className="size-3.5 shrink-0" aria-hidden="true" />
            مبلغ دریافتی
          </button>
          <button
            type="button"
            onClick={toggleSplit}
            disabled={disabled || methods.length === 0}
            aria-pressed={draft.split}
            className={
              "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2 text-xs font-bold transition disabled:opacity-55 " +
              (draft.split ? CHIP_ON : CHIP_OFF)
            }
          >
            <SplitIcon className="size-3.5 shrink-0" aria-hidden="true" />
            {draft.split ? "پرداخت یکجا" : "تقسیم بین چند روش"}
          </button>
        </div>
      </div>

      {!loaded ? (
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="در حال بارگذاری روش‌های دریافت وجه"
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} aria-hidden="true" className="h-14 rounded-xl" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert">
          <p className="text-destructive">{loadError.message}</p>
          {onReload ? (
            <button
              type="button"
              onClick={onReload}
              className="mt-2 min-h-9 rounded-lg border border-destructive/30 px-3 font-bold text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
            >
              تلاش دوباره
            </button>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {methods.map((method) => {
            const Icon = paymentWayIcon(method);
            const selected = !draft.split && draft.methodId === method.id;
            return (
              <button
                key={method.id}
                type="button"
                onClick={() => chooseWay(method.id)}
                disabled={disabled}
                className={
                  "flex min-h-14 items-center justify-center gap-2 rounded-xl border px-2 text-center text-sm font-bold transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-55 motion-reduce:transition-none " +
                  (selected ? CHIP_ON : CHIP_OFF)
                }
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{method.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {loaded && !loadError && methods.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">هیچ روش فعالی برای دریافت وجه پیکربندی نشده است. با مدیر کسب‌وکار تماس بگیرید.</p>
      ) : null}

      {/*
        The amount actually handed over, expanded beneath the way it was taken
        with — the two belong together, because "cash" says nothing about how
        much of the bill it covers. It only exists while the cashier asked for
        it: a normal payment leaves this collapsed and the selected way covers
        the whole invoice (no amount is sent at all — see paymentDraftBody).
      */}
      {manual && loaded && methods.length > 0 ? (
        <div
          id={idPrefix + "-received-panel"}
          className="mt-2.5 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-2.5"
        >
          <label
            className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs font-bold text-muted-foreground"
            htmlFor={idPrefix + "-received"}
          >
            <span>
              مبلغ دریافتی
              {selectedMethod ? (
                <span className="font-normal"> — {selectedMethod.name}</span>
              ) : null}
            </span>
            <span className="font-normal">صورتحساب: {money.format(due)}</span>
          </label>
          <div className="flex items-center gap-2">
            <PersianNumberInput
              id={idPrefix + "-received"}
              className={AMOUNT_INPUT + " h-12 text-base font-bold"}
              dir="ltr"
              inputMode="numeric"
              autoFocus
              value={draft.receivedAmount ?? ""}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, receivedAmount: event.target.value })}
              placeholder="کل مبلغ صورتحساب"
              aria-label="مبلغ دریافتی از مشتری"
            />
            <button
              type="button"
              onClick={toggleManualAmount}
              disabled={disabled}
              aria-label="بستن مبلغ دریافتی و دریافت کل صورتحساب"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-card text-muted-foreground hover:bg-muted disabled:opacity-55"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
          {/* Still owed, where it is actually actionable — the figure that used
              to live permanently in the order dialog's footer. */}
          {receivedRial !== null && receivedRial < due ? (
            <p className="mt-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
              باقی‌مانده {money.format(due - receivedRial)}
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        The settle-with-difference preview — جمع سفارش / دریافتی / بدهی یا
        اعتبار — shown the moment the typed amount leaves the bill, so the
        cashier books the difference deliberately instead of discovering it in
        a rejection. Split payments keep the exact-arithmetic rows below.
      */}
      {manual && receivedRial !== null && receivedRial !== due ? (
        <div className="mt-2.5 space-y-1 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-2.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">جمع سفارش</span>
            <span className="font-bold tabular-nums">{money.format(due)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">دریافتی</span>
            <span className="font-bold tabular-nums">{money.format(receivedRial)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-amber-200/70 dark:border-amber-500/30 pt-1">
            <span className="text-muted-foreground">
              {difference.balanceDue > 0 ? "بدهی مشتری" : "اعتبار مشتری"}
            </span>
            <span
              className={
                "font-black tabular-nums " +
                (difference.balanceDue > 0
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-emerald-700 dark:text-emerald-300")
              }
            >
              {money.format(difference.balanceDue > 0 ? difference.balanceDue : difference.customerCredit)}
            </span>
          </div>
          {needsCustomer ? (
            <div className="rounded-lg bg-card/80 dark:bg-card/60 p-2">
              <p className="leading-5 text-amber-700 dark:text-amber-300">
                برای ثبت بدهی یا اعتبار، ابتدا مشتری را انتخاب کنید.
              </p>
              {onChooseCustomer ? (
                <button
                  type="button"
                  onClick={onChooseCustomer}
                  disabled={disabled}
                  className="mt-1.5 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 dark:bg-amber-400 px-3 text-xs font-bold text-amber-950 disabled:opacity-55"
                >
                  <UserIcon className="size-4" aria-hidden="true" />
                  انتخاب یا افزودن مشتری
                </button>
              ) : null}
            </div>
          ) : customer && (difference.balanceDue > 0 || difference.customerCredit > 0) ? (
            <p className="leading-5 text-muted-foreground">
              روی حساب «{customer.name}» ثبت می‌شود.
            </p>
          ) : null}
        </div>
      ) : null}

      {draft.split ? (
        <div className="mt-3 space-y-2 rounded-xl border border-border/80 bg-muted p-2">
          {draft.rows.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              یکی از روش‌های بالا را بزنید تا سهم آن از مبلغ اضافه شود.
            </p>
          ) : null}
          {draft.rows.map((row, index) => {
            const method = methods.find((candidate) => candidate.id === row.methodId);
            return (
              <div key={row.key} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-bold text-foreground">
                    {method?.name ?? "—"}
                  </span>
                  <PersianNumberInput
                    id={`${idPrefix}-tender-${index}`}
                    className={AMOUNT_INPUT + " max-w-32"}
                    dir="ltr"
                    inputMode="numeric"
                    value={row.amount}
                    disabled={disabled}
                    onChange={(event) => patchRow(row.key, { amount: event.target.value })}
                    placeholder={money.unit === "rial" ? "ریال" : "تومان"}
                    aria-label={`مبلغ ${method?.name ?? ""}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(row.key)}
                    disabled={disabled}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/80 text-muted-foreground hover:bg-card disabled:opacity-55"
                    aria-label={`حذف ${method?.name ?? ""}`}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </button>
                </div>
                {method?.requiresReference ? (
                  <input
                    className={AMOUNT_INPUT}
                    dir="ltr"
                    value={row.reference}
                    disabled={disabled}
                    onChange={(event) => patchRow(row.key, { reference: event.target.value })}
                    placeholder="شمارهٔ پیگیری"
                    aria-label={`شمارهٔ پیگیری ${method.name}`}
                  />
                ) : null}
              </div>
            );
          })}

          <div className="flex items-center justify-between border-t border-border/80 pt-2 text-xs font-bold">
            <span className="text-muted-foreground">
              {remaining > 0 ? "باقی‌مانده" : remaining < 0 ? "مازاد (بازگشت به مشتری)" : "تسویه شد"}
            </span>
            <span className={remaining === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}>
              {money.format(Math.abs(remaining))}
            </span>
          </div>
          {draft.rows.length > 0 && remaining > 0 ? (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <PlusIcon className="size-3" aria-hidden="true" />
              روش دیگری را از بالا بزنید تا {money.format(remaining)} باقی‌مانده با آن دریافت شود.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
