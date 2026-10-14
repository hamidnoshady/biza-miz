/**
 * Phase 16 — bank & cash reconciliation.
 *
 * Reconciles one settlement account against a manually-entered statement
 * ending balance. Three accounts qualify: صندوق (`cash`), بانک (`bank`) and
 * کارت‌خوان در راه (`bankClearing`). `bank` was missing until now, from a time
 * when nothing posted to it — but since Phase 30 a cheque *clears into the
 * bank* (cheques-service.ts posts 1110 on `clear`/`present`), so a business
 * that takes cheques had movements on 1110 and no way to reconcile the very
 * account «تطبیق بانکی» is named after. A reconciliation's candidate lines are every journal line
 * ever posted to the account, up to the statement date, that no earlier
 * *completed* reconciliation has already claimed — so "unreconciled items
 * carry forward" is just what's left unclaimed, not a separate step.
 * Completing a reconciliation requires its opening balance (the last
 * completed reconciliation's statement balance, or 0 for the first one)
 * plus the sum of its cleared lines to match the statement balance exactly,
 * and locks every cleared line: they can never be un-cleared or claimed by
 * a later reconciliation.
 *
 * ## Concurrency contract
 *
 * Every mutation, and the completion that ends a reconciliation, take the same
 * lock: `SELECT … FOR UPDATE` on the reconciliation's own row, inside one
 * transaction (`withTenantTransaction` — which is what makes a row lock mean
 * anything here, since ambient `query()` would take a fresh connection per
 * statement and release the lock the instant it returned). A tick, an untick,
 * a bulk «انتخاب همه» and «تکمیل و قفل» therefore queue behind each other, and
 * the balance a completion verifies is the balance the line set it locks
 * actually produces. Before that, completion read the lines on one connection
 * and wrote the status on another, so a tick landing in between could lock a
 * period whose final line set no longer balanced.
 *
 * DB-touching, so per repo convention it has no direct unit test. The rules it
 * enforces that *can* be stated without a database live in
 * `bank-reconciliation.ts` (unit-tested there, and shared with the screen so
 * the «مغایرت» a person reads and the one the server refuses to lock on are
 * the same computation). The rest is covered by
 * integration/reconciliation.integration.test.ts.
 */
import { query, withTenantTransaction } from "./db";
import { isUuid } from "./uuid";
import { todayIsoDate } from "./jalali";
import {
  canComplete,
  computedBalanceOf,
  differenceOf,
  isPlausibleStatementDate,
  isStatementDateInFuture,
  MAX_RECONCILIATION_LINE_BATCH,
  MAX_RECONCILIATION_LINES_PAGE,
  RECONCILABLE_ACCOUNTS,
  RECONCILABLE_ACCOUNT_CODES,
  type ReconcilableAccount,
} from "./bank-reconciliation";
import { decodeReconciliationCursor, encodeReconciliationCursor } from "./bank-reconciliation-cursor";

// Re-exported so the API routes, the assistant's own «تطبیق نشده» tool and the
// accounting audit keep importing the reconcilable set from the service, while
// the definition lives in the framework-free module that request parsing and
// the screen also read. One list, three readers, no copy left to drift.
export { RECONCILABLE_ACCOUNTS, RECONCILABLE_ACCOUNT_CODES };
export type { ReconcilableAccount };

/**
 * code → key, so a third account cannot be mislabelled as the fallback. The
 * two-way ternary this replaced read "cash, else bankClearing", which would
 * have reported every بانک reconciliation as a کارت‌خوان one.
 */
const ACCOUNT_KEYS_BY_CODE = new Map<string, ReconcilableAccount>(
  RECONCILABLE_ACCOUNTS.map((key) => [RECONCILABLE_ACCOUNT_CODES[key], key]),
);

export class ReconciliationError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Postgres' unique-violation code — see `createReconciliation`'s catch. */
const UNIQUE_VIOLATION = "23505";

async function resolveAccountId(businessId: string, accountCode: ReconcilableAccount): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, RECONCILABLE_ACCOUNT_CODES[accountCode]],
  );
  if (!rows[0]) throw new ReconciliationError("ledger_account_missing", 409);
  return rows[0].id;
}

export interface ReconciliationSummary {
  id: string;
  accountCode: ReconcilableAccount;
  statementDate: string;
  statementBalance: number;
  status: "in_progress" | "completed";
  completedAt: string | null;
  /**
   * Who signed the period off, and when — the audit half of a completed
   * reconciliation. The history list used to show a date and a balance and
   * nothing about who locked it, which is the first question an audit asks.
   */
  completedByName: string | null;
  createdBy: string | null;
  createdByName: string | null;
}

/** What a row read out of `bank_reconciliations` has to carry. */
interface ReconciliationRow extends Record<string, unknown> {
  id: string;
  account_code: string;
  statement_date: string;
  statement_balance: string;
  status: "in_progress" | "completed";
  completed_at: string | null;
  completed_by_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
}

const RECONCILIATION_COLUMNS = `
       r.id, a.code AS account_code, r.statement_date::text AS statement_date,
       r.statement_balance::text AS statement_balance, r.status,
       r.completed_at::text AS completed_at,
       completer.full_name AS completed_by_name,
       r.created_by::text AS created_by,
       creator.full_name AS created_by_name`;

const RECONCILIATION_JOINS = `
  JOIN accounts a ON a.id = r.account_id
  LEFT JOIN users completer ON completer.id = r.completed_by
  LEFT JOIN users creator ON creator.id = r.created_by`;

function toSummary(r: ReconciliationRow): ReconciliationSummary {
  return {
    id: r.id,
    accountCode: ACCOUNT_KEYS_BY_CODE.get(r.account_code) ?? "cash",
    statementDate: r.statement_date,
    statementBalance: Number(r.statement_balance),
    status: r.status,
    completedAt: r.completed_at,
    completedByName: r.completed_by_name,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
  };
}

/** Every reconciliation for one account, newest first. */
export async function listReconciliations(
  businessId: string,
  accountCode: ReconcilableAccount,
): Promise<ReconciliationSummary[]> {
  const accountId = await resolveAccountId(businessId, accountCode);
  const { rows } = await query<ReconciliationRow>(
    `SELECT ${RECONCILIATION_COLUMNS}
       FROM bank_reconciliations r ${RECONCILIATION_JOINS}
      WHERE r.business_id = $1 AND r.account_id = $2
      ORDER BY r.statement_date DESC, r.created_at DESC`,
    [businessId, accountId],
  );
  return rows.map(toSummary);
}

/**
 * The statement balance this reconciliation opens from: the most recent
 * completed reconciliation *that ends on or before its own statement date*, or
 * 0 if there isn't one.
 *
 * Excludes `excludeId` (the reconciliation this balance is being computed for)
 * — otherwise, once that reconciliation is itself completed, it would match
 * its own "most recent completed" query and double-count against itself.
 *
 * The `statement_date <= $4` bound is the other half, and it is what makes a
 * *backdated* reconciliation correct. Without it the query took the newest
 * completed reconciliation on the account full stop, so starting a June
 * statement after July's had been locked opened June from July's closing
 * balance — a period opening from its own future. The «مغایرت» that produced
 * could only be cleared by ticking lines that had nothing to do with it.
 */
async function openingBalance(
  businessId: string,
  accountId: string,
  excludeId: string,
  statementDate: string,
): Promise<number> {
  const { rows } = await query<{ statement_balance: string }>(
    `SELECT statement_balance::text AS statement_balance FROM bank_reconciliations
      WHERE business_id = $1 AND account_id = $2 AND status = 'completed' AND id <> $3
        AND statement_date <= $4
      ORDER BY statement_date DESC, completed_at DESC LIMIT 1`,
    [businessId, accountId, excludeId, statementDate],
  );
  return rows[0] ? Number(rows[0].statement_balance) : 0;
}

export interface ReconciliationLine {
  journalLineId: string;
  /** The entry this line belongs to — what a matcher actually looks up. */
  entryId: string;
  entryDate: string;
  postedAt: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /**
   * The document number behind the posting: a cheque's serial, an order's
   * number. Reconciling is matching a statement row to a document, and «چک»
   * next to a debit of ۵٬۰۰۰٬۰۰۰ does not identify one — the serial does.
   */
  reference: string | null;
  debit: number;
  credit: number;
  cleared: boolean;
}

export interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: number;
  clearedTotal: number;
  computedBalance: number;
  difference: number;
  /**
   * Candidates and ticks across the *whole* reconciliation, not this page:
   * «مغایرت» is computed from these, so they must not shrink when a filter
   * hides rows or a page ends.
   */
  candidateCount: number;
  clearedCount: number;
  /** How many lines the current search/filter matched — the page's own count. */
  matchedCount: number;
  lines: ReconciliationLine[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface ReconciliationListOptions {
  /** Free text over the memo, the document reference and the line's own id. */
  search?: string;
  /** Only the lines this reconciliation has already ticked. */
  clearedOnly?: boolean;
  /** Keyset position from a previous page's `nextCursor`. */
  cursor?: string | null;
  /** Page size, capped at `MAX_RECONCILIATION_LINES_PAGE`. */
  limit?: number;
}

/**
 * The candidate set, as SQL — one definition, shared by the aggregate that
 * computes «مغایرت», the filtered count and the paged read.
 *
 * `cheques`/`orders` are LEFT JOINed for the document number only, each on its
 * primary key, so neither can multiply a candidate line.
 */
const CANDIDATE_FROM = `
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       LEFT JOIN bank_reconciliation_lines brl
              ON brl.journal_line_id = jl.id AND brl.reconciliation_id = $1
       LEFT JOIN cheques ch ON je.source_type = 'cheque' AND ch.id = je.source_id
       LEFT JOIN orders o ON je.source_type IN ('order', 'retail_invoice') AND o.id = je.source_id`;

const CANDIDATE_WHERE = `
      WHERE jl.account_id = $2 AND je.business_id = $3 AND je.entry_date <= $4
        AND NOT EXISTS (
          SELECT 1 FROM bank_reconciliation_lines other
           WHERE other.journal_line_id = jl.id AND other.reconciliation_id <> $1
        )`;

/**
 * `je.id, jl.id` are the tie-breakers: two postings on one day, or a batch
 * posted in the same instant, used to come back in whatever order the planner
 * felt like, so the same screen could list the same lines differently between
 * two refreshes — and a paged list whose order is not total can drop or repeat
 * a row across a page boundary.
 */
const CANDIDATE_ORDER = ` ORDER BY je.entry_date, je.posted_at, je.id, jl.id`;

/**
 * The optional predicates, as SQL plus the parameters they need. The base four
 * parameters (`$1`–`$4`) are always the reconciliation, the account, the
 * business and the statement date, so a filter's placeholder starts at `$5`.
 */
function candidateFilters(options: ReconciliationListOptions): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const search = options.search?.trim();
  if (search) {
    params.push(`%${search}%`);
    // A statement row is found by what is written on it, so the search covers
    // the memo, the document number and — for whoever is holding a bank
    // printout with a line number on it — the ledger line's own id.
    clauses.push(
      `(je.memo ILIKE $5 OR coalesce(ch.serial_number, o.order_number::text, '') ILIKE $5
         OR jl.id::text LIKE $5)`,
    );
  }
  if (options.clearedOnly) clauses.push(`brl.id IS NOT NULL`);

  return { clauses, params };
}

function pageLimit(options: ReconciliationListOptions): number {
  return Math.min(
    Math.max(1, Math.trunc(options.limit ?? MAX_RECONCILIATION_LINES_PAGE)),
    MAX_RECONCILIATION_LINES_PAGE,
  );
}

/**
 * Totals over the whole candidate set, independent of any filter or page.
 *
 * `clearedTotal` is summed in the database rather than added up by the caller
 * from whichever lines it happens to be holding: the list is paged now, and a
 * total derived from one page would make «مغایرت» depend on how far the reader
 * had scrolled.
 */
async function candidateTotals(
  businessId: string,
  accountId: string,
  reconciliationId: string,
  statementDate: string,
): Promise<{ candidateCount: number; clearedCount: number; clearedTotal: number }> {
  const { rows } = await query<{
    candidate_count: string;
    cleared_count: string;
    cleared_total: string;
  }>(
    `SELECT count(*)::text AS candidate_count,
            count(*) FILTER (WHERE brl.id IS NOT NULL)::text AS cleared_count,
            coalesce(sum(jl.debit - jl.credit) FILTER (WHERE brl.id IS NOT NULL), 0)::text AS cleared_total
       ${CANDIDATE_FROM}
       ${CANDIDATE_WHERE}`,
    [reconciliationId, accountId, businessId, statementDate],
  );
  const row = rows[0];
  return {
    candidateCount: Number(row?.candidate_count ?? 0),
    clearedCount: Number(row?.cleared_count ?? 0),
    clearedTotal: Number(row?.cleared_total ?? 0),
  };
}

async function candidatePage(
  businessId: string,
  accountId: string,
  reconciliationId: string,
  statementDate: string,
  options: ReconciliationListOptions,
  limit: number,
): Promise<{ lines: ReconciliationLine[]; nextCursor: string | null }> {
  const { clauses, params } = candidateFilters(options);
  const cursor = decodeReconciliationCursor(options.cursor ?? null);
  // A cursor is caller-supplied text; a malformed one is a 400, never a cast
  // error escaping as a 500.
  if (options.cursor && !cursor) throw new ReconciliationError("invalid_cursor");
  if (cursor) {
    params.push(cursor.entryDate, cursor.postedAt, cursor.entryId, cursor.journalLineId);
    const at = 4 + params.length;
    // Row comparison over the whole sort key, so a page boundary that falls in
    // the middle of a day — or of a batch posted in the same instant — resumes
    // exactly where the previous page stopped.
    clauses.push(
      `(je.entry_date, je.posted_at, je.id, jl.id) > ($${at - 3}::date, $${at - 2}::timestamptz, $${at - 1}::uuid, $${at}::bigint)`,
    );
  }

  params.push(limit + 1);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT jl.id::text AS journal_line_id, je.id::text AS entry_id,
            je.entry_date::text AS entry_date, je.posted_at::text AS posted_at,
            je.memo, je.source_type, je.source_id::text AS source_id,
            coalesce(ch.serial_number, o.order_number::text) AS reference,
            jl.debit::text AS debit, jl.credit::text AS credit,
            (brl.id IS NOT NULL) AS cleared
       ${CANDIDATE_FROM}
       ${CANDIDATE_WHERE}${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
       ${CANDIDATE_ORDER}
      LIMIT $${4 + params.length}`,
    [reconciliationId, accountId, businessId, statementDate, ...params],
  );

  // One row more than the page is asked for: its presence is what says there
  // is another page, and it is trimmed so a page holds what it claims to.
  const page = rows.slice(0, limit);
  const lines = page.map((r) => ({
    journalLineId: String(r.journal_line_id),
    entryId: String(r.entry_id),
    entryDate: String(r.entry_date),
    postedAt: String(r.posted_at),
    memo: (r.memo as string | null) ?? null,
    sourceType: (r.source_type as string | null) ?? null,
    sourceId: (r.source_id as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    debit: Number(r.debit),
    credit: Number(r.credit),
    cleared: Boolean(r.cleared),
  }));

  return {
    lines,
    // `rows.length > limit` is the extra row's presence, and it also means the
    // page is full, so its last line is a real keyset position.
    nextCursor:
      rows.length > limit
        ? encodeReconciliationCursor({
            entryDate: lines[lines.length - 1].entryDate,
            postedAt: lines[lines.length - 1].postedAt,
            entryId: lines[lines.length - 1].entryId,
            journalLineId: lines[lines.length - 1].journalLineId,
          })
        : null,
  };
}

/** How many lines the current search/filter matched, cursor aside. */
async function candidateMatchedCount(
  businessId: string,
  accountId: string,
  reconciliationId: string,
  statementDate: string,
  options: ReconciliationListOptions,
): Promise<number> {
  const { clauses, params } = candidateFilters(options);
  const { rows } = await query<{ matched: string }>(
    `SELECT count(*)::text AS matched
       ${CANDIDATE_FROM}
       ${CANDIDATE_WHERE}${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}`,
    [reconciliationId, accountId, businessId, statementDate, ...params],
  );
  return Number(rows[0]?.matched ?? 0);
}

export async function getReconciliation(
  businessId: string,
  id: string,
  options: ReconciliationListOptions = {},
): Promise<ReconciliationDetail> {
  // `WHERE id = $1` against a uuid column raises a syntax error rather than
  // returning no rows, which surfaced as a 500 and «خطای غیرمنتظره» instead of
  // an honest «تطبیق پیدا نشد» — see `isUuid`.
  if (!isUuid(id)) throw new ReconciliationError("reconciliation_not_found", 404);

  const { rows } = await query<ReconciliationRow & { account_id: string }>(
    `SELECT ${RECONCILIATION_COLUMNS}, r.account_id::text AS account_id
       FROM bank_reconciliations r ${RECONCILIATION_JOINS}
      WHERE r.id = $1 AND r.business_id = $2`,
    [id, businessId],
  );
  const row = rows[0];
  if (!row) throw new ReconciliationError("reconciliation_not_found", 404);

  const limit = pageLimit(options);
  const filtered = Boolean(options.search?.trim()) || Boolean(options.clearedOnly);
  const [opening, totals, page, matched] = await Promise.all([
    openingBalance(businessId, row.account_id, row.id, row.statement_date),
    candidateTotals(businessId, row.account_id, id, row.statement_date),
    candidatePage(businessId, row.account_id, id, row.statement_date, options, limit),
    // Without a filter every candidate matches, so the unfiltered aggregate
    // above already answered it and the second query would be pure waste.
    filtered
      ? candidateMatchedCount(businessId, row.account_id, id, row.statement_date, options)
      : Promise.resolve(null),
  ]);

  // One definition of the sign and the arithmetic, shared with the screen
  // (`bank-reconciliation.ts`) so the two cannot disagree about «مغایرت».
  const computedBalance = computedBalanceOf(opening, totals.clearedTotal);
  const summary = toSummary(row);

  return {
    ...summary,
    openingBalance: opening,
    clearedTotal: totals.clearedTotal,
    computedBalance,
    difference: differenceOf(summary.statementBalance, computedBalance),
    candidateCount: totals.candidateCount,
    clearedCount: totals.clearedCount,
    matchedCount: matched ?? totals.candidateCount,
    lines: page.lines,
    limit,
    hasMore: page.nextCursor !== null,
    nextCursor: page.nextCursor,
  };
}

export async function createReconciliation(params: {
  businessId: string;
  accountCode: ReconcilableAccount;
  statementDate: string;
  statementBalance: number;
  createdBy: string | null;
}): Promise<ReconciliationSummary> {
  if (!Number.isSafeInteger(params.statementBalance)) {
    throw new ReconciliationError("invalid_amount");
  }
  // A negative closing balance is refused per account rather than outright.
  // A till and a card-reader float are physical holdings: they cannot contain
  // less than nothing, so a minus there is a typo or a sign flip (entering the
  // period's movement instead of its closing balance), and it would otherwise
  // be accepted and then never reconcile. A *bank* account genuinely can be
  // overdrawn, so ۱۱۱۰ keeps the minus.
  if (params.statementBalance < 0 && params.accountCode !== "bank") {
    throw new ReconciliationError("negative_statement_balance");
  }
  // The wire format is ISO/Gregorian (the screen's JalaliDatePicker converts at
  // the boundary). Validated here rather than left to the `date` column, which
  // answered a malformed date with a 500; and a Jalali year that slipped
  // through un-converted was accepted as a *Gregorian* 1404 — a statement six
  // centuries back that no posting could ever match.
  if (!isPlausibleStatementDate(params.statementDate)) {
    throw new ReconciliationError("invalid_statement_date");
  }
  const statementDate = params.statementDate.trim();
  // The screen warned about a future statement and the server accepted it.
  // That one row then blocked every real statement after it: completions chain
  // by `statement_date` and a reconciliation dated into an already-locked
  // period is refused, so the business could not reconcile the month it was
  // actually living in until the future row was deleted by hand. See
  // `isStatementDateInFuture`; `todayIsoDate()` is Tehran's day, not UTC's.
  if (isStatementDateInFuture(statementDate, todayIsoDate())) {
    throw new ReconciliationError("statement_date_in_future");
  }
  const accountId = await resolveAccountId(params.businessId, params.accountCode);

  try {
    return await withTenantTransaction(params.businessId, async () => {
      // The pre-check below is a `SELECT … FOR UPDATE` over rows that may not
      // exist yet, and a lock on nothing locks nothing: two simultaneous
      // requests both saw "no open reconciliation", both inserted, and the
      // loser surfaced Postgres' raw 23505 instead of the domain answer. The
      // advisory lock is keyed on the account, so check-and-insert is one
      // critical section per account while different accounts still run in
      // parallel. Same shape as `loyalty-service.ts`'s programme guards.
      await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`bank-reconciliation:${accountId}`]);

      const { rows: existing } = await query<{ id: string }>(
        `SELECT id FROM bank_reconciliations WHERE account_id = $1 AND status = 'in_progress' FOR UPDATE`,
        [accountId],
      );
      if (existing[0]) throw new ReconciliationError("reconciliation_in_progress", 409);

      // A reconciliation may not end on or before one that is already locked.
      //
      // Reconciliations on an account form a chain: each opens from the last
      // completed one's closing balance and claims the lines that one left. A
      // statement dated into a settled period has no honest place in that chain
      // — its candidate lines were already claimed and locked, so it opens from
      // a balance it cannot reach and can never be completed. It used to be
      // accepted silently and then sit as a permanently unclosable «تطبیق
      // ناتمام», blocking every new reconciliation on the account (only one may
      // be in progress). Refused up front instead.
      const { rows: locked } = await query<{ statement_date: string }>(
        `SELECT statement_date::text AS statement_date FROM bank_reconciliations
          WHERE account_id = $1 AND business_id = $2 AND status = 'completed' AND statement_date >= $3
          LIMIT 1`,
        [accountId, params.businessId, statementDate],
      );
      if (locked[0]) throw new ReconciliationError("statement_date_already_reconciled", 409);

      const { rows } = await query<{
        id: string;
        statement_date: string;
        statement_balance: string;
        status: "in_progress" | "completed";
        completed_at: string | null;
        created_by: string | null;
      }>(
        `INSERT INTO bank_reconciliations (business_id, account_id, statement_date, statement_balance, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, statement_date::text AS statement_date,
                   statement_balance::text AS statement_balance, status,
                   completed_at::text AS completed_at, created_by::text AS created_by`,
        [params.businessId, accountId, statementDate, params.statementBalance, params.createdBy],
      );
      const inserted = rows[0];
      return toSummary({
        id: inserted.id,
        account_code: RECONCILABLE_ACCOUNT_CODES[params.accountCode],
        statement_date: inserted.statement_date,
        statement_balance: inserted.statement_balance,
        status: inserted.status,
        completed_at: inserted.completed_at,
        // Nobody has signed a brand-new reconciliation off, and the creator's
        // name would cost a join the caller does not need on a 201.
        completed_by_name: null,
        created_by: inserted.created_by,
        created_by_name: null,
      });
    });
  } catch (err) {
    // Belt to the advisory lock's braces: the partial unique index is what
    // actually guarantees one open reconciliation per account, so a writer
    // that reached the database without taking that lock (a maintenance
    // script, a future service) must still get the domain answer rather than
    // a raw constraint name.
    if (isUniqueViolation(err)) throw new ReconciliationError("reconciliation_in_progress", 409);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * The one place line claims are written.
 *
 * A single tick and «انتخاب همه» are the same operation with a different list
 * length, so they share this function — including its transaction and its row
 * lock. The single-line endpoint used to have its own unlocked read of
 * `status`, which meant a completion could land between that read and the
 * write: the reconciliation showed as locked while a line kept moving in and
 * out of it, and the balance the completion had just verified stopped being
 * the balance the lines produced.
 */
async function applyLineClearance(params: {
  businessId: string;
  reconciliationId: string;
  journalLineIds: readonly string[];
  cleared: boolean;
}): Promise<{ changed: number }> {
  // See `getReconciliation`: a non-uuid id must be an honest 404, not a 500.
  if (!isUuid(params.reconciliationId)) throw new ReconciliationError("reconciliation_not_found", 404);
  // `journal_lines.id` is a bigint, so a malformed id would raise a cast error
  // rather than answer «not found» — the same class of 500, on the other side
  // of the query. Checked here rather than in each caller, because both
  // callers reach the same `= ANY($1::bigint[])`.
  for (const id of params.journalLineIds) {
    if (!/^\d+$/.test(id)) throw new ReconciliationError("journal_line_not_found", 404);
  }

  return withTenantTransaction(params.businessId, async () => {
    // Locked, so a completion cannot land between this check and the writes.
    const { rows } = await query<{
      account_id: string;
      status: string;
      statement_date: string;
    }>(
      `SELECT account_id::text AS account_id, status, statement_date::text AS statement_date
         FROM bank_reconciliations WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.reconciliationId, params.businessId],
    );
    const reconciliation = rows[0];
    if (!reconciliation) throw new ReconciliationError("reconciliation_not_found", 404);
    if (reconciliation.status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);

    // One round-trip proving every id is a real, in-window line on this
    // account. The window matters: the candidate list stops at the statement
    // date, so accepting a later line would claim it into a reconciliation
    // that never displays it and that no later reconciliation could ever see
    // again — money silently leaving the reconcilable set.
    const { rows: lineRows } = await query<{ id: string }>(
      `SELECT jl.id
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.id = ANY($1::bigint[]) AND jl.account_id = $2 AND je.business_id = $3
          AND je.entry_date <= $4::date`,
      [[...params.journalLineIds], reconciliation.account_id, params.businessId, reconciliation.statement_date],
    );
    if (lineRows.length !== params.journalLineIds.length) {
      throw new ReconciliationError("journal_line_not_found", 404);
    }

    if (!params.cleared) {
      const { rowCount } = await query(
        `DELETE FROM bank_reconciliation_lines
          WHERE reconciliation_id = $1 AND journal_line_id = ANY($2::bigint[])`,
        [params.reconciliationId, [...params.journalLineIds]],
      );
      return { changed: rowCount ?? 0 };
    }

    // A line already owned by a *different* (necessarily completed)
    // reconciliation is owned for good. `ON CONFLICT DO NOTHING` on its own
    // used to swallow exactly this case: the caller got «ok», the tick looked
    // like it took, and it had vanished by the next read.
    const { rows: taken } = await query<{ journal_line_id: string }>(
      `SELECT journal_line_id FROM bank_reconciliation_lines
        WHERE journal_line_id = ANY($1::bigint[]) AND reconciliation_id <> $2`,
      [[...params.journalLineIds], params.reconciliationId],
    );
    if (taken[0]) throw new ReconciliationError("journal_line_already_reconciled", 409);

    const { rowCount } = await query(
      `INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id)
       SELECT $1, unnest($2::bigint[])
       ON CONFLICT (journal_line_id) DO NOTHING`,
      [params.reconciliationId, [...params.journalLineIds]],
    );
    return { changed: rowCount ?? 0 };
  });
}

/**
 * Clears or un-clears one journal line against an in-progress reconciliation.
 *
 * The same transaction, the same row lock and the same per-line rules as the
 * batch, because it *is* the batch with one id: re-ticking a line this
 * reconciliation already holds stays a no-op rather than an error (a
 * double-click, an offline retry), and every refusal the batch makes it makes
 * too. `changed` is dropped — a single-line caller has nothing to count.
 */
export async function setLineCleared(params: {
  businessId: string;
  reconciliationId: string;
  journalLineId: string;
  cleared: boolean;
}): Promise<void> {
  await applyLineClearance({
    businessId: params.businessId,
    reconciliationId: params.reconciliationId,
    journalLineIds: [params.journalLineId],
    cleared: params.cleared,
  });
}

/**
 * Clears or un-clears *many* lines against one in-progress reconciliation.
 *
 * «انتخاب همه» on a month of card settlements is several hundred lines. Sent
 * one PATCH per line that is several hundred round-trips: slow enough that the
 * screen looks hung, and each request its own opportunity to fail and leave
 * the reconciliation half-ticked with no record of how far it got. One
 * statement per line still runs here — the per-line rules are not worth
 * duplicating in SQL — but they run inside a single transaction, so the batch
 * either lands whole or not at all.
 *
 * Every rule `setLineCleared` enforces is enforced here, by calling into the
 * same checks against the same client: a line on another account, a line past
 * the statement date, or a line another (completed) reconciliation already
 * owns still refuses the *whole* batch rather than being skipped silently.
 *
 * Returns how many rows actually changed, so «۵ سند علامت خورد» is the truth
 * rather than the size of the request: re-ticking already-ticked lines is a
 * no-op, not an error.
 */
export async function setLinesCleared(params: {
  businessId: string;
  reconciliationId: string;
  journalLineIds: readonly string[];
  cleared: boolean;
}): Promise<{ changed: number }> {
  if (params.journalLineIds.length === 0) throw new ReconciliationError("journal_line_required");
  if (params.journalLineIds.length > MAX_RECONCILIATION_LINE_BATCH) {
    throw new ReconciliationError("too_many_lines");
  }
  // Duplicates in one payload are the caller's slip, not an error; collapse
  // them so `changed` counts lines rather than mentions. (The ids' *shape* is
  // `applyLineClearance`'s business — one line and five hundred are checked by
  // the same rule, next to the cast that would otherwise raise.)
  const ids = [...new Set(params.journalLineIds)];

  return applyLineClearance({
    businessId: params.businessId,
    reconciliationId: params.reconciliationId,
    journalLineIds: ids,
    cleared: params.cleared,
  });
}

/**
 * Locks a reconciliation — only once its cleared lines exactly account for the
 * statement balance.
 *
 * The whole check-and-lock is one transaction holding the reconciliation row's
 * lock, so the line set that is verified is the line set that ends up locked.
 * It used to read the lines, verify the difference, and *then* update the
 * status on a separate connection: a tick or an untick landing in that window
 * changed the lines without changing the verdict, and the reconciliation was
 * locked at a balance it did not have. `WHERE status = 'in_progress'` is still
 * on the UPDATE, because two completions racing must produce exactly one
 * winner and one honest «این تطبیق قبلاً قفل شده» — the audit trail then names
 * whoever finished first, not whoever finished last.
 */
export async function completeReconciliation(params: {
  businessId: string;
  reconciliationId: string;
  actorId: string;
}): Promise<ReconciliationDetail> {
  if (!isUuid(params.reconciliationId)) {
    throw new ReconciliationError("reconciliation_not_found", 404);
  }

  await withTenantTransaction(params.businessId, async () => {
    const { rows } = await query<{
      account_id: string;
      status: string;
      statement_date: string;
      statement_balance: string;
    }>(
      `SELECT account_id::text AS account_id, status, statement_date::text AS statement_date,
              statement_balance::text AS statement_balance
         FROM bank_reconciliations WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.reconciliationId, params.businessId],
    );
    const row = rows[0];
    if (!row) throw new ReconciliationError("reconciliation_not_found", 404);
    if (row.status !== "in_progress") throw new ReconciliationError("reconciliation_completed", 409);

    // Both halves of the arithmetic are read on this transaction's connection,
    // behind the lock any line mutation has to wait for.
    const opening = await openingBalance(
      params.businessId,
      row.account_id,
      params.reconciliationId,
      row.statement_date,
    );
    const { rows: clearedRows } = await query<{ cleared_total: string }>(
      // The lines this reconciliation holds, summed the way a candidate line
      // signs into the running total. Joined back through the entry so that a
      // claim pointing at another account, another business or a date past the
      // statement would not count toward the balance: an illegitimate line
      // makes the difference non-zero and the completion is refused, rather
      // than being quietly locked into a period it does not belong to.
      `SELECT coalesce(sum(jl.debit - jl.credit), 0)::text AS cleared_total
         FROM bank_reconciliation_lines brl
         JOIN journal_lines jl ON jl.id = brl.journal_line_id
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE brl.reconciliation_id = $1 AND jl.account_id = $2
          AND je.business_id = $3 AND je.entry_date <= $4::date`,
      [params.reconciliationId, row.account_id, params.businessId, row.statement_date],
    );
    const clearedTotal = Number(clearedRows[0]?.cleared_total ?? 0);
    const difference = differenceOf(
      Number(row.statement_balance),
      computedBalanceOf(opening, clearedTotal),
    );

    // `canComplete` is the same predicate the screen reads, so "ready to lock"
    // means one thing on both sides of the wire.
    if (!canComplete({ status: row.status, difference })) {
      throw new ReconciliationError("balance_mismatch", 409);
    }

    const { rowCount } = await query(
      `UPDATE bank_reconciliations SET status = 'completed', completed_at = now(), completed_by = $2
        WHERE id = $1 AND business_id = $3 AND status = 'in_progress'`,
      [params.reconciliationId, params.actorId, params.businessId],
    );
    if (!rowCount) throw new ReconciliationError("reconciliation_completed", 409);
  });

  return getReconciliation(params.businessId, params.reconciliationId);
}

/**
 * Discard an in-progress reconciliation.
 *
 * Without this the screen had no way back from a typo. Only one
 * reconciliation may be in progress per account, there is no way to edit a
 * statement balance once entered, and a reconciliation whose difference can
 * never reach zero can never be completed — so a single mistyped closing
 * balance wedged the account permanently, and the only escape was SQL against
 * the production database.
 *
 * Only `in_progress` may be discarded: a completed reconciliation is the
 * opening balance of the next one and an audit record of a period someone
 * signed off, so it is immutable here (`ON DELETE CASCADE` on
 * `bank_reconciliation_lines` merely releases this reconciliation's own
 * claims, returning those lines to the candidate pool for the next attempt).
 */
export async function discardReconciliation(params: {
  businessId: string;
  reconciliationId: string;
}): Promise<void> {
  if (!isUuid(params.reconciliationId)) {
    throw new ReconciliationError("reconciliation_not_found", 404);
  }

  // One statement: the status test rides along in the WHERE clause so a
  // completed reconciliation can never be deleted by a request that raced a
  // completion between the read and the write.
  const { rows } = await query<{ status: string }>(
    `DELETE FROM bank_reconciliations
      WHERE id = $1 AND business_id = $2 AND status = 'in_progress'
      RETURNING status`,
    [params.reconciliationId, params.businessId],
  );
  if (rows[0]) return;

  // Nothing was deleted: say which of the two reasons it was.
  const { rows: existing } = await query<{ status: string }>(
    `SELECT status FROM bank_reconciliations WHERE id = $1 AND business_id = $2`,
    [params.reconciliationId, params.businessId],
  );
  throw existing[0]
    ? new ReconciliationError("reconciliation_completed", 409)
    : new ReconciliationError("reconciliation_not_found", 404);
}
