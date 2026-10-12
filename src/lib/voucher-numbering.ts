/**
 * Issue #867 — formal accounting voucher numbering, the pure part.
 *
 * Every accounting document (journal entry) carries one stable, printable,
 * fiscal-year scoped number: `<PREFIX>-<fiscalYear>-<6-digit sequence>`, e.g.
 * `MJ-1404-000012`. The number is *metadata on `journal_entries`* (see
 * migration 0217) — nothing here creates a document; it only names one.
 *
 * The DB-touching half (sequence allocation, backfill, register, renumber) is
 * `voucher-numbering-service.ts`. This module is what the screen, the service
 * and the tests all agree about: the document-type catalogue, the number's
 * shape, which source type belongs to which book, and where a sequence has a
 * hole.
 */

/**
 * The closed catalogue of numbering books. A document type is a *book*, not a
 * source: every source that posts into a book draws its sequence from that
 * book's per-(business, fiscal year) counter.
 *
 *  - `journal`  — دفتر روزنامه: every auto-posted operational entry (an
 *    order payment, a purchase receipt, a depreciation run …). One running
 *    sequence per fiscal year, the way a physical journal is numbered.
 *  - `manual`   — the manual journal's own book (a manual entry and its
 *    reversal both live here: the reversal is a manual document, dated today).
 *  - `opening`  — the opening-balance postings (the wizard's first entry and
 *    the accountant's sets, posted or reversed).
 *  - `summary`  — summary vouchers: aggregations over defined source sets.
 *    They never post journal lines, but they are accounting documents with
 *    their own book and, therefore, their own numbers.
 */
export const VOUCHER_DOCUMENT_TYPES = ["journal", "manual", "opening", "summary"] as const;
export type VoucherDocumentType = (typeof VOUCHER_DOCUMENT_TYPES)[number];

export interface VoucherDocumentTypeSpec {
  type: VoucherDocumentType;
  /** Latin prefix, printed in the number. Stable forever — a renamed prefix would renumber history. */
  prefix: string;
  /** The book's Persian name, for the register and reports. */
  label: string;
}

export const VOUCHER_DOCUMENT_TYPE_SPECS: Record<VoucherDocumentType, VoucherDocumentTypeSpec> = {
  journal: { type: "journal", prefix: "RJ", label: "دفتر روزنامه" },
  manual: { type: "manual", prefix: "MJ", label: "سند دستی" },
  opening: { type: "opening", prefix: "OP", label: "سند افتتاحیه" },
  summary: { type: "summary", prefix: "SV", label: "سند خلاصه" },
};

/**
 * Which book a posting belongs to, by the entry's own `source_type`.
 *
 * The source type is the entry's fact, so a reversal keeps its original book
 * (a manual entry's reversal is still a manual document), a carry-forward
 * opening posting stays in the opening book, and a document without a source
 * (there is none today) falls into the journal — the book that is the ledger
 * itself. Unknown source types added later land in the journal rather than
 * failing the posting: a new business event must not be unable to post over a
 * numbering question, and the journal is the catch-all that says exactly
 * that.
 */
const OPENING_SOURCE_PREFIXES = ["opening"] as const;

export function documentTypeForSourceType(sourceType: string | null | undefined): VoucherDocumentType {
  const source = (sourceType ?? "").trim();
  if (source === "manual" || source === "manual_reversal") return "manual";
  for (const prefix of OPENING_SOURCE_PREFIXES) {
    if (source === prefix || source.startsWith(`${prefix}_`)) return "opening";
  }
  return "journal";
}

/** A fiscal year's label: the Jalali year as four digits (`1404`). */
export function fiscalYearLabel(jalaliYear: number): string {
  if (!Number.isInteger(jalaliYear) || jalaliYear < 0 || jalaliYear > 9999) {
    throw new Error("invalid_fiscal_year_label");
  }
  return String(jalaliYear).padStart(4, "0");
}

export function isFiscalYearLabel(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}$/.test(value);
}

/**
 * The stable printable number. Six sequence digits covers 999,999 documents
 * per book per fiscal year per business — far past any real year; the check
 * exists so the shape stays one, not to clamp a business that outgrew it.
 */
export const VOUCHER_SEQUENCE_DIGITS = 6;
export const VOUCHER_SEQUENCE_MAX = 10 ** VOUCHER_SEQUENCE_DIGITS;

export function voucherNumberFor(
  documentType: VoucherDocumentType,
  fiscalYearLabel: string,
  sequenceNo: number,
): string {
  if (!VOUCHER_DOCUMENT_TYPES.includes(documentType)) throw new Error("unknown_document_type");
  if (!isFiscalYearLabel(fiscalYearLabel)) throw new Error("invalid_fiscal_year_label");
  if (!Number.isInteger(sequenceNo) || sequenceNo < 1 || sequenceNo >= VOUCHER_SEQUENCE_MAX) {
    throw new Error("invalid_voucher_sequence");
  }
  return `${VOUCHER_DOCUMENT_TYPE_SPECS[documentType].prefix}-${fiscalYearLabel}-${String(sequenceNo).padStart(VOUCHER_SEQUENCE_DIGITS, "0")}`;
}

export interface ParsedVoucherNumber {
  documentType: VoucherDocumentType;
  fiscalYearLabel: string;
  sequenceNo: number;
}

const VOUCHER_NUMBER_RE = /^(RJ|MJ|OP|SV)-([0-9]{4})-([0-9]{6})$/;

/** Parses a printed number back into (book, year, sequence). `null` = not a voucher number. */
export function parseVoucherNumber(value: string | null | undefined): ParsedVoucherNumber | null {
  const match = (value ?? "").match(VOUCHER_NUMBER_RE);
  if (!match) return null;
  const byPrefix: Record<string, VoucherDocumentType> = {
    RJ: "journal",
    MJ: "manual",
    OP: "opening",
    SV: "summary",
  };
  return { documentType: byPrefix[match[1]], fiscalYearLabel: match[2], sequenceNo: Number(match[3]) };
}

/**
 * The accountant's own reference number (what the document was called in the
 * system it came from). It is advisory metadata — never part of the sequence
 * — and its shape is exactly what migration 0217's CHECK allows, so a value
 * that passes here always stores, and one that stores always passes here.
 */
export const VOUCHER_REFERENCE_MAX = 64;
const VOUCHER_REFERENCE_RE = /^[A-Za-z0-9._/-]{1,64}$/;

export function voucherReferenceProblem(value: string | null | undefined): "voucher_reference_invalid" | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null; // empty means "none", not a problem
  if (!VOUCHER_REFERENCE_RE.test(trimmed)) return "voucher_reference_invalid";
  return null;
}

export interface VoucherSequenceRow {
  sequenceNo: number;
  /** Present when the number was minted from the sequence (always, for posted numbers). */
  documentType: VoucherDocumentType;
  fiscalYearLabel: string;
}

/**
 * The holes in a numbered sequence, given its rows in sequence order.
 *
 * A real journal's numbering has three ways to gap, and the report must name
 * them separately because each has a different answer:
 *
 *  - `gaps` — a sequence number that was never used (a posting rolled back
 *    after taking the counter's lock, or a deliberate renumber).
 *  - `manuals` — nothing: manual *reference* numbers are not part of the
 *    sequence and can never gap it.
 *
 * `expectedCount` is what an unbroken sequence from 1 to `max` would hold;
 * `missing` is that minus what is present. `max` of an empty set is 0 and a
 * set with no holes is reported as one, not zero — an empty gap report is a
 * fact worth printing ("سند شماره‌گذاری: بدون شکاف").
 */
export interface VoucherGapReport {
  documentType: VoucherDocumentType;
  fiscalYearLabel: string;
  presentCount: number;
  maxSequenceNo: number;
  gapCount: number;
  /** The missing sequence numbers, ascending, capped for display. */
  missing: number[];
  missingTruncated: boolean;
}

export const VOUCHER_GAP_REPORT_CAP = 500;

export function findVoucherGaps(
  rows: readonly { sequenceNo: number }[],
  documentType: VoucherDocumentType,
  fiscalYearLabel: string,
): VoucherGapReport {
  const present = new Set<number>();
  let max = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.sequenceNo) || row.sequenceNo < 1) continue;
    present.add(row.sequenceNo);
    if (row.sequenceNo > max) max = row.sequenceNo;
  }
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) {
    if (!present.has(n)) {
      if (missing.length < VOUCHER_GAP_REPORT_CAP) missing.push(n);
    }
  }
  const gapCount = max - present.size;
  return {
    documentType,
    fiscalYearLabel,
    presentCount: present.size,
    maxSequenceNo: max,
    gapCount,
    missing,
    missingTruncated: gapCount > missing.length,
  };
}

/**
 * The voucher register's printable column, one rule for screen and export:
 * the stable number when the entry has one, else the sequence the backfill
 * will give it (never a blank — a blank reads as "no document"), else a
 * dash.
 */
export function voucherNumberDisplay(
  entry: { voucherNumber: string | null; sequenceNo: number | null; documentType: VoucherDocumentType; fiscalYearLabel: string } | null,
): string {
  if (!entry) return "—";
  if (entry.voucherNumber) return entry.voucherNumber;
  if (entry.sequenceNo && entry.sequenceNo > 0) {
    try {
      return voucherNumberFor(entry.documentType, entry.fiscalYearLabel, entry.sequenceNo);
    } catch {
      return "—";
    }
  }
  return "—";
}
