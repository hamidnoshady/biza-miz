/**
 * «خروجی دریافت‌ها / پرداخت‌ها» — the table a voucher register export is.
 *
 * Framework-free and DB-free so it can be asserted directly
 * (`voucher-export.test.ts`): what the columns are, that amounts survive as
 * exact Rial, and that the Persian labels and Shamsi dates the rest of the
 * product shows are the ones the file carries too.
 *
 * One row per voucher. Amounts are **Latin integer Rial**, deliberately — the
 * same call the journal export makes for the same reason: grouped Persian
 * digits are display text that Excel cannot sum, and a BIGINT amount must
 * arrive intact so the file reconciles against the journal export (which is
 * also Rial; mixed units across the two audit artefacts would be a footgun).
 * Dates are Shamsi, because a date shown to a person is always Shamsi
 * (AGENTS.md), and an export is shown to a person. Formula-injection guarding
 * is the CSV codec's job (`report-export` → `data-transfer/codecs`), not the
 * table's — memo text passes through raw.
 */
import { formatJalali } from "./jalali";
import { VOUCHER_METHOD_LABELS } from "./payables-input";
import type { PaymentListRow, ReceiptListRow } from "./installments-service";
import type { ReportTable } from "./report-export";

type VoucherExportRow = ReceiptListRow | PaymentListRow;

const RECEIPT_EXPORT_COLUMNS = [
  { key: "voucherNumber", label: "شماره سند" },
  { key: "date", label: "تاریخ" },
  { key: "party", label: "مشتری" },
  { key: "method", label: "روش" },
  { key: "bankReference", label: "شماره پیگیری" },
  { key: "amount", label: "مبلغ (ریال)" },
  { key: "memo", label: "شرح" },
  { key: "location", label: "شعبه" },
  { key: "createdBy", label: "ثبت‌کننده" },
  { key: "status", label: "وضعیت" },
  { key: "id", label: "شناسه" },
] as const;

const PAYMENT_EXPORT_COLUMNS = [
  { key: "voucherNumber", label: "شماره سند" },
  { key: "date", label: "تاریخ" },
  { key: "party", label: "تأمین‌کننده" },
  { key: "method", label: "روش" },
  { key: "bankReference", label: "شماره پیگیری" },
  { key: "amount", label: "مبلغ (ریال)" },
  { key: "memo", label: "شرح" },
  { key: "location", label: "شعبه" },
  { key: "createdBy", label: "ثبت‌کننده" },
  { key: "status", label: "وضعیت" },
  { key: "id", label: "شناسه" },
] as const;

/** «فعال» / «باطل‌شده» — the same two words the register shows. */
export function voucherStatusLabel(row: { reversedAt: string | null }): string {
  return row.reversedAt ? "باطل‌شده" : "فعال";
}

/** The method cell the register shows: method label, plus the named account when the voucher named one. */
export function voucherMethodCell(row: VoucherExportRow): string {
  return row.cashAccount ? `${VOUCHER_METHOD_LABELS[row.method]} · ${row.cashAccount.name}` : VOUCHER_METHOD_LABELS[row.method];
}

function voucherExportRow(row: VoucherExportRow): Record<string, unknown> {
  return {
    voucherNumber: row.voucherNumber ?? "",
    date: formatJalali(row.date),
    party: row.partyName,
    method: voucherMethodCell(row),
    bankReference: row.bankReference ?? "",
    amount: row.amount,
    memo: row.memo ?? "",
    location: row.locationName ?? "",
    createdBy: row.createdByName ?? "",
    status: voucherStatusLabel(row),
    id: row.id,
  };
}

/** The export table for a complete filtered receipt result. */
export function buildReceiptsExportTable(rows: readonly ReceiptListRow[]): ReportTable {
  return { columns: [...RECEIPT_EXPORT_COLUMNS], rows: rows.map(voucherExportRow) };
}

/** The export table for a complete filtered payment result. */
export function buildPaymentsExportTable(rows: readonly PaymentListRow[]): ReportTable {
  return { columns: [...PAYMENT_EXPORT_COLUMNS], rows: rows.map(voucherExportRow) };
}

/** The download's filename; ASCII, because a `filename=` header value must be. */
export function voucherExportFilename(kind: "receipts" | "payments"): string {
  return kind === "receipts" ? "receipts.csv" : "payments.csv";
}
