/**
 * Accounting voucher identity — the DB-touching half (issue #867).
 *
 * The number itself is assigned by the database (migration 0216). This module
 * reads the voucher register and the numbering gap report, and performs the two
 * controlled changes that can touch an issued identity:
 *
 *  - renumber: move a document into a gap the sequence has already issued
 *    (owner only, in the route);
 *  - reference: set or change the business's own reference number (ledger.post).
 *
 * Both run inside the database's privileged path: the transaction sets the
 * `app.voucher_identity_change` flag, the guard trigger lets the one UPDATE
 * through, and the change is written to the append-only `journal_voucher_audit`
 * in the same transaction. A caller cannot change identity without the audit.
 */
import { getPool, query, type PoolClient } from "./db";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import {
  formatVoucherNo,
  normalizeVoucherChangeReason,
  normalizeVoucherReference,
  renumberTargetError,
} from "./vouchers";

export class VoucherError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

export interface VoucherRegisterRow {
  id: string;
  voucherNo: string;
  voucherYear: number;
  voucherNumber: number;
  externalReference: string | null;
  entryDate: string;
  postedAt: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversedAt: string | null;
  totalDebit: number;
}

export interface VoucherRegisterFilter {
  voucherYear?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sourceType?: string | null;
  /** Matches the voucher number, the reference or the memo. */
  q?: string | null;
  limit?: number | null;
}

export const VOUCHER_REGISTER_DEFAULT_LIMIT = 200;
export const VOUCHER_REGISTER_MAX_LIMIT = 500;

/** Every document of the business by its number, newest year and number first. */
export async function listVoucherRegister(businessId: string, filter: VoucherRegisterFilter): Promise<VoucherRegisterRow[]> {
  if (filter.dateFrom && !isValidIsoDate(filter.dateFrom)) throw new VoucherError("invalid_date", 400);
  if (filter.dateTo && !isValidIsoDate(filter.dateTo)) throw new VoucherError("invalid_date", 400);
  const year = filter.voucherYear ?? null;
  if (year !== null && (!Number.isSafeInteger(year) || year < 1)) throw new VoucherError("invalid_voucher_year", 400);
  const limit = Math.min(
    Math.max(Math.trunc(filter.limit ?? VOUCHER_REGISTER_DEFAULT_LIMIT), 1),
    VOUCHER_REGISTER_MAX_LIMIT,
  );
  const q = filter.q?.trim() || null;

  const { rows } = await query<{
    id: string;
    voucher_no: string;
    voucher_year: number;
    voucher_number: string;
    external_reference: string | null;
    entry_date: string;
    posted_at: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    reverses_entry_id: string | null;
    reversed_at: string | null;
    total_debit: string;
  }>(
    `SELECT je.id, je.voucher_no, je.voucher_year, je.voucher_number::text AS voucher_number,
            je.external_reference, je.entry_date::text AS entry_date, je.posted_at::text AS posted_at,
            je.memo, je.source_type, je.source_id::text AS source_id,
            je.reverses_entry_id, je.reversed_at::text AS reversed_at,
            COALESCE((SELECT sum(jl.debit) FROM journal_lines jl WHERE jl.entry_id = je.id), 0)::text AS total_debit
       FROM journal_entries je
      WHERE je.business_id = $1
        AND ($2::int IS NULL OR je.voucher_year = $2::int)
        AND ($3::date IS NULL OR je.entry_date >= $3::date)
        AND ($4::date IS NULL OR je.entry_date <= $4::date)
        AND ($5::text IS NULL OR je.source_type = $5::text)
        AND (
          $6::text IS NULL
          OR je.voucher_no ILIKE '%' || $6::text || '%'
          OR je.external_reference ILIKE '%' || $6::text || '%'
          OR je.memo ILIKE '%' || $6::text || '%'
        )
      ORDER BY je.voucher_year DESC, je.voucher_number DESC
      LIMIT $7`,
    [businessId, year, filter.dateFrom ?? null, filter.dateTo ?? null, filter.sourceType ?? null, q, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    voucherNo: r.voucher_no,
    voucherYear: r.voucher_year,
    voucherNumber: Number(r.voucher_number),
    externalReference: r.external_reference,
    entryDate: r.entry_date,
    postedAt: r.posted_at,
    memo: r.memo,
    sourceType: r.source_type,
    sourceId: r.source_id,
    reversesEntryId: r.reverses_entry_id,
    reversedAt: r.reversed_at,
    totalDebit: Number(r.total_debit),
  }));
}

export interface NumberingGapReport {
  voucherYear: number;
  /** The highest number the sequence has issued for this year. */
  lastIssued: number;
  /** Numbers issued but no longer held by any document. */
  gapCount: number;
  /** The first gaps, in order. Capped so a damaged year cannot produce an unbounded response. */
  gaps: number[];
  gapsTruncated: boolean;
}

export const NUMBERING_GAP_LIST_CAP = 500;

export async function numberingGapReport(businessId: string, voucherYear: number): Promise<NumberingGapReport> {
  if (!Number.isSafeInteger(voucherYear) || voucherYear < 1) throw new VoucherError("invalid_voucher_year", 400);
  const { rows: seqRows } = await query<{ last_number: string }>(
    `SELECT last_number::text AS last_number FROM accounting_voucher_sequences WHERE business_id = $1 AND voucher_year = $2`,
    [businessId, voucherYear],
  );
  const lastIssued = Number(seqRows[0]?.last_number ?? 0);
  if (lastIssued === 0) {
    return { voucherYear, lastIssued: 0, gapCount: 0, gaps: [], gapsTruncated: false };
  }
  const { rows: countRows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND voucher_year = $2`,
    [businessId, voucherYear],
  );
  const held = Number(countRows[0]?.n ?? 0);
  const gapCount = Math.max(lastIssued - held, 0);

  const { rows: gapRows } = await query<{ n: string }>(
    `SELECT g::text AS n
       FROM generate_series(1::bigint, $3::bigint) AS g
      WHERE NOT EXISTS (
        SELECT 1 FROM journal_entries je
         WHERE je.business_id = $1 AND je.voucher_year = $2 AND je.voucher_number = g
      )
      ORDER BY g
      LIMIT $4`,
    [businessId, voucherYear, lastIssued, NUMBERING_GAP_LIST_CAP + 1],
  );
  const gapsTruncated = gapRows.length > NUMBERING_GAP_LIST_CAP;
  return {
    voucherYear,
    lastIssued,
    gapCount,
    gaps: gapRows.slice(0, NUMBERING_GAP_LIST_CAP).map((r) => Number(r.n)),
    gapsTruncated,
  };
}

interface EntryIdentityRow {
  id: string;
  voucher_year: number;
  voucher_number: string;
  external_reference: string | null;
  entry_date: string;
}

async function lockEntry(client: PoolClient, businessId: string, entryId: string): Promise<EntryIdentityRow> {
  if (!isUuid(entryId)) throw new VoucherError("entry_not_found", 404);
  const { rows } = await client.query<EntryIdentityRow>(
    `SELECT id, voucher_year, voucher_number::text AS voucher_number, external_reference,
            entry_date::text AS entry_date
       FROM journal_entries WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [entryId, businessId],
  );
  if (!rows[0]) throw new VoucherError("entry_not_found", 404);
  return rows[0];
}

async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Opens the privileged identity path for this transaction only. */
async function enterIdentityChange(client: PoolClient) {
  await client.query(`SELECT set_config('app.voucher_identity_change', 'on', true)`);
}

async function assertPeriodOpenForIdentityChange(client: PoolClient, businessId: string, entryDate: string) {
  const { rows } = await client.query<{ status: string }>(
    `SELECT status::text AS status FROM fiscal_periods
      WHERE business_id = $1 AND $2::date BETWEEN starts_on AND ends_on LIMIT 1`,
    [businessId, entryDate],
  );
  if (rows[0]?.status === "locked") throw new VoucherError("fiscal_period_locked", 409);
}

export interface RenumberResult {
  entryId: string;
  voucherNo: string;
  fromVoucherNo: string;
  voucherNumber: number;
  fromVoucherNumber: number;
}

/**
 * Moves a document to a gap in its year's sequence. The old number becomes a
 * gap, which the gap report then shows. The reason and both numbers are kept.
 */
export async function renumberVoucher(
  businessId: string,
  actorId: string,
  entryId: string,
  input: { toVoucherNumber: unknown; reason: unknown },
): Promise<RenumberResult> {
  const reason = normalizeVoucherChangeReason(input.reason);
  if (!reason) throw new VoucherError("reason_required", 400);

  return transaction(async (client) => {
    const entry = await lockEntry(client, businessId, entryId);
    const currentNumber = Number(entry.voucher_number);
    const { rows: seqRows } = await client.query<{ last_number: string }>(
      `SELECT last_number::text AS last_number FROM accounting_voucher_sequences
        WHERE business_id = $1 AND voucher_year = $2 FOR UPDATE`,
      [businessId, entry.voucher_year],
    );
    const lastIssued = Number(seqRows[0]?.last_number ?? 0);

    const target = input.toVoucherNumber;
    const targetError = renumberTargetError(target, currentNumber, lastIssued);
    if (targetError) {
      const status = targetError === "voucher_number_out_of_range" ? 409 : 400;
      throw new VoucherError(targetError, status, { lastIssued });
    }
    const toNumber = target as number;

    await assertPeriodOpenForIdentityChange(client, businessId, entry.entry_date);

    const { rows: taken } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE business_id = $1 AND voucher_year = $2 AND voucher_number = $3`,
      [businessId, entry.voucher_year, toNumber],
    );
    if (taken[0]) throw new VoucherError("voucher_number_in_use", 409);

    const fromNo = formatVoucherNo(entry.voucher_year, currentNumber);
    const toNo = formatVoucherNo(entry.voucher_year, toNumber);

    await enterIdentityChange(client);
    await client.query(
      `UPDATE journal_entries SET voucher_number = $2, voucher_no = $3 WHERE id = $1`,
      [entry.id, toNumber, toNo],
    );
    await client.query(
      `INSERT INTO journal_voucher_audit
         (business_id, entry_id, action, voucher_year, from_voucher_number, to_voucher_number,
          from_voucher_no, to_voucher_no, reason, actor_id)
       VALUES ($1, $2, 'renumber', $3, $4, $5, $6, $7, $8, $9)`,
      [businessId, entry.id, entry.voucher_year, currentNumber, toNumber, fromNo, toNo, reason, actorId],
    );
    return {
      entryId: entry.id,
      voucherNo: toNo,
      fromVoucherNo: fromNo,
      voucherNumber: toNumber,
      fromVoucherNumber: currentNumber,
    };
  });
}

export interface ReferenceResult {
  entryId: string;
  reference: string | null;
  previousReference: string | null;
}

/** Sets, changes or clears a document's own reference number, with a reason. */
export async function setVoucherReference(
  businessId: string,
  actorId: string,
  entryId: string,
  input: { reference: unknown; reason: unknown },
): Promise<ReferenceResult> {
  const reason = normalizeVoucherChangeReason(input.reason);
  if (!reason) throw new VoucherError("reason_required", 400);
  if (input.reference !== null && input.reference !== undefined && typeof input.reference !== "string") {
    throw new VoucherError("reference_invalid_characters", 400);
  }
  const normalized = normalizeVoucherReference(input.reference as string | null | undefined);
  if (!normalized.ok) throw new VoucherError(normalized.error, 400);

  return transaction(async (client) => {
    const entry = await lockEntry(client, businessId, entryId);
    if (entry.external_reference === normalized.value) {
      throw new VoucherError("reference_unchanged", 409);
    }
    await assertPeriodOpenForIdentityChange(client, businessId, entry.entry_date);

    if (normalized.value) {
      const { rows: taken } = await client.query<{ id: string }>(
        `SELECT id FROM journal_entries WHERE business_id = $1 AND external_reference = $2 AND id <> $3`,
        [businessId, normalized.value, entry.id],
      );
      if (taken[0]) throw new VoucherError("reference_in_use", 409);
    }

    await enterIdentityChange(client);
    await client.query(`UPDATE journal_entries SET external_reference = $2 WHERE id = $1`, [entry.id, normalized.value]);
    const voucherNo = formatVoucherNo(entry.voucher_year, Number(entry.voucher_number));
    await client.query(
      `INSERT INTO journal_voucher_audit
         (business_id, entry_id, action, voucher_year, from_voucher_number, to_voucher_number,
          from_voucher_no, to_voucher_no, from_reference, to_reference, reason, actor_id)
       VALUES ($1, $2, 'reference', $3, $4, $4, $5, $5, $6, $7, $8, $9)`,
      [
        businessId,
        entry.id,
        entry.voucher_year,
        Number(entry.voucher_number),
        voucherNo,
        entry.external_reference,
        normalized.value,
        reason,
        actorId,
      ],
    );
    return { entryId: entry.id, reference: normalized.value, previousReference: entry.external_reference };
  });
}

export interface VoucherAuditRow {
  id: string;
  action: "renumber" | "reference";
  voucherNo: string | null;
  fromVoucherNo: string | null;
  toVoucherNo: string | null;
  fromReference: string | null;
  toReference: string | null;
  reason: string;
  actorId: string | null;
  createdAt: string;
}

export async function voucherAuditTrail(businessId: string, entryId: string): Promise<VoucherAuditRow[]> {
  if (!isUuid(entryId)) throw new VoucherError("entry_not_found", 404);
  const { rows } = await query<{
    id: string;
    action: "renumber" | "reference";
    from_voucher_no: string | null;
    to_voucher_no: string | null;
    from_reference: string | null;
    to_reference: string | null;
    reason: string;
    actor_id: string | null;
    created_at: string;
  }>(
    `SELECT id, action, from_voucher_no, to_voucher_no, from_reference, to_reference,
            reason, actor_id, created_at::text AS created_at
       FROM journal_voucher_audit
      WHERE business_id = $1 AND entry_id = $2
      ORDER BY created_at, id`,
    [businessId, entryId],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    voucherNo: r.to_voucher_no,
    fromVoucherNo: r.from_voucher_no,
    toVoucherNo: r.to_voucher_no,
    fromReference: r.from_reference,
    toReference: r.to_reference,
    reason: r.reason,
    actorId: r.actor_id,
    createdAt: r.created_at,
  }));
}
