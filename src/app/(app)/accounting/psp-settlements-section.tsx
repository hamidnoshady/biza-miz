"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import type { FinancialAccountRecord } from "@/lib/financial-accounts";
import { formatJalali } from "@/lib/jalali";
import type { PspSettlementMovement } from "@/lib/psp-settlements-posting";
import { accountingSectionHref } from "./accounting-routes";

interface FeeAccount { id: string; name: string; type: string; is_postable: boolean }
interface Page { movements: PspSettlementMovement[]; nextCursor: string | null }

const SETTLEMENT_ERRORS: Record<string, string> = {
  invalid_psp_reference: "شناسه‌های دسته و واریز را از صورت‌حساب وارد کنید.",
  invalid_psp_amount: "مبلغ کل دسته، مبلغ خالص و کارمزد را بررسی کنید.",
  invalid_psp_fee_account: "برای کارمزد غیرصفر یک حساب هزینه انتخاب کنید.",
  psp_batch_conflict: "مبلغ کل یا مشخصات این دسته با ثبت قبلی مطابقت ندارد.",
  psp_batch_amount_exceeded: "مبلغ این تسویه از ماندهٔ دسته بیشتر است.",
  psp_insufficient_clearing: "ماندهٔ وجوه در راه پایانه برای این تسویه کافی نیست.",
  psp_terminal_not_configured: "اطلاعات پذیرنده، پایانه و شرکت پرداخت را تکمیل کنید.",
  psp_settlement_bank_mismatch: "بانک مقصد با حساب تسویهٔ پایانه مطابقت ندارد.",
  psp_settlement_gl_mismatch: "حساب‌های دفتر کل پایانه و بانک را بررسی کنید.",
  psp_settlement_requires_irr: "تسویهٔ پایانه فقط برای حساب‌های ریالی امکان‌پذیر است.",
  idempotency_conflict: "این شناسهٔ واریز قبلاً با جزئیات دیگری ثبت شده است.",
};

export function PspSettlementsSection({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [rows, setRows] = useState<PspSettlementMovement[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<FinancialAccountRecord[]>([]);
  const [fees, setFees] = useState<FeeAccount[]>([]);
  const [terminalId, setTerminalId] = useState("");
  const [settledOn, setSettledOn] = useState("");
  const [expectedOn, setExpectedOn] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const terminal = terminals.find(({ id }) => id === terminalId);
  const refresh = useCallback(async (after?: string) => {
    const { ok, data } = await api<Page>(`/api/ledger/psp-settlements${after ? `?cursor=${encodeURIComponent(after)}` : ""}`);
    if (!ok || !data) { setError(errorMessage("load_failed")); return; }
    setRows((previous) => after ? [...previous, ...data.movements] : data.movements);
    setCursor(data.nextCursor);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!canManage) return;
    void api<{ accounts: FinancialAccountRecord[] }>("/api/ledger/financial-accounts?kind=pos_psp&status=active").then(({ ok, data }) => {
      if (ok && data) setTerminals(data.accounts.filter((account) => account.settlementAccountId));
    });
    void api<{ accounts: FeeAccount[] }>("/api/ledger/accounts").then(({ ok, data }) => {
      if (ok && data) setFees(data.accounts.filter((account) => account.type === "expense" && account.is_postable));
    });
  }, [canManage]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!terminal?.settlementAccountId) return;
    setSaving(true);
    setError("");
    try {
      const values = Object.fromEntries(data.entries());
      try {
        values.batchGrossAmount = money.parseText(String(values.batchGrossAmount));
        values.netAmount = money.parseText(String(values.netAmount));
        values.feeAmount = String(values.feeAmount).trim() ? money.parseText(String(values.feeAmount)) : "0";
      } catch {
        setError(SETTLEMENT_ERRORS.invalid_psp_amount);
        return;
      }
      const result = await api<{ error?: string }>("/api/ledger/psp-settlements", {
        method: "POST",
        body: JSON.stringify({ ...values, terminalAccountId: terminal.id, bankAccountId: terminal.settlementAccountId,
          settledOn, expectedOn: expectedOn || null }),
      });
      if (!result.ok) {
        const code = result.data?.error ?? "save_failed";
        setError(SETTLEMENT_ERRORS[code] ?? errorMessage(code));
        return;
      }
      form.reset();
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="تسویه پایانه‌ها و درگاه‌ها">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {canManage ? (
        <form className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={save}>
          <Field label="پایانه">
            <select required className={inputClass} value={terminalId} onChange={(event) => setTerminalId(event.target.value)}>
              <option value="">انتخاب کنید</option>
              {terminals.map(({ id, name, settlementAccountName }) => (
                <option value={id} key={id}>{name} — {settlementAccountName}</option>
              ))}
            </select>
          </Field>
          <Field label="شناسه دسته تسویه"><input className={inputClass} name="batchReference" required /></Field>
          <Field label="شناسه واریز"><input className={inputClass} name="movementReference" required /></Field>
          <Field label={`مبلغ کل دسته (${money.unitLabel})`}><input className={inputClass} name="batchGrossAmount" inputMode="numeric" required /></Field>
          <Field label={`مبلغ واریز (${money.unitLabel})`}><input className={inputClass} name="netAmount" inputMode="numeric" required /></Field>
          <Field label={`کارمزد تأییدشده (${money.unitLabel})`}><input className={inputClass} name="feeAmount" inputMode="numeric" /></Field>
          <Field label="سرفصل کارمزد"><select className={inputClass} name="feeAccountId"><option value="">بدون کارمزد</option>
            {fees.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
          </select></Field>
          <Field label="تاریخ واریز" as="div"><JalaliDatePicker value={settledOn} onChange={setSettledOn} ariaLabel="تاریخ واریز" /></Field>
          <Field label="تاریخ مورد انتظار" as="div"><JalaliDatePicker value={expectedOn} onChange={setExpectedOn} ariaLabel="تاریخ مورد انتظار" /></Field>
          <div><PrimaryButton type="submit" disabled={saving || !terminal || !settledOn}>ثبت واریز تأییدشده</PrimaryButton></div>
        </form>
      ) : null}
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.transferId} className="py-2 text-sm">
            <div className="font-semibold">{row.terminalName} — {row.bankName}</div>
            <div>{row.batchReference} / {row.movementReference} · {formatJalali(row.settledOn)}</div>
            <div>واریز {money.formatText(row.netAmount)} · کارمزد {money.formatText(row.feeAmount)} · مانده دسته {money.formatText(row.remainingAmount)}</div>
            {row.expectedOn ? (
              <div>موعد واریز {formatJalali(row.expectedOn)}{row.settledOn > row.expectedOn ? " · با تأخیر" : ""}</div>
            ) : null}
            <Link className="text-primary underline-offset-4 hover:underline"
              href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(row.journalEntryId)}`}>
              مشاهدهٔ سند {row.transferNumber}
            </Link>
            {row.status === "reversed" ? <div>برگشت داده شده</div> : null}
          </li>
        ))}
      </ul>
      {cursor ? <SecondaryButton onClick={() => void refresh(cursor)}>نمایش بیشتر</SecondaryButton> : null}
    </SectionCard>
  );
}
