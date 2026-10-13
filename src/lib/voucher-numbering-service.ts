/**
 * Issue #867 — voucher numbering, the DB-touching half.
 *
 * The rule (which book a source type belongs to, what a number looks like,
 * where a sequence has a hole) is `voucher-numbering.ts`. This layer owns the
 * transactional boundaries:
 *
 *  - **assignment at posting** — `assignVoucherNumber` runs inside the
 *    posting's own transaction (called from `ledger-service.ts`), so an entry
 *    and its number commit together and a posting that cannot be numbered
 *    rolls back;
 *  - **backfill** — the one-time numbering of entries posted before this
 *    feature, deterministic in journal order and idempotent;
 *  - **renumber** — the privileged, audited change of an existing number
 *    (`ledger.approve` at the route; the 0217 trigger + `voucher_renumber_log`
 *    at the database). Note the log records *changes of numbers that already
 *    exist*: first assignments — the posting path and the backfill — take a
 *    `NULL` number without the flag and deliberately write no log row, so a
 *    migration-scale backfill does not drown the trail renumbers exist to
 *    show (0217's column comment speaks of a backfill row with a NULL
 *    `previous_number`; the implementation is the trigger's NULL-allowance,
 *    which is what this layer relies on);
 *  - **summary vouchers** — aggregation documents over a defined source set,
 *    traced through `summary_voucher_sources`, never posting a second truth.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { isUuid } from "./uuid";
import { isoDateToJalali, isValidIsoDate } from "./jalali";
import {
  VOUCHER_DOCUMENT_TYPES,
  VOUCHER_DOCUMENT_TYPE_SPECS,
  documentTypeForSourceType,
  fiscalYearLabel,
  findVoucherGaps,
  isFiscalYearLabel,
  parseVoucherNumber,
  voucherNumberFor,
  voucherReferenceProblem,
  type VoucherDocumentType,
  type VoucherGapReport,
} from "./voucher-numbering";

export class VoucherError extends Error {
  status: number;
  /** Optional structured context a route may return beside the code. */
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

/** The Jalali (fiscal) year an ISO calendar date falls in, or null for an invalid date. */
export function fiscalYearLabelForIsoDate(isoDate: string): string | null {
  if (!isValidIsoDate(isoDate)) return null;
  const jalali = isoDateToJalali(isoDate);
  if (!jalali) return null;
  return fiscalYearLabel(jalali.jy);
}

interface SequenceRow extends Record<string, unknown> {
  last_number: string;
}

/**
 * Allocates the next sequence number for (business, fiscal year, document
 * type) and returns it, inside the caller's transaction.
 *
 * The upsert creates the counter row on first use (filling the fiscal-year
 * link when the year is defined already, or leaving it for a later posting to
 * fill), and the `SELECT … FOR UPDATE` serialises two concurrent postings
 * against the same counter. The lock is held only for the increment — the
 * caller assigns the number to its own entry and commits; a posting that
 * rolls back leaves the counter advanced, which is exactly how a physical
 * journal behaves (a torn-out page still has its number) and what the gap
 * report exists to show.
 */
export async function allocateVoucherSequence(
  client: PoolClient,
  params: {
    businessId: string;
    fiscalYearId: string | null;
    fiscalYearLabel: string;
    documentType: VoucherDocumentType;
  },
): Promise<{ sequenceNo: number; fiscalYearLabel: string; documentType: VoucherDocumentType }> {
  await client.query(
    `INSERT INTO voucher_sequences (business_id, fiscal_year_id, fiscal_year_label, document_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, fiscal_year_label, document_type)
     DO UPDATE SET fiscal_year_id = COALESCE(voucher_sequences.fiscal_year_id, EXCLUDED.fiscal_year_id),
                   updated_at = now()`,
    [params.businessId, params.fiscalYearId, params.fiscalYearLabel, params.documentType],
  );
  const { rows } = await client.query<SequenceRow>(
    `SELECT last_number::text AS last_number
       FROM voucher_sequences
      WHERE business_id = $1 AND fiscal_year_label = $2 AND document_type = $3
      FOR UPDATE`,
    [params.businessId, params.fiscalYearLabel, params.documentType],
  );
  const sequenceNo = Number(BigInt(rows[0].last_number) + 1n);
  await client.query(
    `UPDATE voucher_sequences SET last_number = $4, updated_at = now()
      WHERE business_id = $1 AND fiscal_year_label = $2 AND document_type = $3`,
    [params.businessId, params.fiscalYearLabel, params.documentType, sequenceNo],
  );
  return { sequenceNo, fiscalYearLabel: params.fiscalYearLabel, documentType: params.documentType };
}

/** The fiscal year record for a business's Jalali year, when one exists. */
async function fiscalYearIdForLabel(client: PoolClient, businessId: string, label: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM fiscal_years WHERE business_id = $1 AND label = $2",
    [businessId, label],
  );
  return rows[0]?.id ?? null;
}

/**
 * Assigns the just-posted entry its number. Called inside the posting's
 * transaction; the entry's own stored `entry_date` is the fact the fiscal
 * year is derived from (so a `CURRENT_DATE` default and the number can never
 * disagree).
 */
export async function assignVoucherNumber(
  client: PoolClient,
  params: {
    businessId: string;
    entryId: string;
    entryDate: string;
    sourceType: string | null;
    /** The accountant's own reference number, when the posting carries one. */
    voucherReference?: string | null;
  },
): Promise<{ voucherNumber: string; sequenceNo: number; fiscalYearLabel: string; documentType: VoucherDocumentType }> {
  const label = fiscalYearLabelForIsoDate(params.entryDate);
  if (!label) throw new Error("voucher_numbering: invalid entry date");
  const documentType = documentTypeForSourceType(params.sourceType);
  const fiscalYearId = await fiscalYearIdForLabel(client, params.businessId, label);
  const seq = await allocateVoucherSequence(client, {
    businessId: params.businessId,
    fiscalYearId,
    fiscalYearLabel: label,
    documentType,
  });
  const voucherNumber = voucherNumberFor(documentType, label, seq.sequenceNo);
  await client.query(
    `UPDATE journal_entries
        SET voucher_number = $3, voucher_sequence_no = $4, voucher_reference = $5, voucher_assigned_at = now()
      WHERE id = $1 AND business_id = $2`,
    [params.entryId, params.businessId, voucherNumber, seq.sequenceNo, params.voucherReference ?? null],
  );
  return { voucherNumber, sequenceNo: seq.sequenceNo, fiscalYearLabel: label, documentType };
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

interface UnnumberedEntryRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  source_type: string | null;
}

/**
 * Numbers every unnumbered entry of a business, in journal order
 * `(entry_date, posted_at, id)` — the order a physical journal was kept in.
 * Idempotent: a second run finds nothing to do. Runs in its own transaction
 * so a crash never leaves half a business numbered and the counter out of
 * step with the entries.
 *
 * Race-safe against live postings: each (year, book) group **reserves its
 * whole range atomically** — one `voucher_sequences` upsert that adds the
 * group's size to the counter and hands back the starting point. A posting
 * that allocates from the same counter blocks on that row lock until the
 * backfill commits, then takes the next free number — the two can never
 * hand out the same sequence. (A first, unlocked read of the counter would
 * let a concurrent posting slip in between the read and the write and take
 * a number the backfill also reserved: a unique violation and a 500 on the
 * register, only a cosmetic problem in the one window where unnumbered
 * legacy entries still exist, but a 500 is a 500.)
 *
 * If two backfills race instead, the loser's group updates match nothing —
 * the `voucher_number IS NULL` guard — and its reserved range becomes the
 * gaps the gap report already knows how to name (a torn page keeps its
 * number); no entry is ever numbered twice.
 */
export async function backfillVoucherNumbers(businessId: string): Promise<{ backfilled: number }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<UnnumberedEntryRow>(
      `SELECT id, entry_date::text AS entry_date, source_type
         FROM journal_entries
        WHERE business_id = $1 AND voucher_number IS NULL
        ORDER BY entry_date, posted_at, id`,
      [businessId],
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return { backfilled: 0 };
    }

    // The groups, in journal order: (fiscal year, book) -> the entries it
    // numbers. The fiscal-year link is resolved once per label, the same way
    // the posting path does it.
    const groups = new Map<
      string,
      { label: string; type: VoucherDocumentType; fiscalYearId: string | null; entries: UnnumberedEntryRow[] }
    >();
    for (const entry of rows) {
      const label = fiscalYearLabelForIsoDate(entry.entry_date);
      if (!label) throw new Error("voucher_numbering: entry date outside the supported range");
      const type = documentTypeForSourceType(entry.source_type);
      const key = `${label}|${type}`;
      const group = groups.get(key) ?? { label, type, fiscalYearId: null, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.fiscalYearId = await fiscalYearIdForLabel(client, businessId, group.label);
    }

    let backfilled = 0;
    for (const group of groups.values()) {
      const size = group.entries.length;

      // The atomic reservation: the upsert locks the counter row (or creates
      // it), advances it by the group's size in one statement, and hands back
      // where the group's range starts. See the docblock for why this is the
      // synchronisation point with `allocateVoucherSequence`.
      const { rows: reserved } = await client.query<{ lo: string }>(
        `WITH s AS (
           INSERT INTO voucher_sequences (business_id, fiscal_year_id, fiscal_year_label, document_type, last_number)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (business_id, fiscal_year_label, document_type)
           DO UPDATE SET last_number = voucher_sequences.last_number + $5,
                         fiscal_year_id = COALESCE(voucher_sequences.fiscal_year_id, $2),
                         updated_at = now()
           RETURNING last_number - $5 AS lo
         )
         SELECT lo::text AS lo FROM s`,
        [businessId, group.fiscalYearId, group.label, group.type, size],
      );
      const start = BigInt(reserved[0].lo);

      // One statement per 500 rows. The casts matter: the extended protocol
      // has no way to infer a type for $n inside VALUES, so every column gets
      // its type spelled out. `voucher_number IS NULL` is the lost-race guard
      // from the docblock — it must be there for the update to be safe under
      // a concurrent backfill, not merely because it is tidy.
      for (let i = 0; i < group.entries.length; i += 500) {
        const batch = group.entries.slice(i, i + 500);
        const values = batch
          .map((e, idx) => `('${e.id}'::uuid, $${idx * 2 + 2}::text, $${idx * 2 + 3}::int8)`)
          .join(", ");
        const params: unknown[] = [businessId];
        batch.forEach((e, idx) => {
          const seq = Number(start + BigInt(i + idx) + 1n);
          params.push(voucherNumberFor(group.type, group.label, seq), seq);
        });
        const result = await client.query(
          `UPDATE journal_entries je
              SET voucher_number = v.number,
                  voucher_sequence_no = v.seq,
                  voucher_assigned_at = now()
            FROM (VALUES ${values}) AS v(id, number, seq)
           WHERE je.id = v.id AND je.business_id = $1 AND je.voucher_number IS NULL`,
          params,
        );
        backfilled += result.rowCount ?? 0;
      }
    }

    await client.query("COMMIT");
    return { backfilled };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Register / gaps
// ---------------------------------------------------------------------------

export interface VoucherRegisterFilters {
  from?: string;
  to?: string;
  documentType?: VoucherDocumentType;
  sourceType?: string;
  search?: string;
  /** Keyset cursor: the last row of the previous page, in register order. */
  cursor?: { voucherNumber: string | null; entryDate: string; id: string };
  limit?: number;
}

export interface VoucherRegisterRow {
  id: string;
  voucherNumber: string | null;
  sequenceNo: number | null;
  fiscalYearLabel: string;
  documentType: VoucherDocumentType;
  voucherReference: string | null;
  entryDate: string;
  sourceType: string | null;
  sourceId: string | null;
  postingKind: string | null;
  memo: string | null;
  totalDebit: string;
  totalCredit: string;
  reversesEntryId: string | null;
  reversedAt: string | null;
  postedAt: string;
  createdByName: string | null;
}

/**
 * The voucher register: every posted entry with its number, in number order
 * (a register is read by number, not by arrival). Keyset pagination over
 * `(voucher_number NULLS LAST, entry_date, id)`. The book is backfilled
 * before it is read, so the list and the export of the same page cannot
 * disagree about which rows carry numbers.
 */
export async function listVoucherRegister(
  businessId: string,
  filters: VoucherRegisterFilters = {},
): Promise<{
  rows: VoucherRegisterRow[];
  nextCursor: { voucherNumber: string | null; entryDate: string; id: string } | null;
  total: number;
}> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

  if ((await unnumberedCount(businessId)) > 0n) await backfillVoucherNumbers(businessId);

  const where: string[] = ["je.business_id = $1"];
  const params: unknown[] = [businessId];
  const add = (clause: string, ...values: unknown[]) => {
    params.push(...values);
    where.push(clause.replace(/(\$\d)/g, (_m, n) => `$${params.length - values.length + Number(n)}`));
  };
  if (filters.from && isValidIsoDate(filters.from)) add("je.entry_date >= $1::date", filters.from);
  if (filters.to && isValidIsoDate(filters.to)) add("je.entry_date <= $1::date", filters.to);
  if (filters.documentType && VOUCHER_DOCUMENT_TYPES.includes(filters.documentType)) {
    add("je.voucher_number LIKE $1", `${VOUCHER_DOCUMENT_TYPE_SPECS[filters.documentType].prefix}-%`);
  }
  if (filters.sourceType) add("je.source_type = $1", filters.sourceType);
  if (filters.search && filters.search.trim()) {
    // Through `add` — the clause's $1 must be renumbered past the params
    // already bound (business id first); pushing the raw clause left both
    // ILIKEs bound to $1 (the business id) and the pattern bound to nothing.
    add("(je.voucher_number ILIKE $1 OR je.memo ILIKE $1)", `%${filters.search.trim()}%`);
  }
  if (filters.cursor) {
    if (filters.cursor.voucherNumber !== null) {
      add(
        `(je.voucher_number IS NOT NULL AND (je.voucher_number, je.entry_date, je.id) > ($1, $2::date, $3::uuid))`,
        filters.cursor.voucherNumber,
        filters.cursor.entryDate,
        filters.cursor.id,
      );
    } else {
      add("(je.voucher_number IS NULL AND (je.entry_date, je.id) > ($1::date, $2::uuid))", filters.cursor.entryDate, filters.cursor.id);
    }
  }

  const { rows: countRows } = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM journal_entries je WHERE ${where.join(" AND ")}`,
    params,
  );

  const { rows } = await query<Record<string, unknown>>(
    `SELECT je.id,
            je.voucher_number,
            je.voucher_sequence_no,
            je.voucher_reference,
            je.entry_date::text AS entry_date,
            je.source_type,
            je.source_id,
            je.posting_kind,
            je.memo,
            je.reverses_entry_id,
            je.reversed_at::text AS reversed_at,
            je.posted_at::text AS posted_at,
            COALESCE(t.debit, 0)::text AS total_debit,
            COALESCE(t.credit, 0)::text AS total_credit,
            u.full_name AS created_by_name
       FROM journal_entries je
       LEFT JOIN (SELECT entry_id, SUM(debit) AS debit, SUM(credit) AS credit
                    FROM journal_lines GROUP BY entry_id) t ON t.entry_id = je.id
       LEFT JOIN users u ON u.id = je.created_by
      WHERE ${where.join(" AND ")}
      ORDER BY (je.voucher_number IS NULL) ASC, je.voucher_number ASC, je.entry_date ASC, je.id ASC
      LIMIT $${params.length + 1}`,
    [...params, limit],
  );

  const out: VoucherRegisterRow[] = rows.map((r) => {
    const parsed = r.voucher_number ? parseVoucherNumber(r.voucher_number as string) : null;
    return {
      id: r.id as string,
      voucherNumber: (r.voucher_number as string | null) ?? null,
      sequenceNo: r.voucher_sequence_no === null ? null : Number(r.voucher_sequence_no),
      fiscalYearLabel: parsed?.fiscalYearLabel ?? (fiscalYearLabelForIsoDate(r.entry_date as string) ?? ""),
      documentType: parsed?.documentType ?? documentTypeForSourceType(r.source_type as string | null),
      voucherReference: (r.voucher_reference as string | null) ?? null,
      entryDate: r.entry_date as string,
      sourceType: (r.source_type as string | null) ?? null,
      sourceId: (r.source_id as string | null) ?? null,
      postingKind: (r.posting_kind as string | null) ?? null,
      memo: (r.memo as string | null) ?? null,
      totalDebit: r.total_debit as string,
      totalCredit: r.total_credit as string,
      reversesEntryId: (r.reverses_entry_id as string | null) ?? null,
      reversedAt: r.reversed_at as string | null,
      postedAt: r.posted_at as string,
      createdByName: (r.created_by_name as string | null) ?? null,
    };
  });

  const last = out[out.length - 1];
  const nextCursor =
    out.length === limit && last
      ? { voucherNumber: last.voucherNumber, entryDate: last.entryDate, id: last.id }
      : null;

  return { rows: out, nextCursor, total: Number(countRows[0]?.total ?? out.length) };
}

/**
 * The complete filtered register, page by page — what an export must be.
 * One `listVoucherRegister` call is one page (≤ 200 rows); a register with
 * 3,000 entries in a year is not a 200-row file. Keyset cursor, same filters
 * on every page, a hard cap so a runaway filter cannot stream forever.
 */
export async function fetchAllVoucherRegisterRows(
  businessId: string,
  filters: Omit<VoucherRegisterFilters, "cursor" | "limit">,
  maxRows = 20_000,
): Promise<VoucherRegisterRow[]> {
  const out: VoucherRegisterRow[] = [];
  let cursor: VoucherRegisterFilters["cursor"];
  for (;;) {
    const page = await listVoucherRegister(businessId, { ...filters, cursor, limit: 200 });
    out.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
    if (!cursor || out.length >= maxRows) break;
  }
  return out;
}

async function unnumberedCount(businessId: string): Promise<bigint> {
  const { rows } = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND voucher_number IS NULL",
    [businessId],
  );
  return BigInt(rows[0]?.n ?? "0");
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

export async function voucherGapReport(
  businessId: string,
  params: { fiscalYearLabel: string; documentType: VoucherDocumentType },
): Promise<VoucherGapReport & { counterMax: number }> {
  if (!isFiscalYearLabel(params.fiscalYearLabel)) throw new VoucherError("invalid_fiscal_year_label", 400);
  if (!VOUCHER_DOCUMENT_TYPES.includes(params.documentType)) throw new VoucherError("unknown_document_type", 400);

  if ((await unnumberedCount(businessId)) > 0n) await backfillVoucherNumbers(businessId);

  const { rows } = await query<{ sequence_no: string }>(
    `SELECT voucher_sequence_no::text AS sequence_no
       FROM journal_entries
      WHERE business_id = $1
        AND voucher_number IS NOT NULL
        AND voucher_number LIKE $2`,
    [
      businessId,
      `${VOUCHER_DOCUMENT_TYPE_SPECS[params.documentType].prefix}-${params.fiscalYearLabel}-%`,
    ],
  );
  const inUse = rows.map((r) => Number(r.sequence_no));
  const { rows: counterRows } = await query<{ last_number: string }>(
    `SELECT last_number::text AS last_number FROM voucher_sequences
      WHERE business_id = $1 AND fiscal_year_label = $2 AND document_type = $3`,
    [businessId, params.fiscalYearLabel, params.documentType],
  );
  // The counter's high-water mark is part of the gap math: a number the
  // counter has already handed out that no live entry holds (entry deleted,
  // renumbered below it) is a hole renumbering may never reuse, so it shows
  // in `missing` — not just in the counterMax readout.
  const counterMax = Number(BigInt(counterRows[0]?.last_number ?? "0"));
  const report = findVoucherGaps(
    inUse.map((sequenceNo) => ({ sequenceNo })),
    params.documentType,
    params.fiscalYearLabel,
    counterMax,
  );
  return { ...report, counterMax: Math.max(report.maxSequenceNo, counterMax) };
}

// ---------------------------------------------------------------------------
// Renumber — privileged, audited
// ---------------------------------------------------------------------------

export interface RenumberParams {
  businessId: string;
  entryId: string;
  /** The new sequence within the entry's own book and fiscal year. */
  newSequenceNo: number;
  /** Optional new reference number. */
  newReference?: string | null;
  reason: string;
  actorId: string;
}

/**
 * Changes an existing entry's number. The only writer of the voucher columns
 * on an already-numbered entry: it sets the transaction flag the 0217 trigger
 * checks, updates the entry, and writes the audit row — in one transaction,
 * so a renumber either has its log row or did not happen.
 */
export async function renumberEntry(params: RenumberParams): Promise<{ entryId: string; voucherNumber: string }> {
  if (!isUuid(params.entryId)) throw new VoucherError("entry_not_found", 404);
  if (!Number.isInteger(params.newSequenceNo) || params.newSequenceNo < 1) {
    throw new VoucherError("invalid_sequence", 400);
  }
  const reason = params.reason.trim();
  if (reason.length === 0 || reason.length > 500) throw new VoucherError("reason_required", 400);
  if (params.newReference !== undefined && params.newReference !== null && voucherReferenceProblem(params.newReference)) {
    throw new VoucherError("voucher_reference_invalid", 400);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.allow_voucher_renumber', 'on', true)");

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT je.id, je.voucher_number, je.voucher_sequence_no, je.voucher_reference
         FROM journal_entries je
        WHERE je.id = $1 AND je.business_id = $2
        FOR UPDATE`,
      [params.entryId, params.businessId],
    );
    const entry = rows[0];
    if (!entry) throw new VoucherError("entry_not_found", 404);

    const parsed = entry.voucher_number ? parseVoucherNumber(entry.voucher_number as string) : null;
    if (!parsed) throw new VoucherError("entry_not_numbered", 409);
    // A renumber moves the number within its book and year — never between books.
    const voucherNumber = voucherNumberFor(parsed.documentType, parsed.fiscalYearLabel, params.newSequenceNo);
    const previousNumber = entry.voucher_number as string | null;
    const previousSequenceNo = entry.voucher_sequence_no === null ? null : Number(entry.voucher_sequence_no);
    const previousReference = (entry.voucher_reference as string | null) ?? null;
    const newReference = params.newReference === undefined ? previousReference : params.newReference?.trim() || null;

    await client.query(
      `UPDATE journal_entries
          SET voucher_number = $3, voucher_sequence_no = $4, voucher_reference = $5,
              voucher_assigned_by = $6, voucher_assigned_at = now()
        WHERE id = $1 AND business_id = $2`,
      [params.entryId, params.businessId, voucherNumber, params.newSequenceNo, newReference, params.actorId],
    );
    await client.query(
      `INSERT INTO voucher_renumber_log
         (business_id, journal_entry_id, fiscal_year_label, document_type,
          previous_number, new_number, previous_sequence_no, new_sequence_no, reason, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        params.businessId,
        params.entryId,
        parsed.fiscalYearLabel,
        parsed.documentType,
        previousNumber,
        voucherNumber,
        previousSequenceNo,
        params.newSequenceNo,
        reason,
        params.actorId,
      ],
    );
    // The renumber moves the pen: the book's counter must never sit behind
    // the highest number in use, or the next allocation would hand out a
    // number the renumber already skipped past.
    const fiscalYearId = await fiscalYearIdForLabel(client, params.businessId, parsed.fiscalYearLabel);
    await client.query(
      `INSERT INTO voucher_sequences (business_id, fiscal_year_id, fiscal_year_label, document_type, last_number)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, fiscal_year_label, document_type)
       DO UPDATE SET last_number = GREATEST(voucher_sequences.last_number, EXCLUDED.last_number),
                     fiscal_year_id = COALESCE(voucher_sequences.fiscal_year_id, EXCLUDED.fiscal_year_id),
                     updated_at = now()`,
      [params.businessId, fiscalYearId, parsed.fiscalYearLabel, parsed.documentType, params.newSequenceNo],
    );
    await client.query("COMMIT");
    return { entryId: params.entryId, voucherNumber };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // A unique-violation on the new number is a collision with another entry,
    // not a server fault.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new VoucherError("voucher_number_taken", 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function listRenumberLog(businessId: string, limit = 200): Promise<
  Array<{
    id: string;
    entryId: string;
    fiscalYearLabel: string;
    documentType: string;
    previousNumber: string | null;
    newNumber: string;
    reason: string;
    performedByName: string | null;
    createdAt: string;
  }>
> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT l.id, l.journal_entry_id, l.fiscal_year_label, l.document_type,
            l.previous_number, l.new_number, l.reason, l.created_at::text AS created_at,
            u.full_name AS performed_by_name
       FROM voucher_renumber_log l
       LEFT JOIN users u ON u.id = l.performed_by
      WHERE l.business_id = $1
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    entryId: r.journal_entry_id as string,
    fiscalYearLabel: r.fiscal_year_label as string,
    documentType: r.document_type as string,
    previousNumber: (r.previous_number as string | null) ?? null,
    newNumber: r.new_number as string,
    reason: r.reason as string,
    performedByName: (r.performed_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

// ---------------------------------------------------------------------------
// Summary vouchers
// ---------------------------------------------------------------------------

export interface SummaryVoucherScope {
  /** Explicit entries; when present, no other filter widens it. */
  entryIds?: string[];
  sourceTypes?: string[];
  from?: string;
  to?: string;
}

export interface SummaryVoucherParams {
  businessId: string;
  label: string;
  scope: SummaryVoucherScope;
  idempotencyKey?: string | null;
  actorId: string;
}

export interface SummaryVoucherRow {
  id: string;
  voucherNumber: string;
  label: string;
  scope: SummaryVoucherScope;
  entryCount: number;
  totalDebit: string;
  totalCredit: string;
  fiscalYearLabel: string;
  createdAt: string;
  createdByName: string | null;
}

export interface SummaryVoucherSourceRow {
  journalEntryId: string;
  entryDate: string;
  sourceType: string | null;
  entryVoucherNumber: string | null;
  totalDebit: string;
  totalCredit: string;
}

interface SourceEntryRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  source_type: string | null;
  voucher_number: string | null;
  debit: string;
  credit: string;
}

/**
 * Builds the WHERE for a scope. A scope must define its set completely:
 * explicit entries, or source types (optionally with a date cutoff). A scope
 * with no constraint is refused — a summary of "everything" is not a defined
 * source set, and the double-inclusion guard would make the first such
 * voucher swallow the whole book.
 */
function scopeWhere(businessId: string, scope: SummaryVoucherScope): { sql: string; params: unknown[] } {
  const where: string[] = ["je.business_id = $1", "je.reversed_at IS NULL"];
  const params: unknown[] = [businessId];
  if (scope.entryIds && scope.entryIds.length > 0) {
    const ids = scope.entryIds.filter((id) => isUuid(id)).slice(0, 5000);
    if (ids.length === 0) throw new VoucherError("scope_invalid", 400);
    params.push(ids);
    where.push(`je.id = ANY($${params.length}::uuid[])`);
  } else {
    let hasConstraint = false;
    if (scope.sourceTypes && scope.sourceTypes.length > 0) {
      params.push(scope.sourceTypes.slice(0, 50));
      where.push(`je.source_type = ANY($${params.length}::text[])`);
      hasConstraint = true;
    }
    if (scope.from && isValidIsoDate(scope.from)) {
      params.push(scope.from);
      where.push(`je.entry_date >= $${params.length}::date`);
      hasConstraint = true;
    }
    if (scope.to && isValidIsoDate(scope.to)) {
      params.push(scope.to);
      where.push(`je.entry_date <= $${params.length}::date`);
      hasConstraint = true;
    }
    if (!hasConstraint) throw new VoucherError("scope_invalid", 400);
  }
  return { sql: where.join(" AND "), params };
}

/**
 * Generates a summary voucher over a defined source set. The source set must
 * balance as a whole (it is the aggregation's identity), no source may already
 * sit in another summary voucher (the double-inclusion guard), and an
 * idempotency key returns the original on retry. Nothing here posts or
 * modifies a journal entry — the sources are linked, with snapshots of their
 * own numbers, and the detail stays exactly where it is.
 */
export async function generateSummaryVoucher(
  params: SummaryVoucherParams,
): Promise<SummaryVoucherRow & { sources: SummaryVoucherSourceRow[]; idempotent: boolean }> {
  const label = params.label.trim();
  if (label.length === 0 || label.length > 200) throw new VoucherError("label_required", 400);
  const idempotencyKey = params.idempotencyKey?.trim() || null;
  if (idempotencyKey && !/^[A-Za-z0-9._-]{1,128}$/.test(idempotencyKey)) {
    throw new VoucherError("invalid_idempotency_key", 400);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (idempotencyKey) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM summary_vouchers
          WHERE business_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [params.businessId, idempotencyKey],
      );
      if (rows[0]) {
        await client.query("COMMIT");
        const existing = await getSummaryVoucher(params.businessId, rows[0].id);
        if (!existing) throw new VoucherError("summary_voucher_not_found", 404);
        return { ...existing, idempotent: true };
      }
    }

    const { sql, params: scopeParams } = scopeWhere(params.businessId, params.scope);

    const { rows: included } = await client.query<SourceEntryRow>(
      `SELECT je.id, je.entry_date::text AS entry_date, je.source_type, je.voucher_number,
              COALESCE(SUM(jl.debit), 0)::text AS debit,
              COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE ${sql}
        GROUP BY je.id, je.entry_date, je.source_type, je.voucher_number
        ORDER BY je.entry_date, je.posted_at, je.id`,
      scopeParams,
    );
    if (included.length === 0) throw new VoucherError("scope_empty", 400);

    let totalDebit = 0n;
    let totalCredit = 0n;
    for (const row of included) {
      totalDebit += BigInt(row.debit);
      totalCredit += BigInt(row.credit);
    }
    if (totalDebit !== totalCredit) throw new VoucherError("scope_not_balanced", 400);

    const { rows: alreadyIncluded } = await client.query<{ entry_id: string }>(
      `SELECT journal_entry_id AS entry_id
         FROM summary_voucher_sources
        WHERE business_id = $1 AND journal_entry_id = ANY($2::uuid[])`,
      [params.businessId, included.map((r) => r.id)],
    );
    if (alreadyIncluded.length > 0) {
      throw new VoucherError("entries_already_summarised", 409, {
        entryIds: alreadyIncluded.map((r) => r.entry_id),
      });
    }

    // The document's fiscal year is the latest entry's year — the year the
    // summary describes.
    const latestDate = included[included.length - 1].entry_date;
    const yearLabel = fiscalYearLabelForIsoDate(latestDate);
    if (!yearLabel) throw new VoucherError("scope_invalid", 400);
    const fiscalYearId = await fiscalYearIdForLabel(client, params.businessId, yearLabel);
    const seq = await allocateVoucherSequence(client, {
      businessId: params.businessId,
      fiscalYearId,
      fiscalYearLabel: yearLabel,
      documentType: "summary",
    });
    const voucherNumber = voucherNumberFor("summary", yearLabel, seq.sequenceNo);

    const { rows: voucherRows } = await client.query<{ id: string }>(
      `INSERT INTO summary_vouchers
         (business_id, fiscal_year_id, voucher_number, label, scope, entry_count, total_debit, total_credit, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        params.businessId,
        fiscalYearId,
        voucherNumber,
        label,
        JSON.stringify(params.scope),
        included.length,
        totalDebit.toString(),
        totalCredit.toString(),
        idempotencyKey,
        params.actorId,
      ],
    );
    const summaryId = voucherRows[0].id;
    for (const row of included) {
      await client.query(
        `INSERT INTO summary_voucher_sources
           (business_id, summary_voucher_id, journal_entry_id, entry_date, source_type, entry_voucher_number, total_debit, total_credit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          params.businessId,
          summaryId,
          row.id,
          row.entry_date,
          row.source_type,
          row.voucher_number,
          row.debit,
          row.credit,
        ],
      );
    }
    await client.query("COMMIT");

    const created = await getSummaryVoucher(params.businessId, summaryId);
    if (!created) throw new VoucherError("summary_voucher_not_found", 404);
    return { ...created, idempotent: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      // Two retries with the same key raced: one committed, the other met the
      // unique index and answers with the winner.
      if (idempotencyKey) {
        const { rows } = await query<{ id: string }>(
          "SELECT id FROM summary_vouchers WHERE business_id = $1 AND idempotency_key = $2",
          [params.businessId, idempotencyKey],
        );
        if (rows[0]) {
          const existing = await getSummaryVoucher(params.businessId, rows[0].id);
          if (existing) return { ...existing, idempotent: true };
        }
      }
      throw new VoucherError("idempotency_conflict", 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getSummaryVoucher(
  businessId: string,
  summaryId: string,
): Promise<(SummaryVoucherRow & { sources: SummaryVoucherSourceRow[] }) | null> {
  if (!isUuid(summaryId)) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT v.id, v.voucher_number, v.label, v.scope, v.entry_count,
            v.total_debit::text AS total_debit, v.total_credit::text AS total_credit,
            v.created_at::text AS created_at, u.full_name AS created_by_name
       FROM summary_vouchers v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.id = $1 AND v.business_id = $2`,
    [summaryId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const parsed = parseVoucherNumber(row.voucher_number as string);
  const { rows: sources } = await query<Record<string, unknown>>(
    `SELECT s.journal_entry_id, s.entry_date::text AS entry_date, s.source_type,
            s.entry_voucher_number, s.total_debit::text AS total_debit, s.total_credit::text AS total_credit
       FROM summary_voucher_sources s
      WHERE s.summary_voucher_id = $1
      ORDER BY s.entry_date, s.journal_entry_id`,
    [summaryId],
  );
  return {
    id: row.id as string,
    voucherNumber: row.voucher_number as string,
    label: row.label as string,
    // The column is jsonb, so the driver hands back a parsed object; the
    // string branch covers a plain-text driver configuration.
    scope: (typeof row.scope === "string" ? JSON.parse(row.scope) : row.scope) as SummaryVoucherScope,
    entryCount: Number(row.entry_count),
    totalDebit: row.total_debit as string,
    totalCredit: row.total_credit as string,
    fiscalYearLabel: parsed?.fiscalYearLabel ?? "",
    createdAt: row.created_at as string,
    createdByName: (row.created_by_name as string | null) ?? null,
    sources: sources.map((s) => ({
      journalEntryId: s.journal_entry_id as string,
      entryDate: s.entry_date as string,
      sourceType: (s.source_type as string | null) ?? null,
      entryVoucherNumber: (s.entry_voucher_number as string | null) ?? null,
      totalDebit: s.total_debit as string,
      totalCredit: s.total_credit as string,
    })),
  };
}

export async function listSummaryVouchers(businessId: string): Promise<SummaryVoucherRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT v.id, v.voucher_number, v.label, v.scope, v.entry_count,
            v.total_debit::text AS total_debit, v.total_credit::text AS total_credit,
            v.created_at::text AS created_at, u.full_name AS created_by_name
       FROM summary_vouchers v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.business_id = $1
      ORDER BY v.created_at DESC, v.id DESC`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    voucherNumber: r.voucher_number as string,
    label: r.label as string,
    scope: (typeof r.scope === "string" ? JSON.parse(r.scope) : r.scope) as SummaryVoucherScope,
    entryCount: Number(r.entry_count),
    totalDebit: r.total_debit as string,
    totalCredit: r.total_credit as string,
    fiscalYearLabel: parseVoucherNumber(r.voucher_number as string)?.fiscalYearLabel ?? "",
    createdAt: r.created_at as string,
    createdByName: (r.created_by_name as string | null) ?? null,
  }));
}
