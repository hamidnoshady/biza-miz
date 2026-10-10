/**
 * «خروجی دریافت‌ها / پرداخت‌ها» — the table a voucher register export is.
 *
 * The table half is framework-free and DB-free so it can be asserted directly
 * (`voucher-export.test.ts`): what the columns are, that the amount column
 * carries the business's selected unit and says so in its header, and that
 * the Persian labels and Shamsi dates the rest of the product shows are the
 * ones the file carries too.
 *
 * One row per voucher. Amount cells are **Latin numbers in the business's
 * display unit** — converted with the same `moneyExportCell` the report
 * exports use, so a Toman business gets Toman it can sum, not Rial it reads
 * ten times too large (AGENTS.md: exports follow the selected unit).
 * Storage and every calculation stay integer Rial; the conversion happens
 * only here, at the file boundary. Dates are Shamsi, because a date shown to
 * a person is always Shamsi (AGENTS.md), and an export is shown to a person.
 * Formula-injection guarding is the CSV codec's job (`report-export` →
 * `data-transfer/codecs`), not the table's — memo text passes through raw.
 *
 * The stream half (`streamVoucherExportCsv`) serves the whole filtered set
 * in bounded memory: the routes hand it an export iterator and it encodes
 * chunk after chunk into the response. A failure mid-stream errors the
 * stream — the download fails loudly rather than landing as a silently
 * short file.
 */
import { formatJalali } from "./jalali";
import { VOUCHER_METHOD_LABELS } from "./payables-input";
import type { PaymentListRow, ReceiptListRow } from "./installments-service";
import { cellValue, moneyColumnLabel, moneyExportCell, type ReportTable } from "./report-export";
import { csvCell } from "./data-transfer/codecs";
import type { MoneyUnit } from "./money";
import { withTenant } from "./db";

export type VoucherExportRow = ReceiptListRow | PaymentListRow;

function receiptExportColumns(unit: MoneyUnit) {
  return [
    { key: "voucherNumber", label: "شماره سند" },
    { key: "date", label: "تاریخ" },
    { key: "party", label: "مشتری" },
    { key: "method", label: "روش" },
    { key: "bankReference", label: "شماره پیگیری" },
    { key: "amount", label: moneyColumnLabel("مبلغ", unit) },
    { key: "memo", label: "شرح" },
    { key: "location", label: "شعبه" },
    { key: "createdBy", label: "ثبت‌کننده" },
    { key: "status", label: "وضعیت" },
    { key: "id", label: "شناسه" },
  ];
}

function paymentExportColumns(unit: MoneyUnit) {
  return [
    { key: "voucherNumber", label: "شماره سند" },
    { key: "date", label: "تاریخ" },
    { key: "party", label: "تأمین‌کننده" },
    { key: "method", label: "روش" },
    { key: "bankReference", label: "شماره پیگیری" },
    { key: "amount", label: moneyColumnLabel("مبلغ", unit) },
    { key: "memo", label: "شرح" },
    { key: "location", label: "شعبه" },
    { key: "createdBy", label: "ثبت‌کننده" },
    { key: "status", label: "وضعیت" },
    { key: "id", label: "شناسه" },
  ];
}

/** «فعال» / «باطل‌شده» — the same two words the register shows. */
export function voucherStatusLabel(row: { reversedAt: string | null }): string {
  return row.reversedAt ? "باطل‌شده" : "فعال";
}

/** The method cell the register shows: method label, plus the resolved account — the named choice, or the account the original entry moved money through. */
export function voucherMethodCell(row: VoucherExportRow): string {
  return row.cashAccount ? `${VOUCHER_METHOD_LABELS[row.method]} · ${row.cashAccount.name}` : VOUCHER_METHOD_LABELS[row.method];
}

function voucherExportRow(row: VoucherExportRow, unit: MoneyUnit): Record<string, unknown> {
  return {
    voucherNumber: row.voucherNumber ?? "",
    date: formatJalali(row.date),
    party: row.partyName,
    method: voucherMethodCell(row),
    bankReference: row.bankReference ?? "",
    amount: moneyExportCell(row.amount, unit, "csv"),
    memo: row.memo ?? "",
    location: row.locationName ?? "",
    createdBy: row.createdByName ?? "",
    status: voucherStatusLabel(row),
    id: row.id,
  };
}

/** The export table for a filtered receipt result, in the business's display unit. */
export function buildReceiptsExportTable(rows: readonly ReceiptListRow[], unit: MoneyUnit): ReportTable {
  return { columns: receiptExportColumns(unit), rows: rows.map((row) => voucherExportRow(row, unit)) };
}

/** The export table for a filtered payment result, in the business's display unit. */
export function buildPaymentsExportTable(rows: readonly PaymentListRow[], unit: MoneyUnit): ReportTable {
  return { columns: paymentExportColumns(unit), rows: rows.map((row) => voucherExportRow(row, unit)) };
}

/** The download's filename; ASCII, because a `filename=` header value must be. */
export function voucherExportFilename(kind: "receipts" | "payments"): string {
  return kind === "receipts" ? "receipts.csv" : "payments.csv";
}

/**
 * The whole filtered set as a CSV byte stream — header first, then one line
 * per voucher, the same bytes `rowsToCsv` would emit for the same rows (BOM,
 * CRLF, the shared codec's quoting and formula guard).
 *
 * `firstChunk` is the iterator's already-pulled first page: the route pulls
 * it eagerly so an invalid filter still answers 400 JSON instead of a 200
 * whose body starts mid-error. Every further pull fetches the next chunk
 * inside `withTenant` — the response streams after the request handler's own
 * scope has exited, and an unscoped read fails closed under RLS (silently
 * empty) rather than erroring, which here would mean silently short files.
 */
export function streamVoucherExportCsv(options: {
  businessId: string;
  locationId: string | null;
  userId: string | null;
  unit: MoneyUnit;
  kind: "receipts" | "payments";
  firstChunk: readonly VoucherExportRow[];
  rest: AsyncIterator<readonly VoucherExportRow[]>;
}): ReadableStream<Uint8Array> {
  const columns =
    options.kind === "receipts" ? receiptExportColumns(options.unit) : paymentExportColumns(options.unit);
  const encodeRow = (row: VoucherExportRow): string =>
    columns.map((column) => csvCell(cellValue(voucherExportRow(row, options.unit)[column.key]))).join(",");
  const toLines = (rows: readonly VoucherExportRow[]): string[] => rows.map((row) => `${encodeRow(row)}\r\n`);

  const encoder = new TextEncoder();
  const pending: string[] = [
    `\uFEFF${columns.map((column) => csvCell(column.label)).join(",")}\r\n`,
    ...toLines(options.firstChunk),
  ];
  let exhausted = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (pending.length === 0 && !exhausted) {
          const next = await withTenant(
            options.businessId,
            () => options.rest.next(),
            { locationId: options.locationId, userId: options.userId },
          );
          if (next.done) {
            exhausted = true;
          } else {
            pending.push(...toLines(next.value));
          }
        }
        const line = pending.shift();
        if (line === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(line));
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
