/**
 * Issue #867 — accountant opening balances & fiscal carry-forward, the
 * DB-touching half.
 *
 * The rules live in `opening-balances.ts`; the posting path, the period-lock
 * trigger and the RLS policies are the existing #821/#834 machinery. This
 * layer owns the transactional boundaries around the set's lifecycle:
 *
 *  draft ──submit──▶ review ──approve──▶ approved ──post──▶ posted ──reverse──▶ reversed
 *
 *  - updates only while the set is a draft (the 0217 trigger freezes it at
 *    submission, at the database);
 *  - approval is the reconciliation gate: a carry-forward set must match the
 *    prior close to the Rial, and no manual set may approve into a year that
 *    already carries an opening posting;
 *  - posting calls the ordinary `postJournalEntry` — the same path, trigger
 *    and reports as any other document, dated at the set's effective date;
 *  - reversal posts a mirror entry through `postExactMirrorEntry` and is
 *    refused outright once any dependent posting exists (any other entry
 *    dated after the effective date) — after that point the books are
 *    corrected forward, never rewritten.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./jalali";
import { isSupportedFiscalYear } from "./fiscal-periods";
import { WELL_KNOWN_CODES } from "./coa-template";
import { postJournalEntry, postExactMirrorEntry } from "./ledger-service";
import {
  AR_CUSTOMER_ATTRIBUTION_SQL,
  AR_CUSTOMER_ID_SQL,
} from "./ar-attribution";
import {
  AP_SUPPLIER_ATTRIBUTION_SQL,
  AP_SUPPLIER_ID_SQL,
} from "./ap-attribution";
import {
  buildCarryForwardProposal,
  nonZeroOpeningLines,
  openingLineTotals,
  openingSetProblem,
  reconcileOpeningToClosing,
  type CarryForwardAccount,
  type CarryForwardCheque,
  type CarryForwardFixedAsset,
  type CarryForwardLine,
  type CarryForwardPartyBalance,
  type OpeningLineInput,
  type OpeningReconciliation,
} from "./opening-balances";

export class OpeningBalanceError extends Error {
  status: number;
  /** Optional structured context a route may return beside the code. */
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

const SET_SELECT = `
  SELECT s.id, s.fiscal_year_label, s.fiscal_year_id::text AS fiscal_year_id,
         s.effective_date::text AS effective_date, s.status::text AS status,
         s.source::text AS source, s.carry_forward_from_year_id::text AS carry_forward_from_year_id,
         s.journal_entry_id::text AS journal_entry_id, s.reversal_entry_id::text AS reversal_entry_id,
         s.total_debit::text AS total_debit, s.total_credit::text AS total_credit,
         s.note, s.created_by::text AS created_by, s.created_at::text AS created_at,
         s.submitted_at::text AS submitted_at, s.approved_at::text AS approved_at,
         s.posted_at::text AS posted_at, s.reversed_at::text AS reversed_at,
         s.reversed_reason,
         u.full_name AS created_by_name
    FROM opening_balance_sets s
    LEFT JOIN users u ON u.id = s.created_by
`;

interface SetRow extends Record<string, unknown> {
  id: string;
  fiscal_year_label: string;
  fiscal_year_id: string | null;
  effective_date: string;
  status: string;
  source: string;
  carry_forward_from_year_id: string | null;
  journal_entry_id: string | null;
  reversal_entry_id: string | null;
  total_debit: string;
  total_credit: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  posted_at: string | null;
  reversed_at: string | null;
  reversed_reason: string | null;
  created_by_name: string | null;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  set_id: string;
  account_id: string;
  debit: string;
  credit: string;
  party_type: string | null;
  party_id: string | null;
  reference: string | null;
  source_note: string | null;
  code: string;
  account_name: string;
  party_name: string | null;
}

function toSet(r: SetRow) {
  return {
    id: r.id,
    fiscalYearLabel: r.fiscal_year_label,
    fiscalYearId: r.fiscal_year_id,
    effectiveDate: r.effective_date,
    status: r.status,
    source: r.source,
    carryForwardFromYearId: r.carry_forward_from_year_id,
    journalEntryId: r.journal_entry_id,
    reversalEntryId: r.reversal_entry_id,
    totalDebit: r.total_debit,
    totalCredit: r.total_credit,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    approvedAt: r.approved_at,
    postedAt: r.posted_at,
    reversedAt: r.reversed_at,
    reversedReason: r.reversed_reason,
    createdByName: r.created_by_name,
  };
}

function toLine(r: LineRow) {
  return {
    id: r.id,
    accountId: r.account_id,
    accountCode: r.code,
    accountName: r.account_name,
    debit: r.debit,
    credit: r.credit,
    partyType: r.party_type,
    partyId: r.party_id,
    partyName: r.party_name,
    reference: r.reference,
    sourceNote: r.source_note,
  };
}

/** Every opening set of the business, newest first. */
export async function listOpeningSets(businessId: string) {
  const { rows } = await query<SetRow>(
    `${SET_SELECT} WHERE s.business_id = $1 ORDER BY s.fiscal_year_label DESC, s.created_at DESC`,
    [businessId],
  );
  return rows.map(toSet);
}

const LINE_SELECT = `
  SELECT l.id, l.set_id, l.account_id, l.debit::text AS debit, l.credit::text AS credit,
         l.party_type, l.party_id::text AS party_id, l.reference, l.source_note,
         a.code, a.name AS account_name,
         COALESCE(c.name, sp.name, ch.counterparty_name, fa.name) AS party_name
    FROM opening_balance_lines l
    JOIN accounts a ON a.id = l.account_id
    -- Customer and supplier lines carry the party's own id as party_id
    -- (0137 merged the customer directory into parties), so both name
    -- lookups resolve through parties.
    LEFT JOIN parties c ON c.id = l.party_id AND l.party_type = 'customer'
    LEFT JOIN parties sp ON sp.id = l.party_id AND l.party_type = 'supplier'
    LEFT JOIN cheques ch ON ch.id = l.party_id AND l.party_type = 'cheque'
    LEFT JOIN fixed_assets fa ON fa.id = l.party_id AND l.party_type = 'fixed_asset'
`;

/** One set with its lines, each line carrying the names the drill-down needs. */
export async function getOpeningSet(
  businessId: string,
  setId: string,
): Promise<{ set: ReturnType<typeof toSet>; lines: ReturnType<typeof toLine>[] } | null> {
  if (!isUuid(setId)) return null;
  const { rows } = await query<SetRow>(`${SET_SELECT} WHERE s.business_id = $1 AND s.id = $2`, [
    businessId,
    setId,
  ]);
  if (!rows[0]) return null;
  const { rows: lines } = await query<LineRow>(
    `${LINE_SELECT} WHERE l.set_id = $1 ORDER BY a.code, l.id`,
    [setId],
  );
  return { set: toSet(rows[0]), lines: lines.map(toLine) };
}

// ---------------------------------------------------------------------------
// Normalisation + validation
// ---------------------------------------------------------------------------

function normalizedLines(payload: unknown): OpeningLineInput[] {
  if (!Array.isArray(payload)) return [];
  const lines: OpeningLineInput[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    const debit = typeof l.debit === "number" ? l.debit : 0;
    const credit = typeof l.credit === "number" ? l.credit : 0;
    if (debit === 0 && credit === 0) continue;
    const partyType =
      l.partyType === "customer" || l.partyType === "supplier" || l.partyType === "cheque" ||
      l.partyType === "fixed_asset" || l.partyType === "inventory"
        ? l.partyType
        : null;
    // 0217's party_consistent constraint: a party without a type is dropped,
    // a type without a resolvable party id keeps the type (an unattributed
    // bucket is legal — that is how the subledgers say "no customer named").
    const partyId = typeof l.partyId === "string" && isUuid(l.partyId) ? l.partyId : null;
    lines.push({
      accountId: typeof l.accountId === "string" && isUuid(l.accountId) ? l.accountId : "",
      debit,
      credit,
      partyType,
      partyId: partyType ? partyId : null,
      reference: typeof l.reference === "string" ? l.reference.slice(0, 200) : null,
      sourceNote: typeof l.sourceNote === "string" ? l.sourceNote.slice(0, 500) : null,
    });
  }
  return lines;
}

async function assertAccountsPostable(
  client: PoolClient,
  businessId: string,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const unique = [...new Set(accountIds)];
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active",
    [businessId, unique],
  );
  const found = new Set(rows.map((r) => r.id));
  for (const id of unique) {
    if (!found.has(id)) throw new OpeningBalanceError("account_missing_or_archived", 409);
  }
}

async function assertNoConflictingOpening(client: PoolClient, businessId: string, fiscalYearLabel: string, exceptSetId?: string): Promise<void> {
  // A set already posted for this year.
  const { rows: sets } = await client.query<{ id: string }>(
    `SELECT id FROM opening_balance_sets
      WHERE business_id = $1 AND fiscal_year_label = $2 AND status = 'posted' AND id <> $3`,
    [businessId, fiscalYearLabel, exceptSetId ?? "00000000-0000-0000-0000-000000000000"],
  );
  if (sets.length > 0) throw new OpeningBalanceError("opening_set_already_posted", 409);
  // The wizard's own opening posting, dated in this year (when the year is defined).
  const { rows: years } = await client.query<{ starts_on: string; ends_on: string }>(
    "SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM fiscal_years WHERE business_id = $1 AND label = $2",
    [businessId, fiscalYearLabel],
  );
  if (years[0]) {
    const { rows: entries } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'opening'
          AND entry_date BETWEEN $2::date AND $3::date`,
      [businessId, years[0].starts_on, years[0].ends_on],
    );
    if (entries.length > 0) throw new OpeningBalanceError("opening_entry_exists_for_year", 409);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createOpeningSet(params: {
  businessId: string;
  fiscalYearLabel: string | undefined;
  effectiveDate: string | null | undefined;
  note?: string | null;
  lines: unknown;
  actorId: string;
}): Promise<{ setId: string }> {
  const label = (params.fiscalYearLabel ?? "").trim();
  if (!/^[0-9]{4}$/.test(label) || !isSupportedFiscalYear(Number(label))) {
    throw new OpeningBalanceError("invalid_fiscal_year", 400);
  }
  // An opening set is *effective from* a day: without one there is no entry
  // date, no dependent-posting horizon and no year to attach it to.
  if (!params.effectiveDate || !isValidIsoDate(params.effectiveDate)) {
    throw new OpeningBalanceError("invalid_effective_date", 400);
  }
  const effectiveDate = params.effectiveDate;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // The set's fiscal year must contain its effective date — an opening that
    // is effective in a different year than the one it names is a mistake the
    // label can no longer fix.
    const { rows: years } = await client.query<{ starts_on: string; ends_on: string }>(
      "SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM fiscal_years WHERE business_id = $1 AND label = $2",
      [params.businessId, label],
    );
    if (years[0] && (effectiveDate < years[0].starts_on || effectiveDate > years[0].ends_on)) {
      throw new OpeningBalanceError("effective_date_outside_fiscal_year", 400);
    }

    const lines = normalizedLines(params.lines);
    const problem = openingSetProblem(lines);
    if (problem) throw new OpeningBalanceError(problem, 400);
    await assertAccountsPostable(client, params.businessId, lines.map((l) => l.accountId));

    const fiscalYearId = years[0] ? await fiscalYearIdFor(client, params.businessId, label) : null;
    const { totalDebit, totalCredit } = openingLineTotals(lines);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO opening_balance_sets
         (business_id, fiscal_year_label, fiscal_year_id, effective_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [params.businessId, label, fiscalYearId, effectiveDate, params.note?.slice(0, 500) ?? null, params.actorId],
    );
    await insertLines(client, rows[0].id, lines);
    await client.query(
      `UPDATE opening_balance_sets SET total_debit = $2, total_credit = $3, updated_at = now() WHERE id = $1`,
      [rows[0].id, totalDebit.toString(), totalCredit.toString()],
    );
    await client.query("COMMIT");
    return { setId: rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function fiscalYearIdFor(client: PoolClient, businessId: string, label: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM fiscal_years WHERE business_id = $1 AND label = $2",
    [businessId, label],
  );
  return rows[0]?.id ?? null;
}

async function insertLines(client: PoolClient, setId: string, lines: OpeningLineInput[]): Promise<void> {
  for (const l of lines) {
    await client.query(
      `INSERT INTO opening_balance_lines (set_id, account_id, debit, credit, party_type, party_id, reference, source_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [setId, l.accountId, l.debit, l.credit, l.partyType, l.partyId || null, l.reference, l.sourceNote],
    );
  }
}

/** Replaces a set's lines. Legal while the set is a draft or in review. */
export async function updateOpeningSetLines(params: {
  businessId: string;
  setId: string;
  lines: unknown;
  note?: string | null;
  actorId: string;
}): Promise<{ setId: string; totalDebit: string; totalCredit: string }> {
  if (!isUuid(params.setId)) throw new OpeningBalanceError("set_not_found", 404);
  const lines = normalizedLines(params.lines);
  const problem = openingSetProblem(lines);
  if (problem) throw new OpeningBalanceError(problem, 400);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      "SELECT status::text AS status FROM opening_balance_sets WHERE id = $1 AND business_id = $2 FOR UPDATE",
      [params.setId, params.businessId],
    );
    const status = rows[0]?.status;
    if (!status) throw new OpeningBalanceError("set_not_found", 404);
    if (status !== "draft" && status !== "review") {
      throw new OpeningBalanceError("set_not_editable", 409);
    }
    await assertAccountsPostable(client, params.businessId, lines.map((l) => l.accountId));
    await client.query("DELETE FROM opening_balance_lines WHERE set_id = $1", [params.setId]);
    await insertLines(client, params.setId, lines);
    const { totalDebit, totalCredit } = openingLineTotals(lines);
    await client.query(
      `UPDATE opening_balance_sets
          SET total_debit = $2, total_credit = $3, note = $4, updated_at = now()
        WHERE id = $1`,
      [params.setId, totalDebit.toString(), totalCredit.toString(), params.note?.slice(0, 500) ?? null],
    );
    await client.query("COMMIT");
    return { setId: params.setId, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString() };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** draft → review. The set must already balance. */
export async function submitOpeningSet(params: {
  businessId: string;
  setId: string;
  actorId: string;
}): Promise<void> {
  if (!isUuid(params.setId)) throw new OpeningBalanceError("set_not_found", 404);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<SetRow>(
      `${SET_SELECT} WHERE s.business_id = $1 AND s.id = $2 FOR UPDATE OF s`,
      [params.businessId, params.setId],
    );
    const set = rows[0];
    if (!set) throw new OpeningBalanceError("set_not_found", 404);
    if (set.status !== "draft") throw new OpeningBalanceError("invalid_status", 409);
    if (BigInt(set.total_debit) !== BigInt(set.total_credit) || BigInt(set.total_debit) === 0n) {
      throw new OpeningBalanceError("not_balanced", 409);
    }
    await client.query(
      `UPDATE opening_balance_sets SET status = 'review', submitted_at = now(), submitted_by = $3, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [params.setId, params.businessId, params.actorId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * review → approved. The reconciliation gate:
 *  - a carry-forward set must match the prior close to the Rial (the proposal
 *    is recomputed from the books at approval time, so a ledger that moved
 *    since generation fails here, not at posting);
 *  - no year may carry two openings (see assertNoConflictingOpening).
 */
export async function approveOpeningSet(params: {
  businessId: string;
  setId: string;
  actorId: string;
}): Promise<OpeningReconciliation | null> {
  if (!isUuid(params.setId)) throw new OpeningBalanceError("set_not_found", 404);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<SetRow>(
      `${SET_SELECT} WHERE s.business_id = $1 AND s.id = $2 FOR UPDATE OF s`,
      [params.businessId, params.setId],
    );
    const set = rows[0];
    if (!set) throw new OpeningBalanceError("set_not_found", 404);
    if (set.status !== "review") throw new OpeningBalanceError("invalid_status", 409);
    if (BigInt(set.total_debit) !== BigInt(set.total_credit)) throw new OpeningBalanceError("not_balanced", 409);

    let reconciliation: OpeningReconciliation | null = null;
    if (set.source === "carry_forward" && set.carry_forward_from_year_id) {
      const [proposalLines, actualLines] = await Promise.all([
        (async () => {
          const { input } = await readCarryForwardInput(client, params.businessId, set.carry_forward_from_year_id!);
          return buildCarryForwardProposal(input).lines;
        })(),
        readSetLines(client, params.setId),
      ]);
      reconciliation = reconcileOpeningToClosing(proposalLines, actualLines);
      if (!reconciliation.matched) {
        throw new OpeningBalanceError("reconciliation_failed", 409, { reconciliation });
      }
    }
    await assertNoConflictingOpening(client, params.businessId, set.fiscal_year_label, params.setId);

    await client.query(
      `UPDATE opening_balance_sets SET status = 'approved', approved_at = now(), approved_by = $3, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [params.setId, params.businessId, params.actorId],
    );
    await client.query("COMMIT");
    return reconciliation;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function readSetLines(
  client: PoolClient,
  setId: string,
): Promise<{ accountId: string; debit: bigint; credit: bigint; partyType: string | null; partyId: string | null; reference: string | null; sourceNote: string | null }[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT account_id, debit::text AS debit, credit::text AS credit, party_type,
            party_id::text AS party_id, reference, source_note
       FROM opening_balance_lines WHERE set_id = $1`,
    [setId],
  );
  return rows.map((r) => ({
    accountId: r.account_id as string,
    debit: BigInt(r.debit as string),
    credit: BigInt(r.credit as string),
    partyType: (r.party_type as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    sourceNote: (r.source_note as string | null) ?? null,
  }));
}

/**
 * approved → posted. The posting is the ordinary `postJournalEntry` — same
 * path, same period-lock trigger, same reports — dated at the set's
 * effective date and carrying the set id as its source.
 */
export async function postOpeningSet(params: {
  businessId: string;
  setId: string;
  actorId: string;
}): Promise<{ entryId: string; voucherNumber: string | null }> {
  if (!isUuid(params.setId)) throw new OpeningBalanceError("set_not_found", 404);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<SetRow>(
      `${SET_SELECT} WHERE s.business_id = $1 AND s.id = $2 FOR UPDATE OF s`,
      [params.businessId, params.setId],
    );
    const set = rows[0];
    if (!set) throw new OpeningBalanceError("set_not_found", 404);
    if (set.status !== "approved") throw new OpeningBalanceError("invalid_status", 409);
    if (BigInt(set.total_debit) !== BigInt(set.total_credit)) throw new OpeningBalanceError("not_balanced", 409);

    await assertNoConflictingOpening(client, params.businessId, set.fiscal_year_label, params.setId);

    const lineRows = await readSetLines(client, params.setId);
    if (lineRows.length === 0) throw new OpeningBalanceError("set_has_no_lines", 409);
    await assertAccountsPostable(client, params.businessId, lineRows.map((l) => l.accountId));

    // The fiscal period lock trigger may refuse the effective date (a locked
    // period). Its error is surfaced by the caller as a fiscal-period 409.
    const entryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: null,
      entryDate: set.effective_date,
      memo:
        set.source === "carry_forward"
          ? `ترازات افتتاحیه ${set.fiscal_year_label} — انتقال از سال ${set.carry_forward_from_year_id ? "قبلی" : "گذشته"}`
          : `ترازات افتتاحیه ${set.fiscal_year_label}`,
      sourceType: "opening",
      sourceId: params.setId,
      createdBy: params.actorId,
      postingKind: "opening",
      lines: lineRows.map((l) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit) })),
    });
    if (!entryId) throw new OpeningBalanceError("set_has_no_lines", 409);

    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'posted', journal_entry_id = $3, posted_at = now(), posted_by = $4, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [params.setId, params.businessId, entryId, params.actorId],
    );
    const { rows: numberRows } = await client.query<{ voucher_number: string | null }>(
      "SELECT voucher_number FROM journal_entries WHERE id = $1",
      [entryId],
    );
    await client.query("COMMIT");
    return { entryId, voucherNumber: numberRows[0]?.voucher_number ?? null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * posted → reversed. A mirror entry dated today (never backdated into the
 * original's period), and only while no dependent posting exists — any other
 * entry dated after the effective date means the books have moved on and the
 * correction is a forward entry, not a rewrite.
 */
export async function reverseOpeningSet(params: {
  businessId: string;
  setId: string;
  reason: string;
  actorId: string;
}): Promise<{ reversalEntryId: string }> {
  if (!isUuid(params.setId)) throw new OpeningBalanceError("set_not_found", 404);
  const reason = params.reason.trim();
  if (reason.length === 0 || reason.length > 500) throw new OpeningBalanceError("reason_required", 400);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<SetRow>(
      `${SET_SELECT} WHERE s.business_id = $1 AND s.id = $2 FOR UPDATE OF s`,
      [params.businessId, params.setId],
    );
    const set = rows[0];
    if (!set) throw new OpeningBalanceError("set_not_found", 404);
    if (set.status !== "posted" || !set.journal_entry_id) throw new OpeningBalanceError("invalid_status", 409);

    const { rows: dependent } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE business_id = $1 AND id <> $2 AND entry_date > $3::date`,
      [params.businessId, set.journal_entry_id, set.effective_date],
    );
    if (BigInt(dependent[0].n) > 0n) {
      throw new OpeningBalanceError("dependent_postings_exist", 409);
    }

    const reversalEntryId = await postExactMirrorEntry(client, {
      businessId: params.businessId,
      locationId: null,
      originalEntryId: set.journal_entry_id,
      sourceType: "opening",
      sourceId: params.setId,
      postingKind: "opening_reversal",
      memo: `برگشت ترازات افتتاحیه ${set.fiscal_year_label}: ${reason}`,
      createdBy: params.actorId,
    });
    if (!reversalEntryId) throw new OpeningBalanceError("reversal_post_failed", 500);

    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'reversed', reversal_entry_id = $3, reversed_at = now(), reversed_by = $4,
              reversed_reason = $5, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [params.setId, params.businessId, reversalEntryId, params.actorId, reason],
    );
    await client.query("COMMIT");
    return { reversalEntryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Import / preview
// ---------------------------------------------------------------------------

/**
 * Validates an import without persisting it: the same rules the create
 * endpoint applies, answered as a preview the screen shows before the
 * accountant commits anything.
 */
export async function previewOpeningImport(params: {
  businessId: string;
  fiscalYearLabel: string | undefined;
  effectiveDate: string | null | undefined;
  lines: unknown;
}): Promise<{
  valid: boolean;
  problem: string | null;
  totalDebit: string;
  totalCredit: string;
  lineCount: number;
  accounts: { accountId: string; code: string; name: string; debit: string; credit: string }[];
}> {
  const lines = normalizedLines(params.lines);
  const problem = openingSetProblem(lines);
  const { totalDebit, totalCredit } = openingLineTotals(nonZeroOpeningLines(lines));
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, code, name FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [params.businessId, [...new Set(lines.map((l) => l.accountId).filter(Boolean))]],
  );
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const perAccount = new Map<string, { debit: bigint; credit: bigint }>();
  for (const l of lines) {
    if (!l.accountId) continue;
    const acc = perAccount.get(l.accountId) ?? { debit: 0n, credit: 0n };
    acc.debit += BigInt(l.debit);
    acc.credit += BigInt(l.credit);
    perAccount.set(l.accountId, acc);
  }
  const accounts = [...perAccount.entries()]
    .map(([accountId, t]) => {
      const a = byId.get(accountId);
      return {
        accountId,
        code: a ? (a.code as string) : "؟",
        name: a ? (a.name as string) : "حساب پیدا نشد",
        debit: t.debit.toString(),
        credit: t.credit.toString(),
      };
    })
    .sort((x, y) => x.code.localeCompare(y.code));
  return { valid: !problem, problem, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), lineCount: lines.length, accounts };
}

// ---------------------------------------------------------------------------
// Carry-forward
// ---------------------------------------------------------------------------

interface FiscalYearRow extends Record<string, unknown> {
  id: string;
  label: string;
  starts_on: string;
  ends_on: string;
  closed_at: string | null;
}

async function readFiscalYear(client: PoolClient, businessId: string, yearId: string): Promise<FiscalYearRow> {
  const { rows } = await client.query<FiscalYearRow>(
    `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, closed_at::text AS closed_at
       FROM fiscal_years WHERE id = $1 AND business_id = $2`,
    [yearId, businessId],
  );
  const year = rows[0];
  if (!year) throw new OpeningBalanceError("fiscal_year_not_found", 404);
  return year;
}

/**
 * The prior year's closing position, read exactly as the carry-forward rule
 * needs it: the complete trial balance at the year's last day, the A/R by
 * customer and A/P by supplier at that date (the subledgers' own
 * attribution SQL), the open cheques, and the fixed-asset register.
 */
async function readCarryForwardInput(
  client: PoolClient,
  businessId: string,
  fromYearId: string,
) {
  const year = await readFiscalYear(client, businessId, fromYearId);
  const asOf = year.ends_on;

  // The year must be transitioned: every period locked, or the year closed.
  const { rows: periodRows } = await client.query<{ open: string }>(
    `SELECT count(*) FILTER (WHERE status <> 'locked')::text AS open
       FROM fiscal_periods WHERE business_id = $1 AND fiscal_year_id = $2`,
    [businessId, fromYearId],
  );
  const openPeriods = Number(periodRows[0]?.open ?? 0);
  if (openPeriods > 0 && !year.closed_at) {
    throw new OpeningBalanceError("prior_year_not_closed", 409, { openPeriods });
  }

  // Complete closing trial balance, signed net per account. The same
  // aggregation the trial balance uses — net per account through the close.
  const { rows: accountRows } = await client.query<Record<string, unknown>>(
    `SELECT a.id AS account_id, a.code, a.name, a.type::text AS type,
            (COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::text AS closing_net
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.business_id = $1
      WHERE a.business_id = $1
        AND (je.id IS NULL OR je.entry_date <= $2::date)
      GROUP BY a.id, a.code, a.name, a.type
      ORDER BY a.code`,
    [businessId, asOf],
  );

  // A/R by customer, at the year-end date, via the subledger's own attribution.
  const { rows: arRows } = await client.query<Record<string, unknown>>(
    `SELECT ${AR_CUSTOMER_ID_SQL} AS customer_id,
            COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
     ${AR_CUSTOMER_ATTRIBUTION_SQL}
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.business_id = $1
       AND a.business_id = $1
       AND a.code = $2
       AND je.entry_date <= $3::date
       AND ${AR_CUSTOMER_ID_SQL} IS NOT NULL
     GROUP BY ${AR_CUSTOMER_ID_SQL}`,
    [businessId, WELL_KNOWN_CODES.accountsReceivable, asOf],
  );
  // The attribution's customer id is the party's own id (0137), so the
  // lookup is the party table itself.
  const { rows: customerRows } = await client.query<Record<string, unknown>>(
    "SELECT id, name FROM parties WHERE business_id = $1",
    [businessId],
  );
  const customerById = new Map(customerRows.map((r) => [r.id as string, r]));
  const arByCustomer: CarryForwardPartyBalance[] = arRows
    .map((r) => {
      const cid = r.customer_id as string;
      const c = customerById.get(cid);
      return {
        subledgerId: cid,
        partyId: c ? (c.id as string) : null,
        name: c ? (c.name as string) : "مشتری ناشناس",
        balance: BigInt(r.balance as string),
      };
    })
    .filter((r) => r.balance !== 0n);

  // A/P by supplier — the mirror (credit positive).
  const { rows: apRows } = await client.query<Record<string, unknown>>(
    `SELECT ${AP_SUPPLIER_ID_SQL} AS supplier_id,
            COALESCE(SUM(jl.credit - jl.debit), 0)::text AS balance
     ${AP_SUPPLIER_ATTRIBUTION_SQL}
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.business_id = $1
       AND a.business_id = $1
       AND a.code = $2
       AND je.entry_date <= $3::date
       AND ${AP_SUPPLIER_ID_SQL} IS NOT NULL
     GROUP BY ${AP_SUPPLIER_ID_SQL}`,
    [businessId, WELL_KNOWN_CODES.accountsPayable, asOf],
  );
  // `suppliers` is location-scoped (0001 predates the business-wide party);
  // the business filter goes through the location, and the party link is the
  // per-branch alias's party_id.
  const { rows: supplierRows } = await client.query<Record<string, unknown>>(
    `SELECT s.id, s.name, s.party_id::text AS party_id
       FROM suppliers s
       JOIN locations l ON l.id = s.location_id
      WHERE l.business_id = $1`,
    [businessId],
  );
  const supplierById = new Map(supplierRows.map((r) => [r.id as string, r]));
  const apBySupplier: CarryForwardPartyBalance[] = apRows
    .map((r) => {
      const sid = r.supplier_id as string;
      const s = supplierById.get(sid);
      return {
        subledgerId: sid,
        partyId: (s?.party_id as string | null) ?? null,
        name: s ? (s.name as string) : "تأمین‌کننده ناشناس",
        balance: BigInt(r.balance as string),
      };
    })
    .filter((r) => r.balance !== 0n);

  // Open cheques, in the accounts they sit in.
  const { rows: acctRows } = await client.query<{ id: string; code: string }>(
    "SELECT id, code FROM accounts WHERE business_id = $1 AND code = ANY($2::text[])",
    [businessId, [WELL_KNOWN_CODES.chequesOnHand, WELL_KNOWN_CODES.chequesInCollection, WELL_KNOWN_CODES.chequesIssued]],
  );
  const accountByCode = new Map(acctRows.map((r) => [r.code, r.id]));
  const { rows: chequeRows } = await client.query<Record<string, unknown>>(
    `SELECT id, direction::text AS direction, status::text AS status,
            serial_number, sayad_id, counterparty_name, amount::text AS amount
       FROM cheques
      WHERE business_id = $1
        AND ((direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed'))
          OR (direction = 'payable' AND status = 'issued'))`,
    [businessId],
  );
  const openCheques: CarryForwardCheque[] = [];
  for (const r of chequeRows) {
    const code =
      r.direction === "receivable"
        ? r.status === "in_collection"
          ? WELL_KNOWN_CODES.chequesInCollection
          : WELL_KNOWN_CODES.chequesOnHand
        : WELL_KNOWN_CODES.chequesIssued;
    const accountId = accountByCode.get(code);
    if (!accountId) continue; // a chart without this account: the GL line carries it
    openCheques.push({
      chequeId: r.id as string,
      direction: r.direction as "receivable" | "payable",
      accountId,
      serialNumber: r.serial_number as string,
      sayadId: (r.sayad_id as string | null) ?? null,
      counterpartyName: r.counterparty_name as string,
      amount: BigInt(r.amount as string),
    });
  }

  // The fixed-asset register, active assets only, with accumulated depreciation.
  const { rows: assetRows } = await client.query<Record<string, unknown>>(
    `SELECT fa.id, fa.name, fa.cost::text AS cost, fa.acquisition_source,
            fa.asset_account_id::text AS asset_account_id,
            COALESCE(d.total, 0)::text AS accumulated
       FROM fixed_assets fa
       LEFT JOIN (SELECT fixed_asset_id, SUM(amount) AS total
                    FROM fixed_asset_depreciation_entries GROUP BY fixed_asset_id) d
         ON d.fixed_asset_id = fa.id
      WHERE fa.business_id = $1 AND fa.status = 'active'
      ORDER BY fa.name`,
    [businessId],
  );
  const fixedAssetsRootId = accountByCode.has(WELL_KNOWN_CODES.fixedAssets)
    ? (accountByCode.get(WELL_KNOWN_CODES.fixedAssets) as string)
    : null;
  const { rows: assetAcctRows } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE business_id = $1 AND code = $2",
    [businessId, WELL_KNOWN_CODES.fixedAssets],
  );
  const rootId = assetAcctRows[0]?.id ?? fixedAssetsRootId;
  const fixedAssets: CarryForwardFixedAsset[] = assetRows
    .map((r) => ({
      assetId: r.id as string,
      name: r.name as string,
      accountId: (r.asset_account_id as string | null) ?? rootId ?? "",
      cost: BigInt(r.cost as string),
      accumulatedDepreciation: BigInt(r.accumulated as string),
      acquisitionSource: r.acquisition_source as string,
    }))
    .filter((r) => r.accountId !== "");

  // The accounts the rule names.
  const { rows: idRows } = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE business_id = $1
      AND code = ANY($2::text[])`,
    [
      businessId,
      [
        WELL_KNOWN_CODES.accountsReceivable,
        WELL_KNOWN_CODES.accountsPayable,
        WELL_KNOWN_CODES.accumulatedDepreciation,
        WELL_KNOWN_CODES.retainedEarnings,
        WELL_KNOWN_CODES.openingEquity,
      ],
    ],
  );
  const byCode = new Map(idRows.map((r) => [r.code, r.id]));
  const retainedEarnings = byCode.get(WELL_KNOWN_CODES.retainedEarnings) ?? byCode.get(WELL_KNOWN_CODES.openingEquity) ?? null;

  return {
    year,
    input: {
      accounts: accountRows.map((r) => ({
        accountId: r.account_id as string,
        code: r.code as string,
        name: r.name as string,
        type: r.type as CarryForwardAccount["type"],
        closingNet: BigInt(r.closing_net as string),
      })),
      arByCustomer,
      apBySupplier,
      openCheques,
      fixedAssets,
      accountIds: {
        accountsReceivable: byCode.get(WELL_KNOWN_CODES.accountsReceivable) ?? null,
        accountsPayable: byCode.get(WELL_KNOWN_CODES.accountsPayable) ?? null,
        accumulatedDepreciation: byCode.get(WELL_KNOWN_CODES.accumulatedDepreciation) ?? null,
        retainedEarnings,
      },
    },
  };
}

/**
 * Generates (or returns, on retry) the carry-forward proposal for a fiscal
 * year transition: the prior year's closing balances become the next year's
 * draft opening set. Idempotent per prior year — the 0217 unique index makes
 * a second generation of the same transition a return of the first.
 */
export async function generateCarryForward(params: {
  businessId: string;
  fromYearId: string;
  toYearId: string;
  actorId: string;
}): Promise<{ setId: string; idempotent: boolean; lines: CarryForwardLine[]; notes: string[]; balanced: boolean }> {
  if (!isUuid(params.fromYearId) || !isUuid(params.toYearId)) {
    throw new OpeningBalanceError("fiscal_year_not_found", 404);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const fromYear = await readFiscalYear(client, params.businessId, params.fromYearId);
    const toYear = await readFiscalYear(client, params.businessId, params.toYearId);

    // A transition is consecutive: the next year starts the day after the
    // prior one ends. Anything else is a scope error, not a guess to make.
    const dayAfter = new Date(`${fromYear.ends_on}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    const nextStart = dayAfter.toISOString().slice(0, 10);
    if (toYear.starts_on !== nextStart) {
      throw new OpeningBalanceError("years_not_consecutive", 400, { expectedStart: nextStart });
    }
    // The target year must not already be open.
    const { rows: existingPosted } = await client.query<{ id: string }>(
      `SELECT id FROM opening_balance_sets
        WHERE business_id = $1 AND fiscal_year_label = $2 AND status = 'posted'`,
      [params.businessId, toYear.label],
    );
    if (existingPosted.length > 0) throw new OpeningBalanceError("opening_set_already_posted", 409);

    const { input } = await readCarryForwardInput(client, params.businessId, params.fromYearId);
    const proposal = buildCarryForwardProposal(input);
    if (!proposal.balanced) {
      throw new OpeningBalanceError("prior_close_not_balanced", 409, {
        totalDebit: proposal.totalDebit.toString(),
        totalCredit: proposal.totalCredit.toString(),
      });
    }

    // Idempotent: one proposal per prior year (0217's unique index).
    const { rows: prior } = await client.query<{ id: string }>(
      `SELECT id FROM opening_balance_sets
        WHERE business_id = $1 AND source = 'carry_forward' AND carry_forward_from_year_id = $2
        FOR UPDATE`,
      [params.businessId, params.fromYearId],
    );
    if (prior[0]) {
      await client.query("COMMIT");
      return { setId: prior[0].id, idempotent: true, lines: proposal.lines, notes: proposal.notes, balanced: proposal.balanced };
    }

    const { rows: setRows } = await client.query<{ id: string }>(
      `INSERT INTO opening_balance_sets
         (business_id, fiscal_year_label, fiscal_year_id, effective_date, source, carry_forward_from_year_id, note, created_by)
       VALUES ($1, $2, $3, $4, 'carry_forward', $5, $6, $7)
       RETURNING id`,
      [
        params.businessId,
        toYear.label,
        toYear.id,
        toYear.starts_on,
        params.fromYearId,
        `انتقال ترازات ${fromYear.label} به ${toYear.label}`,
        params.actorId,
      ],
    );
    const setId = setRows[0].id;
    for (const l of proposal.lines) {
      await client.query(
        `INSERT INTO opening_balance_lines (set_id, account_id, debit, credit, party_type, party_id, reference, source_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [setId, l.accountId, l.debit.toString(), l.credit.toString(), l.partyType, l.partyId, l.reference, l.sourceNote],
      );
    }
    await client.query(
      `UPDATE opening_balance_sets
          SET total_debit = $2, total_credit = $3, updated_at = now()
        WHERE id = $1`,
      [setId, proposal.totalDebit.toString(), proposal.totalCredit.toString()],
    );
    await client.query("COMMIT");
    return { setId, idempotent: false, lines: proposal.lines, notes: proposal.notes, balanced: proposal.balanced };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The prior-close vs next-open reconciliation for a carry-forward set: the
 * proposal is recomputed from the books and compared, account by account and
 * party by party, with the set as it stands.
 */
export async function reconcileCarryForwardSet(
  businessId: string,
  setId: string,
): Promise<{
  matched: boolean;
  rows: Array<{
    key: string;
    label: string;
    expectedDebit: string;
    expectedCredit: string;
    actualDebit: string;
    actualCredit: string;
    difference: string;
    matched: boolean;
  }>;
  notes: string[];
  totals: {
    expectedDebit: string;
    expectedCredit: string;
    actualDebit: string;
    actualCredit: string;
  };
} | null> {
  if (!isUuid(setId)) return null;
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<SetRow>(
      `${SET_SELECT} WHERE s.business_id = $1 AND s.id = $2`,
      [businessId, setId],
    );
    const set = rows[0];
    if (!set) return null;
    if (set.source !== "carry_forward" || !set.carry_forward_from_year_id) return null;

    const { input } = await readCarryForwardInput(client, businessId, set.carry_forward_from_year_id);
    const expected = buildCarryForwardProposal(input).lines;
    const actual = await readSetLines(client, setId);
    const reconciliation = reconcileOpeningToClosing(expected, actual);

    // Names for the report rows.
    const { rows: nameRows } = await client.query<Record<string, unknown>>(
      "SELECT id, code || ' — ' || name AS label FROM accounts WHERE business_id = $1",
      [businessId],
    );
    const nameById = new Map(nameRows.map((r) => [r.id as string, r.label as string]));

    return {
      matched: reconciliation.matched,
      rows: reconciliation.rows.map((r) => ({
        key: r.key,
        label: r.key.startsWith("account:") ? (nameById.get(r.key.slice("account:".length)) ?? r.label) : r.label,
        expectedDebit: r.expectedDebit.toString(),
        expectedCredit: r.expectedCredit.toString(),
        actualDebit: r.actualDebit.toString(),
        actualCredit: r.actualCredit.toString(),
        difference: r.difference.toString(),
        matched: r.matched,
      })),
      notes: buildCarryForwardProposal(input).notes,
      totals: {
        expectedDebit: reconciliation.totalExpectedDebit.toString(),
        expectedCredit: reconciliation.totalExpectedCredit.toString(),
        actualDebit: reconciliation.totalActualDebit.toString(),
        actualCredit: reconciliation.totalActualCredit.toString(),
      },
    };
  } finally {
    client.release();
  }
}
