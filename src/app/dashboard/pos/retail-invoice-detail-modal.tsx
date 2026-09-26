"use client";

/**
 * The retail invoice's own detail view — not `OrderDetailModal`. A retail
 * sale has no table, no kitchen ticket, no menu modifiers and no add-on
 * groups; reusing the café's order workflow component here would mean either
 * dragging all of that in unused or forking the component in place. This
 * reads the dedicated `getRetailInvoiceDetail`/`getRetailInvoicePrintData`
 * read model (`/api/sales/invoices/[id]`) and renders only what a shop
 * invoice actually has: فاکتور (lines + totals), پرداخت (tenders), حسابداری
 * (a pointer to the ledger, not a duplicate of it) and اطلاعات (who/where/when).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Ban, PrinterIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { PAYMENT_METHOD_LABELS, CONDITION_GRADE_LABELS } from "@/lib/receipt-template";
import { printReceipt } from "@/lib/printing/client";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { api, ErrorBox, errorMessageOrRaw } from "../ui";
import { StatusBadge, LoadingSkeleton } from "../page-chrome";
import type { RetailInvoiceDetail, RetailInvoiceDetailLine } from "@/lib/retail-invoice/types";
import type { ReceiptData } from "@/lib/receipt-template";

const PURITY_LABELS: Record<string, string> = { "18": "عیار ۱۸", "21": "عیار ۲۱", "24": "عیار ۲۴" };

function lineName(line: RetailInvoiceDetailLine): string {
  return line.nameSnapshot;
}

function lineQuantityLabel(line: RetailInvoiceDetailLine): string {
  if (line.kind === "gold" || line.kind === "watch" || line.kind === "legacy") return "۱ عدد";
  return `${toPersianDigits(line.quantity)} عدد`;
}

/** One line's kind-specific sub-details — the same facts the printed receipt shows under the line. */
function LineDetails({ line }: { line: RetailInvoiceDetailLine }) {
  const money = useMoney();
  if (line.kind === "gold") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {PURITY_LABELS[line.purity] ?? line.purity} · {toPersianDigits(line.netWeight)} گرم · فلز{" "}
        {money.formatText(line.metalValue)} · اجرت {money.formatText(line.makingCharge)} · سود{" "}
        {money.formatText(line.profit)}
        {line.consigned ? " · امانی" : ""}
      </p>
    );
  }
  if (line.kind === "watch") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        سریال {line.serialNumber}
        {line.warrantyMonths ? ` · گارانتی ${toPersianDigits(line.warrantyMonths)} ماهه` : ""}
        {line.warrantyEndDate ? ` تا ${toPersianDigits(formatJalali(line.warrantyEndDate))}` : ""}
        {line.provenance
          ? ` · دست‌دوم · ${CONDITION_GRADE_LABELS[line.provenance.conditionGrade ?? ""] ?? line.provenance.conditionGrade ?? "—"}${
              line.provenance.boxAndPapers ? " · همراه جعبه و مدارک" : " · بدون جعبه و مدارک"
            }`
          : ""}
      </p>
    );
  }
  if (line.kind === "cosmetic") {
    return line.batchNumbers.length ? (
      <p className="mt-1 text-xs text-muted-foreground">
        بچ {line.batchNumbers.join("، ")}
        {line.expiryDate ? ` · انقضا ${toPersianDigits(formatJalali(line.expiryDate))}` : ""}
      </p>
    ) : null;
  }
  if (line.kind === "legacy" && line.metalValue != null) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        فلز {money.formatText(line.metalValue)} · اجرت {money.formatText(line.makingCharge ?? "0")} · سود{" "}
        {money.formatText(line.profit ?? "0")}
      </p>
    );
  }
  return null;
}

export function RetailInvoiceDetailModal({
  invoiceId,
  open,
  onOpenChange,
  canVoid = false,
  onVoided,
}: {
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `PERMISSIONS.ordersAmendClosed` — voiding a completed invoice, same gate as the café's own closed-order amendment. */
  canVoid?: boolean;
  /** Called after a void actually commits, so the invoice list behind this modal can refetch. */
  onVoided?: () => void;
}) {
  const money = useMoney();
  const [invoice, setInvoice] = useState<RetailInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [voiding, setVoiding] = useState(false);

  function loadInvoice() {
    if (!invoiceId) return;
    setLoading(true);
    setError("");
    const controller = new AbortController();
    void api<{ invoice?: RetailInvoiceDetail; error?: string }>(`/api/sales/invoices/${invoiceId}`, {
      signal: controller.signal,
    }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (ok && data.invoice) setInvoice(data.invoice);
      else setError("جزئیات فاکتور بارگذاری نشد.");
      setLoading(false);
    });
    return () => controller.abort();
  }

  useEffect(() => {
    if (!open || !invoiceId) {
      setInvoice(null);
      setError("");
      return;
    }
    return loadInvoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId]);

  async function voidInvoice() {
    if (!invoiceId) return;
    const reason = window.prompt("دلیل ابطال فاکتور؟ (این فاکتور و ثبت‌های حسابداری آن به‌طور کامل برگشت می‌خورد)");
    if (reason === null) return; // cancelled
    if (reason.trim().length < 3) {
      toast.error("دلیل ابطال باید حداقل ۳ نویسه باشد.");
      return;
    }
    setVoiding(true);
    const { ok, data } = await api<{ ok?: boolean; error?: string; message?: string }>(
      `/api/sales/invoices/${invoiceId}/void`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
    setVoiding(false);
    if (ok) {
      toast.success("فاکتور باطل شد و حسابداری آن برگشت خورد.");
      loadInvoice();
      onVoided?.();
    } else {
      toast.error(data.message || errorMessageOrRaw(data.error) || "ابطال فاکتور انجام نشد.");
    }
  }

  async function reprint() {
    if (!invoiceId) return;
    setPrinting(true);
    const { ok, data } = await api<{ receipt?: ReceiptData; error?: string }>(
      `/api/sales/invoices/${invoiceId}?view=print`,
    );
    setPrinting(false);
    if (!ok || !data.receipt) {
      toast.error("اطلاعات چاپ این فاکتور دریافت نشد.");
      return;
    }
    const receipt = data.receipt;
    const requestId = `reprint:${crypto.randomUUID()}`;
    const result = await printReceipt(null, receipt, { requestId, documentType: "invoice" });
    if (result.ok) {
      toast.success("رسید برای چاپ ارسال شد");
    } else if (result.error === "printer_not_configured") {
      toast.warning("چاپگری برای این شعبه تنظیم نشده است.", {
        action: { label: "تنظیمات چاپگر", onClick: () => window.open("/dashboard/settings/printers", "_blank") },
      });
    } else {
      toast.warning("چاپ رسید انجام نشد.", {
        action: {
          label: "چاپ دوباره",
          onClick: () => void printReceipt(null, receipt, { requestId: `${requestId}:retry`, documentType: "invoice" }),
        },
      });
    }
  }

  const hasLegacyLines = invoice?.lines.some((l) => l.kind === "legacy") ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none bg-muted p-0 ring-0 sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:rounded-2xl sm:ring-1 sm:ring-border/80"
      >
        <DialogHeader className="shrink-0 gap-0 border-b border-border/80 bg-card px-4 py-3 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="font-sans text-lg font-bold text-foreground sm:text-xl">
                {invoice ? `فاکتور ${toPersianDigits(invoice.orderNumber)}` : "جزئیات فاکتور"}
              </DialogTitle>
              {invoice ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <StatusBadge tone={invoice.status === "voided" ? "danger" : "positive"}>
                    {invoice.status === "voided" ? "باطل‌شده" : "تکمیل‌شده"}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    {toPersianDigits(formatJalali(invoice.issuedAt, { withMonthName: true, withTime: true }))}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void reprint()}
                disabled={!invoice || printing}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:border-amber-300 hover:bg-amber-50 disabled:pointer-events-none disabled:opacity-50 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10"
              >
                <PrinterIcon aria-hidden="true" className="size-4" />
                {printing ? "در حال ارسال…" : "چاپ مجدد"}
              </button>
              {canVoid && invoice?.status === "completed" ? (
                <button
                  type="button"
                  onClick={() => void voidInvoice()}
                  disabled={voiding}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                >
                  <Ban aria-hidden="true" className="size-4" />
                  {voiding ? "در حال ابطال…" : "ابطال فاکتور"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="بستن"
                className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {loading ? (
            <LoadingSkeleton rows={5} label="در حال بارگذاری فاکتور" />
          ) : error ? (
            <ErrorBox>{error}</ErrorBox>
          ) : invoice ? (
            <Tabs defaultValue="invoice">
              {/*
                The shared TabsList defaults to a 32px-tall single-line strip
                (`h-8`), well under this app's own ~40px touch-target floor —
                fine for the mouse-driven screens it was built for, but this
                is the one place it is used as a hand-held four-way switch at
                390px wide. `h-auto min-h-10` lets it grow instead of clipping,
                and each trigger allows a wrap (`whitespace-normal`) so the
                longest label, «حسابداری», never overlaps its neighbour on a
                narrow screen instead of silently overflowing sideways.
              */}
              <TabsList className="grid h-auto min-h-10 w-full grid-cols-4">
                <TabsTrigger value="invoice" className="min-h-10 whitespace-normal py-1.5 text-center leading-tight">
                  فاکتور
                </TabsTrigger>
                <TabsTrigger value="payment" className="min-h-10 whitespace-normal py-1.5 text-center leading-tight">
                  پرداخت
                </TabsTrigger>
                <TabsTrigger value="accounting" className="min-h-10 whitespace-normal py-1.5 text-center leading-tight">
                  حسابداری
                </TabsTrigger>
                <TabsTrigger value="info" className="min-h-10 whitespace-normal py-1.5 text-center leading-tight">
                  اطلاعات
                </TabsTrigger>
              </TabsList>

              <TabsContent value="invoice" className="mt-4 space-y-3">
                {hasLegacyLines ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    این فاکتور پیش از ثبت جزئیات کامل هر قلم صادر شده؛ برخی اطلاعات (مانند تعداد دقیق) برای آن قابل بازسازی نیست.
                  </div>
                ) : null}
                <div className="space-y-2">
                  {invoice.lines.map((line) => (
                    <div key={line.orderItemId} className="rounded-xl border border-border/80 bg-card p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{lineName(line)}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{lineQuantityLabel(line)}</p>
                          <LineDetails line={line} />
                        </div>
                        <span className="shrink-0 text-sm font-bold">{money.formatText(line.total)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rounded-xl border border-border/80 bg-card p-3 text-sm">
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">جمع جزء</span>
                    <span>{money.format(invoice.subtotal)}</span>
                  </div>
                  {invoice.discount > 0 ? (
                    <div className="flex justify-between py-0.5">
                      <span className="text-muted-foreground">تخفیف</span>
                      <span>-{money.format(invoice.discount)}</span>
                    </div>
                  ) : null}
                  {invoice.tax > 0 ? (
                    <div className="flex justify-between py-0.5">
                      <span className="text-muted-foreground">مالیات</span>
                      <span>{money.format(invoice.tax)}</span>
                    </div>
                  ) : null}
                  <div className="mt-1 flex justify-between border-t border-border pt-1.5 text-base font-bold">
                    <span>جمع کل</span>
                    <span>{money.format(invoice.total)}</span>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="payment" className="mt-4 space-y-3">
                <div className="space-y-2">
                  {invoice.payments.map((payment) => (
                    <div key={payment.id} className="flex items-center justify-between rounded-xl border border-border/80 bg-card p-3">
                      <div>
                        <p className="text-sm font-semibold">{payment.methodLabel || PAYMENT_METHOD_LABELS[payment.method] || payment.method}</p>
                        {payment.reference ? <p className="mt-0.5 text-xs text-muted-foreground">مرجع: {payment.reference}</p> : null}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {toPersianDigits(formatJalali(payment.receivedAt, { withTime: true }))}
                        </p>
                      </div>
                      <span className="font-bold">{money.format(payment.amount)}</span>
                    </div>
                  ))}
                  {invoice.payments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">پرداختی برای این فاکتور ثبت نشده است.</p>
                  ) : null}
                </div>
                <div className="rounded-xl border border-border/80 bg-card p-3 text-sm">
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">جمع پرداخت‌شده</span>
                    <span>{money.format(invoice.paidTotal)}</span>
                  </div>
                  {invoice.balanceDue > 0 ? (
                    <div className="flex justify-between py-0.5 font-semibold text-amber-700 dark:text-amber-300">
                      <span>باقی‌مانده (بستانکار مشتری)</span>
                      <span>{money.format(invoice.balanceDue)}</span>
                    </div>
                  ) : null}
                  {invoice.overpaid > 0 ? (
                    <div className="flex justify-between py-0.5 font-semibold">
                      <span>اضافه‌پرداخت</span>
                      <span>{money.format(invoice.overpaid)}</span>
                    </div>
                  ) : null}
                  {invoice.creditTotal > 0 ? (
                    <div className="flex justify-between py-0.5">
                      <span className="text-muted-foreground">نسیه (حساب مشتری)</span>
                      <span>{money.format(invoice.creditTotal)}</span>
                    </div>
                  ) : null}
                </div>
              </TabsContent>

              <TabsContent value="accounting" className="mt-4 space-y-3">
                <div className="rounded-xl border border-border/80 bg-card p-4 text-sm">
                  <p className="text-muted-foreground">
                    ثبت‌های دفتر روزنامهٔ این فروش (درآمد، مالیات، بهای تمام‌شده) در حسابداری قابل مشاهده است؛ این فاکتور رکورد دومی از آن‌ها نگه نمی‌دارد.
                  </p>
                  <Link
                    href={accountingSectionHref("entries")}
                    className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:border-amber-300 hover:bg-amber-50 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10"
                  >
                    مشاهدهٔ ثبت‌های دفتر روزنامه
                  </Link>
                </div>
                {invoice.integration.holooQueued ? (
                  <div className="rounded-xl border border-border/80 bg-card p-4 text-sm">
                    <p className="font-semibold">اتصال هلو</p>
                    <p className="mt-1 text-muted-foreground">
                      {invoice.integration.holooSynced ? "این فاکتور با هلو همگام‌سازی شده است." : "این فاکتور در صف ارسال به هلو است."}
                    </p>
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent value="info" className="mt-4 space-y-3">
                <div className="rounded-xl border border-border/80 bg-card p-4 text-sm">
                  <dl className="space-y-2">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">مشتری</dt>
                      <dd className="text-end font-medium">{invoice.customer?.name ?? "بدون مشتری"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">صندوق‌دار</dt>
                      <dd className="text-end font-medium">{invoice.cashierName ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">شعبه</dt>
                      <dd className="text-end font-medium">{invoice.locationName}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">تاریخ صدور</dt>
                      <dd className="text-end font-medium">
                        {toPersianDigits(formatJalali(invoice.issuedAt, { withMonthName: true, withTime: true }))}
                      </dd>
                    </div>
                    {invoice.note ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">یادداشت</dt>
                        <dd className="text-end font-medium">{invoice.note}</dd>
                      </div>
                    ) : null}
                    {invoice.status === "voided" && invoice.voidedReason ? (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">دلیل ابطال</dt>
                        <dd className="text-end font-medium text-destructive">{invoice.voidedReason}</dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
