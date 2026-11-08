"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, inputClass } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { formatRialText } from "@/lib/money";
import type { HistoricalInvoiceRow } from "@/lib/data-transfer/historical-invoice-preview";
import type { HistoricalInvoiceSummary } from "@/lib/data-transfer/historical-invoice-archive-service";

/** Separate, read-only history: never add these amounts to operational totals. */
export function HistoricalInvoiceHistory({ customerId }: { customerId?: string }) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ invoices: HistoricalInvoiceSummary[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError(false);
    const params = new URLSearchParams({ offset: String(offset) });
    if (search) params.set("q", search);
    void api<{ invoices: HistoricalInvoiceSummary[]; hasMore: boolean }>(
      customerId
        ? `/api/crm/customers/${encodeURIComponent(customerId)}/historical-invoices?${params}`
        : `/api/accounting/historical-invoices?${params}`,
      { signal: controller.signal },
    ).then(({ ok, data, aborted }) => {
      if (aborted || controller.signal.aborted) return;
      if (ok && Array.isArray(data.invoices)) setState({ invoices: data.invoices, hasMore: data.hasMore === true });
      else setError(true);
    });
    return () => controller.abort();
  }, [customerId, offset, search, version]);

  return (
    <SectionCard
      title="فاکتورهای فروش قبلی"
      description="واردشده از نرم‌افزار قبلی / سابقه تاریخی؛ در دفتر رسمی، ماندهٔ بدهی و آمار فروش سامانه ثبت نشده است. نمایش فقط برای شعبهٔ فعال است."
    >
      <form className="mb-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(draft.trim()); }}>
        <label className="sr-only" htmlFor="historical-invoice-search">جست‌وجوی فاکتورهای قبلی</label>
        <input id="historical-invoice-search" className={`${inputClass} max-w-xs`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="شناسه، شماره یا منبع" />
        <Button type="submit" variant="outline">جست‌وجو</Button>
      </form>
      {error ? (
        <div className="space-y-2">
          <ErrorBox>بارگذاری فاکتورهای تاریخی ناموفق بود.</ErrorBox>
          <Button type="button" variant="outline" size="sm" onClick={() => setVersion((value) => value + 1)}>تلاش دوباره</Button>
        </div>
      ) : !state ? <LoadingSkeleton rows={3} /> : state.invoices.length === 0 ? (
        <EmptyState>{customerId ? "فاکتور تاریخی برای این مشتری و شعبه یافت نشد." : "فاکتور تاریخی برای این شعبه یافت نشد."}</EmptyState>
      ) : (
        <ul className="divide-y divide-border/80 text-sm">
          {state.invoices.map((invoice) => (
            <li key={invoice.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1 break-words">
                <p className="font-medium">شمارهٔ اصلی: {invoice.invoiceNumber || "—"}</p>
                <p>شناسهٔ اصلی: {invoice.externalId} · منبع: {invoice.sourceKey}</p>
                {!customerId ? <p>شناسهٔ مشتری: {invoice.partyId} · کد مشتری در منبع: {invoice.externalCustomerCode}</p> : null}
                <p className="text-muted-foreground">{formatJalali(invoice.invoiceDate)}{invoice.sourceStatus ? ` · وضعیت منبع: ${invoice.sourceStatus}` : ""}</p>
                <StatusBadge tone="neutral">واردشده از نرم‌افزار قبلی / سابقه تاریخی</StatusBadge>{" "}
                {invoice.summaryOnly ? <StatusBadge tone="neutral">فقط خلاصه، بدون ردیف کالا</StatusBadge> : null}{" "}
                {customerId && invoice.partyId !== customerId ? <StatusBadge tone="neutral">پروندهٔ قبلی ادغام‌شده</StatusBadge> : null}
              </div>
              <div className="text-sm">
                <p>مبلغ کل: {formatRialText(invoice.totalRial)}</p>
                {invoice.paidRial !== null ? <p>پرداختی در منبع: {formatRialText(invoice.paidRial)}</p> : null}
                {invoice.balanceRial !== null ? <p>مانده در منبع: {formatRialText(invoice.balanceRial)}</p> : null}
              </div>
              </div>
              {!invoice.summaryOnly ? <HistoricalInvoiceLines invoice={invoice} customerId={customerId} /> : null}
            </li>
          ))}
        </ul>
      )}
      {state && (offset > 0 || state.hasMore) ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 50))}>صفحهٔ قبل</Button>
          <Button type="button" variant="outline" size="sm" disabled={!state.hasMore} onClick={() => setOffset((value) => value + 50)}>صفحهٔ بعد</Button>
        </div>
      ) : null}
    </SectionCard>
  );
}

function HistoricalInvoiceLines({ invoice, customerId }: { invoice: HistoricalInvoiceSummary; customerId?: string }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ lines: HistoricalInvoiceRow[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState(null);
    setError(false);
    const base = customerId
      ? `/api/crm/customers/${encodeURIComponent(customerId)}/historical-invoices/${encodeURIComponent(invoice.id)}`
      : `/api/accounting/historical-invoices/${encodeURIComponent(invoice.id)}`;
    void api<{ lines: HistoricalInvoiceRow[]; hasMore: boolean }>(`${base}?offset=${offset}`, { signal: controller.signal })
      .then(({ ok, data, aborted }) => {
        if (aborted || controller.signal.aborted) return;
        if (ok && Array.isArray(data.lines)) setState({ lines: data.lines, hasMore: data.hasMore === true });
        else setError(true);
      });
    return () => controller.abort();
  }, [open, offset, version, invoice.id, customerId]);
  const unit = invoice.sourceCurrency === "toman" ? "تومان" : "ریال";
  return (
    <div className="mt-2">
      <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "بستن ردیف‌ها" : "نمایش ردیف‌های فاکتور"}
      </Button>
      {open && (error ? (
        <div className="space-y-2"><ErrorBox>بارگذاری ردیف‌ها ناموفق بود.</ErrorBox><Button type="button" variant="outline" size="sm" onClick={() => setVersion((value) => value + 1)}>تلاش دوباره</Button></div>
      ) : !state ? <LoadingSkeleton rows={2} /> : state.lines.length === 0 ? <EmptyState>ردیفی برای نمایش نیست.</EmptyState> : (
        <>
          <p className="mt-2 text-xs text-muted-foreground">مقادیر ردیف‌ها به واحد اصلی منبع ({unit}) نمایش داده شده‌اند.</p>
          <ul className="mt-1 space-y-2">
            {state.lines.map((line, index) => (
              <li key={`${line.rowNumber}-${index}`} className="rounded-lg border border-border p-2 break-words">
                <p>{line.lineName || "—"}{line.lineSku ? ` · کد کالا: ${line.lineSku}` : ""}{line.lineBarcode ? ` · بارکد: ${line.lineBarcode}` : ""}</p>
                <p>تعداد: {line.quantity || "—"} · قیمت واحد: {line.unitPrice || "—"} {unit}</p>
                {line.lineDiscount ? <p>تخفیف: {line.lineDiscount} {unit}</p> : null}
                {line.lineTax ? <p>مالیات: {line.lineTax} {unit}</p> : null}
              </li>
            ))}
          </ul>
          {(offset > 0 || state.hasMore) ? <div className="mt-2 flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 20))}>ردیف‌های قبل</Button>
            <Button type="button" variant="outline" size="sm" disabled={!state.hasMore} onClick={() => setOffset((value) => value + 20)}>ردیف‌های بعد</Button>
          </div> : null}
        </>
      ))}
    </div>
  );
}
