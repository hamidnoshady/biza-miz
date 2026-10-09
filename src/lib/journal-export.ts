/**
 * «خروجی دفتر روزنامه» — the table a journal export is.
 *
 * Framework-free and DB-free so it can be asserted directly
 * (`journal-export.test.ts`): what the columns are, that a document's amounts
 * survive as exact Rial, and that the Persian labels and Shamsi dates the rest
 * of the product shows are the ones the file carries too.
 *
 * One row per *journal line*, not per document. An export of a general journal
 * is read as an audit artefact — somebody reconciles it against another
 * system, or hands it to an auditor — and a document-level row would drop the
 * account breakdown that makes it useful. The document's own columns repeat
 * across its lines, which is what every accounting package's journal export
 * does.
 *
 * Amounts are **Latin integer Rial**, deliberately. Grouped Persian digits are
 * display text that Excel cannot sum, and the whole point of this export is
 * that a BIGINT amount arrives intact; `buildProductsCsv` made the same call
 * for the same reason. Dates are Shamsi, because a date shown to a person is
 * always Shamsi (AGENTS.md), and an export is shown to a person.
 */
import { formatJalali } from "./jalali";
import { ledgerSourceLabel } from "./ledger-source-labels";
import type { JournalEntryRecord } from "./journal-service";
import type { ReportTable } from "./report-export";

export const JOURNAL_EXPORT_COLUMNS = [
  { key: "entryDate", label: "تاریخ سند" },
  { key: "postedAt", label: "زمان ثبت" },
  { key: "source", label: "منبع سند" },
  { key: "memo", label: "شرح" },
  { key: "accountCode", label: "کد حساب" },
  { key: "accountName", label: "نام حساب" },
  { key: "debit", label: "بدهکار (ریال)" },
  { key: "credit", label: "بستانکار (ریال)" },
  // Multicurrency (issue #863): a foreign document's lines keep their original
  // currency, foreign amounts and frozen rate beside the base amounts — the
  // export is the audit artefact, so the snapshot travels with it.
  { key: "currency", label: "ارز" },
  { key: "foreignDebit", label: "بدهکار ارزی" },
  { key: "foreignCredit", label: "بستانکار ارزی" },
  { key: "exchangeRate", label: "نرخ تسعیر سند" },
  { key: "entryTotal", label: "جمع سند (ریال)" },
  { key: "location", label: "شعبه" },
  { key: "project", label: "پروژه" },
  { key: "createdBy", label: "ثبت‌کننده" },
  { key: "status", label: "وضعیت" },
  { key: "entryId", label: "شناسهٔ سند" },
  { key: "sourceId", label: "شناسهٔ مرجع" },
  { key: "reversesEntryId", label: "برگشتِ سند" },
  { key: "reversedByEntryId", label: "سند برگشتی" },
  { key: "reversedAt", label: "تاریخ برگشت" },
  { key: "reversedByName", label: "برگشت‌زننده" },
] as const;

/** «سند برگشتی» / «برگشت‌خورده» / «عادی» — the same three words the list shows. */
export function journalStatusLabel(entry: {
  reversesEntryId: string | null;
  reversedAt: string | null;
}): string {
  if (entry.reversesEntryId) return "سند برگشتی";
  if (entry.reversedAt) return "برگشت‌خورده";
  return "عادی";
}

/** The export table for a complete filtered result. */
export function buildJournalExportTable(entries: readonly JournalEntryRecord[]): ReportTable {
  const rows: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const shared = {
      entryDate: formatJalali(entry.entryDate),
      postedAt: formatJalali(entry.postedAt, { withTime: true }),
      source: ledgerSourceLabel(entry.sourceType),
      memo: entry.memo ?? "",
      entryTotal: entry.totalDebit,
      location: entry.locationName ?? "",
      project: entry.projectName ?? "",
      createdBy: entry.createdByName ?? "",
      status: journalStatusLabel(entry),
      entryId: entry.id,
      sourceId: entry.sourceId ?? "",
      reversesEntryId: entry.reversesEntryId ?? "",
      reversedByEntryId: entry.reversedByEntryId ?? "",
      reversedAt: entry.reversedAt ? formatJalali(entry.reversedAt, { withTime: true }) : "",
      reversedByName: entry.reversedByName ?? "",
    };
    if (entry.lines.length === 0) {
      // A document with no lines is corrupt, not absent — it belongs in the
      // export so the person reconciling can see it.
      rows.push({
        ...shared,
        accountCode: "",
        accountName: "",
        debit: "",
        credit: "",
        currency: entry.currencyCode ?? "",
        foreignDebit: "",
        foreignCredit: "",
        exchangeRate: entry.exchangeRate ?? "",
      });
      continue;
    }
    for (const line of entry.lines) {
      rows.push({
        ...shared,
        accountCode: line.accountCode,
        accountName: line.accountName,
        debit: line.debit,
        credit: line.credit,
        currency: entry.currencyCode ?? "",
        foreignDebit: line.foreignDebit !== "0" ? line.foreignDebit : "",
        foreignCredit: line.foreignCredit !== "0" ? line.foreignCredit : "",
        exchangeRate: entry.exchangeRate ?? "",
      });
    }
  }
  return { columns: [...JOURNAL_EXPORT_COLUMNS], rows };
}

/** The download's filename; ASCII, because a `filename=` header value must be. */
export function journalExportFilename(format: "csv" | "xlsx"): string {
  return `journal.${format === "xlsx" ? "xlsx" : "csv"}`;
}
