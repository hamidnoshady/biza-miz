/**
 * No-write building block for the historical invoice import (#1289).
 *
 * This is deliberately not a row adapter: one document can span many rows.
 * Callers must re-run this against current, tenant-scoped verified identities and
 * archived document identities at execution time. It does not create customers,
 * persist approvals, enqueue a job, or post anything to the live books.
 */
import Decimal from "decimal.js";
import { isValidIsoDate, isValidJalaliDate, jalaliToIsoDate } from "../jalali";
import { westernDigits } from "./csv";

const Exact = Decimal.clone({ precision: 80 });
const MAX_RIAL = new Exact("9223372036854775807");

export type HistoricalCurrency = "rial" | "toman";
export type HistoricalCalendar = "gregorian" | "jalali";

/** Values after the operator has mapped source columns; never numeric JS values. */
export interface HistoricalInvoiceRow {
  externalInvoiceId: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  externalCustomerCode?: string;
  sourceCustomerName?: string;
  sourceCustomerPhone?: string;
  sourceBranch?: string;
  currency?: string;
  total?: string;
  paid?: string;
  balance?: string;
  invoiceDiscount?: string;
  invoiceTax?: string;
  status?: string;
  paymentDetails?: string;
  reference?: string;
  lineName?: string;
  lineSku?: string;
  lineBarcode?: string;
  quantity?: string;
  unitPrice?: string;
  lineDiscount?: string;
  lineTax?: string;
  /** Spreadsheet row number for review. */
  rowNumber: number;
}

export interface VerifiedCustomerBinding {
  externalCustomerCode: string;
  partyId: string;
}

export interface HistoricalPreviewOptions {
  /** A stable source instance, not a display name or filename. */
  sourceKey: string;
  currency: HistoricalCurrency;
  calendar: HistoricalCalendar;
  /** ONLY verified, active source_identities or explicit reviewed bindings for this source. */
  verifiedCustomers: readonly VerifiedCustomerBinding[];
  /** Document IDs already archived in this tenant and source instance. */
  archivedExternalIds: readonly string[];
}

export interface HistoricalPreviewDocument {
  externalInvoiceId: string;
  rows: HistoricalInvoiceRow[];
  partyId: string | null;
  invoiceDate: string | null;
  totalRial: string | null;
  paidRial: string | null;
  balanceRial: string | null;
  summaryOnly: boolean;
  outcome: "invalid" | "review" | "already_imported" | "ready";
  errors: string[];
  warnings: string[];
}

const HEADER_FIELDS = ["invoiceNumber", "invoiceDate", "externalCustomerCode", "sourceCustomerName", "sourceCustomerPhone", "sourceBranch", "currency", "total", "paid", "balance", "invoiceDiscount", "invoiceTax", "status", "paymentDetails", "reference"] as const;
const LINE_FIELDS = ["lineName", "lineSku", "lineBarcode", "quantity", "unitPrice", "lineDiscount", "lineTax"] as const;
const text = (value: string | undefined) => (value ?? "").trim();

/** Strict decimal syntax; do not silently discard unexpected characters. */
function decimalText(value: string): string | null {
  const normalized = westernDigits(value.trim()).replace(/\u066b/g, ".").replace(/\u066c/g, ",");
  if (normalized.length > 40 || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized)) return null;
  return normalized.replace(/,/g, "");
}

/** Convert exactly, never round fractional Rial or use IEEE-754 arithmetic. */
export function parseHistoricalRial(value: string, currency: HistoricalCurrency): string | null {
  const input = decimalText(value);
  if (input === null) return null;
  const amount = new Exact(input).mul(currency === "toman" ? 10 : 1);
  return amount.isInteger() && amount.lte(MAX_RIAL) ? amount.toFixed(0) : null;
}

export function parseHistoricalDate(value: string, calendar: HistoricalCalendar): string | null {
  const normalized = westernDigits(value.trim());
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(normalized);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (calendar === "jalali") {
    if (!isValidJalaliDate(year, month, day)) return null;
    return jalaliToIsoDate(year, month, day);
  }
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * Groups a mapped flat file. Blank repeated header cells inherit the non-blank
 * value, but conflicting values are rejected instead of choosing one. Missing
 * IDs each get their own invalid document, never an invented identity.
 */
export function previewHistoricalInvoices(
  rows: readonly HistoricalInvoiceRow[],
  options: HistoricalPreviewOptions,
): HistoricalPreviewDocument[] {
  const groups = new Map<string, HistoricalInvoiceRow[]>();
  rows.forEach((row, index) => {
    const id = text(row.externalInvoiceId);
    // Prefixes prevent a real external ID from colliding with the missing-ID key.
    const key = id ? `id:${id}` : `missing:${index}`;
    const group = groups.get(key) ?? [];
    group.push({ ...row });
    groups.set(key, group);
  });
  const archived = new Set(options.archivedExternalIds);
  const bindings = new Map<string, Set<string>>();
  for (const binding of options.verifiedCustomers) {
    const code = text(binding.externalCustomerCode);
    const party = text(binding.partyId);
    if (!code || !party) continue;
    const ids = bindings.get(code) ?? new Set<string>();
    ids.add(party);
    bindings.set(code, ids);
  }

  return Array.from(groups.values(), (group) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const id = text(group[0].externalInvoiceId);
    if (!text(options.sourceKey)) errors.push("شناسهٔ پایدار منبع مشخص نشده است.");
    if (!id) errors.push("شناسهٔ اصلی فاکتور در منبع الزامی است؛ شمارهٔ فاکتور جایگزین آن نیست.");
    const header: Partial<Record<(typeof HEADER_FIELDS)[number], string>> = {};
    for (const field of HEADER_FIELDS) {
      const values = new Set(group.map((row) => text(row[field])).filter(Boolean));
      if (values.size > 1) errors.push(`مقادیر سربرگ ${field} در ردیف‌های فاکتور یکسان نیست.`);
      header[field] = values.values().next().value ?? "";
    }
    if (header.currency && header.currency.toLowerCase() !== options.currency) {
      errors.push("واحد پول فاکتور با واحد انتخاب‌شده یکسان نیست.");
    }
    const date = parseHistoricalDate(header.invoiceDate ?? "", options.calendar);
    if (!date) errors.push("تاریخ فاکتور نامعتبر یا خالی است.");
    const readMoney = (raw: string | undefined, label: string, required = false): string | null => {
      if (!raw) {
        if (required) errors.push(`${label} الزامی است.`);
        return null;
      }
      const amount = parseHistoricalRial(raw, options.currency);
      if (amount === null) errors.push(`${label} نامعتبر است؛ مبلغ باید غیرمنفی و دقیقاً قابل تبدیل به ریال باشد.`);
      return amount;
    };
    const total = readMoney(header.total, "مبلغ کل", true);
    const paid = readMoney(header.paid, "مبلغ پرداختی");
    const balance = readMoney(header.balance, "مانده");
    const discount = readMoney(header.invoiceDiscount, "تخفیف فاکتور");
    const tax = readMoney(header.invoiceTax, "مالیات فاکتور");
    if (total !== null && paid !== null && new Exact(paid).gt(total)) errors.push("مبلغ پرداختی از مبلغ کل بیشتر است.");
    if (total !== null && balance !== null && new Exact(balance).gt(total)) errors.push("مانده از مبلغ کل بیشتر است.");
    if (total !== null && paid !== null && balance !== null && !new Exact(paid).plus(balance).eq(total)) {
      errors.push("مجموع پرداختی و مانده با مبلغ کل برابر نیست.");
    }
    if (paid !== null && balance !== null && new Exact(paid).gt(0) && new Exact(balance).gt(0)) {
      warnings.push("پرداخت جزئی فقط به‌عنوان سابقه نمایش داده می‌شود و بدهی یا پرداختی در دفتر ثبت نمی‌کند.");
    }
    const lines = group.filter((row) => LINE_FIELDS.some((field) => text(row[field])));
    let lineSum = new Exact(0);
    for (const row of lines) {
      const quantityText = decimalText(text(row.quantity));
      const price = readMoney(text(row.unitPrice), `قیمت ردیف ${row.rowNumber}`, true);
      const lineDiscount = readMoney(text(row.lineDiscount), `تخفیف ردیف ${row.rowNumber}`);
      const lineTax = readMoney(text(row.lineTax), `مالیات ردیف ${row.rowNumber}`);
      if (!text(row.lineName) && !text(row.lineSku) && !text(row.lineBarcode)) errors.push(`مشخصات کالا در ردیف ${row.rowNumber} خالی است.`);
      if (!quantityText || new Exact(quantityText).lte(0)) {
        errors.push(`تعداد ردیف ${row.rowNumber} باید عددی مثبت باشد؛ مرجوعی نیاز به بررسی دارد.`);
        continue;
      }
      if (price === null) continue;
      const lineTotal = new Exact(quantityText).mul(price).minus(lineDiscount ?? "0").plus(lineTax ?? "0");
      if (lineTotal.lt(0) || !lineTotal.isInteger() || lineTotal.gt(MAX_RIAL)) {
        errors.push(`مبلغ ردیف ${row.rowNumber} نامعتبر یا دارای کسر ریال است.`);
      } else lineSum = lineSum.plus(lineTotal);
    }
    if (lines.length && total !== null && !lineSum.minus(discount ?? "0").plus(tax ?? "0").eq(total)) {
      errors.push("جمع ردیف‌ها پس از تخفیف و مالیات فاکتور با مبلغ کل برابر نیست.");
    }
    if (!lines.length) warnings.push("این فاکتور فقط خلاصه است و ردیف کالا ندارد.");
    if (header.status) warnings.push("وضعیت اصلی فقط به‌عنوان سابقه نگهداری می‌شود و باعث ثبت مالی نمی‌شود.");
    const parties = bindings.get(header.externalCustomerCode ?? "");
    const partyId = parties?.size === 1 ? [...parties][0] : null;
    if (!partyId) warnings.push(parties && parties.size > 1
      ? "کد مشتری چند ارتباط تأییدشده دارد؛ نیاز به بررسی است."
      : "مشتری به ارتباط تأییدشده با یک شخص موجود نیاز دارد.");
    const outcome = errors.length ? "invalid" : archived.has(id) ? "already_imported" : !partyId ? "review" : "ready";
    return { externalInvoiceId: id, rows: group, partyId, invoiceDate: date, totalRial: total, paidRial: paid, balanceRial: balance, summaryOnly: !lines.length, outcome, errors, warnings };
  });
}

/** A line sheet contains only line fields and the source document ID. */
export type HistoricalInvoiceLineRow = Pick<HistoricalInvoiceRow,
  "rowNumber" | "externalInvoiceId" | (typeof LINE_FIELDS)[number]>;

/**
 * Join separately mapped sheets by stable ID. An orphan is reported, never
 * synthesized into a header. Duplicate header IDs are blocked even if their
 * fields happen to match: they may be distinct source documents.
 */
export function previewHistoricalInvoiceSheets(
  headers: readonly HistoricalInvoiceRow[],
  lines: readonly HistoricalInvoiceLineRow[],
  options: HistoricalPreviewOptions,
): { documents: HistoricalPreviewDocument[]; orphanLines: HistoricalInvoiceLineRow[] } {
  const headerCounts = new Map<string, number>();
  for (const header of headers) {
    const id = text(header.externalInvoiceId);
    if (id) headerCounts.set(id, (headerCounts.get(id) ?? 0) + 1);
  }
  const joined: HistoricalInvoiceRow[] = headers.map((header) => ({ ...header }));
  const orphanLines: HistoricalInvoiceLineRow[] = [];
  for (const line of lines) {
    const id = text(line.externalInvoiceId);
    if (!id || !headerCounts.has(id)) orphanLines.push({ ...line });
    else joined.push({ ...line });
  }
  const documents = previewHistoricalInvoices(joined, options);
  for (const document of documents) {
    if ((headerCounts.get(document.externalInvoiceId) ?? 0) > 1) {
      document.errors.push("شناسهٔ فاکتور در برگهٔ سربرگ تکرار شده است؛ نیاز به بررسی دارد.");
      document.outcome = "invalid";
    }
  }
  return { documents, orphanLines };
}
