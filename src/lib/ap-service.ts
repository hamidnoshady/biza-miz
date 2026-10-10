import { subledgerNextOffset, validateSubledgerWindow } from "./subledger-pagination";
/**
 * Accounts Payable subledger and supplier-payment workflows.
 *
 * The subledger is reconstructed from journal lines on the control account;
 * no mutable/shadow balance is stored. Liability balances are credit minus
 * debit — the opposite sign convention from A/R's debit-minus-credit — so "an
 * open item" is a credit line here and "a payment" is a debit line. All reads
 * share the canonical source attribution in ap-attribution.ts and keep the
 * unattributed bucket visible so the total reconciles to GL 2100.
 *
 * Like its A/R mirror (ar-service.ts), the report reads happen where the rows
 * are: the balance list is one grouped row per supplier alias with the search,
 * the window and the pre-window count done in SQL, and the aging report
 * returns one row per supplier with the buckets already summed. Nothing loads
 * the business's A/P history into Node to draw a screen.
 *
 * The statement is the one read that walks lines (a statement is a list), and
 * it asks for a single supplier's lines only. DB-touching, so per repo
 * convention it has no direct unit test; covered by integration/ap
 * .integration.test.ts.
 */
import { createHash } from "node:crypto";
import { getPool, query } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { agingBucketCaseSql, UNKNOWN_SUPPLIER_KEY, type AgingSummary } from "./aging";
import { AP_SOURCE_ATTRIBUTION_CONTRACT, AP_SUPPLIER_ATTRIBUTION_SQL, AP_SUPPLIER_ID_SQL, apSupplierAttributionSql, apAttributionStatus } from "./ap-attribution";
import { foldForSearch, searchPattern } from "./sql-search";
import { enqueueHolooReceiptForApPayment } from "./integrations/holoo/outbox-producer";
import { normalizeBankReference, PayablesInputError } from "./payables-input";
import { resolveVoucherCashAccount } from "./voucher-cash-account";

export { MissingLedgerAccountError, UNKNOWN_SUPPLIER_KEY };
export { AP_SOURCE_ATTRIBUTION_CONTRACT, AP_SUPPLIER_ATTRIBUTION_SQL, AP_SUPPLIER_ID_SQL };

export class ApError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function apAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsPayable],
  );
  return rows[0]?.id ?? null;
}

/** How a supplier alias with no name yet is shown — one copy, for the same reason A/R keeps one. */
const UNATTRIBUTED_SUPPLIER_NAME = "بدون تأمین‌کننده مشخص";

/**
 * The display identity a grouped supplier alias is read through: the party
 * behind the branch alias, else the alias's own copy, else the bucket's name.
 */
const AP_SUPPLIER_NAME_SQL = `coalesce(pa.name, s.name, '${UNATTRIBUTED_SUPPLIER_NAME}')`;

/**
 * The joins that give an already-grouped supplier id its display identity and
 * branch label. Takes the id expression because the two shapes that need it
 * name it differently — `g.supplier_id` under the grouped subquery,
 * `p.supplier_id` under the aging CTE.
 */
function apSupplierIdentityJoins(idExpression: string): string {
  return `
  LEFT JOIN suppliers s ON s.id = ${idExpression}
  LEFT JOIN parties pa ON pa.id = s.party_id
  LEFT JOIN locations supplier_location ON supplier_location.id = s.location_id`;
}

interface ApLineRow extends Record<string, unknown> {
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_phone: string | null;
  party_id: string | null;
  supplier_location_id: string | null;
  supplier_location_name: string | null;
  location_id: string | null;
  location_name: string | null;
  journal_entry_id: string;
  journal_line_id: string;
  entry_date: string;
  source_type: string | null;
  source_id: string | null;
  note: string | null;
  return_reason: string | null;
  memo: string | null;
  debit: string;
  credit: string;
  purchase_id: string | null;
  item_purchase_id: string | null;
  supplier_return_id: string | null;
  item_supplier_return_id: string | null;
  payment_id: string | null;
  cheque_id: string | null;
  installment_plan_id: string | null;
}

/** A statement's sources are filtered inside the canonical relation, before
 * the journal join. Unknown statements use its full LEFT JOIN to retain gaps. */
async function queryApLines(filters: { businessId: string; accountId: string; supplierId: string }): Promise<ApLineRow[]> {
  const known = filters.supplierId !== UNKNOWN_SUPPLIER_KEY;
  const values = known ? [filters.businessId, filters.accountId, filters.supplierId] : [filters.businessId, filters.accountId];
  const { rows } = await query<ApLineRow>(
    `SELECT s.id AS supplier_id,
            COALESCE(pa.name, s.name) AS supplier_name,
            COALESCE(pa.phone, s.phone) AS supplier_phone,
            s.party_id AS party_id,
            supplier_location.id AS supplier_location_id,
            supplier_location.name AS supplier_location_name,
            je.location_id AS location_id,
            entry_location.name AS location_name,
            je.id AS journal_entry_id,
            jl.id::text AS journal_line_id,
            je.entry_date::text AS entry_date,
            je.source_type,
            je.source_id::text AS source_id,
            ap_source.note,
            ap_source.return_reason,
            je.memo,
            jl.debit::text AS debit,
            jl.credit::text AS credit,
            ap_source.purchase_id, ap_source.item_purchase_id,
            ap_source.supplier_return_id, ap_source.item_supplier_return_id,
            ap_source.payment_id, ap_source.cheque_id, ap_source.installment_plan_id
       ${known ? apSupplierAttributionSql("$3::uuid") : AP_SUPPLIER_ATTRIBUTION_SQL}
      WHERE je.business_id = $1 AND jl.account_id = $2
        AND ${known ? `${AP_SUPPLIER_ID_SQL} = $3::uuid` : `${AP_SUPPLIER_ID_SQL} IS NULL`}
      ORDER BY je.entry_date, je.posted_at, je.id, jl.id`,
    values,
  );
  return rows;
}

export interface SupplierBalance {
  /** UNKNOWN_SUPPLIER_KEY for unattributed lines; otherwise the branch alias id. */
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  /** Party record behind this per-location supplier alias, when linked. */
  supplierPartyId: string | null;
  /** Alias location is the branch that owns this payable under the strict branch-liability rule. */
  locationId: string | null;
  locationName: string | null;
  /** Positive means the business owes the supplier; negative means an advance/debit balance. */
  balance: number;
}

/**
 * Every supplier alias with its current balance. Kept separate from the report
 * list because a new supplier or an advance-payment supplier can have no open
 * bill yet. Branch names stay attached: the visible key is a branch alias, not
 * a business-wide party balance.
 */
export async function listSupplierDirectory(businessId: string): Promise<SupplierBalance[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    phone: string | null;
    party_id: string | null;
    location_id: string;
    location_name: string;
  }>(
    `SELECT s.id,
            COALESCE(pa.name, s.name) AS name,
            COALESCE(pa.phone, s.phone) AS phone,
            s.party_id,
            l.id AS location_id,
            l.name AS location_name
       FROM suppliers s
       JOIN locations l ON l.id = s.location_id
       LEFT JOIN parties pa ON pa.id = s.party_id
      WHERE l.business_id = $1 AND s.is_active
      ORDER BY COALESCE(pa.name, s.name), l.name, s.id`,
    [businessId],
  );
  const balances = new Map((await listSupplierBalances(businessId)).map((s) => [s.supplierId, s.balance]));
  return rows.map((r) => ({
    supplierId: r.id,
    supplierName: r.name,
    supplierPhone: r.phone,
    supplierPartyId: r.party_id,
    locationId: r.location_id,
    locationName: r.location_name,
    balance: balances.get(r.id) ?? 0,
  }));
}

/**
 * The balance list, grouped in SQL and bounded by the caller's window — the
 * A/P twin of `customerBalanceRows`, with the liability sign (credit − debit),
 * the supplier alias as the group key, and the same three search fields
 * (name, phone, accounting code) the A/R list searches.
 *
 * `$3` is the folded pattern or NULL; `$4`/`$5` are the window, both NULL for
 * the whole list. A counted filtered CTE retains the total even for an empty
 * page, in the same SQL snapshot and round trip as the rows.
 */
async function supplierBalanceRows(
  businessId: string,
  accountId: string,
  options: { q: string | null; limit: number | null; offset: number },
): Promise<{ suppliers: SupplierBalance[]; total: number }> {
  const pattern = searchPattern(options.q);
  const { rows } = await query<{
    supplier_id: string | null;
    supplier_name: string | null;
    supplier_phone: string | null;
    party_id: string | null;
    location_id: string | null;
    location_name: string | null;
    balance: string;
    total: string;
    present: boolean | null;
  }>(
    `WITH filtered AS (
     SELECT g.supplier_id,
            ${AP_SUPPLIER_NAME_SQL} AS supplier_name,
            coalesce(pa.phone, s.phone) AS supplier_phone,
            s.party_id AS party_id,
            supplier_location.id AS location_id,
            supplier_location.name AS location_name,
            g.balance AS balance
       FROM (
         SELECT ${AP_SUPPLIER_ID_SQL} AS supplier_id,
                sum(jl.credit - jl.debit) AS balance
         ${AP_SUPPLIER_ATTRIBUTION_SQL}
          WHERE je.business_id = $1 AND jl.account_id = $2
          GROUP BY ${AP_SUPPLIER_ID_SQL}
         HAVING sum(jl.credit - jl.debit) <> 0
       ) g
       ${apSupplierIdentityJoins("g.supplier_id")}
      WHERE $3::text IS NULL
         OR ${foldForSearch(AP_SUPPLIER_NAME_SQL)} ILIKE $3 ESCAPE '\\'
         OR ${foldForSearch("coalesce(pa.phone, s.phone, '')")} ILIKE $3 ESCAPE '\\'
         OR ${foldForSearch("coalesce(pa.accounting_code, '')")} ILIKE $3 ESCAPE '\\'
     )
     SELECT page.*, counts.total
       FROM (SELECT count(*)::text AS total FROM filtered) counts
       LEFT JOIN LATERAL (
         SELECT *, true AS present FROM filtered
          ORDER BY balance DESC, supplier_name, location_name NULLS FIRST, supplier_id NULLS FIRST
          LIMIT $4::int OFFSET $5::bigint
       ) page ON true
      ORDER BY balance DESC, supplier_name, location_name NULLS FIRST, supplier_id NULLS FIRST`,
    [businessId, accountId, pattern, options.limit, options.offset],
  );

  return {
    suppliers: rows.filter((row) => row.present).map((row) => ({
      supplierId: row.supplier_id ?? UNKNOWN_SUPPLIER_KEY,
      supplierName: row.supplier_name ?? UNATTRIBUTED_SUPPLIER_NAME,
      supplierPhone: row.supplier_phone,
      supplierPartyId: row.party_id,
      locationId: row.location_id,
      locationName: row.location_name,
      balance: Number(row.balance),
    })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}

/** Supplier balances aggregated in PostgreSQL; no journal history is copied into application memory. */
export async function listSupplierBalances(businessId: string): Promise<SupplierBalance[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const { suppliers } = await supplierBalanceRows(businessId, accountId, { q: null, limit: null, offset: 0 });
  return suppliers;
}

/**
 * What the whole A/P subledger adds up to — the mirror of
 * `ArReconciliationSummary`, with the liability signs: `payableTotal` is what
 * the business owes, `advanceTotal` the prepayments it has made, and
 * `controlBalance` the A/P control account read credit-positive (the way the
 * trial balance reads accounts of this type).
 */
export interface ApReconciliationSummary {
  payableTotal: number;
  advanceTotal: number;
  netTotal: number;
  controlBalance: number;
  difference: number;
  reconciles: boolean;
  parties: number;
  unattributedBalance: number;
}

const EMPTY_AP_SUMMARY: ApReconciliationSummary = {
  payableTotal: 0,
  advanceTotal: 0,
  netTotal: 0,
  controlBalance: 0,
  difference: 0,
  reconciles: true,
  parties: 0,
  unattributedBalance: 0,
};

/** The whole-subledger totals, in one round trip, over the same attribution as every row. */
export async function getApReconciliationSummary(businessId: string): Promise<ApReconciliationSummary> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return { ...EMPTY_AP_SUMMARY };
  const { rows } = await query<{
    payable: string;
    advances: string;
    net: string;
    control: string;
    parties: number;
    unattributed: string;
  }>(
    `WITH grouped AS (
       SELECT ${AP_SUPPLIER_ID_SQL} AS supplier_id,
              sum(jl.credit - jl.debit) AS balance
       ${AP_SUPPLIER_ATTRIBUTION_SQL}
        WHERE je.business_id = $1 AND jl.account_id = $2
        GROUP BY ${AP_SUPPLIER_ID_SQL}
     ),
     subledger AS (
       SELECT coalesce(sum(balance) FILTER (WHERE balance > 0), 0) AS payable,
              coalesce(sum(-balance) FILTER (WHERE balance < 0), 0) AS advances,
              coalesce(sum(balance), 0) AS net,
              count(*) FILTER (WHERE balance <> 0)::int AS parties,
              coalesce(sum(balance) FILTER (WHERE supplier_id IS NULL), 0) AS unattributed
         FROM grouped
     ),
     control AS (
       -- A liability's own sign: credit-positive, the way the trial balance
       -- reads accounts of this type.
       SELECT coalesce(sum(jl.credit - jl.debit), 0) AS balance
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2
     )
     SELECT s.payable::text AS payable, s.advances::text AS advances, s.net::text AS net,
            s.parties, s.unattributed::text AS unattributed, c.balance::text AS control
       FROM subledger s, control c`,
    [businessId, accountId],
  );
  const row = rows[0];
  if (!row) return { ...EMPTY_AP_SUMMARY };
  const netTotal = Number(row.net);
  const controlBalance = Number(row.control);
  return {
    payableTotal: Number(row.payable),
    advanceTotal: Number(row.advances),
    netTotal,
    controlBalance,
    difference: netTotal - controlBalance,
    reconciles: netTotal === controlBalance,
    parties: Number(row.parties),
    unattributedBalance: Number(row.unattributed),
  };
}

/** One page of the A/P balances list, with the totals the page must not change. */
export interface SupplierBalancePage {
  nextOffset: number | null;
  suppliers: SupplierBalance[];
  total: number;
  summary: ApReconciliationSummary;
}

/** The A/P twin of `listCustomerBalancePage`: the page in SQL, the totals in the same answer. */
export async function listSupplierBalancePage(
  businessId: string,
  options: { q?: string | null; limit: number; offset: number },
): Promise<SupplierBalancePage> {
  validateSubledgerWindow(options.limit, options.offset);
  const accountId = await apAccountId(businessId);
  if (!accountId) return { suppliers: [], total: 0, nextOffset: null, summary: { ...EMPTY_AP_SUMMARY } };
  const [{ suppliers, total }, summary] = await Promise.all([
    supplierBalanceRows(businessId, accountId, {
      q: options.q?.trim() || null,
      limit: options.limit,
      offset: options.offset,
    }),
    getApReconciliationSummary(businessId),
  ]);
  return { suppliers, total, summary, nextOffset: subledgerNextOffset(options.offset, suppliers.length, total) };
}

export type ApStatementType =
  | "bill"
  | "payment"
  | "payment_reversal"
  | "return"
  | "cheque"
  | "interest"
  | "adjustment"
  | "other";

export interface ApStatementLine {
  date: string;
  type: ApStatementType;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  /** Stable ledger/source references; descriptions are never used to infer navigation. */
  journalEntryId: string;
  journalLineId: string;
  sourceType: string | null;
  sourceId: string | null;
  purchaseId: string | null;
  itemPurchaseId: string | null;
  supplierReturnId: string | null;
  itemSupplierReturnId: string | null;
  paymentVoucherId: string | null;
  chequeId: string | null;
  installmentPlanId: string | null;
  locationId: string | null;
  locationName: string | null;
  supplierLocationId: string | null;
  supplierLocationName: string | null;
  attributionStatus: ReturnType<typeof apAttributionStatus>;
}

function statementType(sourceType: string | null): ApStatementType {
  switch (sourceType) {
    case "purchase":
    case "item_purchase":
    case "expense":
      return "bill";
    case "ap_payment":
      return "payment";
    case "ap_payment_reversal":
      return "payment_reversal";
    case "supplier_return":
    case "item_supplier_return":
      return "return";
    case "cheque":
      return "cheque";
    case "installment_interest":
      return "interest";
    case "manual":
    case "manual_adjustment":
    case "opening":
    case "holoo_import":
      return "adjustment";
    default:
      return "other";
  }
}

function statementDescription(line: ApLineRow, type: ApStatementType): string {
  if (type === "bill") return line.note || (line.source_type === "item_purchase" ? "خرید کالای خرده‌فروشی" : "فاکتور خرید");
  if (type === "payment") return line.memo || "پرداخت به تأمین‌کننده";
  if (type === "payment_reversal") return line.memo || "برگشت پرداخت به تأمین‌کننده";
  if (type === "return") return line.return_reason || line.memo || "برگشت به تأمین‌کننده";
  if (type === "cheque") return line.memo || "رویداد چک";
  if (type === "interest") return line.memo || "سود برنامهٔ اقساط";
  return line.memo || (type === "adjustment" ? "تعدیل حساب پرداختنی" : "سند حسابداری");
}

/** One supplier's A/P statement; only that alias (or only the unknown bucket) is queried. */
export async function getSupplierStatement(businessId: string, supplierId: string): Promise<ApStatementLine[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const lines = await queryApLines({ businessId, accountId, supplierId });

  let balance = 0;
  return lines.map((line) => {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    balance += credit - debit;
    const type = statementType(line.source_type);
    return {
      date: line.entry_date,
      type,
      description: statementDescription(line, type),
      debit,
      credit,
      balance,
      journalEntryId: line.journal_entry_id,
      journalLineId: line.journal_line_id,
      sourceType: line.source_type,
      sourceId: line.source_id,
      purchaseId: line.purchase_id,
      itemPurchaseId: line.item_purchase_id,
      supplierReturnId: line.supplier_return_id,
      itemSupplierReturnId: line.item_supplier_return_id,
      paymentVoucherId: line.payment_id,
      chequeId: line.cheque_id,
      installmentPlanId: line.installment_plan_id,
      locationId: line.location_id,
      locationName: line.location_name,
      supplierLocationId: line.supplier_location_id,
      supplierLocationName: line.supplier_location_name,
      attributionStatus: apAttributionStatus(line.source_type, line.supplier_id),
    };
  });
}

export interface AgingRow extends AgingSummary {
  supplierId: string;
  supplierName: string;
  locationId: string | null;
  locationName: string | null;
}

export interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: AgingSummary;
}

/**
 * Standard 30/60/90-day A/P aging, per supplier alias, as of `asOfDate`
 * (defaults to the *business's* today — see `getArAging` for why a UTC date
 * slice would put the late shift's documents in the wrong bucket).
 *
 * Aggregated in PostgreSQL like its A/R mirror: bills are the credits,
 * payments and returns the debits, and the database returns one row per
 * supplier with the buckets already summed and the as-of date already applied.
 *
 * The FIFO allocation is one pass of window functions rather than a join per
 * party: the earlier null-tolerant join planned as a nested loop that compared
 * every party against every line (2.7M comparisons at 300 suppliers × 9,000
 * lines, with `Rows Removed by Join Filter` in the plan — see aging.ts's note).
 * Carrying the party's payments as a window over the rows being scanned turns
 * every join into a hash join: `EXPLAIN ANALYZE` on a seeded 138k-line ledger
 * went from 441 ms to ~100 ms on the same data, all hash joins.
 */
export async function getApAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  if (asOfDate !== undefined && !isValidIsoDate(asOfDate)) throw new ApError("invalid_date");
  const effectiveAsOf = asOfDate ?? (await businessToday(businessId));
  const accountId = await apAccountId(businessId);
  if (!accountId) {
    return { asOfDate: effectiveAsOf, rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } };
  }

  const { rows } = await query<{
    supplier_id: string | null;
    supplier_name: string;
    location_id: string | null;
    location_name: string | null;
    current: string;
    d31_60: string;
    d61_90: string;
    over90: string;
    total: string;
  }>(
    `WITH scoped AS (
       -- The bucket key is the attribution, normalised to text so the
       -- unattributed lines have a key of their own instead of the NULL that
       -- no join can match (an empty string cannot collide with any supplier id).
       SELECT coalesce(${AP_SUPPLIER_ID_SQL}::text, '') AS supplier_key,
              ${AP_SUPPLIER_ID_SQL} AS supplier_id,
              je.entry_date,
              je.posted_at,
              jl.id AS line_id,
              jl.debit AS debit,
              jl.credit AS credit,
              -- The supplier's payments, carried as a window over the rows
              -- being scanned rather than joined back on a per-party total.
              sum(jl.debit) OVER (PARTITION BY coalesce(${AP_SUPPLIER_ID_SQL}::text, '')) AS paid
       ${AP_SUPPLIER_ATTRIBUTION_SQL}
        WHERE je.business_id = $1 AND jl.account_id = $2 AND je.entry_date <= $3::date
     ),
     totals AS (
       SELECT supplier_key, supplier_id, sum(credit) AS owed, sum(debit) AS paid
         FROM scoped GROUP BY supplier_key, supplier_id
     ),
     items AS (
       SELECT supplier_key, entry_date, posted_at, line_id, paid,
              sum(credit) OVER (
                PARTITION BY supplier_key ORDER BY entry_date, posted_at, line_id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS cumulative
         FROM scoped
        WHERE credit > 0
     ),
     open_items AS (
       SELECT supplier_key, bucket, outstanding
         FROM (
           SELECT supplier_key,
                  ${agingBucketCaseSql("($3::date - entry_date)")} AS bucket,
                  greatest(0, cumulative - paid)
                    - coalesce(
                        greatest(0, lag(cumulative) OVER (
                          PARTITION BY supplier_key ORDER BY entry_date, posted_at, line_id
                        ) - paid),
                        0
                      ) AS outstanding
             FROM items
         ) x
        WHERE outstanding > 0
     ),
     buckets AS (
       SELECT supplier_key,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'current'), 0) AS current,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'd31_60'), 0) AS d31_60,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'd61_90'), 0) AS d61_90,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'over90'), 0) AS over90
         FROM open_items GROUP BY supplier_key
     ),
     per_party AS (
       SELECT t.supplier_key,
              t.supplier_id,
              -- Advance payments to a supplier have no open bill to age; carry
              -- them as negative «current» so the report still agrees with the
              -- control account (the mirror of the same rule in getArAging).
              coalesce(b.current, 0) - greatest(0, t.paid - t.owed) AS current,
              coalesce(b.d31_60, 0) AS d31_60,
              coalesce(b.d61_90, 0) AS d61_90,
              coalesce(b.over90, 0) AS over90
         FROM totals t
         LEFT JOIN buckets b ON b.supplier_key = t.supplier_key
     )
     SELECT p.supplier_id,
            ${AP_SUPPLIER_NAME_SQL} AS supplier_name,
            supplier_location.id AS location_id,
            supplier_location.name AS location_name,
            p.current::text AS current,
            p.d31_60::text AS d31_60,
            p.d61_90::text AS d61_90,
            p.over90::text AS over90,
            (p.current + p.d31_60 + p.d61_90 + p.over90)::text AS total
       FROM per_party p
       ${apSupplierIdentityJoins("p.supplier_id")}
      WHERE (p.current + p.d31_60 + p.d61_90 + p.over90) <> 0
      ORDER BY (p.current + p.d31_60 + p.d61_90 + p.over90) DESC,
               ${AP_SUPPLIER_NAME_SQL},
               supplier_location.name NULLS FIRST,
               p.supplier_id NULLS FIRST`,
    [businessId, accountId, effectiveAsOf],
  );

  const agingRows: AgingRow[] = rows.map((row) => ({
    supplierId: row.supplier_id ?? UNKNOWN_SUPPLIER_KEY,
    supplierName: row.supplier_name,
    locationId: row.location_id,
    locationName: row.location_name,
    current: Number(row.current),
    d31_60: Number(row.d31_60),
    d61_90: Number(row.d61_90),
    over90: Number(row.over90),
    total: Number(row.total),
  }));
  const totals = agingRows.reduce<AgingSummary>(
    (sum, row) => ({
      current: sum.current + row.current,
      d31_60: sum.d31_60 + row.d31_60,
      d61_90: sum.d61_90 + row.d61_90,
      over90: sum.over90 + row.over90,
      total: sum.total + row.total,
    }),
    { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 },
  );
  return { asOfDate: effectiveAsOf, rows: agingRows, totals };
}

export interface ApPayment {
  id: string;
  supplierId: string;
  paymentDate: string;
  method: "cash" | "bank";
  amount: number;
  memo: string | null;
  cashAccountId: string | null;
  bankReference: string | null;
  /** True only when this call reused the result for an earlier matching request id. */
  duplicate: boolean;
}

function normalizedClientRequestId(value: unknown): string {
  if (typeof value !== "string") throw new ApError("idempotency_key_required");
  const key = value.trim();
  if (!key || key.length > 200) throw new ApError("idempotency_key_required");
  return key;
}

function paymentRequestFingerprint(params: {
  supplierId: string;
  locationId: string | null;
  method: "cash" | "bank";
  amount: number;
  paymentDate: string | null;
  memo: string | null;
  cashAccountId: string | null;
  bankReference: string | null;
}): string {
  // An ordered tuple keeps normalization/versioning explicit and avoids key
  // order dependence. Date omission remains null so a retry after midnight
  // still refers to the original intended payment date. Voucher account and
  // bank reference are also part of the operation: reusing a key with a changed
  // destination must be rejected rather than silently accepted as a retry.
  const canonical = JSON.stringify([
    params.supplierId,
    params.locationId,
    params.method,
    params.amount,
    params.paymentDate,
    params.memo,
    params.cashAccountId,
    params.bankReference,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function mapApPayment(row: {
  id: string;
  supplier_id: string;
  payment_date: string;
  method: "cash" | "bank";
  amount: string;
  memo: string | null;
  cash_account_id: string | null;
  bank_reference: string | null;
}, duplicate: boolean): ApPayment {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    paymentDate: row.payment_date,
    method: row.method,
    amount: Number(row.amount),
    memo: row.memo,
    cashAccountId: row.cash_account_id,
    bankReference: row.bank_reference,
    duplicate,
  };
}

/**
 * Records a supplier payment atomically and idempotently. The supplier alias
 * and the payment/journal location must be the same branch (strict branch
 * liability semantics); the GL and supplier row are committed together.
 */
export async function payBill(params: {
  businessId: string;
  locationId: string | null;
  supplierId: string;
  method: "cash" | "bank";
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  clientRequestId: string;
  createdBy: string | null;
  /** Holoo imports create local payments but must not push them back to Holoo. */
  skipHolooPush?: boolean;
  /** The cash/bank account the payment left from; null uses the method default. */
  cashAccountId?: string | null;
  /** Bank tracking number; normalized and validated before posting. */
  bankReference?: string | null;
}): Promise<ApPayment> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) throw new ApError("invalid_amount");
  if (!isUuid(params.supplierId)) throw new ApError("supplier_not_found", 404);
  if (params.method !== "cash" && params.method !== "bank") throw new ApError("invalid_method");
  const clientRequestId = normalizedClientRequestId(params.clientRequestId);
  const requestedPaymentDate = params.paymentDate?.trim() || null;
  if (requestedPaymentDate && !isValidIsoDate(requestedPaymentDate)) throw new ApError("invalid_date");
  const memo = params.memo?.trim() || null;
  const requestedCashAccountId = params.cashAccountId?.trim() || null;
  // Throws PayablesInputError for a malformed/oversized bank reference. The
  // normalized value makes Persian and ASCII digit forms the same operation.
  const bankReference = normalizeBankReference(params.bankReference);
  const fingerprint = paymentRequestFingerprint({
    supplierId: params.supplierId,
    locationId: params.locationId,
    method: params.method,
    amount: params.amount,
    paymentDate: requestedPaymentDate,
    memo,
    cashAccountId: requestedCashAccountId,
    bankReference,
  });
  const paymentDate = requestedPaymentDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Fast retry path, including when the active branch/business date changed
    // after the first request committed. A key reused with changed intent is a
    // hard conflict, never a silent second money movement.
    const { rows: priorRows } = await client.query<{
      id: string;
      supplier_id: string;
      payment_date: string;
      method: "cash" | "bank";
      amount: string;
      memo: string | null;
      request_fingerprint: string | null;
      cash_account_id: string | null;
      bank_reference: string | null;
    }>(
      `SELECT id, supplier_id, payment_date::text AS payment_date, method,
              amount::text AS amount, memo, request_fingerprint, cash_account_id, bank_reference
         FROM ap_payments
        WHERE business_id = $1 AND client_request_id = $2
        FOR UPDATE`,
      [params.businessId, clientRequestId],
    );
    if (priorRows[0]) {
      if (priorRows[0].request_fingerprint !== fingerprint) throw new ApError("idempotency_conflict", 409);
      await client.query("COMMIT");
      return mapApPayment(priorRows[0], true);
    }

    const { rows: supplierRows } = await client.query<{ id: string; location_id: string }>(
      `SELECT s.id, s.location_id
         FROM suppliers s
         JOIN locations l ON l.id = s.location_id
        WHERE s.id = $1 AND l.business_id = $2`,
      [params.supplierId, params.businessId],
    );
    const supplier = supplierRows[0];
    if (!supplier) throw new ApError("supplier_not_found", 404);
    if (params.locationId !== supplier.location_id) throw new ApError("supplier_location_mismatch", 409);

    const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsPayable]);
    const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    const cash = await resolveVoucherCashAccount(client, params.businessId, params.method, requestedCashAccountId);
    const cashAccount = cash.accountId;

    const { rows } = await client.query<{
      id: string;
      supplier_id: string;
      payment_date: string;
      method: "cash" | "bank";
      amount: string;
      memo: string | null;
      cash_account_id: string | null;
      bank_reference: string | null;
    }>(
      `INSERT INTO ap_payments
         (business_id, location_id, supplier_id, payment_date, method, amount, memo,
          client_request_id, request_fingerprint, created_by, cash_account_id, bank_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (business_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING id, supplier_id, payment_date::text AS payment_date,
                 method, amount::text AS amount, memo, cash_account_id, bank_reference`,
      [
        params.businessId,
        params.locationId,
        params.supplierId,
        paymentDate,
        params.method,
        params.amount,
        memo,
        clientRequestId,
        fingerprint,
        params.createdBy,
        cash.chosen ? cash.accountId : null,
        bankReference,
      ],
    );

    // A concurrent request may have inserted the same key after our first
    // lookup. The unique index waits for its transaction, then this read sees
    // the single committed voucher and applies the same fingerprint guard.
    if (!rows[0]) {
      const { rows: concurrentRows } = await client.query<{
        id: string;
        supplier_id: string;
        payment_date: string;
        method: "cash" | "bank";
        amount: string;
        memo: string | null;
        request_fingerprint: string | null;
        cash_account_id: string | null;
        bank_reference: string | null;
      }>(
        `SELECT id, supplier_id, payment_date::text AS payment_date, method,
                amount::text AS amount, memo, request_fingerprint, cash_account_id, bank_reference
           FROM ap_payments
          WHERE business_id = $1 AND client_request_id = $2
          FOR UPDATE`,
        [params.businessId, clientRequestId],
      );
      if (!concurrentRows[0] || concurrentRows[0].request_fingerprint !== fingerprint) {
        throw new ApError("idempotency_conflict", 409);
      }
      await client.query("COMMIT");
      return mapApPayment(concurrentRows[0], true);
    }

    const payment = rows[0];
    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: payment.payment_date,
      memo: memo || "پرداخت به تأمین‌کننده",
      sourceType: "ap_payment",
      sourceId: payment.id,
      createdBy: params.createdBy,
      postingKind: "ap_payment",
      lines: [
        { accountId: apAccount, debit: params.amount, credit: 0 },
        { accountId: cashAccount, debit: 0, credit: params.amount },
      ],
    });

    if (!params.skipHolooPush) await enqueueHolooReceiptForApPayment(client, params.businessId, payment.id);

    await client.query("COMMIT");
    return mapApPayment(payment, false);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ApPaymentReversal {
  paymentId: string;
  reversalEntryId: string;
  reversalDate: string;
}

/**
 * Append-only reversal for an A/P payment. The payment voucher is not edited or
 * deleted. Its journal entry is marked reversed and a new entry posts every
 * original debit/credit line on the opposite side, in the supplier's own
 * branch and the date's fiscal period.
 */
export async function reverseApPayment(params: {
  businessId: string;
  locationId: string | null;
  paymentId: string;
  actorId: string | null;
  reversalDate?: string | null;
  memo?: string | null;
}): Promise<ApPaymentReversal> {
  if (!isUuid(params.paymentId)) throw new ApError("payment_not_found", 404);
  const requestedDate = params.reversalDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) throw new ApError("invalid_date");
  const reversalDate = requestedDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      payment_id: string;
      supplier_id: string;
      source_type: string | null;
      source_id: string | null;
      entry_id: string;
      entry_location_id: string | null;
      supplier_location_id: string;
      reversed_at: string | null;
      reverses_entry_id: string | null;
    }>(
      `SELECT ap.id AS payment_id, ap.supplier_id, je.source_type, je.source_id,
              je.id AS entry_id, je.location_id AS entry_location_id,
              s.location_id AS supplier_location_id,
              je.reversed_at::text AS reversed_at, je.reverses_entry_id
         FROM ap_payments ap
         JOIN suppliers s ON s.id = ap.supplier_id
         JOIN locations sl ON sl.id = s.location_id AND sl.business_id = ap.business_id
         JOIN journal_entries je
           ON je.business_id = ap.business_id
          AND je.source_type = 'ap_payment'
          AND je.source_id = ap.id
        WHERE ap.business_id = $1 AND ap.id = $2
        ORDER BY je.posted_at, je.id
        LIMIT 1
        FOR UPDATE OF je`,
      [params.businessId, params.paymentId],
    );
    const original = rows[0];
    if (!original) throw new ApError("payment_not_found", 404);
    if (original.source_type !== "ap_payment" || original.source_id !== original.payment_id || original.reverses_entry_id) {
      throw new ApError("payment_not_reversible", 409);
    }
    if (original.reversed_at) throw new ApError("already_reversed", 409);

    const originalLocationId = original.entry_location_id ?? original.supplier_location_id;
    if (params.locationId !== originalLocationId) throw new ApError("supplier_location_mismatch", 409);

    const { rows: accountRows } = await client.query<{ id: string }>(
      `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
      [params.businessId, WELL_KNOWN_CODES.accountsPayable],
    );
    const apAccount = accountRows[0]?.id;
    if (!apAccount) throw new MissingLedgerAccountError(WELL_KNOWN_CODES.accountsPayable);

    const { rows: lines } = await client.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT jl.account_id, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl
        WHERE jl.entry_id = $1
        ORDER BY jl.id`,
      [original.entry_id],
    );
    if (lines.length === 0 || !lines.some((line) => line.account_id === apAccount)) {
      throw new ApError("payment_not_reversible", 409);
    }

    const reversalEntryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: originalLocationId,
      entryDate: reversalDate,
      memo: params.memo?.trim() || "برگشت پرداخت به تأمین‌کننده",
      sourceType: "ap_payment_reversal",
      sourceId: original.payment_id,
      createdBy: params.actorId,
      postingKind: "ap_payment_reversal",
      lines: lines.map((line) => ({
        accountId: line.account_id,
        debit: Number(line.credit),
        credit: Number(line.debit),
      })),
    });
    if (!reversalEntryId) throw new ApError("payment_not_reversible", 409);

    await client.query("UPDATE journal_entries SET reverses_entry_id = $2 WHERE id = $1", [reversalEntryId, original.entry_id]);
    await client.query("UPDATE journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1", [original.entry_id, params.actorId]);
    await client.query("COMMIT");
    return { paymentId: original.payment_id, reversalEntryId, reversalDate };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
