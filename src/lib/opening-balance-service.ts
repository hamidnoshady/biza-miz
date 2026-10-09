/**
 * Fiscal opening balances and carry-forward — the DB-touching half (issue #867).
 *
 * Transaction discipline, because the books are the thing at stake:
 *  - Every state change locks the opening set row first. Two people approving,
 *    or a retry racing the original, serialise on that row rather than on luck.
 *  - Creating, generating and posting also lock the fiscal-year row, the same
 *    row the year-end close locks. A year cannot be closed under a posting
 *    that is being written, and a posting cannot land in a year that has just
 *    closed.
 *  - Posting writes ONE journal entry through the shared exact-posting path,
 *    and the posted journal lines are linked back to the opening lines in the
 *    same transaction. There is no second ledger to fall out of step.
 *  - A posted set is never edited. A mistake is corrected by reversing the set
 *    (allowed only while nothing else has been posted on or after its effective
 *    date) and posting a corrected one.
 *
 * DB-touching, so per repo convention it has no direct unit test. Its rules are
 * tested through `opening-balances.test.ts`, and its behaviour end to end through
 * `integration/opening-balances.integration.test.ts`.
 */
import { getPool, query, type PoolClient } from "./db";
import { postExactJournalEntry } from "./ledger-service";
import {
  AP_SUPPLIER_ATTRIBUTION_SQL,
  AP_SUPPLIER_ID_SQL,
} from "./ap-attribution";
import {
  AR_CUSTOMER_ATTRIBUTION_SQL,
  AR_CUSTOMER_ID_SQL,
} from "./ar-service";
import {
  balanceTotals,
  canMoveOpeningSet,
  classifyOpeningProvenance,
  OPENING_PROVENANCES,
  reconcileToPriorClose,
  validateOpeningLines,
  type OpeningLineInput,
  type OpeningProvenance,
  type OpeningSetKind,
  type OpeningSetStatus,
  type ReconciliationRow,
} from "./opening-balances";
import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { normalizeVoucherChangeReason } from "./vouchers";
import type { RialText } from "./inventory-exact";

type Queryable = Pick<PoolClient, "query">;

/** A read-only client for the screens that are not inside a transaction. */
async function withReadClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export class OpeningBalanceError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

export const OPENING_SOURCE_TYPE = "opening_balance";
export const OPENING_REVERSAL_SOURCE_TYPE = "opening_balance_reversal";

export interface OpeningLineView {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
  provenance: OpeningProvenance;
  customerId: string | null;
  customerName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  sourceRef: string | null;
  journalLineId: string | null;
  reversalJournalLineId: string | null;
}

export interface OpeningSetView {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  kind: OpeningSetKind;
  sourceFiscalYearId: string | null;
  sourceFiscalYearLabel: string | null;
  effectiveDate: string;
  status: OpeningSetStatus;
  memo: string;
  idempotencyKey: string | null;
  journalEntryId: string | null;
  voucherNo: string | null;
  reversalEntryId: string | null;
  workflow: {
    proposedBy: string | null;
    proposedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    lastRejectedBy: string | null;
    lastRejectedAt: string | null;
    lastRejectionReason: string | null;
    postedBy: string | null;
    postedAt: string | null;
    reversedBy: string | null;
    reversedAt: string | null;
    reversalReason: string | null;
  };
  lines: OpeningLineView[];
  totals: ReturnType<typeof balanceTotals>;
  unattributedPartyLines: number;
  /** Set only for a carry-forward: the prior year's close against this set, account by account. */
  priorCloseReconciliation: {
    priorFiscalYearLabel: string;
    reconciled: boolean;
    rows: (ReconciliationRow & { accountCode: string; accountName: string })[];
  } | null;
}

interface SetRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  fiscal_year_id: string;
  fiscal_year_label: string;
  kind: OpeningSetKind;
  source_fiscal_year_id: string | null;
  source_fiscal_year_label: string | null;
  effective_date: string;
  status: OpeningSetStatus;
  memo: string;
  idempotency_key: string | null;
  journal_entry_id: string | null;
  voucher_no: string | null;
  reversal_entry_id: string | null;
  proposed_by: string | null;
  proposed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  last_rejected_by: string | null;
  last_rejected_at: string | null;
  last_rejection_reason: string | null;
  posted_by: string | null;
  posted_at: string | null;
  reversed_by: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
}

const SET_SELECT = `
  SELECT s.id, s.business_id, s.fiscal_year_id, fy.label AS fiscal_year_label,
         s.kind, s.source_fiscal_year_id, sfy.label AS source_fiscal_year_label,
         s.effective_date::text AS effective_date, s.status, s.memo, s.idempotency_key,
         s.journal_entry_id, je.voucher_no, s.reversal_entry_id,
         s.proposed_by, s.proposed_at::text AS proposed_at,
         s.approved_by, s.approved_at::text AS approved_at,
         s.last_rejected_by, s.last_rejected_at::text AS last_rejected_at, s.last_rejection_reason,
         s.posted_by, s.posted_at::text AS posted_at,
         s.reversed_by, s.reversed_at::text AS reversed_at, s.reversal_reason
    FROM opening_balance_sets s
    JOIN fiscal_years fy ON fy.id = s.fiscal_year_id
    LEFT JOIN fiscal_years sfy ON sfy.id = s.source_fiscal_year_id
    LEFT JOIN journal_entries je ON je.id = s.journal_entry_id`;

interface LineRow extends Record<string, unknown> {
  id: string;
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit: string;
  credit: string;
  provenance: OpeningProvenance;
  customer_id: string | null;
  customer_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  source_ref: string | null;
  journal_line_id: string | null;
  reversal_journal_line_id: string | null;
}

const LINE_SELECT = `
  SELECT l.id, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name,
         a.type::text AS account_type, l.debit::text AS debit, l.credit::text AS credit,
         l.provenance, l.customer_id, pc.name AS customer_name,
         l.supplier_id, COALESCE(psup.name, su.name) AS supplier_name,
         l.source_ref, l.journal_line_id::text AS journal_line_id,
         l.reversal_journal_line_id::text AS reversal_journal_line_id
    FROM opening_balance_lines l
    JOIN accounts a ON a.id = l.account_id
    LEFT JOIN parties pc ON pc.id = l.customer_id
    LEFT JOIN suppliers su ON su.id = l.supplier_id
    LEFT JOIN parties psup ON psup.id = su.party_id`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadSetView(db: Queryable, businessId: string, id: string): Promise<OpeningSetView | null> {
  const { rows: setRows } = await db.query<SetRow>(
    `${SET_SELECT} WHERE s.id = $1 AND s.business_id = $2`,
    [id, businessId],
  );
  const set = setRows[0];
  if (!set) return null;

  const { rows: lineRows } = await db.query<LineRow>(
    `${LINE_SELECT} WHERE l.set_id = $1 AND l.business_id = $2 ORDER BY l.line_no`,
    [id, businessId],
  );
  const lines = lineRows.map(toLineView);
  const totals = balanceTotals(lines.map((l) => ({ debit: l.debit, credit: l.credit })));
  const unattributedPartyLines = lines.filter(
    (l) => (l.provenance === "ar" || l.provenance === "ap") && !l.customerId && !l.supplierId,
  ).length;

  let priorCloseReconciliation: OpeningSetView["priorCloseReconciliation"] = null;
  if (set.kind === "carry_forward" && set.source_fiscal_year_id) {
    const prior = await priorYearClose(db, businessId, set.source_fiscal_year_id);
    const reconciliation = reconcileToPriorClose(
      prior.balances,
      lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    );
    const meta = await accountMeta(db, businessId, reconciliation.rows.map((r) => r.accountId));
    priorCloseReconciliation = {
      priorFiscalYearLabel: prior.label,
      reconciled: reconciliation.reconciled,
      rows: reconciliation.rows.map((r) => ({
        ...r,
        accountCode: meta.get(r.accountId)?.code ?? "",
        accountName: meta.get(r.accountId)?.name ?? "",
      })),
    };
  }

  return {
    id: set.id,
    fiscalYearId: set.fiscal_year_id,
    fiscalYearLabel: set.fiscal_year_label,
    kind: set.kind,
    sourceFiscalYearId: set.source_fiscal_year_id,
    sourceFiscalYearLabel: set.source_fiscal_year_label,
    effectiveDate: set.effective_date,
    status: set.status,
    memo: set.memo,
    idempotencyKey: set.idempotency_key,
    journalEntryId: set.journal_entry_id,
    voucherNo: set.voucher_no,
    reversalEntryId: set.reversal_entry_id,
    workflow: {
      proposedBy: set.proposed_by,
      proposedAt: set.proposed_at,
      approvedBy: set.approved_by,
      approvedAt: set.approved_at,
      lastRejectedBy: set.last_rejected_by,
      lastRejectedAt: set.last_rejected_at,
      lastRejectionReason: set.last_rejection_reason,
      postedBy: set.posted_by,
      postedAt: set.posted_at,
      reversedBy: set.reversed_by,
      reversedAt: set.reversed_at,
      reversalReason: set.reversal_reason,
    },
    lines,
    totals,
    unattributedPartyLines,
    priorCloseReconciliation,
  };
}

function toLineView(row: LineRow): OpeningLineView {
  return {
    id: row.id,
    lineNo: row.line_no,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    debit: Number(row.debit),
    credit: Number(row.credit),
    provenance: row.provenance,
    customerId: row.customer_id,
    customerName: row.customer_name,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    sourceRef: row.source_ref,
    journalLineId: row.journal_line_id,
    reversalJournalLineId: row.reversal_journal_line_id,
  };
}

export async function getOpeningBalanceSet(businessId: string, id: string): Promise<OpeningSetView> {
  if (!isUuid(id)) throw new OpeningBalanceError("opening_set_not_found", 404);
  const view = await withReadClient((client) => loadSetView(client, businessId, id));
  if (!view) throw new OpeningBalanceError("opening_set_not_found", 404);
  return view;
}

export interface OpeningSetSummary {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  kind: OpeningSetKind;
  effectiveDate: string;
  status: OpeningSetStatus;
  memo: string;
  voucherNo: string | null;
  totalDebit: number;
  lineCount: number;
}

export async function listOpeningBalanceSets(
  businessId: string,
  filter: { fiscalYearId?: string | null } = {},
): Promise<OpeningSetSummary[]> {
  if (filter.fiscalYearId && !isUuid(filter.fiscalYearId)) throw new OpeningBalanceError("invalid_fiscal_year", 400);
  const { rows } = await query<{
    id: string;
    fiscal_year_id: string;
    fiscal_year_label: string;
    kind: OpeningSetKind;
    effective_date: string;
    status: OpeningSetStatus;
    memo: string;
    voucher_no: string | null;
    total_debit: string;
    line_count: string;
  }>(
    `SELECT s.id, s.fiscal_year_id, fy.label AS fiscal_year_label, s.kind,
            s.effective_date::text AS effective_date, s.status, s.memo, je.voucher_no,
            COALESCE((SELECT sum(l.debit) FROM opening_balance_lines l WHERE l.set_id = s.id), 0)::text AS total_debit,
            (SELECT count(*) FROM opening_balance_lines l WHERE l.set_id = s.id)::text AS line_count
       FROM opening_balance_sets s
       JOIN fiscal_years fy ON fy.id = s.fiscal_year_id
       LEFT JOIN journal_entries je ON je.id = s.journal_entry_id
      WHERE s.business_id = $1 AND ($2::uuid IS NULL OR s.fiscal_year_id = $2::uuid)
      ORDER BY fy.label DESC, s.effective_date DESC, s.created_at DESC, s.id DESC`,
    [businessId, filter.fiscalYearId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    fiscalYearId: r.fiscal_year_id,
    fiscalYearLabel: r.fiscal_year_label,
    kind: r.kind,
    effectiveDate: r.effective_date,
    status: r.status,
    memo: r.memo,
    voucherNo: r.voucher_no,
    totalDebit: Number(r.total_debit),
    lineCount: Number(r.line_count),
  }));
}

// ---------------------------------------------------------------------------
// Prior-year close and attribution
// ---------------------------------------------------------------------------

interface AccountMetaRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  type: string;
}

async function accountMeta(
  db: Queryable,
  businessId: string,
  accountIds: string[],
): Promise<Map<string, { code: string; name: string; type: string }>> {
  const map = new Map<string, { code: string; name: string; type: string }>();
  if (accountIds.length === 0) return map;
  const { rows } = await db.query<AccountMetaRow>(
    `SELECT id, code, name, type::text AS type FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, accountIds],
  );
  for (const r of rows) map.set(r.id, { code: r.code, name: r.name, type: r.type });
  return map;
}

/**
 * The balance-sheet position of a closed fiscal year, as at its last day.
 *
 * Revenue and expense are excluded on purpose: the year-end close has already
 * moved them into retained earnings, so the balance sheet alone is the year's
 * closing position. Cumulative to `ends_on`, so it includes earlier years too.
 */
async function priorYearClose(
  db: Queryable,
  businessId: string,
  fiscalYearId: string,
): Promise<{ label: string; endsOn: string; balances: { accountId: string; balance: number }[] }> {
  const { rows: yearRows } = await db.query<{ label: string; ends_on: string }>(
    `SELECT label, ends_on::text AS ends_on FROM fiscal_years WHERE id = $1 AND business_id = $2`,
    [fiscalYearId, businessId],
  );
  const year = yearRows[0];
  if (!year) throw new OpeningBalanceError("fiscal_year_not_found", 404);
  const { rows } = await db.query<{ account_id: string; balance: string }>(
    `SELECT jl.account_id, COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND a.business_id = $1
        AND a.type IN ('asset', 'liability', 'equity')
        AND je.entry_date <= $2::date
      GROUP BY jl.account_id
     HAVING SUM(jl.debit - jl.credit) <> 0`,
    [businessId, year.ends_on],
  );
  return {
    label: year.label,
    endsOn: year.ends_on,
    balances: rows.map((r) => ({ accountId: r.account_id, balance: Number(r.balance) })),
  };
}

/** The attributed share of one control account's balance at a date, by party. */
async function attributedBalances(
  db: Queryable,
  businessId: string,
  accountId: string,
  asOf: string,
  side: "ar" | "ap",
): Promise<{ partyId: string; balance: number }[]> {
  const sql =
    side === "ar"
      ? `SELECT ${AR_CUSTOMER_ID_SQL} AS party_id, COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
           ${AR_CUSTOMER_ATTRIBUTION_SQL}
          WHERE je.business_id = $1 AND jl.account_id = $2 AND je.entry_date <= $3::date
            AND ${AR_CUSTOMER_ID_SQL} IS NOT NULL
          GROUP BY ${AR_CUSTOMER_ID_SQL}`
      : `SELECT ${AP_SUPPLIER_ID_SQL} AS party_id, COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
           ${AP_SUPPLIER_ATTRIBUTION_SQL}
          WHERE je.business_id = $1 AND jl.account_id = $2 AND je.entry_date <= $3::date
            AND ${AP_SUPPLIER_ID_SQL} IS NOT NULL
          GROUP BY ${AP_SUPPLIER_ID_SQL}`;
  const { rows } = await db.query<{ party_id: string; balance: string }>(sql, [businessId, accountId, asOf]);
  return rows.map((r) => ({ partyId: r.party_id, balance: Number(r.balance) })).filter((r) => r.balance !== 0);
}

// ---------------------------------------------------------------------------
// Validation shared by submit, approve and post
// ---------------------------------------------------------------------------

async function loadLinesForValidation(client: PoolClient, setId: string): Promise<OpeningLineInput[]> {
  const { rows } = await client.query<{
    account_id: string;
    account_type: string;
    debit: string;
    credit: string;
    provenance: OpeningProvenance;
    customer_id: string | null;
    supplier_id: string | null;
    source_ref: string | null;
  }>(
    `SELECT l.account_id, a.type::text AS account_type, l.debit::text AS debit, l.credit::text AS credit,
            l.provenance, l.customer_id, l.supplier_id, l.source_ref
       FROM opening_balance_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.set_id = $1 ORDER BY l.line_no`,
    [setId],
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    accountType: r.account_type as OpeningLineInput["accountType"],
    debit: Number(r.debit),
    credit: Number(r.credit),
    provenance: r.provenance,
    customerId: r.customer_id,
    supplierId: r.supplier_id,
    sourceRef: r.source_ref,
  }));
}

/**
 * Everything that must be true before a set can be approved, and again before
 * it is posted. Checked twice on purpose: the set can be edited between the
 * two, and posting must never trust an earlier answer.
 */
async function assertReadyToApprove(
  client: PoolClient,
  businessId: string,
  set: { id: string; kind: OpeningSetKind; source_fiscal_year_id: string | null },
  lines: OpeningLineInput[],
): Promise<void> {
  if (lines.length === 0) throw new OpeningBalanceError("no_lines", 409);

  const { errors, activeLines } = validateOpeningLines(lines);
  if (activeLines.length === 0) throw new OpeningBalanceError("no_lines", 409);
  if (errors.length > 0) throw new OpeningBalanceError("invalid_lines", 400, { messages: errors });

  const totals = balanceTotals(activeLines);
  if (!totals.balanced) {
    throw new OpeningBalanceError("opening_not_balanced", 409, {
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      difference: totals.difference,
    });
  }

  const unattributed = activeLines.filter(
    (l) => (l.provenance === "ar" || l.provenance === "ap") && !l.customerId && !l.supplierId,
  ).length;
  if (unattributed > 0) {
    throw new OpeningBalanceError("unattributed_party_lines", 409, { count: unattributed });
  }

  if (set.kind === "carry_forward" && set.source_fiscal_year_id) {
    const prior = await priorYearClose(client, businessId, set.source_fiscal_year_id);
    const reconciliation = reconcileToPriorClose(
      prior.balances,
      activeLines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    );
    if (!reconciliation.reconciled) {
      const meta = await accountMeta(client, businessId, reconciliation.rows.map((r) => r.accountId));
      throw new OpeningBalanceError("carry_forward_does_not_reconcile", 409, {
        rows: reconciliation.rows
          .filter((r) => r.difference !== 0)
          .map((r) => ({ ...r, accountCode: meta.get(r.accountId)?.code ?? "" })),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

interface SetLockRow {
  id: string;
  kind: OpeningSetKind;
  status: OpeningSetStatus;
  fiscal_year_id: string;
  source_fiscal_year_id: string | null;
  effective_date: string;
  memo: string;
  proposed_by: string | null;
  journal_entry_id: string | null;
}

async function lockSet(client: PoolClient, businessId: string, id: string): Promise<SetLockRow> {
  if (!isUuid(id)) throw new OpeningBalanceError("opening_set_not_found", 404);
  const { rows } = await client.query<SetLockRow>(
    `SELECT id, kind, status, fiscal_year_id, source_fiscal_year_id, effective_date::text AS effective_date,
            memo, proposed_by, journal_entry_id
       FROM opening_balance_sets WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [id, businessId],
  );
  if (!rows[0]) throw new OpeningBalanceError("opening_set_not_found", 404);
  return rows[0];
}

/** Locks the fiscal year row the year-end close also locks, then refuses a closed year. */
async function lockOpenYear(client: PoolClient, businessId: string, fiscalYearId: string) {
  const { rows } = await client.query<{ id: string; label: string; starts_on: string; ends_on: string; closed_at: string | null }>(
    `SELECT id, label, starts_on::text AS starts_on, ends_on::text AS ends_on, closed_at
       FROM fiscal_years WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [fiscalYearId, businessId],
  );
  const year = rows[0];
  if (!year) throw new OpeningBalanceError("fiscal_year_not_found", 404);
  if (year.closed_at) throw new OpeningBalanceError("fiscal_year_closed", 409);
  return year;
}

function assertTransition(from: OpeningSetStatus, to: OpeningSetStatus) {
  if (!canMoveOpeningSet(from, to)) {
    throw new OpeningBalanceError("opening_invalid_transition", 409, { from, to });
  }
}

// ---------------------------------------------------------------------------
// Create, edit, submit, review
// ---------------------------------------------------------------------------

export interface CreateOpeningSetInput {
  fiscalYearId: string;
  effectiveDate: string;
  memo?: string | null;
  idempotencyKey?: string | null;
}

export async function createOpeningBalanceSet(
  businessId: string,
  actorId: string,
  input: CreateOpeningSetInput,
): Promise<{ set: OpeningSetView; created: boolean }> {
  if (!isUuid(input.fiscalYearId)) throw new OpeningBalanceError("fiscal_year_not_found", 404);
  const key = input.idempotencyKey?.trim() || null;
  if (key !== null && key.length > 200) throw new OpeningBalanceError("invalid_idempotency_key", 400);

  return withTransaction(async (client) => {
    const year = await lockOpenYear(client, businessId, input.fiscalYearId);

    if (key) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM opening_balance_sets WHERE business_id = $1 AND idempotency_key = $2`,
        [businessId, key],
      );
      if (rows[0]) {
        const set = await loadSetView(client, businessId, rows[0].id);
        return { set: set!, created: false };
      }
    }

    const effectiveDate = input.effectiveDate;
    if (!isValidIsoDate(effectiveDate) || effectiveDate < year.starts_on || effectiveDate > year.ends_on) {
      throw new OpeningBalanceError("effective_date_outside_fiscal_year", 400);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO opening_balance_sets
         (business_id, fiscal_year_id, kind, effective_date, memo, idempotency_key, created_by)
       VALUES ($1, $2, 'opening', $3::date, $4, $5, $6)
       RETURNING id`,
      [businessId, year.id, effectiveDate, (input.memo ?? "").trim(), key, actorId],
    );
    const set = await loadSetView(client, businessId, rows[0].id);
    return { set: set!, created: true };
  });
}

export interface OpeningLineInputRaw {
  accountId: string;
  debit: number;
  credit: number;
  provenance: string;
  customerId?: string | null;
  supplierId?: string | null;
  sourceRef?: string | null;
}

/** Replaces a draft's lines. Balance is not required here — only at submit. */
export async function replaceOpeningBalanceLines(
  businessId: string,
  setId: string,
  lines: OpeningLineInputRaw[],
): Promise<OpeningSetView> {
  return withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    if (set.status !== "draft") throw new OpeningBalanceError("opening_not_editable", 409, { status: set.status });

    const rawLines = Array.isArray(lines) ? lines : [];
    const accountIds = [...new Set(rawLines.map((l) => String(l?.accountId ?? "")))].filter(Boolean);
    if (accountIds.some((id) => !isUuid(id))) throw new OpeningBalanceError("account_not_found", 400);
    const { rows: accountRows } = await client.query<{ id: string; type: string; is_active: boolean }>(
      `SELECT id, type::text AS type, is_active FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, accountIds],
    );
    const accounts = new Map(accountRows.map((a) => [a.id, a]));
    for (const id of accountIds) {
      if (!accounts.get(id)?.is_active) throw new OpeningBalanceError("account_not_found", 400);
    }

    const customerIds = [...new Set(rawLines.map((l) => l?.customerId).filter((v): v is string => Boolean(v)))];
    const supplierIds = [...new Set(rawLines.map((l) => l?.supplierId).filter((v): v is string => Boolean(v)))];
    if ([...customerIds, ...supplierIds].some((id) => !isUuid(id))) throw new OpeningBalanceError("party_not_found", 400);
    if (customerIds.length) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM parties WHERE business_id = $1 AND id = ANY($2::uuid[])`,
        [businessId, customerIds],
      );
      if (rows.length !== customerIds.length) throw new OpeningBalanceError("party_not_found", 400);
    }
    if (supplierIds.length) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
          WHERE l.business_id = $1 AND s.id = ANY($2::uuid[])`,
        [businessId, supplierIds],
      );
      if (rows.length !== supplierIds.length) throw new OpeningBalanceError("party_not_found", 400);
    }

    const inputs: OpeningLineInput[] = rawLines.map((l) => {
      const account = accounts.get(String(l?.accountId ?? ""));
      return {
        accountId: String(l?.accountId ?? ""),
        // A non-number is a NaN, which the shared validator reports as invalid_amount.
        accountType: (account?.type ?? "asset") as OpeningLineInput["accountType"],
        debit: typeof l?.debit === "number" ? l.debit : Number.NaN,
        credit: typeof l?.credit === "number" ? l.credit : Number.NaN,
        provenance: (OPENING_PROVENANCES as readonly string[]).includes(String(l?.provenance))
          ? (l.provenance as OpeningProvenance)
          : ("unknown" as OpeningProvenance),
        customerId: l?.customerId ?? null,
        supplierId: l?.supplierId ?? null,
        sourceRef: l?.sourceRef?.trim() || null,
      };
    });
    const { errors, activeLines } = validateOpeningLines(inputs);
    if (errors.length > 0) throw new OpeningBalanceError("invalid_lines", 400, { messages: errors });

    await client.query(`DELETE FROM opening_balance_lines WHERE set_id = $1 AND business_id = $2`, [setId, businessId]);
    for (let i = 0; i < activeLines.length; i++) {
      const l = activeLines[i];
      await client.query(
        `INSERT INTO opening_balance_lines
           (business_id, set_id, line_no, account_id, debit, credit, provenance, customer_id, supplier_id, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          businessId,
          setId,
          i + 1,
          l.accountId,
          l.debit,
          l.credit,
          l.provenance,
          l.customerId ?? null,
          l.supplierId ?? null,
          l.sourceRef ?? null,
        ],
      );
    }
    await client.query(`UPDATE opening_balance_sets SET updated_at = now() WHERE id = $1`, [setId]);
    return (await loadSetView(client, businessId, setId))!;
  });
}

export async function submitOpeningBalanceSet(businessId: string, actorId: string, setId: string): Promise<OpeningSetView> {
  return withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    assertTransition(set.status, "in_review");
    const lines = await loadLinesForValidation(client, setId);
    await assertReadyToApprove(client, businessId, set, lines);
    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'in_review', proposed_by = $3, proposed_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [setId, businessId, actorId],
    );
    return (await loadSetView(client, businessId, setId))!;
  });
}

export async function rejectOpeningBalanceSet(
  businessId: string,
  actorId: string,
  setId: string,
  reason: unknown,
): Promise<OpeningSetView> {
  const why = normalizeVoucherChangeReason(reason);
  if (!why) throw new OpeningBalanceError("reason_required", 400);
  return withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    assertTransition(set.status, "draft");
    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'draft', last_rejected_by = $3, last_rejected_at = now(),
              last_rejection_reason = $4, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [setId, businessId, actorId, why],
    );
    return (await loadSetView(client, businessId, setId))!;
  });
}

export async function approveOpeningBalanceSet(businessId: string, actorId: string, setId: string): Promise<OpeningSetView> {
  return withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    assertTransition(set.status, "approved");
    // Maker and checker are different people. An approval the proposer gave
    // to their own proposal is no review at all.
    if (set.proposed_by && set.proposed_by === actorId) {
      throw new OpeningBalanceError("self_approval_forbidden", 409);
    }
    await lockOpenYear(client, businessId, set.fiscal_year_id);
    const lines = await loadLinesForValidation(client, setId);
    await assertReadyToApprove(client, businessId, set, lines);
    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [setId, businessId, actorId],
    );
    return (await loadSetView(client, businessId, setId))!;
  });
}

export async function deleteOpeningBalanceDraft(businessId: string, setId: string): Promise<void> {
  await withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    if (set.status !== "draft") throw new OpeningBalanceError("opening_not_editable", 409, { status: set.status });
    if (set.journal_entry_id) throw new OpeningBalanceError("opening_not_editable", 409);
    await client.query(`DELETE FROM opening_balance_sets WHERE id = $1 AND business_id = $2`, [setId, businessId]);
  });
}

// ---------------------------------------------------------------------------
// Post and reverse
// ---------------------------------------------------------------------------

export async function postOpeningBalanceSet(businessId: string, actorId: string, setId: string): Promise<OpeningSetView> {
  return withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    assertTransition(set.status, "posted");
    await lockOpenYear(client, businessId, set.fiscal_year_id);

    const { rows: otherPosted } = await client.query<{ id: string }>(
      `SELECT id FROM opening_balance_sets
        WHERE business_id = $1 AND fiscal_year_id = $2 AND status = 'posted' AND id <> $3 LIMIT 1`,
      [businessId, set.fiscal_year_id, setId],
    );
    if (otherPosted[0]) throw new OpeningBalanceError("opening_already_posted", 409);

    const lines = await loadLinesForValidation(client, setId);
    await assertReadyToApprove(client, businessId, set, lines);

    if (set.kind === "carry_forward") {
      // The ledger is continuous across the year end: balance-sheet balances
      // stay in their accounts and only revenue and expense roll into retained
      // earnings. Posting the carried balances again would double them. So a
      // carry-forward is accepted as the reconciled opening register for the
      // year (its lines keep their party attribution); it adds no journal lines.
      await client.query(
        `UPDATE opening_balance_sets
            SET status = 'posted', posted_by = $3, posted_at = now(), updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [setId, businessId, actorId],
      );
      return (await loadSetView(client, businessId, setId))!;
    }

    // A first opening is the start of the books. If balance-sheet activity is
    // already in the ledger before its date, posting it would double those balances.
    const { rows: earlier } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND je.entry_date < $2::date
          AND a.type IN ('asset', 'liability', 'equity')`,
      [businessId, set.effective_date],
    );
    if (Number(earlier[0]?.n ?? 0) > 0) {
      throw new OpeningBalanceError("opening_would_duplicate_ledger", 409);
    }

    const { activeLines } = validateOpeningLines(lines);

    const entryId = await postExactJournalEntry(client, {
      businessId,
      locationId: null,
      entryDate: set.effective_date,
      memo: set.memo.trim() || "مانده افتتاحیه سال مالی",
      sourceType: OPENING_SOURCE_TYPE,
      sourceId: setId,
      createdBy: actorId,
      lines: activeLines.map((l) => ({
        accountId: l.accountId,
        debit: String(l.debit) as RialText,
        credit: String(l.credit) as RialText,
      })),
    });
    if (!entryId) throw new OpeningBalanceError("no_lines", 409);

    await linkPostedLines(client, businessId, setId, entryId, "journal_line_id");

    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'posted', journal_entry_id = $3, posted_by = $4, posted_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [setId, businessId, entryId, actorId],
    );
    return (await loadSetView(client, businessId, setId))!;
  });
}

/**
 * Writes the journal line ids onto the opening lines. The exact-posting path
 * inserts lines in the order it was given them, and identity columns are
 * increasing, so ordering by id maps each opening line to its journal line.
 * A count mismatch aborts the transaction rather than guessing.
 */
async function linkPostedLines(
  client: PoolClient,
  businessId: string,
  setId: string,
  entryId: string,
  column: "journal_line_id" | "reversal_journal_line_id",
) {
  const { rows: journalLines } = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
    [entryId],
  );
  const { rows: openingLines } = await client.query<{ id: string }>(
    `SELECT id FROM opening_balance_lines WHERE set_id = $1 AND business_id = $2 ORDER BY line_no`,
    [setId, businessId],
  );
  if (journalLines.length !== openingLines.length) {
    throw new Error("opening_line_mapping_failed");
  }
  for (let i = 0; i < openingLines.length; i++) {
    await client.query(
      `UPDATE opening_balance_lines SET ${column} = $2 WHERE id = $1`,
      [openingLines[i].id, journalLines[i].id],
    );
  }
}

export async function reverseOpeningBalanceSet(
  businessId: string,
  actorId: string,
  setId: string,
  reason: unknown,
): Promise<OpeningSetView> {
  const why = normalizeVoucherChangeReason(reason);
  if (!why) throw new OpeningBalanceError("reason_required", 400);
  return withTransaction(async (client) => {
    const set = await lockSet(client, businessId, setId);
    assertTransition(set.status, "reversed");
    await lockOpenYear(client, businessId, set.fiscal_year_id);
    if (set.kind === "carry_forward") {
      // A carry-forward has no journal entry to reverse. Correct it by
      // generating a new proposal after the prior year's close is reviewed.
      throw new OpeningBalanceError("carry_forward_not_reversible", 409);
    }
    if (!set.journal_entry_id) throw new OpeningBalanceError("opening_not_posted", 409);

    // A reversal is a safe correction only while nothing else has been posted
    // on or after the set's date. Otherwise the books have moved on, and the
    // honest fix is an adjusting entry, not a rewind of the opening position.
    const { rows: dependents } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE business_id = $1 AND entry_date >= $2::date AND id <> $3`,
      [businessId, set.effective_date, set.journal_entry_id],
    );
    const dependentCount = Number(dependents[0]?.n ?? 0);
    if (dependentCount > 0) {
      throw new OpeningBalanceError("opening_has_dependent_postings", 409, { count: dependentCount });
    }

    const { rows: original } = await client.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [set.journal_entry_id],
    );
    if (original.length === 0) throw new OpeningBalanceError("entry_has_no_lines", 409);

    const reversalId = await postExactJournalEntry(client, {
      businessId,
      locationId: null,
      entryDate: set.effective_date,
      memo: `برگشت مانده افتتاحیه: ${why}`,
      sourceType: OPENING_REVERSAL_SOURCE_TYPE,
      sourceId: setId,
      createdBy: actorId,
      lines: original.map((l) => ({
        accountId: l.account_id,
        debit: l.credit as RialText,
        credit: l.debit as RialText,
      })),
    });
    if (!reversalId) throw new OpeningBalanceError("entry_has_no_lines", 409);

    await linkPostedLines(client, businessId, setId, reversalId, "reversal_journal_line_id");
    await client.query(`UPDATE journal_entries SET reverses_entry_id = $2 WHERE id = $1`, [reversalId, set.journal_entry_id]);
    await client.query(
      `UPDATE journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1`,
      [set.journal_entry_id, actorId],
    );
    await client.query(
      `UPDATE opening_balance_sets
          SET status = 'reversed', reversal_entry_id = $3, reversed_by = $4, reversed_at = now(),
              reversal_reason = $5, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [setId, businessId, reversalId, actorId, why],
    );
    return (await loadSetView(client, businessId, setId))!;
  });
}

// ---------------------------------------------------------------------------
// Carry-forward
// ---------------------------------------------------------------------------

interface CarryLine {
  accountId: string;
  accountType: OpeningLineInput["accountType"];
  /** Signed: debit − credit. */
  balance: number;
  provenance: OpeningProvenance;
  partyId: string | null;
  partyKind: "customer" | "supplier" | null;
}

/**
 * Generates the next year's opening proposal from a closed prior year.
 *
 * Idempotent per target year: the unique index and the locked year row mean a
 * retry (a double click, a dropped response) returns the proposal that already
 * exists, never a second one. Party attribution is carried line by line for A/R
 * and A/P; the part of a control balance no party explains becomes one
 * unattributed line, which blocks approval until someone assigns it.
 */
export async function generateCarryForwardProposal(
  businessId: string,
  actorId: string,
  targetFiscalYearId: string,
): Promise<{ set: OpeningSetView; created: boolean }> {
  if (!isUuid(targetFiscalYearId)) throw new OpeningBalanceError("fiscal_year_not_found", 404);
  return withTransaction(async (client) => {
    const target = await lockOpenYear(client, businessId, targetFiscalYearId);

    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM opening_balance_sets
        WHERE business_id = $1 AND fiscal_year_id = $2 AND kind = 'carry_forward'`,
      [businessId, targetFiscalYearId],
    );
    if (existing[0]) return { set: (await loadSetView(client, businessId, existing[0].id))!, created: false };

    const priorLabel = String(Number(target.label) - 1);
    const { rows: priorRows } = await client.query<{ id: string; label: string; closed_at: string | null }>(
      `SELECT id, label, closed_at FROM fiscal_years WHERE business_id = $1 AND label = $2`,
      [businessId, priorLabel],
    );
    const prior = priorRows[0];
    if (!prior) throw new OpeningBalanceError("prior_fiscal_year_missing", 409, { label: priorLabel });
    if (!prior.closed_at) throw new OpeningBalanceError("prior_fiscal_year_not_closed", 409, { label: priorLabel });

    const closing = await priorYearClose(client, businessId, prior.id);
    const meta = await accountMeta(client, businessId, closing.balances.map((b) => b.accountId));

    const lines: CarryLine[] = [];

    for (const b of closing.balances) {
      const account = meta.get(b.accountId);
      if (!account) continue;
      const provenance = classifyOpeningProvenance(account);
      if (provenance === "ar" || provenance === "ap") {
        const parties = await attributedBalances(client, businessId, b.accountId, closing.endsOn, provenance);
        let explained = 0;
        for (const p of parties) {
          explained += p.balance;
          lines.push({
            accountId: b.accountId,
            accountType: account.type as OpeningLineInput["accountType"],
            balance: p.balance,
            provenance,
            partyId: p.partyId,
            partyKind: provenance === "ar" ? "customer" : "supplier",
          });
        }
        const remainder = b.balance - explained;
        if (remainder !== 0) {
          lines.push({
            accountId: b.accountId,
            accountType: account.type as OpeningLineInput["accountType"],
            balance: remainder,
            provenance,
            partyId: null,
            partyKind: null,
          });
        }
      } else {
        lines.push({
          accountId: b.accountId,
          accountType: account.type as OpeningLineInput["accountType"],
          balance: b.balance,
          provenance,
          partyId: null,
          partyKind: null,
        });
      }
    }

    const memo = `انتقال مانده پایان سال مالی ${priorLabel}`;
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO opening_balance_sets
         (business_id, fiscal_year_id, kind, source_fiscal_year_id, effective_date, memo, created_by)
       VALUES ($1, $2, 'carry_forward', $3, $4::date, $5, $6)
       RETURNING id`,
      [businessId, targetFiscalYearId, prior.id, target.starts_on, memo, actorId],
    );
    const setId = inserted[0].id;

    let lineNo = 0;
    for (const l of lines) {
      if (l.balance === 0) continue;
      lineNo += 1;
      await client.query(
        `INSERT INTO opening_balance_lines
           (business_id, set_id, line_no, account_id, debit, credit, provenance, customer_id, supplier_id, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          businessId,
          setId,
          lineNo,
          l.accountId,
          l.balance > 0 ? l.balance : 0,
          l.balance < 0 ? -l.balance : 0,
          l.provenance,
          l.partyKind === "customer" ? l.partyId : null,
          l.partyKind === "supplier" ? l.partyId : null,
          `closing:${prior.label}`,
        ],
      );
    }
    return { set: (await loadSetView(client, businessId, setId))!, created: true };
  });
}

export async function priorCloseComparison(businessId: string, targetFiscalYearId: string) {
  if (!isUuid(targetFiscalYearId)) throw new OpeningBalanceError("fiscal_year_not_found", 404);
  return withReadClient(async (client) => {
    const { rows } = await client.query<{ id: string; label: string }>(
      `SELECT id, label FROM fiscal_years WHERE business_id = $1 AND id = $2`,
      [businessId, targetFiscalYearId],
    );
    const target = rows[0];
    if (!target) throw new OpeningBalanceError("fiscal_year_not_found", 404);
    const priorLabel = String(Number(target.label) - 1);
    const { rows: priorRows } = await client.query<{ id: string; closed_at: string | null }>(
      `SELECT id, closed_at FROM fiscal_years WHERE business_id = $1 AND label = $2`,
      [businessId, priorLabel],
    );
    const prior = priorRows[0];
    if (!prior) return { priorFiscalYearLabel: priorLabel, closed: false, proposal: null };
    const { rows: setRows } = await client.query<{ id: string }>(
      `SELECT id FROM opening_balance_sets WHERE business_id = $1 AND fiscal_year_id = $2 AND kind = 'carry_forward'`,
      [businessId, targetFiscalYearId],
    );
    return {
      priorFiscalYearLabel: priorLabel,
      closed: Boolean(prior.closed_at),
      proposal: setRows[0] ? await getOpeningBalanceSet(businessId, setRows[0].id) : null,
    };
  });
}
