"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FilterChip } from "@/app/dashboard/filters";
import { api, errorMessage, Field, inputClass } from "@/app/dashboard/ui";
import type { MoneyApi } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { toPersianDigits } from "@/lib/digits";
import {
  MAX_BANK_REFERENCE_LENGTH,
  VOUCHER_METHOD_LABELS,
  VOUCHER_METHODS,
  voucherAccountChoices,
  type VoucherAccountChoice,
  type VoucherMethod,
} from "@/lib/payables-input";

/**
 * Shared voucher form pieces for issue #829.
 *
 * Recording a receipt and recording a payment are the same act with the sides
 * swapped — amount, method (cash/bank/clearing), an optional explicit cash
 * account, an optional back-date, an optional memo — but the
 * «دریافت و پرداخت» workspace and the AR/AP subledger settle dialogs each grew
 * their own copy. The copies drifted: one learned back-dating while the other
 * posted today, neither knew the «clearing» method, and neither sent an
 * idempotency key. The shared fields live here once; both dialogs render them.
 *
 * The method vocabulary, the method labels and the account choices all come
 * from `@/lib/payables-input` — the same rules the server validates against,
 * so a form and the API cannot disagree about what is valid.
 */

/**
 * One idempotency key per dialog instance. Generated when the dialog opens and
 * kept across retries of the same submission — regenerating on every attempt
 * would defeat the point (each retry would be a new logical voucher). A fresh
 * dialog (after success or cancel) gets a fresh key.
 */
export function useIdempotencyKey(): string {
  const [key] = useState(() => newVoucherKey("voucher"));
  return key;
}

/** A fresh random key, prefixed so a support log shows which surface minted it. */
export function newVoucherKey(prefix: string): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function VoucherMethodPicker({
  value,
  onChange,
  label = "روش",
}: {
  value: VoucherMethod;
  onChange: (next: VoucherMethod) => void;
  label?: string;
}) {
  return (
    <div className="mb-4">
      <p className="mb-1 text-sm font-medium text-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">
        {VOUCHER_METHODS.map((method) => (
          <FilterChip key={method} dense selected={value === method} onClick={() => onChange(method)}>
            {VOUCHER_METHOD_LABELS[method]}
          </FilterChip>
        ))}
      </div>
      {/*
       * «بانکی» posts to the bank account (1110); card/PSP money still in
       * transit uses «در جریان وصول» (1120). The old workspace labeled every
       * bank voucher «بانکی» while posting it to the clearing account — the
       * label below the picker keeps the two honest.
       */}
      <p className="mt-1 text-xs text-muted-foreground">
        {value === "cash" && "ثبت در حساب صندوق"}
        {value === "bank" && "ثبت در حساب بانک"}
        {value === "clearing" && "ثبت در حساب کارت‌خوان (در راه)"}
      </p>
    </div>
  );
}

const CASH_ACCOUNT_DEFAULT_LABELS: Record<VoucherMethod, string> = {
  cash: "صندوق پیش‌فرض",
  bank: "حساب پیش‌فرض بانکی",
  clearing: "کارت‌خوان پیش‌فرض",
};

/**
 * Optional explicit cash account. Empty means «method default» — the server
 * maps cash→1100, bank→1110, clearing→1120. Only the method's own accounts
 * are offered (classified by the same rule the cash-flow statement uses);
 * the server re-validates, so a crafted id cannot post a receipt against
 * e.g. an expense account. A failed load leaves only the default, which is
 * exactly what the form did before it could name an account.
 */
export function CashAccountPicker({
  value,
  onChange,
  method,
}: {
  value: string;
  onChange: (next: string) => void;
  method: VoucherMethod;
}) {
  const [choices, setChoices] = useState<VoucherAccountChoice[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{
      accounts?: { id: string; code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; parent_code: string | null }[];
    }>("/api/ledger/accounts").then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok) {
        setFailed(true);
        return;
      }
      setChoices(voucherAccountChoices(data.accounts ?? []));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => {
    const methodAccounts = (choices ?? []).filter((a) => a.method === method);
    return [
      { value: "", label: CASH_ACCOUNT_DEFAULT_LABELS[method] },
      ...methodAccounts.map((a) => ({
        value: a.id,
        label: `${toPersianDigits(a.code)} ${a.name}`,
        searchString: `${a.code} ${a.name}`,
      })),
    ];
  }, [choices, method]);

  const loading = choices === null && !failed;
  return (
    <Field label="حساب تسویه (اختیاری)">
      {/*
       * While the chart is in flight the field keeps its shape with a
       * skeleton rather than an empty select — the loading-coverage contract
       * (a fetching client component must reserve its region).
       */}
      {loading ? (
        <Skeleton aria-label="در حال بارگذاری حساب‌ها" className="h-10 w-full" />
      ) : (
        <SearchableSelect
          value={value}
          onChange={onChange}
          ariaLabel="انتخاب حساب تسویه"
          disabled={failed}
          options={options}
        />
      )}
      {failed ? <p className="mt-1 text-xs text-destructive">لیست حساب‌ها بارگذاری نشد؛ از پیش‌فرض روش استفاده می‌شود.</p> : null}
    </Field>
  );
}

/**
 * The amount + method + cash account + date + memo block shared by the
 * voucher dialog and the subledger settle dialog. Party selection stays with
 * the callers: the voucher dialog picks a party, the settle dialog already has
 * one.
 *
 * Callers reset the cash account when the method changes (an account belongs
 * to one method) — the picker only offers the current method's accounts, so
 * a stale id would otherwise point at an account the dialog no longer shows.
 *
 * The bank/PSP tracking number is opt-in per caller (`showBankReference`):
 * the voucher dialog records one, the subledger settle dialog does not. Cash
 * carries no reference, so the field shows only for bank and clearing.
 */
export function VoucherFormFields({
  amount,
  onAmountChange,
  method,
  onMethodChange,
  cashAccountId,
  onCashAccountChange,
  showBankReference,
  bankReference,
  onBankReferenceChange,
  date,
  onDateChange,
  memo,
  onMemoChange,
  methodLabel,
  dateLabel = "تاریخ (اختیاری)",
  datePlaceholder,
}: {
  amount: string;
  onAmountChange: (next: string) => void;
  method: VoucherMethod;
  onMethodChange: (next: VoucherMethod) => void;
  cashAccountId: string;
  onCashAccountChange: (next: string) => void;
  showBankReference?: boolean;
  bankReference?: string;
  onBankReferenceChange?: (next: string) => void;
  date: string;
  onDateChange: (next: string) => void;
  memo: string;
  onMemoChange: (next: string) => void;
  methodLabel?: string;
  dateLabel?: string;
  datePlaceholder?: string;
}) {
  const money = useMoney();
  return (
    <>
      <Field label="مبلغ" hint={money.unitLabel}>
        <PersianNumberInput
          className={inputClass}
          dir="ltr"
          inputMode="numeric"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder="۰"
        />
      </Field>
      <VoucherMethodPicker value={method} onChange={onMethodChange} label={methodLabel} />
      <CashAccountPicker value={cashAccountId} onChange={onCashAccountChange} method={method} />
      {showBankReference && method !== "cash" ? (
        <Field label={method === "bank" ? "شماره پیگیری بانک (اختیاری)" : "شماره پیگیری (اختیاری)"}>
          <input
            className={inputClass}
            dir="ltr"
            maxLength={MAX_BANK_REFERENCE_LENGTH}
            value={bankReference ?? ""}
            onChange={(e) => onBankReferenceChange?.(e.target.value)}
            aria-label={method === "bank" ? "شماره پیگیری بانک" : "شماره پیگیری"}
          />
        </Field>
      ) : null}
      <Field label={dateLabel}>
        <JalaliDatePicker value={date} onChange={onDateChange} className={inputClass} ariaLabel="تاریخ" placeholder={datePlaceholder} />
      </Field>
      <Field label="شرح (اختیاری)">
        <input className={inputClass} value={memo} onChange={(e) => onMemoChange(e.target.value)} />
      </Field>
    </>
  );
}

/**
 * The shared voucher submission controller (#829 completion): one validation
 * and one key discipline for the register dialog and both subledger settle
 * dialogs. Each dialog keeps its own chrome — the register picks a party,
 * the settle dialogs show a preselected party and its balance — but the
 * rules below are the same act with the sides swapped, so they live once.
 *
 * Retry-key semantics, deliberately:
 * - one key per dialog instance (`useIdempotencyKey`), retained across
 *   retries of the same logical submission — regenerating per attempt would
 *   mint a new voucher on every retry after an ambiguous failure;
 * - a corrected field after a failure rotates the A/P intent key (a new
 *   transfer), while an unchanged retry replays the same key (idempotent);
 * - a reused key with a *different* fingerprint is rejected by the server
 *   (409), never silently re-applied — the dialog shows the refusal;
 * - closing the dialog (success or cancel) drops the keys: the next opening
 *   is a new logical operation with fresh keys.
 *
 * The wire fields stay exactly what the routes already speak —
 * `idempotencyKey` for A/R, `clientRequestId` for A/P — so the server-side
 * callers (AI apply, installment settlement, Holoo import) are untouched:
 * they mint their own stable keys and never render this form.
 */

/** The typed amount, or the Persian message the dialog shows. */
export type ValidatedVoucherAmount = { ok: true; rial: number } | { ok: false; error: string };

export function validateVoucherAmount(money: Pick<MoneyApi, "parse">, amount: string): ValidatedVoucherAmount {
  let rial: number;
  try {
    rial = money.parse(amount);
  } catch {
    return { ok: false, error: errorMessage("invalid_amount") };
  }
  if (rial <= 0) return { ok: false, error: errorMessage("invalid_amount") };
  return { ok: true, rial };
}

/**
 * The retry keys for one dialog instance. A/R takes the stable dialog key;
 * A/P derives its key from the intended transfer — the caller passes every
 * submitted field that defines it, and any material edit rotates the key.
 */
export function useVoucherSubmission(side: "receipt" | "payment"): {
  keyFor: (intent: Record<string, unknown>) => { idempotencyKey?: string; clientRequestId?: string };
} {
  const idempotencyKey = useIdempotencyKey();
  const requestKeyRef = useRef<{ intent: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(intent: Record<string, unknown>) {
        if (side === "receipt") return { idempotencyKey };
        const fingerprint = JSON.stringify(intent);
        if (requestKeyRef.current?.intent !== fingerprint) {
          requestKeyRef.current = { intent: fingerprint, key: newVoucherKey("ap") };
        }
        return { clientRequestId: requestKeyRef.current.key };
      },
    }),
    [side, idempotencyKey],
  );
}

export interface VoucherBodyInput {
  side: "receipt" | "payment";
  partyId: string;
  rial: number;
  method: VoucherMethod;
  /** "" = the method's default account. */
  cashAccountId: string;
  /** Absent for callers without a reference field (the settle dialogs). */
  bankReference?: string;
  /** "" = today. */
  date: string;
  memo: string;
  idempotencyKey?: string;
  clientRequestId?: string;
}

/**
 * The POST body both voucher endpoints speak. Empty optionals are omitted
 * (never sent as ""), so the server's «absent means default» reads hold.
 */
export function buildVoucherBody(input: VoucherBodyInput): Record<string, string | number | undefined> {
  const common = {
    amount: input.rial,
    method: input.method,
    memo: input.memo.trim() || undefined,
    cashAccountId: input.cashAccountId || undefined,
    bankReference: input.bankReference?.trim() || undefined,
  };
  if (input.side === "receipt") {
    return { ...common, customerId: input.partyId, receiptDate: input.date || undefined, idempotencyKey: input.idempotencyKey };
  }
  return { ...common, supplierId: input.partyId, paymentDate: input.date || undefined, clientRequestId: input.clientRequestId };
}

