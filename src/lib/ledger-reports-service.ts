/**
 * The two read-only reports the Accounting app opens on: the trial balance and
 * the app's own dashboard.
 *
 * Both were SQL inside their route handlers, which is why they drifted: each
 * carried its own copy of "which accounts count", and when one was fixed the
 * other was not. Per the repo layout rule DB-touching logic belongs in
 * `src/lib/*`, and having one module means the dashboard and the trial balance
 * cannot disagree about the same books — they now share
 * {@link accountTotals}.
 *
 * The load-bearing rule here is `ARCHIVED_WITH_POSTINGS`: an **archived
 * account still reports the postings it received**. Archiving an account only
 * stops it being offered for *new* entries — `accounts-service.ts` says so in
 * as many words ("a trial balance or statement still shows every posting an
 * archived account ever received") — so filtering the report on `is_active`
 * dropped one side of a real, balanced entry and made a correct book report
 * itself نامتوازن. An archived account with no postings is still left out: that
 * is noise, not history.
 *
 * DB-touching, so per repo convention no direct unit test; covered by
 * integration/ledger-reports.integration.test.ts.
 */
import { query } from "./db";
import { classifyAccounts, isClearing } from "./account-classification";

export type AccountType =
  "asset" | "liability" | "equity" | "revenue" | "expense";

interface AccountTotalRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  is_active: boolean;
  parent_id?: string | null;
  debit: string;
  credit: string;
}

interface LedgerIntegrityRow extends Record<string, unknown> {
  entry_count: string;
  line_count: string;
  total_debit: string;
  total_credit: string;
  balance_difference: string;
  unbalanced_entry_count: string;
  invalid_entry_count: string;
  balanced: boolean;
}

interface LedgerIntegritySummary {
  entryCount: number;
  lineCount: number;
  totalDebit: number;
  totalCredit: number;
  balanceDifference: number;
  unbalancedEntryCount: number;
  invalidEntryCount: number;
  balanced: boolean;
}

/**
 * Every account that belongs in a report, with its lifetime debit and credit
 * totals: the active chart, plus any archived account that carries postings.
 */
async function accountTotals(businessId: string): Promise<AccountTotalRow[]> {
  const { rows } = await query<AccountTotalRow>(
    `SELECT a.id, a.code, a.name, a.type, a.is_active, a.parent_id,
            COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END), 0)::text AS debit,
            COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journal_entries je
         ON je.id = jl.entry_id AND je.business_id = $1
      WHERE a.business_id = $1
      GROUP BY a.id
     HAVING a.is_active OR COUNT(je.id) > 0
      ORDER BY a.code`,
    [businessId],
  );
  return rows;
}

/**
 * Ledger health is an entry-level question, not only a grand-total question.
 *
 * The old dashboard did `SUM(debit) === SUM(credit)` over account totals. That
 * has two dangerous false positives: an empty ledger (0 = 0) and two broken
 * entries whose differences cancel each other out. This summary keeps those
 * states separate so the UI can say «بدون سند» or «نامتوازن» instead of a
 * green, fake all-clear.
 */
async function ledgerIntegritySummary(
  businessId: string,
): Promise<LedgerIntegritySummary> {
  const { rows } = await query<LedgerIntegrityRow>(
    `WITH per_entry AS (
       SELECT je.id,
              COUNT(jl.id)::bigint AS line_count,
              COALESCE(SUM(jl.debit), 0) AS debit,
              COALESCE(SUM(jl.credit), 0) AS credit
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.business_id = $1
        GROUP BY je.id
     )
     SELECT COUNT(*)::text AS entry_count,
            COALESCE(SUM(line_count), 0)::text AS line_count,
            COALESCE(SUM(debit), 0)::text AS total_debit,
            COALESCE(SUM(credit), 0)::text AS total_credit,
            (COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0))::text AS balance_difference,
            COUNT(*) FILTER (WHERE debit <> credit)::text AS unbalanced_entry_count,
            COUNT(*) FILTER (WHERE line_count < 2)::text AS invalid_entry_count,
            (COUNT(*) > 0
              AND COUNT(*) FILTER (WHERE line_count < 2) = 0
              AND COUNT(*) FILTER (WHERE debit <> credit) = 0
              AND COALESCE(SUM(debit), 0) = COALESCE(SUM(credit), 0)) AS balanced
       FROM per_entry`,
    [businessId],
  );

  const row = rows[0];
  return {
    entryCount: Number(row?.entry_count ?? 0),
    lineCount: Number(row?.line_count ?? 0),
    totalDebit: Number(row?.total_debit ?? 0),
    totalCredit: Number(row?.total_credit ?? 0),
    balanceDifference: Number(row?.balance_difference ?? 0),
    unbalancedEntryCount: Number(row?.unbalanced_entry_count ?? 0),
    invalidEntryCount: Number(row?.invalid_entry_count ?? 0),
    balanced: row?.balanced ?? false,
  };
}

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  /** False for an archived account. It still reports the postings it received. */
  isActive: boolean;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  accounts: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  /** Posted journal entries. Zero means there is nothing to call balanced yet. */
  entryCount: number;
  lineCount: number;
  /** Entries whose debit and credit totals differ, even if the grand totals cancel out. */
  unbalancedEntryCount: number;
  /** Persisted journal entries with fewer than two lines. */
  invalidEntryCount: number;
  /** debit − credit across posted journal lines. */
  balanceDifference: number;
}

/**
 * Every account's total debit/credit across all journal lines. The posting
 * services validate new entries, but imported or hand-repaired data can still be
 * bad, so the health flag is checked at the journal-entry level rather than
 * inferred from a grand total.
 */
export async function getTrialBalance(
  businessId: string,
): Promise<TrialBalance> {
  const [rows, integrity] = await Promise.all([
    accountTotals(businessId),
    ledgerIntegritySummary(businessId),
  ]);
  return {
    accounts: rows.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      isActive: a.is_active,
      debit: a.debit,
      credit: a.credit,
    })),
    totalDebit: integrity.totalDebit,
    totalCredit: integrity.totalCredit,
    balanced: integrity.balanced,
    entryCount: integrity.entryCount,
    lineCount: integrity.lineCount,
    unbalancedEntryCount: integrity.unbalancedEntryCount,
    invalidEntryCount: integrity.invalidEntryCount,
    balanceDifference: integrity.balanceDifference,
  };
}

export interface LedgerOverview {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  /** Posted journal entries. Zero means there is nothing to call balanced yet. */
  journalEntryCount: number;
  journalLineCount: number;
  /** Entries whose debit and credit totals differ, even if the grand totals cancel out. */
  unbalancedEntryCount: number;
  /** Persisted journal entries with fewer than two lines. */
  invalidEntryCount: number;
  /** debit − credit across posted journal lines. */
  balanceDifference: number;
  /**
   * Money the business can spend now: cash, bank and petty cash, as the shared
   * account classifier (`account-classification.ts`) defines them. Card/PSP
   * money in transit is *not* in here — see `paymentClearing`.
   */
  cashAndBank: number;
  /** The usable figure split by role, so the screen can name each part. */
  liquidity: { cash: number; bank: number; pettyCash: number };
  /** Settlement in transit (card reader/gateway clearing, platform receivables) — real, not yet usable. */
  paymentClearing: number;
  /** Owed by customers (1200, notes, retention) — never recoverable VAT. */
  receivables: number;
  /** Recoverable input VAT and non-customer receivables, kept apart from customer balances. */
  otherReceivables: number;
  vatReceivable: number;
  payables: number;
  revenue: number;
  expenses: number;
  netIncome: number;
  openReceivableCheques: number;
  openPayableCheques: number;
  /**
   * Website sales whose cost was not (fully) recorded — dashboard audit F01.
   * When `lines > 0` the profit above is provisional: revenue is complete,
   * COGS is not. Read from `online_sale_lines` (migration 0209).
   */
  costCoverage: { uncostedLines: number; uncostedOrders: number; uncostedNetRial: number; provisional: boolean };
  /** What the balances cover: lifetime, every branch, as of this read. */
  scope: { period: "lifetime"; branches: "all"; asOf: string };
  recentEntries: {
    id: string;
    date: string;
    memo: string | null;
    sourceType: string | null;
    total: number;
  }[];
}

/**
 * The Accounting app's dashboard, in one read.
 *
 * The balances use each account's normal side — assets and expenses are
 * debit-normal, liabilities and revenue are credit-normal — so a positive
 * number always means "we have / we owe / we earned", never a signed ledger
 * figure the owner has to decode. Which account counts as cash, clearing,
 * receivable or payable is decided by `classifyAccounts`, the same contract
 * the cash-flow statement uses, so the two cannot disagree about "cash".
 */
export async function getLedgerOverview(
  businessId: string,
): Promise<LedgerOverview> {
  const [accounts, integrity] = await Promise.all([
    accountTotals(businessId),
    ledgerIntegritySummary(businessId),
  ]);

  const balance = (row: AccountTotalRow, debitNormal: boolean) =>
    (Number(row.debit) - Number(row.credit)) * (debitNormal ? 1 : -1);

  const roles = classifyAccounts(
    accounts.map((a) => ({ id: a.id, code: a.code, parentId: a.parent_id ?? null, type: a.type })),
  );

  const liquidity = { cash: 0, bank: 0, pettyCash: 0 };
  let paymentClearing = 0;
  let receivables = 0;
  let otherReceivables = 0;
  let vatReceivable = 0;
  let payables = 0;
  let revenue = 0;
  let expenses = 0;

  for (const row of accounts) {
    const role = roles.get(row.id) ?? null;
    if (role === "cash") liquidity.cash += balance(row, true);
    else if (role === "bank") liquidity.bank += balance(row, true);
    else if (role === "petty_cash") liquidity.pettyCash += balance(row, true);
    else if (isClearing(role)) paymentClearing += balance(row, true);
    else if (role === "trade_receivable") receivables += balance(row, true);
    else if (role === "other_receivable") otherReceivables += balance(row, true);
    else if (role === "vat_receivable") vatReceivable += balance(row, true);
    else if (role === "trade_payable") payables += balance(row, false);
    if (row.type === "revenue") revenue += balance(row, false);
    if (row.type === "expense") expenses += balance(row, true);
  }
  const cashAndBank = liquidity.cash + liquidity.bank + liquidity.pettyCash;

  const { rows: coverage } = await query<{ lines: string; orders: string; net: string }>(
    `SELECT count(*)::text AS lines, count(DISTINCT f.order_id)::text AS orders,
            COALESCE(sum(f.net_rial), 0)::text AS net
       FROM online_sale_lines f
       JOIN locations l ON l.id = f.location_id AND l.business_id = $1
       JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
      WHERE f.cost_status IN ('partial', 'missing', 'unattributed')`,
    [businessId],
  );
  const uncostedLines = Number(coverage[0]?.lines ?? 0);

  const { rows: cheques } = await query<{
    open_receivable: string;
    open_payable: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed')) AS open_receivable,
            COUNT(*) FILTER (WHERE direction = 'payable' AND status = 'issued') AS open_payable
       FROM cheques
      WHERE business_id = $1`,
    [businessId],
  );

  // `posted_at`, not `entry_date`: this list answers "what was entered last",
  // which is a different question from the journal's "what happened when".
  const { rows: recent } = await query<{
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    total: string;
  }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.memo, je.source_type,
            COALESCE(SUM(jl.debit), 0) AS total
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1
      GROUP BY je.id
      ORDER BY je.posted_at DESC
      LIMIT 5`,
    [businessId],
  );

  return {
    balanced: integrity.balanced,
    totalDebit: integrity.totalDebit,
    totalCredit: integrity.totalCredit,
    journalEntryCount: integrity.entryCount,
    journalLineCount: integrity.lineCount,
    unbalancedEntryCount: integrity.unbalancedEntryCount,
    invalidEntryCount: integrity.invalidEntryCount,
    balanceDifference: integrity.balanceDifference,
    cashAndBank,
    liquidity,
    paymentClearing,
    receivables,
    otherReceivables,
    vatReceivable,
    payables,
    revenue,
    expenses,
    netIncome: revenue - expenses,
    costCoverage: {
      uncostedLines,
      uncostedOrders: Number(coverage[0]?.orders ?? 0),
      uncostedNetRial: Number(coverage[0]?.net ?? 0),
      provisional: uncostedLines > 0,
    },
    scope: { period: "lifetime", branches: "all", asOf: new Date().toISOString() },
    openReceivableCheques: Number(cheques[0]?.open_receivable ?? 0),
    openPayableCheques: Number(cheques[0]?.open_payable ?? 0),
    recentEntries: recent.map((entry) => ({
      id: entry.id,
      date: entry.entry_date,
      memo: entry.memo,
      sourceType: entry.source_type,
      total: Number(entry.total),
    })),
  };
}
