"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { CustomerSearchField } from "@/app/(app)/crm/customer-search";
import { SupplierPartyPicker } from "@/app/(app)/accounting/supplier-party-picker";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { VENDOR_PURCHASE_STATUS_LABELS, type VendorPurchaseStatus } from "@/lib/agency-vendor-purchase";

type Purchase = { client_name: string; vendor_name: string; id: string; purchase_number: string; description: string; quote_reference: string;
  amount_rial: string; quoted_on: string; status: VendorPurchaseStatus; cost_id: string | null };

export function AgencyVendorPurchases({ projectId, canManage, canBook }: {
  projectId: string; canManage: boolean; canBook: boolean;
}) {
  const money = useMoney();
  const [rows, setRows] = useState<Purchase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<{ id: string; name: string } | null>(null);
  const [vendor, setVendor] = useState({ id: "", name: "" });
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [spentOn, setSpentOn] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<{ purchases?: Purchase[] }>(`/api/agency/vendor-purchases?projectId=${projectId}`, { signal });
      if (result.aborted) return;
      if (!result.ok || !result.data.purchases) { setError("خواندن خریدهای فروشنده ممکن نشد."); return; }
      setRows(result.data.purchases);
    } catch { if (!signal?.aborted) setError("ارتباط با فهرست خریدها برقرار نشد."); }
  }, [projectId]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);

  async function write(url: string, body: unknown) {
    setBusy(true); setError(null);
    try {
      const result = await api<{ error?: string }>(url, { method: "POST", body: JSON.stringify(body) });
      if (result.aborted) return;
      if (!result.ok) {
        setError(result.data.error === "purchase_not_posted"
          ? "سند حسابداری ثبت نشد؛ خرید همچنان تأییدشده است و هزینه‌ای ایجاد نشد."
          : "عملیات انجام نشد؛ وضعیت تأیید، مجوز پروژه، تاریخ و اطلاعات اشخاص را بررسی کنید."); return;
      }
      await load();
      return true;
    } catch { setError("ارتباط قطع شد؛ پیش از تلاش دوباره وضعیت خرید را تازه کنید."); }
    finally { setBusy(false); }
  }
  if (rows === null && !error) return <SectionCardSkeleton />;
  const committed = (rows ?? []).filter(r => r.status === "approved").reduce((sum,r) => sum + Number(r.amount_rial),0);
  return <SectionCard title="پیشنهاد فروشنده و خرید تأییدشده">
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <p className="text-sm text-muted-foreground">پیشنهاد و تأیید خرید، هزینهٔ ثبت‌شده نیستند. تأیید در صف مشترک و به‌دست شخص دیگری انجام می‌شود؛ ثبت پرداختنی عمل حسابداری جداگانه است.</p>
      <p className="text-sm">تعهد تأییدشدهٔ ثبت‌نشده در همین فهرست (حداکثر ۲۰۰ ردیف): {toPersianDigits(money.format(committed, { withUnit: true }))}</p>
      <Link href="/workspace/approvals" className="text-sm text-primary underline">صف تأییدهای مشترک</Link>
      <SecondaryButton disabled={busy} onClick={() => void load()}>تازه‌کردن فهرست</SecondaryButton>
      <DataTable caption="خریدهای فروشندهٔ پروژه">
        <DataTableHead><Th>شماره</Th><Th>مرجع پیشنهاد</Th><Th>کارفرما (نام فعلی)</Th><Th>تأمین‌کننده (نام فعلی)</Th><Th>شرح</Th><Th>مبلغ</Th><Th>تاریخ</Th><Th>وضعیت</Th><Th>عملیات</Th></DataTableHead>
        <DataTableBody>{(rows ?? []).map(row => <DataTableRow key={row.id} id={`vendor-purchase-${row.id}`}>
          <Td>{toPersianDigits(row.purchase_number)}</Td><Td>{row.quote_reference}</Td><Td>{row.client_name}</Td><Td>{row.vendor_name}</Td><Td>{row.description}</Td>
          <Td>{toPersianDigits(money.format(Number(row.amount_rial), { withUnit: true }))}</Td><Td>{formatJalali(row.quoted_on)}</Td>
          <Td>{VENDOR_PURCHASE_STATUS_LABELS[row.status]}</Td><Td>
            {canManage && row.status === "draft" ? <PrimaryButton disabled={busy} onClick={() => void write(`/api/agency/vendor-purchases/${row.id}`, { action: "submit" })}>ارسال برای تأیید خرید</PrimaryButton> : null}
            {canBook && row.status === "approved" ? <PrimaryButton disabled={busy || !spentOn} onClick={() => void write(`/api/agency/vendor-purchases/${row.id}`, { action: "book", spentOn })}>ثبت هزینه در پرداختنی</PrimaryButton> : null}
            {row.status === "booked" ? <span className="text-xs">هزینه به دفتر و فهرست هزینه‌های کارفرما منتقل شد</span> : null}
          </Td>
        </DataTableRow>)}</DataTableBody>
      </DataTable>
      {canBook ? <Field label="تاریخ وقوع هزینه برای ثبت پرداختنی" as="div"><JalaliDatePicker ariaLabel="تاریخ وقوع هزینه برای ثبت پرداختنی" value={spentOn} onChange={setSpentOn} /></Field> : null}
      {canManage ? <form className="space-y-3" onSubmit={async e => {
        e.preventDefault();
        if (!client || !vendor.id || !description.trim() || !reference.trim() || !date || !amount) { setError("کارفرما، تأمین‌کننده، مرجع پیشنهاد، شرح، مبلغ و تاریخ را وارد کنید."); return; }
        const parsedAmount = money.tryParse(amount);
        if (!parsedAmount.ok) { setError(money.problemMessage(parsedAmount.problem)); return; }
        const saved = await write("/api/agency/vendor-purchases", { projectId, partyId: client.id, vendorPartyId: vendor.id,
          description, quoteReference: reference, amountRial: parsedAmount.rial, quotedOn: date });
        if (saved) { setReference(""); setDescription(""); setAmount(""); }
      }}>
        <Field label="کارفرمای خرید" as="div"><CustomerSearchField selectedId={client?.id ?? null} selectedName={client?.name ?? ""}
          onPick={match => setClient({ id: match.id, name: match.name })} onClear={() => setClient(null)} emptyText="کارفرما را انتخاب کنید" /></Field>
        <Field label="تأمین‌کنندهٔ خرید" as="div"><SupplierPartyPicker value={vendor.id} name={vendor.name} onPick={(id,name) => setVendor({ id,name })} /></Field>
        <Field label="مرجع پیشنهاد فروشنده"><input className={inputClass} value={reference} maxLength={200} onChange={e => setReference(e.target.value)} /></Field>
        <Field label="شرح خرید"><input className={inputClass} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} /></Field>
        <Field label={`مبلغ کل پیشنهاد (${money.unitLabel})`} hint="مبلغ نهایی اعلام‌شدهٔ فروشنده؛ مالیات یا کارمزد جدیدی از روی آن محاسبه نمی‌شود."><PersianNumberInput className={inputClass} allowNegative={false} value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="تاریخ پیشنهاد فروشنده" as="div"><JalaliDatePicker ariaLabel="تاریخ پیشنهاد فروشنده" value={date} onChange={setDate} /></Field>
        <PrimaryButton type="submit" disabled={busy}>ثبت پیش‌نویس پیشنهاد فروشنده</PrimaryButton>
      </form> : null}
    </div>
  </SectionCard>;
}
