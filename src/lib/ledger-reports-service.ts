/**
 * Read-only accounting reports. Trial-balance semantics live here as a single
 * period-scoped, BigInt-safe source of truth; dashboard KPIs explicitly use
 * lifetime account movements instead of reusing a misleading "trial balance".
 *
 * Archived accounts remain in a report when postings through the requested
 * closing date contribute to its opening, movement, or closing figures. An
 * unused archived account is omitted unless a caller explicitly includes zero
 * balances at the presentation layer.
 */
import { query } from "./db";
import { classifyAccounts, isClearing } from "./account-classification";
import { isValidIsoDate } from "./iso-date";
import type { AccountLevel, AccountType, NormalBalance } from "./coa-template";
import type {
  TrialBalanceFilters,
  TrialBalanceReport,
  TrialBalanceRow,
  TrialBalanceTotals,
} from "./trial-balance";

/**
 * The trial balance's shape is defined in `./trial-balance`, the pure module the
 * client screen also imports. Re-exported here so server callers keep one
 * import for "the trial balance", and so a type can never be declared twice and
 * drift between the query and the screen.
 */
export type {
  TrialBalanceFilters,
  TrialBalanceReport,
  TrialBalanceRow,
  TrialBalanceTotals,
} from "./trial-balance";
export type { AccountType, NormalBalance };

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
  through_entry_count: string;
  through_line_count: string;
}

interface LedgerIntegritySummary {
  entryCount: number;
  lineCount: number;
  totalDebit: string;
  totalCredit: string;
  balanceDifference: string;
  unbalancedEntryCount: number;
  invalidEntryCount: number;
  throughEntryCount: number;
  throughLineCount: number;
  ledgerHealthy: boolean;
}

/** Lifetime movements are used only for the Accounting dashboard's lifetime KPIs. */
async function lifetimeAccountMovements(businessId: string): Promise<AccountTotalRow[]> {
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
 * Integrity is deliberately separate from the trial-balance totals. An empty
 * ledger and offsetting corrupt entries cannot earn a false green state. Counts
 * and amount strings include the whole ledger; the `through*` counts describe
 * the ledger activity represented by the requested closing date.
 */
async function ledgerIntegritySummary(
  businessId: string,
  throughDate: string,
): Promise<LedgerIntegritySummary> {
  const { rows } = await query<LedgerIntegrityRow>(
    `WITH per_entry AS (
       SELECT je.id, je.entry_date,
              COUNT(jl.id)::bigint AS line_count,
              COALESCE(SUM(jl.debit), 0)::bigint AS debit,
              COALESCE(SUM(jl.credit), 0)::bigint AS credit
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
            COUNT(*) FILTER (WHERE entry_date <= $2::date)::text AS through_entry_count,
            COALESCE(SUM(line_count) FILTER (WHERE entry_date <= $2::date), 0)::text AS through_line_count
       FROM per_entry`,
    [businessId, throughDate],
  );

  const row = rows[0];
  const entryCount = Number(row?.entry_count ?? 0);
  const unbalancedEntryCount = Number(row?.unbalanced_entry_count ?? 0);
  const invalidEntryCount = Number(row?.invalid_entry_count ?? 0);
  const balanceDifference = row?.balance_difference ?? "0";
  return {
    entryCount,
    lineCount: Number(row?.line_count ?? 0),
    totalDebit: row?.total_debit ?? "0",
    totalCredit: row?.total_credit ?? "0",
    balanceDifference,
    unbalancedEntryCount,
    invalidEntryCount,
    throughEntryCount: Number(row?.through_entry_count ?? 0),
    throughLineCount: Number(row?.through_line_count ?? 0),
    ledgerHealthy:
      entryCount > 0 &&
      unbalancedEntryCount === 0 &&
      invalidEntryCount === 0 &&
      balanceDifference === "0",
  };
}

interface TrialBalanceSqlRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  is_active: boolean;
  parent_id: string | null;
  parent_code: string | null;
  level: AccountLevel;
  has_children: boolean;
  is_contra: boolean;
  normal_balance: NormalBalance;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  raw_closing_debit: string;
  raw_closing_credit: string;
}

function splitSignedBalance(signed: bigint): { debit: string; credit: string } {
  return signed >= 0n
    ? { debit: signed.toString(), credit: "0" }
    : { debit: "0", credit: (-signed).toString() };
}

/**
 * A production trial balance: opening net balances, in-period gross turnover,
 * and closing net balances. All money is kept in PostgreSQL BIGINT / BigInt /
 * decimal strings through the API. No `Number` conversion is used here.
 */
export async function getTrialBalance(
  businessId: string,
  filters: TrialBalanceFilters,
): Promise<TrialBalanceReport> {
  const closingOnly = Boolean(filters.asOf);
  const dateFrom = closingOnly ? null : filters.dateFrom;
  const dateTo = closingOnly ? filters.asOf : filters.dateTo;
  if (
    !dateTo ||
    !isValidIsoDate(dateTo) ||
    (closingOnly && (filters.dateFrom !== undefined || filters.dateTo !== undefined)) ||
    (!closingOnly && (!dateFrom || !isValidIsoDate(dateFrom) || dateFrom > dateTo))
  ) {
    throw new Error("invalid_trial_balance_scope");
  }

  const [accountsResult, integrity, businessResult] = await Promise.all([
    query<TrialBalanceSqlRow>(
      `SELECT a.id, a.code, a.name, a.type::text AS type, a.is_active,
              a.parent_id, parent.code AS parent_code, a.level::text AS level,
              EXISTS (SELECT 1 FROM accounts child WHERE child.parent_id = a.id) AS has_children,
              a.is_contra, a.normal_balance::text AS normal_balance,
              COALESCE(SUM(jl.debit) FILTER (
                WHERE $2::date IS NOT NULL AND je.entry_date < $2::date
              ), 0)::text AS opening_debit,
              COALESCE(SUM(jl.credit) FILTER (
                WHERE $2::date IS NOT NULL AND je.entry_date < $2::date
              ), 0)::text AS opening_credit,
              COALESCE(SUM(jl.debit) FILTER (
                WHERE $2::date IS NOT NULL AND je.entry_date >= $2::date
                  AND je.entry_date <= $3::date
              ), 0)::text AS period_debit,
              COALESCE(SUM(jl.credit) FILTER (
                WHERE $2::date IS NOT NULL AND je.entry_date >= $2::date
                  AND je.entry_date <= $3::date
              ), 0)::text AS period_credit,
              COALESCE(SUM(jl.debit) FILTER (WHERE je.id IS NOT NULL), 0)::text AS raw_closing_debit,
              COALESCE(SUM(jl.credit) FILTER (WHERE je.id IS NOT NULL), 0)::text AS raw_closing_credit
         FROM accounts a
         LEFT JOIN accounts parent ON parent.id = a.parent_id AND parent.business_id = $1
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
         LEFT JOIN journal_entries je
           ON je.id = jl.entry_id AND je.business_id = $1 AND je.entry_date <= $3::date
        WHERE a.business_id = $1
        GROUP BY a.id, parent.code
       HAVING a.is_active OR COUNT(je.id) > 0
        ORDER BY a.code`,
      [businessId, dateFrom, dateTo],
    ),
    ledgerIntegritySummary(businessId, dateTo),
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [businessId]),
  ]);

  const totals: TrialBalanceTotals = {
    openingDebit: "0",
    openingCredit: "0",
    periodDebit: "0",
    periodCredit: "0",
    closingDebit: "0",
    closingCredit: "0",
    closingDifference: "0",
  };
  const accounts = accountsResult.rows.map((row) => {
    const opening = splitSignedBalance(BigInt(row.opening_debit) - BigInt(row.opening_credit));
    const closingNet = BigInt(row.raw_closing_debit) - BigInt(row.raw_closing_credit);
    const closing = splitSignedBalance(closingNet);
    const normalBalance: NormalBalance = row.is_contra
      ? row.normal_balance === "debit" ? "credit" : "debit"
      : row.normal_balance;
    // A detailed report must reconcile: what came in plus what moved is what
    // went out. The compact as-of view deliberately does not compute opening or
    // movement at all, so there is nothing there to reconcile against.
    if (!closingOnly) {
      const openingNet = BigInt(row.opening_debit) - BigInt(row.opening_credit);
      const movementNet = BigInt(row.period_debit) - BigInt(row.period_credit);
      if (closingNet !== openingNet + movementNet) {
        throw new Error("trial_balance_scope_did_not_reconcile");
      }
    }

    totals.openingDebit = (BigInt(totals.openingDebit) + BigInt(opening.debit)).toString();
    totals.openingCredit = (BigInt(totals.openingCredit) + BigInt(opening.credit)).toString();
    totals.periodDebit = (BigInt(totals.periodDebit) + BigInt(row.period_debit)).toString();
    totals.periodCredit = (BigInt(totals.periodCredit) + BigInt(row.period_credit)).toString();
    totals.closingDebit = (BigInt(totals.closingDebit) + BigInt(closing.debit)).toString();
    totals.closingCredit = (BigInt(totals.closingCredit) + BigInt(closing.credit)).toString();
    totals.closingDifference = (BigInt(totals.closingDifference) + closingNet).toString();

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      isActive: row.is_active,
      parentId: row.parent_id,
      parentCode: row.parent_code,
      level: row.level,
      hasChildren: row.has_children,
      isContra: row.is_contra,
      normalBalance,
      isAbnormalBalance: closingNet !== 0n && (normalBalance === "debit" ? closingNet < 0n : closingNet > 0n),
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      periodDebit: row.period_debit,
      periodCredit: row.period_credit,
      closingDebit: closing.debit,
      closingCredit: closing.credit,
    };
  });

  const activityEntryCount = integrity.throughEntryCount;
  const activityLineCount = integrity.throughLineCount;
  const closingTotalsMatch = totals.closingDebit === totals.closingCredit;
  return {
    businessName: businessResult.rows[0]?.name ?? "",
    mode: closingOnly ? "closing" : "detailed",
    periodFrom: dateFrom ?? null,
    periodTo: dateTo,
    asOf: closingOnly ? dateTo : null,
    accounts,
    totals,
    // Deliberately not tied to ledgerHealthy: two corrupt entries can offset in
    // the report totals while integrity still warns the accountant. It does
    // require *lines* in scope, though — a journal header with no lines leaves
    // both columns at zero, and 0 = 0 over nothing is not a balanced report.
    trialBalanceBalanced: activityLineCount > 0 && closingTotalsMatch,
    activity: { entryCount: activityEntryCount, lineCount: activityLineCount },
    integrity: {
      ledgerHealthy: integrity.ledgerHealthy,
      entryCount: integrity.entryCount,
      lineCount: integrity.lineCount,
      unbalancedEntryCount: integrity.unbalancedEntryCount,
      invalidEntryCount: integrity.invalidEntryCount,
      balanceDifference: integrity.balanceDifference,
    },
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
    lifetimeAccountMovements(businessId),
    ledgerIntegritySummary(businessId, "9999-12-31"),
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
    balanced: integrity.ledgerHealthy,
    totalDebit: Number(integrity.totalDebit),
    totalCredit: Number(integrity.totalCredit),
    journalEntryCount: integrity.entryCount,
    journalLineCount: integrity.lineCount,
    unbalancedEntryCount: integrity.unbalancedEntryCount,
    invalidEntryCount: integrity.invalidEntryCount,
    balanceDifference: Number(integrity.balanceDifference),
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
