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
import { businessToday } from "./business-day-service";
import { classifyAccounts, isClearing, type AccountRole } from "./account-classification";
import { isValidIsoDate } from "./iso-date";
import {
  DIMENSION_COLUMN,
  UNASSIGNED_DIMENSION,
  isDimensionUuid,
} from "./accounting-dimensions";
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
  pl_debit: string;
  pl_credit: string;
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

/** Account movements through a document-date cutoff. P&L columns exclude closing entries. */
async function lifetimeAccountMovements(businessId: string, throughDate: string, periodFrom?: string, periodTo?: string): Promise<AccountTotalRow[]> {
  const { rows } = await query<AccountTotalRow>(
    `SELECT a.id, a.code, a.name, a.type, a.is_active, a.parent_id,
            COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END), 0)::text AS debit,
            COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END), 0)::text AS credit,
            COALESCE(SUM(CASE WHEN je.id IS NOT NULL AND COALESCE(je.source_type,'') <> 'closing' AND COALESCE(je.posting_kind,'') <> 'closing' AND ($3::date IS NULL OR je.entry_date BETWEEN $3::date AND $4::date) THEN jl.debit ELSE 0 END), 0)::text AS pl_debit,
            COALESCE(SUM(CASE WHEN je.id IS NOT NULL AND COALESCE(je.source_type,'') <> 'closing' AND COALESCE(je.posting_kind,'') <> 'closing' AND ($3::date IS NULL OR je.entry_date BETWEEN $3::date AND $4::date) THEN jl.credit ELSE 0 END), 0)::text AS pl_credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journal_entries je
         ON je.id = jl.entry_id AND je.business_id = $1 AND je.entry_date <= $2::date
      WHERE a.business_id = $1
      GROUP BY a.id
     HAVING a.is_active OR COUNT(je.id) > 0
      ORDER BY a.code`,
    [businessId, throughDate, periodFrom ?? null, periodTo ?? null],
  );
  return rows;
}

export interface OverviewAccountFigure { debit: string; credit: string; plDebit: string; plCredit: string; type: AccountType; role: string | null }
/** Pure BigInt-safe KPI aggregation (exported for precision/semantics tests). */
export function computeOverviewFigures(figures: readonly OverviewAccountFigure[]) {
  const bal=(d:string,c:string,debitNormal:boolean)=> (BigInt(d)-BigInt(c))*(debitNormal?1n:-1n);
  const out={cash:0n,bank:0n,pettyCash:0n,paymentClearing:0n,receivables:0n,otherReceivables:0n,vatReceivable:0n,payables:0n,revenue:0n,expenses:0n};
  for(const r of figures){
    const b=bal(r.debit,r.credit,true), bn=bal(r.debit,r.credit,false);
    if(r.role==="cash") out.cash+=b; else if(r.role==="bank") out.bank+=b; else if(r.role==="petty_cash") out.pettyCash+=b;
    else if(r.role && isClearing(r.role as AccountRole | null)) out.paymentClearing+=b;
    else if(r.role==="trade_receivable") out.receivables+=b; else if(r.role==="other_receivable") out.otherReceivables+=b;
    else if(r.role==="vat_receivable") out.vatReceivable+=b; else if(r.role==="trade_payable") out.payables+=bn;
    if(r.type==="revenue") out.revenue+=bal(r.plDebit,r.plCredit,false);
    if(r.type==="expense") out.expenses+=bal(r.plDebit,r.plCredit,true);
  }
  const cashAndBank=out.cash+out.bank+out.pettyCash;
  return {...out,cashAndBank,netIncome:out.revenue-out.expenses};
}
/** Outstanding (non-returned) portion of a sale line's net, exact integer Rial (floor per line). */
export function outstandingNetRial(netRial: string, quantity: string, returnedQuantity: string): string {
  const q=Number(quantity), r=Number(returnedQuantity);
  if(!(q>0)) return "0";
  const remaining=Math.max(0,q-Math.max(0,r));
  if(remaining===0) return "0";
  // BigInt rational: net * remaining/q using decimal quantities scaled 1e9 (DB numeric(24,9))
  const qs=BigInt(Math.round(q*1e9)), rs=BigInt(Math.round(remaining*1e9));
  return (BigInt(netRial)*rs/qs).toString();
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
  const dimension = filters.dimension ?? null;
  if (dimension && dimension.valueId !== UNASSIGNED_DIMENSION && !isDimensionUuid(dimension.valueId)) {
    throw new Error("invalid_trial_balance_scope");
  }
  // A dimension filter restricts the LINES. The predicate sits on the line join,
  // so an account with no matching line still appears (at zero), and every
  // figure is the same subset as every other: nothing is summed twice.
  const dimensionPredicate = !dimension
    ? "TRUE"
    : dimension.valueId === UNASSIGNED_DIMENSION
      ? `jl.${DIMENSION_COLUMN[dimension.kind]} IS NULL`
      : `jl.${DIMENSION_COLUMN[dimension.kind]} = $4::uuid`;
  const dimensionArgs: unknown[] =
    dimension && dimension.valueId !== UNASSIGNED_DIMENSION ? [dimension.valueId] : [];
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
         LEFT JOIN journal_lines jl ON jl.account_id = a.id AND ${dimensionPredicate}
         LEFT JOIN journal_entries je
           ON je.id = jl.entry_id AND je.business_id = $1 AND je.entry_date <= $3::date
        WHERE a.business_id = $1
        GROUP BY a.id, parent.code
       HAVING a.is_active OR COUNT(je.id) > 0
        ORDER BY a.code`,
      [businessId, dateFrom, dateTo, ...dimensionArgs],
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
    // Echoed so the screen can say which subset it is showing. Under a filter the
    // flag above describes that subset only, and a subset need not balance.
    dimension,
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
  /** Exact integer Rial text (BigInt-safe) — never JS numbers. */
  totalDebit: string; totalCredit: string;
  journalEntryCount: number; journalLineCount: number;
  unbalancedEntryCount: number; invalidEntryCount: number;
  balanceDifference: string;
  cashAndBank: string;
  liquidity: { cash: string; bank: string; pettyCash: string };
  paymentClearing: string; receivables: string; otherReceivables: string; vatReceivable: string; payables: string;
  /** Operational P&L for `scope.period*`, closing entries excluded. */
  revenue: string; expenses: string; netIncome: string;
  openReceivableCheques: number; openPayableCheques: number;
  costCoverage: { uncostedLines: number; uncostedOrders: number; uncostedNetRial: string; provisional: boolean;
    affected: { orderId: string; orderNumber: string | null; orderItemId: string; sourceType: string; costStatus: string; outstandingNetRial: string }[] };
  scope: { period: "fiscal_year" | "all_time_operational"; periodFrom: string | null; periodTo: string; fiscalYearLabel: string | null; branches: "all"; asOf: string; asOfDate: string };
  recentEntries: { id: string; date: string; memo: string | null; sourceType: string | null; total: string }[];
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
  options: { asOfDate?: string } = {},
): Promise<LedgerOverview> {
  const asOfDate = options.asOfDate && isValidIsoDate(options.asOfDate) ? options.asOfDate : await businessToday(businessId);
  // Current fiscal year covering as-of (prefer open, else any covering); fallback all-time operational.
  const { rows: fyRows } = await query<{ label: string; starts_on: string; ends_on: string }>(
    `SELECT label, starts_on::text AS starts_on, ends_on::text AS ends_on FROM fiscal_years
      WHERE business_id=$1 AND $2::date BETWEEN starts_on AND ends_on ORDER BY (closed_at IS NULL) DESC, starts_on DESC LIMIT 1`,
    [businessId, asOfDate]);
  const fy = fyRows[0] ?? null;
  const [accounts, integrity] = await Promise.all([
    lifetimeAccountMovements(businessId, asOfDate, fy?.starts_on, fy?.ends_on),
    ledgerIntegritySummary(businessId, asOfDate),
  ]);
  const roles = classifyAccounts(accounts.map((a) => ({ id: a.id, code: a.code, parentId: a.parent_id ?? null, type: a.type })));
  const f = computeOverviewFigures(accounts.map((a)=>({debit:a.debit,credit:a.credit,plDebit:a.pl_debit,plCredit:a.pl_credit,type:a.type,role:roles.get(a.id) ?? null})));
  // Outstanding non-returned exposure: fully returned lines contribute 0; unknown future statuses are gaps too.
  const gapWhere = `f.cost_status NOT IN ('known', 'not_applicable') AND f.returned_quantity < f.quantity`;
  const { rows: coverageAgg } = await query<{ lines: string; orders: string; net: string }>(
    `SELECT count(*)::text AS lines, count(DISTINCT f.order_id)::text AS orders,
            COALESCE(floor(sum(f.net_rial * (f.quantity - f.returned_quantity) / f.quantity)), 0)::bigint::text AS net
       FROM online_sale_lines f
       JOIN locations l ON l.id = f.location_id AND l.business_id = $1
       JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
      WHERE ${gapWhere}`, [businessId]);
  const { rows: coverageRows } = await query<{ order_id: string; order_number: string | null; order_item_id: string; source_type: string; cost_status: string; outstanding: string }>(
    `SELECT f.order_id::text AS order_id, o.order_number::text AS order_number, f.order_item_id::text AS order_item_id, f.source_type, f.cost_status,
            floor(f.net_rial * (f.quantity - f.returned_quantity) / f.quantity)::bigint::text AS outstanding
       FROM online_sale_lines f
       JOIN locations l ON l.id = f.location_id AND l.business_id = $1
       JOIN orders o ON o.id = f.order_id
       JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
      WHERE ${gapWhere} ORDER BY f.occurred_at DESC LIMIT 20`, [businessId]);
  const affected = coverageRows.map((r)=>({orderId:r.order_id,orderNumber:r.order_number,orderItemId:r.order_item_id,sourceType:r.source_type,costStatus:r.cost_status,outstandingNetRial:r.outstanding}));
  const { rows: cheques } = await query<{ open_receivable: string; open_payable: string }>(
    `SELECT COUNT(*) FILTER (WHERE direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed')) AS open_receivable,
            COUNT(*) FILTER (WHERE direction = 'payable' AND status = 'issued') AS open_payable
       FROM cheques WHERE business_id = $1`, [businessId]);
  const { rows: recent } = await query<{ id: string; entry_date: string; memo: string | null; source_type: string | null; total: string }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.memo, je.source_type, COALESCE(SUM(jl.debit), 0)::text AS total
       FROM journal_entries je LEFT JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1 AND je.entry_date <= $2::date GROUP BY je.id ORDER BY je.posted_at DESC LIMIT 5`, [businessId, asOfDate]);
  const S=(v:bigint)=>v.toString();
  return {
    balanced: integrity.ledgerHealthy,
    totalDebit: integrity.totalDebit, totalCredit: integrity.totalCredit,
    journalEntryCount: integrity.entryCount, journalLineCount: integrity.lineCount,
    unbalancedEntryCount: integrity.unbalancedEntryCount, invalidEntryCount: integrity.invalidEntryCount,
    balanceDifference: integrity.balanceDifference,
    cashAndBank: S(f.cashAndBank), liquidity:{cash:S(f.cash),bank:S(f.bank),pettyCash:S(f.pettyCash)},
    paymentClearing:S(f.paymentClearing), receivables:S(f.receivables), otherReceivables:S(f.otherReceivables), vatReceivable:S(f.vatReceivable), payables:S(f.payables),
    revenue:S(f.revenue), expenses:S(f.expenses), netIncome:S(f.netIncome),
    costCoverage:{uncostedLines:Number(coverageAgg[0]?.lines ?? 0), uncostedOrders:Number(coverageAgg[0]?.orders ?? 0), uncostedNetRial:coverageAgg[0]?.net ?? "0", provisional:Number(coverageAgg[0]?.lines ?? 0)>0, affected},
    scope:{period: fy?"fiscal_year":"all_time_operational", periodFrom: fy?.starts_on ?? null, periodTo: fy?.ends_on ?? asOfDate, fiscalYearLabel: fy?.label ?? null, branches:"all", asOf:new Date().toISOString(), asOfDate},
    openReceivableCheques:Number(cheques[0]?.open_receivable ?? 0), openPayableCheques:Number(cheques[0]?.open_payable ?? 0),
    recentEntries: recent.map((e)=>({id:e.id,date:e.entry_date,memo:e.memo,sourceType:e.source_type,total:e.total})),
  };
}
