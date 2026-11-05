"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { LoadingSkeleton, SectionCard, StatusBadge, TabBar, TabPanel } from "@/app/dashboard/page-chrome";
import { DataTable, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, InfoBox, inputClass } from "@/app/dashboard/ui";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import type { WooOrderDetail } from "@/lib/integrations/woo-order-detail-service";
import { formatWooMoney, wooAddressText, wooRecipientName } from "@/lib/integrations/woo-order-snapshot";
import { printWooOrder, type PrintResult } from "@/lib/printing/client";
import type { WooPrintDocumentRef } from "@/lib/printing/document-request";
import { printerErrorMessage } from "@/lib/printing/errors";
import { PAPERS, type PaperKey } from "@/lib/print-template";
import { formatDateTime } from "./format";
import { orderStatusLabel } from "./order-status";
import { OrderStatusBadge } from "./order-status-badge";

// Most-used first: the summary answers "who, what, how much, what next" without
// a click; the technical source/version record is the second-to-last tab.
const TABS = [
  { key: "summary", label: "خلاصه" }, { key: "items", label: "اقلام و مبالغ" },
  { key: "shipping", label: "مشتری و ارسال" }, { key: "payment", label: "پرداخت و وضعیت" },
  { key: "history", label: "سوابق و منبع" }, { key: "print", label: "چاپ" },
] as const;
type Tab = typeof TABS[number]["key"];
type WooDoc = "shipping_label" | "woo_invoice";
const DOC_LABELS = { shipping_label: "برچسب ارسال", woo_invoice: "فاکتور" };
const JOB_STATUS: Record<string, string> = { pending: "در صف", processing: "در حال پردازش", processed: "پردازش‌شده", dead_letter: "نیازمند بررسی", sending: "در حال ارسال", handed_off: "تحویل به صف چاپگر", failed: "ناموفق" };
interface TemplateChoice { id: string | null; key: string; name: string; docType: WooDoc; paper: PaperKey; }
interface PrintOptions {
  plans: Record<WooDoc, { ok: boolean; error?: string; printerName?: string; templateName?: string; paper?: PaperKey }>;
  printers: { id: string; name: string; paper: PaperKey; documentTypes: WooDoc[] }[];
  templates: TemplateChoice[];
  jobs: { id: string; document_type: WooDoc; status: string; error_code: string | null; printer_name: string; template_name: string; template_version: number; source_revision: string; initiated_by: string | null; print_request_id: string | null; created_at: string }[];
}
interface DetailResponse { detail?: WooOrderDetail; canPrint?: boolean; printing?: PrintOptions | null; error?: string; }
interface Preview { imageBase64: string; paper: { key: PaperKey; widthMm: number; heightMm: number }; templateName: string; printerName: string; }

/** One overlay, no route/search/store changes. Server references are the entire print intent. */
export function WooOrderDetailModal({ connectionId, remoteId, onClose, onRefund, statusChoices, statusRegistry = null, canChangeStatus = true, onChangeStatus }: {
  connectionId: string; remoteId: string; onClose: () => void; onRefund?: () => void;
  /** Statuses the order can move to (the store's own included). Omit to hide the control. */
  statusChoices?: readonly string[];
  /** The store's registered status names, so a custom status reads as the owner named it (#1215 / P1‑3). */
  statusRegistry?: ReadonlyMap<string, string> | null;
  canChangeStatus?: boolean;
  /** Queues the change; resolves true when it was queued, so the modal can reload the order. */
  onChangeStatus?: (status: string) => Promise<boolean>;
}) {
  const { unit: displayUnit } = useMoney();
  const [response, setResponse] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("summary");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  // The list action is outside DialogTrigger; restore it explicitly on dismiss.
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [printers, setPrinters] = useState<Record<WooDoc, string>>({ shipping_label: "", woo_invoice: "" });
  const [templates, setTemplates] = useState<Record<WooDoc, string>>({ shipping_label: "", woo_invoice: "" });
  const [copies, setCopies] = useState("1");
  const [packageCount, setPackageCount] = useState("1");
  const [shipmentIndex, setShipmentIndex] = useState("");
  const [mode, setMode] = useState<WooDoc | "both">("both");
  const [invoiceFirst, setInvoiceFirst] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<WooDoc>("shipping_label");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [lastJob, setLastJob] = useState<{ type: WooDoc; result: PrintResult } | null>(null);
  const detail = response?.detail;
  const printing = response?.printing;
  const canPrint = response?.canPrint === true;
  const o = detail?.order;
  const missingShipping = Boolean(o?.missingShipping.length);
  const needsShipmentChoice = (o?.shipments.length ?? 0) > 1 && shipmentIndex === "";
  const labelBlocked = missingShipping || needsShipmentChoice;

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setError(""); setPreview(null);
    const result = await api<DetailResponse>(`/api/integrations/connections/${connectionId}/store/orders/${encodeURIComponent(remoteId)}`, { signal: controller.signal, cache: "no-store" });
    if (result.aborted) return;
    if (result.ok && result.data.detail) setResponse(result.data);
    else { setResponse(null); setError(printerErrorMessage(result.data.error)); }
    setLoading(false);
  }, [connectionId, remoteId]);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);

  function refFor(doc: WooDoc, packageIndex = 1): WooPrintDocumentRef {
    return { kind: doc === "woo_invoice" ? "woo-order-invoice" : "woo-order-shipping-label", connectionId, remoteId,
      snapshotId: detail!.snapshotId,
      ...(doc === "shipping_label" ? { packageIndex, packageCount: Number(packageCount),
        ...(shipmentIndex !== "" ? { shipmentIndex: Number(shipmentIndex) } : {}) } : {}),
    };
  }
  function choices(doc: WooDoc) {
    const choice = templates[doc];
    return { printerId: printers[doc] || null, templateId: choice.startsWith("id:") ? choice.slice(3) : null,
      templateKey: choice.startsWith("key:") ? choice.slice(4) : null };
  }
  function validCounts(): boolean {
    return /^\d+$/.test(copies) && Number(copies) >= 1 && Number(copies) <= 10 &&
      /^\d+$/.test(packageCount) && Number(packageCount) >= 1 && Number(packageCount) <= 100;
  }
  async function runPrint(selection: WooDoc | "both", reprint = false) {
    if (busyRef.current || !detail || !canPrint) return;
    if (!validCounts()) { setError("تعداد نسخه باید بین ۱ تا ۱۰ و تعداد بسته بین ۱ تا ۱۰۰ باشد."); return; }
    if ((selection === "shipping_label" || selection === "both") && labelBlocked) { setTab("print"); return; }
    // A failed/unknown handoff may already have printed. Any matching prior
    // attempt requires an explicit reprint decision, not only handed_off rows.
    const previousAttempt = (lastJob && (selection === "both" || lastJob.type === selection)) ||
      printing?.jobs.some(j => selection === "both" || j.document_type === selection);
    if ((reprint || previousAttempt) && !window.confirm("چاپ مجدد نسخهٔ نمایش‌داده‌شده انجام شود؟ خروجی قبلی چاپگر را بررسی کنید.")) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    const requestId = `woo:${connectionId}:${remoteId}:${crypto.randomUUID()}`;
    const docs: WooDoc[] = selection === "both" ? (invoiceFirst ? ["woo_invoice", "shipping_label"] : ["shipping_label", "woo_invoice"]) : [selection];
    let completed = 0;
    try {
      for (const doc of docs) {
        for (let pkg = 1; pkg <= (doc === "shipping_label" ? Number(packageCount) : 1); pkg++) {
          for (let copy = 1; copy <= Number(copies); copy++) {
            const result = await printWooOrder(refFor(doc, pkg), { ...choices(doc), requestId: `${requestId}:${doc}:${pkg}:${copy}` });
            setLastJob({ type: doc, result });
            if (!result.ok) {
              setError(`${DOC_LABELS[doc]}: ${printerErrorMessage(result.error)}${result.ambiguous ? " وضعیت تحویل نامشخص است؛ پیش از چاپ مجدد، خروجی را بررسی کنید." : ""}`);
              setNotice(`${formatPersianNumber(completed)} سند قبلی به صف چاپ تحویل شد. برای جلوگیری از تکرار، فقط سند ناموفق را مجدداً انتخاب کنید.`);
              return;
            }
            completed++;
          }
        }
      }
      setNotice(`${formatPersianNumber(completed)} سند به صف چاپگر تحویل شد؛ خروج فیزیکی کاغذ را بررسی کنید. سفارش و حسابداری تغییری نکرد.`);
    } catch { setError("نتیجهٔ ارسال مشخص نیست؛ پیش از چاپ مجدد، چاپگر و سوابق را بررسی کنید."); }
    finally {
      // Refresh history only: do not silently replace the operator's selected source revision.
      const refreshed = await api<DetailResponse>(`/api/integrations/connections/${connectionId}/store/orders/${encodeURIComponent(remoteId)}`, { cache: "no-store" });
      if (refreshed.ok && refreshed.data.printing) {
        const jobs = refreshed.data.printing.jobs;
        setResponse(previous => previous?.printing ? { ...previous, printing: { ...previous.printing, jobs } } : previous);
      }
      busyRef.current = false; setBusy(false);
    }
  }
  async function showPreview() {
    if (busyRef.current || !detail || !canPrint || (previewDoc === "shipping_label" && labelBlocked)) return;
    if (!validCounts()) { setError("تعداد نسخه یا بسته معتبر نیست."); return; }
    busyRef.current = true; setBusy(true); setError(""); setPreview(null);
    try {
      const result = await api<Preview & { error?: string }>("/api/printing/preview", { method: "POST", body: JSON.stringify({ document: refFor(previewDoc), documentType: previewDoc, ...choices(previewDoc) }) });
      if (result.ok) setPreview(result.data); else setError(printerErrorMessage(result.data.error));
    } finally { busyRef.current = false; setBusy(false); }
  }
  const money = (a: string) => o ? formatWooMoney(a, o.currency, o.decimals, displayUnit) : "—";

  return (
    <Dialog open onOpenChange={open => { if (!open && !busyRef.current) onClose(); }}>
      <DialogContent dir="rtl" className="flex h-[min(90dvh,52rem)] flex-col sm:max-w-4xl" showCloseButton={false}
        onCloseAutoFocus={event => { event.preventDefault(); if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus(); }}>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>سفارش #{toPersianDigits(o?.number ?? remoteId)}</span>
              {o ? <OrderStatusBadge status={o.status} registry={statusRegistry} /> : null}
            </DialogTitle>
            <DialogDescription>
              {o ? `${wooRecipientName(o.billing) || "مهمان"} · ${formatDateTime(o.createdAt)} · ${detail?.storeName ?? ""}` : "جزئیات سفارش ووکامرس"}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>بستن</Button>
        </header>
        {loading ? <LoadingSkeleton rows={5} label="در حال بارگذاری جزئیات سفارش" /> : null}
        {!loading && !detail ? <><ErrorBox>{error}</ErrorBox><Button variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
        {!loading && detail && o ? <>
          <dl className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="خلاصهٔ مبالغ سفارش">
            {([["جمع سفارش", money(o.total)], ["پرداخت‌شده", money(o.paid)], ["مانده", money(o.due)], ["اقلام", formatPersianNumber(o.lines.length)]] as const).map(([label, value]) =>
              <div key={label} className="rounded-xl border border-border/70 bg-muted/40 px-3 py-2"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="mt-0.5 text-sm font-bold">{value}</dd></div>)}
          </dl>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="اقدام‌های سفارش">
            {statusChoices && onChangeStatus ? <label className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">تغییر وضعیت</span>
              <select className={`${inputClass} h-8 w-auto py-0.5 text-xs`} aria-label="تغییر وضعیت سفارش" value={o.status} disabled={busy || !canChangeStatus}
                onChange={e => { const next = e.target.value; if (next === o.status) return; busyRef.current = true; setBusy(true); setError(""); setNotice("");
                  void onChangeStatus(next).then(queued => { if (queued) { setNotice(`تغییر وضعیت به «${orderStatusLabel(next, statusRegistry)}» در صف قرار گرفت؛ پس از اجرا روی فروشگاه، سفارش را بازخوانی کنید.`); return load(); } }).finally(() => { busyRef.current = false; setBusy(false); }); }}>
                {[...new Set([o.status, ...statusChoices])].filter(Boolean).map(status => <option key={status} value={status}>{orderStatusLabel(status, statusRegistry)}</option>)}
              </select>
            </label> : null}
            {onRefund ? <Button size="sm" variant="outline" disabled={busy} onClick={onRefund}>ثبت برگشت وجه</Button> : null}
            <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
            <Button size="sm" disabled={busy || !canPrint || labelBlocked} onClick={() => void runPrint("shipping_label")}>چاپ برچسب ارسال</Button>
            <Button size="sm" disabled={busy || !canPrint} onClick={() => void runPrint("woo_invoice")}>چاپ فاکتور</Button>
            <Button size="sm" variant="outline" disabled={busy || !canPrint || labelBlocked} onClick={() => void runPrint("both")}>چاپ هر دو</Button>
          </div>
          {o.warnings.length ? <InfoBox>{o.warnings.join(" · ")}</InfoBox> : null}
          {missingShipping ? <InfoBox>برچسب ارسال غیرفعال است. اطلاعات ناقص: {o.missingShipping.join("، ")}. پس از تأیید و اصلاح در ووکامرس، سفارش را همگام‌سازی و بازخوانی کنید؛ چاپ، نشانی ووکامرس را تغییر نمی‌دهد.</InfoBox> : null}
          {needsShipmentChoice ? <InfoBox>چند مرسوله ثبت شده است؛ مرسولهٔ موردنظر را در تب چاپ انتخاب کنید.</InfoBox> : null}
          <ErrorBox>{error}</ErrorBox>
          {notice ? <p className="text-xs" role="status">{notice}</p> : null}
          <TabBar idPrefix="woo-detail" label="بخش‌های جزئیات سفارش" tabs={TABS} active={tab} onChange={setTab}
            className="shrink-0 overflow-x-auto [&>div]:flex [&>div]:w-max [&>div]:flex-nowrap [&_button]:shrink-0" />
          <div className="min-h-0 overflow-y-auto">
            <TabPanel idPrefix="woo-detail" active={tab}>
              {tab === "summary" ? <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <SectionCard title="مشتری"><Details rows={[["نام", wooRecipientName(o.billing) || "مهمان"], ["تلفن", o.billing.phone], ["ایمیل", o.billing.email], ["ثبت حسابداری", detail.localOrderNumber ? `فاکتور ${toPersianDigits(detail.localOrderNumber)}` : "ثبت نشده — چاپ همچنان ممکن است"]]} /></SectionCard>
                  <SectionCard title="ارسال"><Details rows={[["گیرنده", wooRecipientName(o.shipping) || wooRecipientName(o.billing)], ["نشانی", wooAddressText(o.shipping) || wooAddressText(o.billing)], ["روش ارسال", o.shippingMethods.join("، ")], ["رهگیری", o.shipments.map(s => [s.provider, s.trackingId].filter(Boolean).join(": ")).join("، ") || "ثبت نشده"]]} /></SectionCard>
                </div>
                <SectionCard title="اقلام"
                  actions={o.lines.length > 5 ? <Button size="xs" variant="ghost" onClick={() => setTab("items")}>همهٔ {formatPersianNumber(o.lines.length)} قلم</Button> : undefined}>
                  <ul className="divide-y divide-border/60 text-sm">{o.lines.slice(0, 5).map((line, i) => <li key={`${line.id}-${i}`} className="flex items-baseline justify-between gap-3 py-1.5"><span className="min-w-0 truncate">{line.name}{line.sku ? <span className="text-xs text-muted-foreground" dir="ltr"> · {line.sku}</span> : null}</span><span className="shrink-0 text-xs text-muted-foreground">{formatPersianNumber(line.quantity)} × {money(line.unitPrice)}</span></li>)}</ul>
                </SectionCard>
                {o.customerNote ? <InfoBox>یادداشت مشتری: {o.customerNote}</InfoBox> : null}
              </div> : null}
              {tab === "shipping" ? <div className="space-y-3">
                <SectionCard title="مشتری و صورتحساب"><Details rows={[["نام", wooRecipientName(o.billing) || "مهمان"], ["شرکت", o.billing.company], ["تلفن", o.billing.phone], ["ایمیل", o.billing.email], ["نشانی", wooAddressText(o.billing)]]} /></SectionCard>
                <SectionCard title="گیرنده و ارسال"><Details rows={[["گیرنده", wooRecipientName(o.shipping)], ["شرکت", o.shipping.company], ["تلفن", o.shipping.phone], ["نشانی", wooAddressText(o.shipping)], ["روش ارسال", o.shippingMethods.join("، ")], ["رهگیری", o.shipments.map(s => [s.provider, s.trackingId].filter(Boolean).join(": ")).join("، ") || "ثبت نشده"], ["یادداشت مشتری", o.customerNote]]} /></SectionCard>
              </div> : null}
              {tab === "items" ? <div className="space-y-3">
                <DataTable caption="اقلام سفارش ووکامرس"><thead><tr><Th>کالا / تنوع / SKU</Th><Th numeric>تعداد</Th><Th numeric>قیمت واحد</Th><Th numeric>تخفیف</Th><Th numeric>مالیات</Th><Th numeric>جمع بدون مالیات</Th></tr></thead><tbody>
                  {o.lines.map((line, i) => <tr key={`${line.id}-${i}`}><Td>{line.name}<p className="text-xs text-muted-foreground">{line.sku} {line.variation} {line.variationId !== "0" ? toPersianDigits(line.variationId) : ""}</p></Td><Td numeric>{formatPersianNumber(line.quantity)}</Td><Td numeric>{money(line.unitPrice)}</Td><Td numeric>{money(line.discount)}</Td><Td numeric>{money(line.tax)}</Td><Td numeric>{money(line.total)}</Td></tr>)}
                </tbody></DataTable>
                <Details rows={[["جمع اقلام", money(o.subtotal)], ["تخفیف و کوپن", `${money(o.discount)} ${o.coupons.join("، ")}`], ["مالیات کل", money(o.tax)], ["هزینه ارسال", money(o.shippingTotal)], ...o.fees.map(f => [f.name || "هزینه", money(f.total)] as [string, string]), ["جمع منبع", money(o.total)], ["برگشت وجه", money(o.refunded)], ["مانده", money(o.due)]]} />
              </div> : null}
              {tab === "payment" ? <SectionCard title="پرداخت و وضعیت"><Details rows={[["وضعیت ووکامرس", orderStatusLabel(o.status, statusRegistry)], ["پرداخت", o.paymentState], ["روش پرداخت", o.paymentTitle], ["زمان پرداخت ثبت‌شده در منبع", formatDateTime(o.paidAt)], ["پرداخت تأییدشده", money(o.paid)], ["برگشت وجه", money(o.refunded)], ["مانده قابل وصول", money(o.due)]]} /></SectionCard> : null}
              {tab === "history" ? <div className="space-y-3"><SectionCard title="عملیات و سوابق">
                <Details rows={[["ورود به سیستم", JOB_STATUS[detail.ingestStatus] ?? detail.ingestStatus], ["خطای ورود", detail.ingestError || "ندارد"]]} />
                <ul className="mt-3 space-y-2 text-sm">{detail.operations.map((op, i) => <li key={i}>{op.type === "refund_create" ? "برگشت وجه" : "تغییر وضعیت"} — {JOB_STATUS[op.status] ?? ({ dead: "متوقف", sent: "ارسال‌شده" } as Record<string, string>)[op.status] ?? op.status} · {formatDateTime(op.createdAt)}</li>)}</ul>
                {!detail.operations.length ? <p className="mt-3 text-sm text-muted-foreground">عملیاتی ثبت نشده است.</p> : null}
                                <p className="mt-3 text-xs text-muted-foreground">چاپ و چاپ مجدد، وضعیت سفارش، رزرو موجودی یا اسناد حسابداری را تغییر نمی‌دهد.</p><Link className="text-sm text-primary underline" href={`/websites/wp/queue?store=${encodeURIComponent(connectionId)}`}>صف همگام‌سازی و تلاش مجدد (جدا از چاپ)</Link>
              </SectionCard>
              <SectionCard title="منبع و نسخه سفارش">
                <Details rows={[["فروشگاه", detail.storeName], ["شماره ووکامرس", o.number], ["شناسه ثابت ووکامرس", o.remoteId],
                  ["ایجاد", formatDateTime(o.createdAt)], ["آخرین تغییر منبع", formatDateTime(o.updatedAt)], ["دریافت نسخه", formatDateTime(detail.receivedAt)],
                  ["شناسه نسخه", detail.snapshotId], ["شناسه حسابداری", detail.localOrderId ?? "ثبت نشده"]]} />
                <p className="mt-3 text-xs text-muted-foreground">بازخوانی فقط آخرین نسخهٔ موجود در سیستم را نشان می‌دهد. برای دریافت تغییرات از فروشگاه، از همگام‌سازی سفارش‌ها در فهرست استفاده کنید.</p>
                <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>بازخوانی نسخه ذخیره‌شده</Button>
              </SectionCard></div> : null}
              {tab === "print" ? <div className="space-y-4">
                {!canPrint ? <InfoBox>برای پیش‌نمایش و چاپ، دسترسی اجرای چاپ لازم است.</InfoBox> : null}
                <p className="text-xs text-muted-foreground">پیش‌فرض‌ها از تنظیمات ← چاپ ← قوانین چاپ می‌آیند. انتخاب‌های این پنجره موقت هستند و هیچ ترجیحی خودکار ذخیره نمی‌شود.</p>
                {(["shipping_label", "woo_invoice"] as const).map(doc => {
                  const plan = printing?.plans[doc];
                  const selectedPrinter = printing?.printers.find(p => p.id === printers[doc]);
                  const applicable = printing?.templates.filter(t => t.docType === doc && (!selectedPrinter || t.paper === selectedPrinter.paper)) ?? [];
                  return <SectionCard key={doc} title={DOC_LABELS[doc]}>
                    <p className="mb-3 text-xs text-muted-foreground">{plan?.ok ? `${plan.templateName} ← ${plan.printerName} · ${PAPERS[plan.paper!]?.label}` : printerErrorMessage(plan?.error)}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="grid gap-1 text-sm"><span>چاپگر {DOC_LABELS[doc]}</span><select className={inputClass} disabled={busy || !canPrint} value={printers[doc]} onChange={e => { setPrinters(v => ({ ...v, [doc]: e.target.value })); setTemplates(v => ({ ...v, [doc]: "" })); setPreview(null); }}><option value="">طبق قانون چاپ</option>{printing?.printers.filter(p => p.documentTypes.includes(doc)).map(p => <option key={p.id} value={p.id}>{p.name} — {PAPERS[p.paper]?.label}</option>)}</select></label>
                      <label className="grid gap-1 text-sm"><span>قالب {DOC_LABELS[doc]}</span><select className={inputClass} disabled={busy || !canPrint} value={templates[doc]} onChange={e => { setTemplates(v => ({ ...v, [doc]: e.target.value })); setPreview(null); }}><option value="">طبق قانون چاپ</option>{applicable.map(t => <option key={t.key} value={t.id ? `id:${t.id}` : `key:${t.key}`}>{t.name}</option>)}</select></label>
                    </div>
                  </SectionCard>;
                })}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm"><span>تعداد نسخه از هر سند</span><PersianNumberInput className={inputClass} value={copies} disabled={busy} onChange={e => setCopies(e.target.value)} /></label>
                  <label className="grid gap-1 text-sm"><span>تعداد بسته (برچسب جدا برای هر بسته)</span><PersianNumberInput className={inputClass} value={packageCount} disabled={busy} onChange={e => { setPackageCount(e.target.value); setPreview(null); }} /></label>
                  <label className="grid gap-1 text-sm"><span>حالت چاپ</span><select className={inputClass} value={mode} disabled={busy} onChange={e => setMode(e.target.value as WooDoc | "both")}><option value="both">هر دو سند</option><option value="shipping_label">برچسب ارسال</option><option value="woo_invoice">فاکتور</option></select></label>
                  <label className="grid gap-1 text-sm"><span>ترتیب چاپ هر دو</span><select className={inputClass} value={invoiceFirst ? "invoice" : "label"} disabled={busy} onChange={e => setInvoiceFirst(e.target.value === "invoice")}><option value="label">ابتدا برچسب، سپس فاکتور</option><option value="invoice">ابتدا فاکتور، سپس برچسب</option></select></label>
                  {o.shipments.length > 1 ? <label className="grid gap-1 text-sm"><span>مرسوله (انتخاب الزامی)</span><select className={inputClass} value={shipmentIndex} disabled={busy} onChange={e => { setShipmentIndex(e.target.value); setPreview(null); }}><option value="">مرسوله را انتخاب کنید</option>{o.shipments.map((s, i) => <option key={i} value={i}>{s.provider} — {s.trackingId}</option>)}</select></label> : null}
                </div>
                <p className="text-xs text-muted-foreground">تعداد بسته با تعداد نسخه متفاوت است. برای سفارش چندمرسوله‌ای، هر مرسوله را جداگانه انتخاب و چاپ کنید. اطلاعات رهگیری ثبت‌نشده ساخته نمی‌شود.</p>
                <div className="flex flex-wrap items-end gap-2">
                  <Button disabled={busy || !canPrint || (mode !== "woo_invoice" && labelBlocked)} onClick={() => void runPrint(mode)}>چاپ انتخاب‌شده</Button>
                  <Button variant="outline" disabled={busy || !canPrint || (mode !== "woo_invoice" && labelBlocked)} onClick={() => void runPrint(mode, true)}>چاپ مجدد</Button>
                  <label className="grid gap-1 text-sm"><span>سند پیش‌نمایش</span><select className={inputClass} value={previewDoc} disabled={busy} onChange={e => { setPreviewDoc(e.target.value as WooDoc); setPreview(null); }}><option value="shipping_label">برچسب ارسال</option><option value="woo_invoice">فاکتور</option></select></label>
                  <Button variant="outline" disabled={busy || !canPrint || (previewDoc === "shipping_label" && labelBlocked)} onClick={() => void showPreview()}>پیش‌نمایش</Button>
                  <Link className="text-sm text-primary underline" href="/settings/printers">تنظیمات چاپ</Link>
                </div>
                {preview ? <figure className="space-y-2"><figcaption className="text-xs">{preview.templateName} · {formatPersianNumber(preview.paper.widthMm)} × {formatPersianNumber(preview.paper.heightMm)} میلی‌متر · {preview.printerName}</figcaption>{/* First-party server raster, never browser-authored HTML. */}<img src={`data:image/png;base64,${preview.imageBase64}`} alt={`پیش‌نمایش ${DOC_LABELS[previewDoc]}`} className="mx-auto h-auto max-w-full border border-border" style={{ width: `${preview.paper.widthMm}mm` }} /></figure> : null}
                {lastJob ? <p role="status" className="text-sm">آخرین تلاش {DOC_LABELS[lastJob.type]}: {lastJob.result.ok ? "تحویل به صف چاپگر" : printerErrorMessage(lastJob.result.error)}{lastJob.result.jobId ? ` · ${lastJob.result.jobId}` : ""}</p> : null}
                <SectionCard title="سوابق چاپ سفارش"><ul className="space-y-2 text-xs">{printing?.jobs.map(j => <li key={j.id}>{DOC_LABELS[j.document_type]} · {JOB_STATUS[j.status] ?? j.status} · {j.printer_name} · {j.template_name} ({toPersianDigits(j.template_version)}) · {formatDateTime(j.created_at)} · نسخه {j.source_revision} · کاربر {j.initiated_by ?? "ثبت نشده"} · درخواست {j.print_request_id ?? "ثبت نشده"}{j.error_code ? ` · ${printerErrorMessage(j.error_code)}` : ""}</li>)}</ul>{!printing?.jobs.length ? <p className="text-sm text-muted-foreground">هنوز تلاشی ثبت نشده است.</p> : null}</SectionCard>
              </div> : null}
            </TabPanel>
          </div>
        </> : null}
      </DialogContent>
    </Dialog>
  );
}

function Details({ rows }: { rows: [string, string][] }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">{rows.map(([label, value], i) => <div className="min-w-0" key={`${label}-${i}`}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words" dir="auto">{toPersianDigits(value || "ثبت نشده")}</dd></div>)}</dl>;
}
