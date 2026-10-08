"use client";

/**
 * Audit F11 — the supplier's invoice on a purchase: its number and date, the
 * VAT it carries, and when it has to be paid. Shared by the create and edit
 * forms of «خرید».
 *
 * VAT is proposed from the business's own rate (`vatPercent`, read from its
 * «تنظیمات مالیات» by the purchases list endpoint) over the goods total, and
 * stays editable: a supplier that is not VAT-registered bills none, and the
 * printed invoice is the authority. Until the person types into it the field
 * follows the lines; once typed it is theirs. Money crosses the wire as
 * integer Rial — an untouched default is sent as the exact Rial figure, never
 * re-parsed from a Toman display that floors by ten.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  MAX_PAYMENT_TERMS_DAYS,
  MAX_SUPPLIER_INVOICE_NUMBER_LENGTH,
  purchasePayableRial,
  resolvePaymentDueDate,
  vatAmountForRate,
} from "@/lib/payables-input";
import { JalaliDatePicker } from "../jalali-date-picker";
import { Field, inputClass } from "../ui";

export interface SupplierInvoiceDraft {
  invoiceNumber: string;
  invoiceDate: string;
  /** What the VAT field shows once the person has typed into it. */
  vatText: string;
  /** False while the VAT follows the business rate over the lines. */
  vatTouched: boolean;
  /** The stored VAT an edit form opened with, so an untouched figure round-trips exactly. */
  vatOriginal?: { text: string; rial: string };
  paymentTermsDays: string;
  dueDate: string;
}

export const EMPTY_SUPPLIER_INVOICE_DRAFT: SupplierInvoiceDraft = {
  invoiceNumber: "",
  invoiceDate: "",
  vatText: "",
  vatTouched: false,
  paymentTermsDays: "",
  dueDate: "",
};

/** The Rial VAT a draft stands for, or null when the typed figure is not a number. */
export function draftVatRial(draft: SupplierInvoiceDraft, goodsRial: string, vatPercent: number, parseText: (t: string) => string): string | null {
  if (!draft.vatTouched) return String(vatAmountForRate(goodsRial, vatPercent));
  if (draft.vatOriginal && draft.vatText === draft.vatOriginal.text) return draft.vatOriginal.rial;
  try {
    return parseText(draft.vatText.trim() || "0");
  } catch {
    return null;
  }
}

/** The API's `invoice` block for a draft (see `parseSupplierInvoice`). */
export function supplierInvoicePayload(draft: SupplierInvoiceDraft, vatRial: string) {
  return {
    invoiceNumber: draft.invoiceNumber.trim() || null,
    invoiceDate: draft.invoiceDate || null,
    vatAmount: vatRial,
    paymentTermsDays: draft.paymentTermsDays.trim() || null,
    dueDate: draft.dueDate || null,
  };
}

export function SupplierInvoiceFields({
  value,
  onChange,
  goodsRial,
  vatPercent,
  purchaseDate,
}: {
  value: SupplierInvoiceDraft;
  onChange: (next: SupplierInvoiceDraft) => void;
  /** The lines' goods total in Rial (integer text). */
  goodsRial: string;
  vatPercent: number;
  /** The purchase's own date (ISO), the base for payment terms when the invoice has no date. */
  purchaseDate: string;
}) {
  const money = useMoney();
  const set = (patch: Partial<SupplierInvoiceDraft>) => onChange({ ...value, ...patch });

  const defaultVat = String(vatAmountForRate(goodsRial, vatPercent));
  const vatRial = draftVatRial(value, goodsRial, vatPercent, money.parseText);
  const shownVat = value.vatTouched ? value.vatText : money.formatText(defaultVat, { withUnit: false });

  let terms: number | null = null;
  const termsText = value.paymentTermsDays.trim();
  if (termsText) {
    const n = Number(termsText);
    terms = Number.isInteger(n) && n >= 0 && n <= MAX_PAYMENT_TERMS_DAYS ? n : null;
  }
  const derivedDue = resolvePaymentDueDate({
    dueDate: value.dueDate || null,
    paymentTermsDays: terms,
    invoiceDate: value.invoiceDate || null,
    purchaseDate: purchaseDate || null,
  });

  return (
    <fieldset className="min-w-0 rounded-xl border border-border/80 p-3">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">فاکتور تأمین‌کننده</legend>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="شمارهٔ فاکتور تأمین‌کننده">
          <input
            className={inputClass}
            dir="ltr"
            maxLength={MAX_SUPPLIER_INVOICE_NUMBER_LENGTH}
            value={value.invoiceNumber}
            onChange={(e) => set({ invoiceNumber: e.target.value })}
            placeholder="اختیاری"
          />
        </Field>
        <Field label="تاریخ فاکتور">
          <JalaliDatePicker value={value.invoiceDate} onChange={(v) => set({ invoiceDate: v })} placeholder="اختیاری" />
        </Field>
        <Field
          label={`مالیات بر ارزش افزوده (${money.unitLabel})`}
          hint={
            vatPercent > 0
              ? `پیش‌فرض با نرخ ${toPersianDigits(String(vatPercent))}٪ کسب‌وکار؛ اگر فاکتور مالیات ندارد صفر کنید.`
              : "نرخ مالیات کسب‌وکار صفر است؛ اگر فاکتور مالیات دارد مبلغ آن را وارد کنید."
          }
        >
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            allowNegative={false}
            value={shownVat}
            onChange={(e) => set({ vatText: e.target.value, vatTouched: true })}
            aria-invalid={vatRial === null}
          />
        </Field>
        <Field label="مهلت پرداخت (روز)">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            allowNegative={false}
            value={value.paymentTermsDays}
            onChange={(e) => set({ paymentTermsDays: e.target.value })}
            placeholder="اختیاری"
          />
        </Field>
        <Field
          label="سررسید پرداخت"
          hint={!value.dueDate && derivedDue ? `بر اساس مهلت: ${toPersianDigits(formatJalali(derivedDue))}` : undefined}
        >
          <JalaliDatePicker value={value.dueDate} onChange={(v) => set({ dueDate: v })} placeholder="اختیاری" />
        </Field>
        <div className="flex min-w-0 flex-col justify-end text-sm">
          <span className="text-xs text-muted-foreground">مبلغ قابل پرداخت به تأمین‌کننده</span>
          <span className="mt-1 font-semibold tabular-nums">
            {vatRial === null ? "—" : money.formatText(purchasePayableRial(goodsRial, vatRial).toString())}
          </span>
        </div>
      </div>
    </fieldset>
  );
}
