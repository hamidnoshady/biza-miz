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
  manualRejectionReasonProblem,
  nonZeroLines,
} from "./manual-journal";
import type { RialText } from "./inventory-exact";
import { isUuid } from "./uuid";
import { locationBusinessToday } from "./business-day-service";

export { MANUAL_LINES_MAX, MANUAL_MEMO_MAX };

/** The review queue is read a page at a time — see `listDrafts`. */
export const MANUAL_DRAFTS_PAGE_SIZE = 25;

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
  /*
   * Inside a transaction (the approval path) the validated rows are locked
   * while they are validated.
   *
   * Validation and posting are two statements: an account that had no children
   * a millisecond ago can gain one, or be archived, by a concurrent edit before
   * the journal lines are inserted — the check then describes a chart of
   * accounts that no longer exists. `FOR UPDATE` holds those rows until the
   * transaction commits, so an archive or a reparent waits rather than racing
   * the insert.
   *
   * `ORDER BY a.id` is part of that, not decoration: two concurrent approvals
   * touching overlapping accounts then take their locks in the same order, so
   * they queue instead of deadlocking.
   */
  const sql = client
    ? `SELECT a.id,
                      EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children
                 FROM accounts a
                WHERE a.business_id = $1 AND a.id = ANY($2::uuid[]) AND a.is_active
                ORDER BY a.id
                FOR UPDATE OF a`
    : `SELECT a.id,
                      EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children
                 FROM accounts a
                WHERE a.business_id = $1 AND a.id = ANY($2::uuid[]) AND a.is_active`;
  /*
   * Checked here, not only at the HTTP boundary, because this query is the
   * first place a submitted id meets a `::uuid[]` cast — and `WHERE id =
   * ANY($2::uuid[])` does not answer "no such account" for a non-UUID, it
   * raises `invalid input syntax for type uuid` and the caller gets a 500
   * under «خطای غیرمنتظره». The API route parses strictly now, but the
   * autopilot's journal-draft executor builds these rows itself, so the
   * service is where every caller is actually covered.
   */
  if (accountIds.some((id) => !isUuid(id))) throw new ManualJournalError("unknown_account");

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
  /**
   * The branch this draft will post to. The review queue is business-wide, so
   * without it a reviewer approves a branch's document without being able to
   * see whose books it lands in — and approval posts to the draft's own
   * location, not the approver's, which makes the badge the only place the
   * answer is visible.
   */
  locationName: string | null;
  memo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Who proposed it — `journal_entry_drafts.proposed_by`, migration 0211. */
  proposedBy: string | null;
  proposedByName: string | null;
  proposedAt: string | null;
  lines: DraftLine[];
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  entry_date: string | null;
  location_id: string | null;
  location_name: string | null;
  memo: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  proposed_by: string | null;
  proposed_by_name: string | null;
  proposed_at: string | null;
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
    locationName: d.location_name,
    memo: d.memo,
    createdBy: d.created_by,
    createdByName: d.created_by_name,
    createdAt: d.created_at,
    proposedBy: d.proposed_by,
    proposedByName: d.proposed_by_name,
    proposedAt: d.proposed_at,
    lines: linesByDraft.get(d.id) ?? [],
  }));
}

/** One page of the review queue plus the count the pager needs. */
export interface DraftPage {
  drafts: JournalDraft[];
  /** Every pending draft, not just this page — the number the heading shows. */
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

/**
 * The same SELECT for one draft, so the queue, the detail read and the
 * approver's `FOR UPDATE` lock cannot drift into listing different columns.
 */
const DRAFT_SELECT = `SELECT d.id, d.entry_date::text AS entry_date, d.location_id,
              l.name AS location_name, d.memo, d.created_by,
              u.full_name AS created_by_name, d.created_at::text AS created_at,
              d.proposed_by, p.full_name AS proposed_by_name,
              d.proposed_at::text AS proposed_at
       FROM journal_entry_drafts d
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN users p ON p.id = d.proposed_by
       LEFT JOIN locations l ON l.id = d.location_id`;

/**
 * One page of pending drafts, newest first.
 *
 * Bounded on purpose. The queue used to load every draft in the business and
 * then every line of every one of them, and the screen rendered all of it —
 * fine at five drafts, and a review page that never finishes drawing once the
 * AI assistant has been proposing journals for a month. `total` is a separate
 * `count(*)` rather than "the page was full, so there is probably more",
 * because the heading says «N سند» and a floor is not a count.
 */
export async function listDrafts(
  businessId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<DraftPage> {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? MANUAL_DRAFTS_PAGE_SIZE), 1), MANUAL_DRAFTS_PAGE_SIZE);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  const [{ rows }, countRows] = await Promise.all([
    query<DraftRow>(
      `${DRAFT_SELECT} WHERE d.business_id = $1
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total FROM journal_entry_drafts WHERE business_id = $1`,
      [businessId],
    ),
  ]);
  const drafts = await attachLines(businessId, rows);
  const total = Number(countRows.rows[0]?.total ?? 0);
  return { drafts, total, hasMore: offset + drafts.length < total, limit, offset };
}

export async function getDraft(
  businessId: string,
  id: string,
): Promise<JournalDraft | null> {
  // A non-UUID cannot match a row, and asking Postgres anyway raises
  // `invalid input syntax for type uuid` — a 500 under «خطای غیرمنتظره»
  // instead of the 404 the caller is entitled to. See `isUuid`.
  if (!isUuid(id)) return null;
  const { rows } = await query<DraftRow>(
    `${DRAFT_SELECT} WHERE d.business_id = $1 AND d.id = $2`,
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
  /** Client-supplied dedupe key; a retry with the same key returns the first draft. */
  idempotencyKey?: string | null;
}): Promise<{ id: string; duplicate: boolean }> {
  const memo = typeof params.memo === "string" ? params.memo.trim() : "";
  const memoProblem = manualMemoProblem(memo);
  if (memoProblem) throw new ManualJournalError(memoProblem);
  /*
   * «خالی یعنی امروز» is a promise the form makes, so it is kept *here*, at
   * the moment the draft is written — not at approval.
   *
   * The date used to be stored as NULL and left to `COALESCE(entry_date,
   * CURRENT_DATE)` inside `postJournalEntry`, so a draft written on the 30th
   * and approved on the 1st posted on the 1st: the accountant dates a document,
   * watches the screen agree, and the ledger disagrees with both. `CURRENT_DATE`
   * is worse than merely late — it is the *database server's* date, UTC inside
   * the Docker image, so an evening in Tehran was filed under the next calendar
   * day. `locationBusinessToday` is the branch's own clock, the same one
   * `ar-service.ts` documents for receipts.
   */
  const entryDate = normalizeEntryDate(params.entryDate) ?? (await locationBusinessToday(params.businessId, params.locationId));
  const nonZero = validatedNonZeroLines(params.lines);
  await assertAccountsPostable(
    params.businessId,
    nonZero.map((l) => l.accountId),
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    /*
     * Idempotency: a retried «ثبت پیش‌نویس» — a flaky connection, a double
     * tap, a reconnecting client, an external caller replaying — used to
     * create two drafts, each of which could then be approved separately and
     * post the same document twice. The unique index (migration 0211) is what
     * actually decides; this read is what lets the retry report 200 with the
     * id it already got rather than 500 on the constraint.
     */
    if (params.idempotencyKey) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM journal_entry_drafts
          WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, params.idempotencyKey],
      );
      if (existing[0]) {
        await client.query("COMMIT");
        return { id: existing[0].id, duplicate: true };
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entry_drafts
         (business_id, location_id, entry_date, memo, created_by, proposed_by, proposed_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $5, now(), $6)
       ON CONFLICT (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [params.businessId, params.locationId, entryDate, memo, params.createdBy, params.idempotencyKey ?? null],
    );
    // The concurrent case: two identical requests racing past the read above.
    // The loser's insert is a no-op, so it re-reads the winner's row and
    // reports it back as a duplicate rather than as a failure.
    if (!rows[0]) {
      if (!params.idempotencyKey) throw new ManualJournalError("draft_not_found", 500);
      const { rows: winner } = await client.query<{ id: string }>(
        `SELECT id FROM journal_entry_drafts WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, params.idempotencyKey],
      );
      if (!winner[0]) throw new ManualJournalError("bad_request");
      await client.query("COMMIT");
      return { id: winner[0].id, duplicate: true };
    }
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
    return { id: draftId, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Discards a draft and records why.
 *
 * The draft row itself is still deleted — it never had any financial effect,
 * so unlike a posted entry there is nothing to keep visible — but the
 * *decision* is written to `journal_entry_draft_rejections` first, in the same
 * transaction. A rejection used to be a bare DELETE with no actor, no time and
 * no reason, so «چه کسی این سند را رد کرد و چرا» had no answer anywhere in the
 * system, and a reviewer had no way to tell a discarded duplicate from a
 * refused expense claim.
 *
 * `requireReason` is the difference between the two ways a draft can go: a
 * reviewer rejecting somebody else's work has to say why, while the drafter
 * withdrawing their own draft («اشتباه تایپ کردم») is allowed to say nothing.
 */
export async function rejectDraft(params: {
  businessId: string;
  draftId: string;
  actorId: string;
  reason?: string | null;
  requireReason?: boolean;
}): Promise<{ draftId: string; reason: string | null }> {
  const reason = (params.reason ?? "").trim() || null;
  // A reviewer's rejection has to say why; a drafter's withdrawal does not.
  // Either way a *given* reason is length-checked, so nobody stores a novel.
  const reasonProblem = manualRejectionReasonProblem(reason);
  if (reasonProblem && !(reasonProblem === "rejection_reason_required" && !params.requireReason)) {
    throw new ManualJournalError(reasonProblem);
  }
  // A malformed id is a draft that does not exist, said that way — asking
  // Postgres would raise `invalid input syntax for type uuid` instead.
  if (!isUuid(params.draftId)) throw new ManualJournalError("draft_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      business_id: string;
      location_id: string | null;
      memo: string;
      entry_date: string | null;
      proposed_by: string | null;
      proposed_at: string | null;
    }>(
      `SELECT id, business_id, location_id, memo, entry_date::text AS entry_date,
              proposed_by, proposed_at::text AS proposed_at
         FROM journal_entry_drafts
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [params.businessId, params.draftId],
    );
    const draft = rows[0];
    if (!draft) throw new ManualJournalError("draft_not_found", 404);

    await client.query(
      `INSERT INTO journal_entry_draft_rejections
         (business_id, draft_id, location_id, memo, entry_date, proposed_by, proposed_at,
          rejected_by, rejected_at, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
      [
        params.businessId,
        draft.id,
        draft.location_id,
        draft.memo,
        draft.entry_date,
        draft.proposed_by,
        draft.proposed_at,
        params.actorId,
        reason,
      ],
    );
    const { rowCount } = await client.query(
      `DELETE FROM journal_entry_drafts WHERE id = $1 AND business_id = $2`,
      [params.draftId, params.businessId],
    );
    if (!rowCount) throw new ManualJournalError("draft_not_found", 404);
    await client.query("COMMIT");
    return { draftId: params.draftId, reason };
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
  if (!isUuid(id)) throw new ManualJournalError("draft_not_found", 404);
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
  // See `rejectDraft`: a malformed id is answered as a missing draft, not as a
  // PostgreSQL type error.
  if (!isUuid(params.draftId)) throw new ManualJournalError("draft_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<DraftRow>(
      `${DRAFT_SELECT} WHERE d.business_id = $1 AND d.id = $2 FOR UPDATE OF d`,
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

    /*
     * A draft written before migration 0211 resolved «امروز» has NULL here.
     * Resolve it against the draft's own branch rather than letting
     * `postJournalEntry` fall back to `CURRENT_DATE` — the database server's
     * date, UTC in the container — which is the whole defect this function
     * exists to remove.
     */
    const entryDate =
      draft.entryDate ?? (await locationBusinessToday(params.businessId, draft.locationId));

    const entryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: draft.locationId,
      entryDate,
      memo: draft.memo,
      sourceType: "manual",
      sourceId: null,
      createdBy: params.actorId,
      lines: nonZero as JournalLine[],
    });
    /*
     * Who proposed it and who approved it, written onto the row that lives for
     * ever — because the draft that held the proposal is deleted three lines
     * below this one.
     *
     * `created_by` on the posted entry is the approver (the person whose
     * action created the posting, which is what that column has always meant);
     * `proposed_by`/`proposed_at` are the draft's, carried across by hand.
     * Without this the only surviving name on an approved journal was the
     * approver's, and an audit of «who put this entry in the books» answered
     * with the wrong person.
     */
    if (entryId) {
      await client.query(
        `UPDATE journal_entries
            SET proposed_by = $3, proposed_at = $4, approved_by = $5, approved_at = now(), draft_id = $6
          WHERE id = $1 AND business_id = $2`,
        [
          entryId,
          params.businessId,
          draft.proposedBy ?? draft.createdBy,
          draft.proposedAt ?? draft.createdAt,
          params.actorId,
          draft.id,
        ],
      );
    }
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
   * The caller's active location — a *fallback*, never the routing.
   *
   * Both the reversing journal and its sync event follow the original entry's
   * own branch; where the accountant happens to be standing is not where the
   * document lives. This value is consulted only for a document that has no
   * branch at all, and only so the event has a queue to travel in (see
   * `reverseEntryInTransaction`).
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
   * The caller's branch survives only as a last resort, for a document that
   * has none of its own (`location_id IS NULL` — a business-wide entry, or a
   * single-location business that predates branches). `sync_events.location_id`
   * is NOT NULL and a site's own writes reach the central server only through
   * this queue, so dropping the event there would lose a desktop's reversal
   * rather than merely delay it. Delivering it to the actor's branch is safe
   * because the applying side derives the branch from the original too: the
   * handler's `locationId` is an envelope, not an instruction.
   */
  const syncLocationId = original.location_id ?? params.locationId;
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
