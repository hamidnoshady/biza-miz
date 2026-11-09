"use client";

import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { PaymentSourceOption } from "@/lib/financial-payment-sources";
import { api } from "./ui";

export function PurchasePaymentAccountSelect({ method, value, onChange }: {
  method: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [options, setOptions] = useState<PaymentSourceOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void api<{ options?: PaymentSourceOption[] }>("/api/ledger/financial-accounts/payment-sources?role=purchase").then(({ ok, data }) => {
      if (!current) return;
      if (ok) setOptions(data.options ?? []);
      else setFailed(true);
    });
    return () => { current = false; };
  }, []);

  if (failed) return <p role="alert" className="text-xs text-muted-foreground">بارگذاری حساب‌های پرداخت ناموفق بود.</p>;
  if (!options) return <p role="status" className="text-xs text-muted-foreground">در حال بارگذاری حساب‌های پرداخت…</p>;
  const choices = options.flatMap((option) => option.kind === method && option.financialAccountId ? [{
    value: option.financialAccountId,
    label: `${option.financialAccountName ?? option.accountName} (${option.accountCode})`,
  }] : []);
  if (!choices.length) return null;
  return <div className="grid gap-1 text-xs font-medium">
    <span>حساب پرداخت</span>
    <SearchableSelect value={value} onChange={onChange} options={choices} ariaLabel="حساب پرداخت" placeholder="انتخاب حساب پرداخت" />
  </div>;
}
