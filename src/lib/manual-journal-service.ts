/**
 * Phase 16 — manual journals, properly: draft -> review -> post, and
 * reversal rather than deletion.
 *
 * A draft has no financial effect until approved; approving it posts a real
 * journal entry through the same postJournalEntry() path (and the same
 * fiscal-period lock trigger) any other posting goes through. Reversing a
 * posted manual entry always posts a new, real, immediate entry too — Debit
 * and Credit swapped from the original — rather than editing or deleting
 * it, so both stay visible and the net effect is zero (the Phase 16 exit
 * criterion this satisfies).
 *
 * DB-touching, so per repo convention it has no direct unit test; the line
 * validation this reuses is the same shape src/app/api/ledger/entries/
 * route.ts already validated inline before this existed. Covered by
 * integration/manual-journal.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { postExactJournalEntry, postJournalEntry } from "./ledger-service";
import type { JournalLine } from "./ledger";
import type { Role } from "./auth-edge";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { normalizeOptionalIsoDate } from "./iso-date";
import {
  MANUAL_LINES_MAX,
  MANUAL_MEMO_MAX,
  manualDocumentProblem,
  manualMemoProblem,
  nonZeroLines,
} from "./manual-journal";
import type { RialText } from "./inventory-exact";

export { MANUAL_LINES_MAX, MANUAL_MEMO_MAX };

export class ManualJournalError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface DraftLineInput {
  accountId: string;
  debit: number;
  credit: number;
}

/**
 * The document's date, or `null` for "whenever this is posted".
 *
 * The month-length table this used to carry by hand is `iso-date.ts` now —
 * the module that exists for exactly this check, and the one A/R aging, A/P
 * aging, bank reconciliation and «دفتر روزنامه» validate through. A
 * well-shaped impossible day (`2026-02-31`) must be a named 400 here rather
 * than a `date` cast error three layers down.
 */
function normalizeEntryDate(
  entryDate: string | null | undefined,
): string | null {
  const normalized = normalizeOptionalIsoDate(entryDate);
  if (!normalized.ok) throw new ManualJournalError("invalid_entry_date");
  return normalized.value;
}

/**
 * The submitted rows, or a `ManualJournalError` naming the first thing wrong
 * with them. The rules themselves live in the framework-free `manual-journal.ts`
 * so the browser applies exactly the same ones before enabling «ثبت پیش‌نویس» —
 * the screen calling a document balanced that this then refuses is the class of
 * bug that module exists to prevent.
 */
function validatedNonZeroLines(lines: DraftLineInput[]): DraftLineInput[] {
  const problem = manualDocumentProblem(lines);
  if (problem) throw new ManualJournalError(problem);
  return nonZeroLines(lines);
}

/**
 * Every referenced account must belong to this business, be active, and be a
 * leaf.
 *
 * The leaf rule is deliberately enforced here rather than in
 * `postJournalEntry`, even though it reads like a universal ledger invariant.
 * It is not one in this chart of accounts: the shipped templates post to `2300`
 * (حقوق پرداختنی), `1240` (اسناد دریافتنی) and `2120` (اسناد پرداختنی) while
 * each of those carries children, so payroll, commissions and every cheque
 * operation legitimately write to a parent. A blanket check on the shared
 * posting function would reject them in all eight industry templates.
 *
 * A *hand-typed* document is different: nothing chooses the account but the
 * person, the picker already offers leaves only, and posting to a parent
 * silently corrupts any report that sums children into it. So the rule belongs
 * to the manual path, and this is the one query it already makes.
 */
async function assertAccountsPostable(
  businessId: string,
  accountIds: string[],
  client?: Pick<PoolClient, "query">,
): Promise<void> {
  const sql = `SELECT a.id,
                      EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children
                 FROM accounts a
                WHERE a.business_id = $1 AND a.id = ANY($2::uuid[]) AND a.is_active`;
  const args = [businessId, accountIds];
  const { rows } = client
    ? await client.query<{ id: string; has_children: boolean }>(sql, args)
    : await query<{ id: string; has_children: boolean }>(sql, args);
  if (rows.length !== new Set(accountIds).size)
    throw new ManualJournalError("unknown_account");
  if (rows.some((r) => r.has_children)) throw new ManualJournalError("not_a_leaf_account");
}

export interface DraftLine extends DraftLineInput {
  accountCode: string;
  accountName: string;
}

export interface JournalDraft {
  id: string;
  entryDate: string | null;
  locationId: string | null;
  memo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  lines: DraftLine[];
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  entry_date: string | null;
  location_id: string | null;
  memo: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}
interface DraftLineRow extends Record<string, unknown> {
  draft_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
}

async function attachLines(
  businessId: string,
  drafts: DraftRow[],
  client?: Pick<PoolClient, "query">,
): Promise<JournalDraft[]> {
  if (drafts.length === 0) return [];
  const args = [businessId, drafts.map((d) => d.id)];
  /*
   * `ORDER BY dl.line_no`, never `dl.id`: the draft-line key is a random
   * `gen_random_uuid()`, so ordering by it handed the review queue a document
   * whose rows were shuffled out of the order they were typed in (migration
   * 0151 adds the ordinal this sorts on). journal_lines can order by its own
   * id because that one is an identity bigint.
   */
  const lineSelect = `SELECT dl.draft_id, dl.account_id, a.code AS account_code, a.name AS account_name, dl.debit::text AS debit, dl.credit::text AS credit
           FROM journal_entry_draft_lines dl
           JOIN accounts a ON a.id = dl.account_id
           JOIN journal_entry_drafts d ON d.id = dl.draft_id
          WHERE d.business_id = $1 AND dl.draft_id = ANY($2::uuid[])
          ORDER BY dl.draft_id, dl.line_no`;
  const { rows: lines } = client
    ? await client.query<DraftLineRow>(lineSelect, args)
    : await query<DraftLineRow>(lineSelect, args);
  const linesByDraft = new Map<string, DraftLine[]>();
  for (const l of lines) {
    const list = linesByDraft.get(l.draft_id) ?? [];
    list.push({
      accountId: l.account_id,
      accountCode: l.account_code,
      accountName: l.account_name,
      debit: Number(l.debit),
      credit: Number(l.credit),
    });
    linesByDraft.set(l.draft_id, list);
  }
  return drafts.map((d) => ({
    id: d.id,
    entryDate: d.entry_date,
    locationId: d.location_id,
    memo: d.memo,
    createdBy: d.created_by,
    createdByName: d.created_by_name,
    createdAt: d.created_at,
    lines: linesByDraft.get(d.id) ?? [],
  }));
}

/** Every pending draft (the review queue), newest first. */
export async function listDrafts(businessId: string): Promise<JournalDraft[]> {
  const { rows } = await query<DraftRow>(
    `SELECT d.id, d.entry_date::text AS entry_date, d.location_id, d.memo, d.created_by, u.full_name AS created_by_name, d.created_at::text AS created_at
       FROM journal_entry_drafts d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.business_id = $1
      ORDER BY d.created_at DESC`,
    [businessId],
  );
  return attachLines(businessId, rows);
}

export async function getDraft(
  businessId: string,
  id: string,
): Promise<JournalDraft | null> {
  const { rows } = await query<DraftRow>(
    `SELECT d.id, d.entry_date::text AS entry_date, d.location_id, d.memo, d.created_by, u.full_name AS created_by_name, d.created_at::text AS created_at
       FROM journal_entry_drafts d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, id],
  );
  if (!rows[0]) return null;
  const [draft] = await attachLines(businessId, rows);
  return draft;
}

export async function createDraft(params: {
  businessId: string;
  locationId: string | null;
  entryDate?: string | null;
  memo: string;
  lines: DraftLineInput[];
  createdBy: string;
}): Promise<{ id: string }> {
  const memo = typeof params.memo === "string" ? params.memo.trim() : "";
  const memoProblem = manualMemoProblem(memo);
  if (memoProblem) throw new ManualJournalError(memoProblem);
  const entryDate = normalizeEntryDate(params.entryDate);
  const nonZero = validatedNonZeroLines(params.lines);
  await assertAccountsPostable(
    params.businessId,
    nonZero.map((l) => l.accountId),
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entry_drafts (business_id, location_id, entry_date, memo, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [params.businessId, params.locationId, entryDate, memo, params.createdBy],
    );
    const draftId = rows[0].id;
    // `line_no` is the row's place in the document as it was typed; see
    // attachLines above for why the read cannot recover it from the key.
    for (const [index, l] of nonZero.entries()) {
      await client.query(
        `INSERT INTO journal_entry_draft_lines (draft_id, account_id, debit, credit, line_no) VALUES ($1, $2, $3, $4, $5)`,
        [draftId, l.accountId, l.debit, l.credit, index],
      );
    }
    await client.query("COMMIT");
    return { id: draftId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Discards a draft — it never had any financial effect, so unlike a posted entry there's nothing to keep visible. */
export async function deleteDraft(
  businessId: string,
  id: string,
): Promise<void> {
  const { rowCount } = await query(
    `DELETE FROM journal_entry_drafts WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  if (!rowCount) throw new ManualJournalError("draft_not_found", 404);
}

/** Approves a draft: posts it as a real journal entry (through the normal fiscal-period-checked path) and removes the draft. */
export async function approveDraft(params: {
  businessId: string;
  /** Kept for API compatibility; the posted entry uses the draft's own location. */
  locationId: string | null;
  draftId: string;
  actorId: string;
}): Promise<{ entryId: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<DraftRow>(
      `SELECT d.id, d.entry_date::text AS entry_date, d.location_id, d.memo, d.created_by,
              u.full_name AS created_by_name, d.created_at::text AS created_at
         FROM journal_entry_drafts d LEFT JOIN users u ON u.id = d.created_by
        WHERE d.business_id = $1 AND d.id = $2
        FOR UPDATE OF d`,
      [params.businessId, params.draftId],
    );
    if (!rows[0]) throw new ManualJournalError("draft_not_found", 404);
    const [draft] = await attachLines(params.businessId, rows, client);

    // Re-validated at approval time, not just draft creation: an account the
    // draft referenced may have been edited or removed since.
    const nonZero = validatedNonZeroLines(draft.lines);
    await assertAccountsPostable(
      params.businessId,
      nonZero.map((l) => l.accountId),
      client,
    );

    const entryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: draft.locationId,
      entryDate: draft.entryDate,
      memo: draft.memo,
      sourceType: "manual",
      sourceId: null,
      createdBy: params.actorId,
      lines: nonZero as JournalLine[],
    });
    const { rowCount } = await client.query(
      `DELETE FROM journal_entry_drafts WHERE id = $1 AND business_id = $2`,
      [params.draftId, params.businessId],
    );
    if (!rowCount) throw new ManualJournalError("draft_not_found", 404);
    await client.query("COMMIT");
    return { entryId: entryId! };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverses a posted manual entry: a new entry with every line's debit and
 * credit swapped, dated whenever it's recorded (not backdated into the
 * original's period). Only a manual entry may be reversed — an auto-posted
 * one (an order payment, a purchase receipt, …) already has its own
 * correction flow (a void, a refund, a return).
 */
export interface ReverseManualEntryParams {
  businessId: string;
  /**
   * Kept for API compatibility and ignored for routing: both the reversing
   * journal **and** its sync event use the original entry's own location. The
   * caller's active location is where the accountant is standing, which is not
   * where the document lives.
   */
  locationId: string | null;
  entryId: string;
  actorId: string;
  memo?: string | null;
  entryDate?: string | null;
  sync?: { actorRole: Role; clientEventId?: string };
}

export async function reverseEntryInTransaction(
  client: PoolClient,
  params: ReverseManualEntryParams,
): Promise<{ entryId: string }> {
  const entryDate = normalizeEntryDate(params.entryDate);
  const { rows: entryRows } = await client.query<{
    id: string;
    location_id: string | null;
    source_type: string | null;
    memo: string | null;
    reverses_entry_id: string | null;
    reversed_at: string | null;
  }>(
    `SELECT id, location_id, source_type, memo, reverses_entry_id, reversed_at::text AS reversed_at
       FROM journal_entries
      WHERE id = $1 AND business_id = $2
      FOR UPDATE`,
    [params.entryId, params.businessId],
  );
  const original = entryRows[0];
  if (!original) throw new ManualJournalError("entry_not_found", 404);
  if (original.source_type !== "manual") throw new ManualJournalError("not_reversible", 409);
  if (original.reverses_entry_id) throw new ManualJournalError("cannot_reverse_a_reversal", 409);
  if (original.reversed_at) throw new ManualJournalError("already_reversed", 409);

  const { rows: lineRows } = await client.query<{ account_id: string; debit: string; credit: string }>(
    `SELECT account_id, debit::text AS debit, credit::text AS credit
       FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
    [params.entryId],
  );
  if (lineRows.length === 0) throw new ManualJournalError("entry_has_no_lines", 409);

  const entryId = await postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: original.location_id,
    entryDate,
    memo:
      (typeof params.memo === "string" ? params.memo.trim() : "") ||
      `برگشت سند: ${original.memo ?? ""}`.trim(),
    sourceType: "manual",
    sourceId: null,
    createdBy: params.actorId,
    lines: lineRows.map((line) => ({
      accountId: line.account_id,
      debit: line.credit as RialText,
      credit: line.debit as RialText,
    })),
  });
  await client.query("UPDATE journal_entries SET reverses_entry_id = $2 WHERE id = $1", [entryId, params.entryId]);
  await client.query("UPDATE journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1", [params.entryId, params.actorId]);
  /*
   * The outbox event is routed by the *original document's* branch, never by
   * the approver's currently active one.
   *
   * The reversing journal is posted to `original.location_id` (right above),
   * but the event used to carry `params.locationId` — which the route reads
   * from `resolveActiveLocation(session)`, i.e. wherever the accountant
   * happens to be standing. `accounting.manual_journal.reversed` is registered
   * with `locationRule: "event_location"` and `sync-outbox.ts` routes
   * cloud/site delivery by that value, so an accountant active in Branch B
   * reversing Branch A's journal wrote the row to A and queued the event for
   * B: the desktop at A never learned its own document had been reversed, and
   * the one at B was handed an entry id it does not own. In a hybrid
   * deployment that is a permanent divergence, not a delayed one.
   *
   * A document with no branch (`location_id IS NULL` — a business-wide entry,
   * or a single-location business that predates branches) queues nothing, and
   * that is intentional rather than an omission: there is no branch to deliver
   * it to, and falling back to the actor's location is exactly the bug above.
   * Such a reversal converges through the ordinary full-table replication path.
   */
  const syncLocationId = original.location_id;
  if (params.sync && syncLocationId) await appendSyncOutboxEvent(client, {
    locationId: syncLocationId,
    clientEventId: params.sync.clientEventId ?? `journal:reverse:${params.entryId}`,
    eventType: "accounting.manual_journal.reversed",
    payload: { entryId: params.entryId, memo: params.memo ?? null, entryDate: params.entryDate ?? null },
    actorUserId: params.actorId,
    actorRole: params.sync.actorRole,
  });
  return { entryId: entryId! };
}

export async function reverseEntry(params: ReverseManualEntryParams): Promise<{ entryId: string }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseEntryInTransaction(client, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
