"use client";

import { useEffect, useMemo, useState } from "react";
import { FilterChip } from "@/app/dashboard/filters";
import { api, Field, inputClass } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { toPersianDigits } from "@/lib/digits";

/**
 * Shared settlement form pieces for issue #829.
 *
 * Recording a receipt and recording a payment are the same act with the sides
 * swapped — amount, method (cash/bank/clearing), an optional explicit
 * settlement account, an optional back-date, an optional memo — but the
 * «دریافت و پرداخت» workspace and the AR/AP subledger settle dialogs each grew
 * their own copy. The copies drifted: one learned back-dating while the other
 * posted today, neither knew the «clearing» method, and neither sent an
 * idempotency key. The shared fields live here once; both dialogs render them.
 */

export type SettlementMethod = "cash" | "bank" | "clearing";

export const SETTLEMENT_METHOD_LABELS: Record<SettlementMethod, string> = {
  cash: "نقدی",
  bank: "بانکی",
  clearing: "اسناد در جریان وصول",
};

export const SETTLEMENT_METHOD_OPTIONS: { value: SettlementMethod; label: string }[] = [
  { value: "cash", label: SETTLEMENT_METHOD_LABELS.cash },
  { value: "bank", label: SETTLEMENT_METHOD_LABELS.bank },
  { value: "clearing", label: SETTLEMENT_METHOD_LABELS.clearing },
];

/**
 * One idempotency key per dialog instance. Generated when the dialog opens and
 * kept across retries of the same submission — regenerating on every attempt
 * would defeat the point (each retry would be a new logical voucher). A fresh
 * dialog (after success or cancel) gets a fresh key.
 */
export function useIdempotencyKey(): string {
  const [key] = useState(() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  });
  return key;
}

export function SettlementMethodPicker({
  value,
  onChange,
  label = "روش",
}: {
  value: SettlementMethod;
  onChange: (next: SettlementMethod) => void;
  label?: string;
}) {
  return (
    <div className="mb-4">
      <p className="mb-1 text-sm font-medium text-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">
        {SETTLEMENT_METHOD_OPTIONS.map((opt) => (
          <FilterChip key={opt.value} dense selected={value === opt.value} onClick={() => onChange(opt.value)}>
            {opt.label}
          </FilterChip>
        ))}
      </div>
      {/*
       * «بانکی» posts to the bank account (1110); deferred instruments that
       * have not cleared yet use «اسناد در جریان وصول» (1120). The old
       * workspace labeled every bank voucher «بانکی» while posting it to the
       * clearing account — the label below the picker keeps the two honest.
       */}
      <p className="mt-1 text-xs text-muted-foreground">
        {value === "cash" && "ثبت در حساب صندوق"}
        {value === "bank" && "ثبت در حساب بانک"}
        {value === "clearing" && "ثبت در حساب اسناد در جریان وصول"}
      </p>
    </div>
  );
}

interface SettlementAccountOption {
  id: string;
  code: string;
  name: string;
}

/**
 * Optional explicit settlement account. Empty means «method default» — the
 * server maps cash→1100, bank→1110, clearing→1120. Only active asset accounts
 * under 11xx are offered; the server re-validates, so a crafted id cannot post
 * a receipt against e.g. an expense account.
 */
export function SettlementAccountPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [accounts, setAccounts] = useState<SettlementAccountOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ accounts?: { id: string; code: string; name: string; type: string }[] }>("/api/ledger/accounts").then(
      ({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setFailed(true);
          return;
        }
        setAccounts(
          (data.accounts ?? [])
            .filter((a) => a.type === "asset" && a.code.startsWith("11"))
            .map((a) => ({ id: a.id, code: a.code, name: a.name })),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () => [
      { value: "", label: "پیش‌فرض روش (صندوق / بانک / اسناد در جریان وصول)" },
      ...(accounts ?? []).map((a) => ({
        value: a.id,
        label: `${toPersianDigits(a.code)} · ${a.name}`,
        searchString: `${a.code} ${a.name}`,
      })),
    ],
    [accounts],
  );

  return (
    <Field label="حساب تسویه (اختیاری)">
      <SearchableSelect
        value={value}
        onChange={onChange}
        ariaLabel="انتخاب حساب تسویه"
        loading={accounts === null && !failed}
        disabled={failed}
        options={options}
      />
      {failed ? <p className="mt-1 text-xs text-destructive">لیست حساب‌ها بارگذاری نشد؛ از پیش‌فرض روش استفاده می‌شود.</p> : null}
    </Field>
  );
}

/**
 * The amount + method + settlement account + date + memo block shared by the
 * voucher dialog and the subledger settle dialog. Party selection stays with
 * the callers: the voucher dialog picks a party, the settle dialog already has
 * one.
 */
export function SettlementFormFields({
  amount,
  onAmountChange,
  method,
  onMethodChange,
  settlementAccountId,
  onSettlementAccountChange,
  date,
  onDateChange,
  memo,
  onMemoChange,
  methodLabel,
  dateLabel = "تاریخ (اختیاری)",
}: {
  amount: string;
  onAmountChange: (next: string) => void;
  method: SettlementMethod;
  onMethodChange: (next: SettlementMethod) => void;
  settlementAccountId: string;
  onSettlementAccountChange: (next: string) => void;
  date: string;
  onDateChange: (next: string) => void;
  memo: string;
  onMemoChange: (next: string) => void;
  methodLabel?: string;
  dateLabel?: string;
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
      <SettlementMethodPicker value={method} onChange={onMethodChange} label={methodLabel} />
      <SettlementAccountPicker value={settlementAccountId} onChange={onSettlementAccountChange} />
      <Field label={dateLabel}>
        <JalaliDatePicker value={date} onChange={onDateChange} className={inputClass} ariaLabel="تاریخ" />
      </Field>
      <Field label="شرح (اختیاری)">
        <input className={inputClass} value={memo} onChange={(e) => onMemoChange(e.target.value)} />
      </Field>
    </>
  );
}
