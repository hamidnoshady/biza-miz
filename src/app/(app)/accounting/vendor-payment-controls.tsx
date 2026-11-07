"use client";

import { useState } from "react";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox, Field, inputClass, PrimaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { normalizeAgencyCostDate } from "@/lib/agency-reimbursable-cost";

export type VendorPaymentCost = {
  id: string; costNumber: string; vendorName: string; amountRial: number;
  posted: boolean; settledBy: string; settled?: boolean;
  settlementId?: string | null; settlementNumber?: string | null;
};

const ERRORS: Record<string, string> = {
  cost_already_settled: "این هزینه قبلاً پرداخت شده است؛ فهرست را تازه کنید.",
  cost_not_posted: "هزینه هنوز در دفتر ثبت نشده است.",
  cost_not_payable: "این هزینه از حساب پرداختنی ثبت نشده است.",
  settlement_already_reversed: "این پرداخت قبلاً برگشت خورده است.",
  settlement_not_posted: "سند در دفتر ثبت نشد؛ هیچ تغییری انجام نشد.",
  settlement_not_found: "پرداخت پیدا نشد یا به این کسب‌وکار تعلق ندارد.",
  invalid_date: "تاریخ معتبر میلادی را با انتخابگر تاریخ وارد کنید.",
  fiscal_period_locked: "دورهٔ مالی بسته است؛ تاریخ یک دورهٔ باز را انتخاب کنید.",
};

/** A separate payable-management authority; expense writers cannot move cash. */
export function VendorPaymentControls({ costs, onChanged }: {
  costs: VendorPaymentCost[]; onChanged: () => void;
}) {
  const money = useMoney();
  const [costId, setCostId] = useState("");
  const [method, setMethod] = useState("bank");
  const [date, setDate] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const eligible = costs.filter(c => c.posted && c.settledBy === "payable" && !c.settled && c.vendorName.trim());
  const payments = [...new Map(costs.filter(c => c.settled && c.settlementId).map(c => [c.settlementId!, c])).values()];
  const selected = eligible.find(c => c.id === costId);

  async function submit(reverse: boolean) {
    if (busy) return;
    setError(null); setNotice(null);
    if (!normalizeAgencyCostDate(date)) { setError(ERRORS.invalid_date); return; }
    if (reverse ? !paymentId || !confirmed : !selected) return;
    setBusy(true);
    try {
      const result = await api<{ error?: string; settlement?: { settlementNumber: string }; reversal?: { reversalEntryId: string } }>(
        reverse ? `/api/agency/vendor-settlements/${paymentId}/reverse` : "/api/agency/reimbursable-costs/settle",
        { method: "POST", body: JSON.stringify(reverse ? { reversedOn: date } : { costIds: [costId], method, paidOn: date }) },
      );
      if (result.aborted) return;
      if (!result.ok || (reverse ? !result.data.reversal : !result.data.settlement)) {
        setError(ERRORS[result.data.error ?? ""] ?? "عملیات انجام نشد؛ فهرست و وضعیت دورهٔ مالی را بررسی کنید."); return;
      }
      setNotice(reverse ? "پرداخت برگشت خورد؛ هزینه‌ها دوباره قابل پرداخت‌اند." : `پرداخت شمارهٔ ${result.data.settlement!.settlementNumber} ثبت شد.`);
      setCostId(""); setPaymentId(""); setConfirmed(false); onChanged();
    } catch {
      setError("ارتباط قطع شد؛ پیش از تلاش دوباره، فهرست را تازه کنید و وضعیت پرداخت را بررسی کنید.");
    } finally { setBusy(false); }
  }

  return <SectionCard title="تسویهٔ پرداختنی رسانه و تولید">
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">پرداخت بدهی به فروشنده، مستقل از بازدریافت از کارفرماست. فقط هزینه‌های ثبت‌شده با روش پرداختنی و نام فروشنده قابل پرداخت‌اند. فهرست محدود به هزینه‌های بارگذاری‌شده است.</p>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{toPersianDigits(notice)}</InfoBox> : null}
      <Field label="تاریخ پرداخت یا برگشت"><input type="date" className={inputClass} value={date} onChange={e => setDate(e.target.value)} disabled={busy} /></Field>
      <Field label="هزینهٔ قابل پرداخت"><select className={inputClass} value={costId} onChange={e => setCostId(e.target.value)} disabled={busy}>
        <option value="">انتخاب هزینه</option>
        {eligible.map(c => <option key={c.id} value={c.id}>{toPersianDigits(c.costNumber)} — {c.vendorName} — {money.format(c.amountRial, { withUnit: true })}</option>)}
      </select></Field>
      <Field label="روش پرداخت به فروشنده"><select className={inputClass} value={method} onChange={e => setMethod(e.target.value)} disabled={busy}>
        <option value="bank">بانکی</option><option value="cash">نقدی</option>
      </select></Field>
      <PrimaryButton disabled={busy || !selected || !date} onClick={() => void submit(false)}>ثبت پرداخت به فروشنده</PrimaryButton>
      <Field label="پرداخت برای برگشت"><select className={inputClass} value={paymentId} onChange={e => { setPaymentId(e.target.value); setConfirmed(false); }} disabled={busy}>
        <option value="">انتخاب پرداخت</option>
        {payments.map(c => <option key={c.settlementId} value={c.settlementId!}>{toPersianDigits(c.settlementNumber ?? "")} — {c.vendorName}</option>)}
      </select></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} />تأیید می‌کنم کل پرداخت انتخاب‌شده برگشت بخورد، نه فقط یک هزینهٔ آن.</label>
      <PrimaryButton disabled={busy || !paymentId || !confirmed || !date} onClick={() => void submit(true)}>برگشت کل پرداخت</PrimaryButton>
    </div>
  </SectionCard>;
}
