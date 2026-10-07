/**
 * Phase 16 — AP subledger, the DB-touching part. Mirrors ar-service.ts, with
 * two structural differences from AR:
 *
 * - Accounts Payable is a liability: its normal balance is credit-debit
 *   (the opposite sign convention from AR's asset debit-credit), so "an open
 *   item" is a credit line here and "a payment" is a debit line — backwards
 *   from ar-service.ts everywhere the two would otherwise look identical.
 * - A supplier can come from the purchase that raised it (`purchases.
 *   supplier_id`, required for a `credit`-settled purchase since this phase
 *   — see the validation in the purchases receive route), transitively from
 *   the purchase a supplier_return's `purchase_id` points at, an A/P payment,
 *   a cheque issued to that supplier, or the supplier stored on a cheque
 *   endorsement. `suppliers` itself has no `business_id` column (only
 *   `location_id`), so payBill verifies the business match through `locations`
 *   explicitly rather than a plain equality check.
 *
 * Like the A/R mirror, every read is aggregated in SQL: the balance list is
 * one row per supplier, a statement reads only that supplier's lines, and the
 * aging report returns one row per supplier with the buckets already summed.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * aging math (shared with AR) lives in aging.ts. Covered here by
 * integration/ap.integration.test.ts.
 */
import { getPool, query, type PoolClient } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { agingBucketCaseSql, UNKNOWN_SUPPLIER_KEY, type AgingSummary } from "./aging";
import { isValidIsoDate } from "./iso-date";
import { foldForSearch, searchPattern } from "./sql-search";
import { enqueueHolooReceiptForApPayment } from "./integrations/holoo/outbox-producer";

export { MissingLedgerAccountError };

/**
 * Group key for AP lines that carry no supplier attribution — a manual journal
 * entry against A/P, or a credit purchase predating this feature. Defined in
 * the pure `aging` module (see the note there) so client components can import
 * it without pulling in `pg`; re-exported here because this is where callers
 * expect to find it.
 */
export { UNKNOWN_SUPPLIER_KEY };

export class ApError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** How a supplier alias with no name yet is shown — one copy, for the same reason A/R keeps one. */
const UNATTRIBUTED_SUPPLIER_NAME = "بدون تأمین‌کننده مشخص";

async function apAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsPayable],
  );
  return rows[0]?.id ?? null;
}

/**
 * The canonical "which supplier does this A/P line belong to?" SQL — the A/P
 * twin of `AR_CUSTOMER_ATTRIBUTION_SQL`, and the same reason it is a fragment:
 * every A/P read (balances, statement, aging) must attribute a line the same
 * way, and an endorsed received cheque names its supplier only through its
 * endorsement event.
 *
 * `$1` is the business id. The caller supplies the account filter.
 */
export const AP_SUPPLIER_ATTRIBUTION_SQL = `
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  LEFT JOIN purchases p ON je.source_type = 'purchase' AND p.id = je.source_id
  LEFT JOIN supplier_returns sr ON je.source_type = 'supplier_return' AND sr.id = je.source_id
  LEFT JOIN purchases p2 ON sr.purchase_id = p2.id
  LEFT JOIN ap_payments ap ON je.source_type = 'ap_payment' AND ap.id = je.source_id
  LEFT JOIN cheques ch ON je.source_type = 'cheque' AND ch.id = je.source_id
  -- An endorsed received cheque has no supplier_id on its original row: the
  -- supplier is the one recorded by the endorsement event. Reuse it for a
  -- later bounce too, so that debit and reversing credit stay in the same
  -- supplier statement. (First endorsement wins, as the old walk did.)
  LEFT JOIN LATERAL (
    SELECT endorsed_to_supplier_id
      FROM cheque_events
     WHERE cheque_id = ch.id AND endorsed_to_supplier_id IS NOT NULL
     ORDER BY created_at, id
     LIMIT 1
  ) endorsed ON ch.id IS NOT NULL`;

/** The supplier-id expression that goes with {@link AP_SUPPLIER_ATTRIBUTION_SQL}. */
export const AP_SUPPLIER_ID_SQL =
  "COALESCE(p.supplier_id, p2.supplier_id, ap.supplier_id, ch.supplier_id, endorsed.endorsed_to_supplier_id)";

/** The expression the supplier's display identity is read through: the party behind the branch alias, else the alias's own copy. */
const AP_SUPPLIER_NAME_SQL = `coalesce(pa.name, s.name, '${UNATTRIBUTED_SUPPLIER_NAME}')`;

/**
 * The joins that give a grouped supplier id its display identity: the branch
 * alias, then the party behind it. Takes the id expression because the two
 * shapes that need it name it differently — `g.supplier_id` under the grouped
 * subquery, `p.supplier_id` under the aging CTE.
 */
function apSupplierJoins(idExpression: string): string {
  return `
  LEFT JOIN suppliers s ON s.id = ${idExpression}
  LEFT JOIN parties pa ON pa.id = s.party_id`;
}

export interface SupplierBalance {
  supplierId: string; // UNKNOWN_SUPPLIER_KEY for unattributed lines
  supplierName: string;
  supplierPhone: string | null;
  /**
   * The party behind this branch alias (`suppliers.party_id`), or null for the
   * unattributed bucket and a legacy alias no party was ever linked to. This is
   * what a deep link into «اشخاص» needs: `supplierId` is the *alias* id, and
   * the directory is keyed by the party record, not by the alias.
   */
  supplierPartyId: string | null;
  balance: number;
}

/**
 * Every supplier *record* of this business, with whatever A/P balance it
 * carries — the picker's list, as opposed to {@link listSupplierBalances}'s
 * report. See `listCustomerDirectory` in ar-service.ts for the reasoning: a
 * cheque written to a supplier we owe nothing to yet is ordinary, and the
 * balances list also carries the `UNKNOWN_SUPPLIER_KEY` bucket, which is not a
 * supplier at all.
 *
 * The id is the branch alias's (`suppliers.id`) because that is what every A/P
 * write references; the name is the party's when there is one.
 */
export async function listSupplierDirectory(businessId: string): Promise<SupplierBalance[]> {
  const { rows } = await query<{ id: string; name: string; phone: string | null; party_id: string | null }>(
    `SELECT s.id, COALESCE(pa.name, s.name) AS name, COALESCE(pa.phone, s.phone) AS phone, s.party_id
       FROM suppliers s
       JOIN locations l ON l.id = s.location_id
       LEFT JOIN parties pa ON pa.id = s.party_id
      WHERE l.business_id = $1 AND s.is_active
      ORDER BY COALESCE(pa.name, s.name)`,
    [businessId],
  );
  const balances = new Map((await listSupplierBalances(businessId)).map((s) => [s.supplierId, s.balance]));
  return rows.map((r) => ({
    supplierId: r.id,
    supplierName: r.name,
    supplierPhone: r.phone,
    supplierPartyId: r.party_id,
    balance: balances.get(r.id) ?? 0,
  }));
}

/**
 * The balance list, grouped in SQL and bounded by the caller's window — the
 * A/P twin of `customerBalanceRows`, with the liability sign (credit − debit)
 * and the supplier alias as the group key.
 */
async function supplierBalanceRows(
  businessId: string,
  accountId: string,
  options: { q: string | null; limit: number | null; offset: number },
): Promise<{ suppliers: SupplierBalance[]; total: number }> {
  const pattern = searchPattern(options.q);
  const { rows } = await query<{
    supplier_id: string | null;
    name: string;
    phone: string | null;
    party_id: string | null;
    balance: string;
    total: string;
  }>(
    `SELECT g.supplier_id,
            ${AP_SUPPLIER_NAME_SQL} AS name,
            coalesce(pa.phone, s.phone) AS phone,
            s.party_id,
            g.balance::text AS balance,
            count(*) OVER () AS total
       FROM (
         SELECT ${AP_SUPPLIER_ID_SQL} AS supplier_id,
                sum(jl.credit - jl.debit) AS balance
         ${AP_SUPPLIER_ATTRIBUTION_SQL}
          WHERE je.business_id = $1 AND jl.account_id = $2
          GROUP BY ${AP_SUPPLIER_ID_SQL}
         HAVING sum(jl.credit - jl.debit) <> 0
       ) g
       ${apSupplierJoins("g.supplier_id")}
      WHERE $3::text IS NULL
         -- Name, phone and accounting code — the same three the A/R list
         -- searches, so the two subledger search boxes behave alike.
         OR ${foldForSearch(AP_SUPPLIER_NAME_SQL)} ILIKE $3 ESCAPE '\\'
         OR ${foldForSearch("coalesce(pa.phone, s.phone, '')")} ILIKE $3 ESCAPE '\\'
         OR ${foldForSearch("coalesce(pa.accounting_code, '')")} ILIKE $3 ESCAPE '\\'
      ORDER BY g.balance DESC, g.supplier_id NULLS LAST
      LIMIT $4::int OFFSET $5::int`,
    [businessId, accountId, pattern, options.limit, options.offset],
  );
  return {
    suppliers: rows.map((r) => ({
      supplierId: r.supplier_id ?? UNKNOWN_SUPPLIER_KEY,
      supplierName: r.name,
      supplierPhone: r.phone,
      supplierPartyId: r.party_id,
      balance: Number(r.balance),
    })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}

/** Every supplier with a nonzero AP balance, largest first — the unbounded read the callers outside the A/P screen need. */
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
 * `controlBalance` the A/P control account read credit-positive.
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
  suppliers: SupplierBalance[];
  total: number;
  summary: ApReconciliationSummary;
}

/** The A/P twin of `listCustomerBalancePage`. */
export async function listSupplierBalancePage(
  businessId: string,
  options: { q?: string | null; limit: number; offset: number },
): Promise<SupplierBalancePage> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return { suppliers: [], total: 0, summary: { ...EMPTY_AP_SUMMARY } };
  const [{ suppliers, total }, summary] = await Promise.all([
    supplierBalanceRows(businessId, accountId, {
      q: options.q?.trim() || null,
      limit: options.limit,
      offset: options.offset,
    }),
    getApReconciliationSummary(businessId),
  ]);
  return { suppliers, total, summary };
}

/** Where an A/P statement line came from — the mirror of the A/R shape (see `StatementSource`). */
export interface ApStatementSource {
  type: string | null;
  id: string | null;
  label: string | null;
  /** The purchase behind the line, including the purchase a supplier return points back at. */
  purchaseId: string | null;
}

export interface ApStatementLine {
  entryId: string;
  date: string;
  type: "bill" | "payment" | "return" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: ApStatementSource;
}

interface ApStatementRow extends Record<string, unknown> {
  entry_id: string;
  entry_date: string;
  source_type: string | null;
  source_id: string | null;
  purchase_id: string | null;
  serial_number: string | null;
  bank_name: string | null;
  memo: string | null;
  note: string | null;
  debit: string;
  credit: string;
}

/** The label a cheque line wears — the document's own words, never the memo's. */
function apStatementSourceLabel(row: ApStatementRow): string | null {
  if (row.source_type === "cheque" && row.serial_number) {
    return row.bank_name ? `چک ${row.serial_number} — ${row.bank_name}` : `چک ${row.serial_number}`;
  }
  return null;
}

/**
 * One supplier's full activity against A/P, oldest first, with a running
 * balance. `supplierId` may be UNKNOWN_SUPPLIER_KEY.
 *
 * Attributed in SQL and filtered there — see `getCustomerStatement` for why
 * that matters on a long-lived book, and for why the filter is not a reason
 * to fork the attribution rule.
 */
export async function getSupplierStatement(businessId: string, supplierId: string): Promise<ApStatementLine[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const isUnknown = supplierId === UNKNOWN_SUPPLIER_KEY;
  if (!isUnknown && !isUuid(supplierId)) return [];

  const { rows } = await query<ApStatementRow>(
    `SELECT je.id AS entry_id, je.entry_date::text AS entry_date, je.source_type, je.source_id,
            purchase.id AS purchase_id,
            ch.serial_number, ch.bank_name,
            je.memo, coalesce(p.note, p2.note) AS note,
            jl.debit::text AS debit, jl.credit::text AS credit
     ${AP_SUPPLIER_ATTRIBUTION_SQL}
     -- The purchase a line belongs to, including the one a return points back
     -- at — the same bridge the attribution above uses, named for the reader.
     LEFT JOIN purchases purchase ON purchase.id = coalesce(p.id, p2.id)
      WHERE je.business_id = $1 AND jl.account_id = $2
        AND ${isUnknown ? `${AP_SUPPLIER_ID_SQL} IS NULL` : `${AP_SUPPLIER_ID_SQL} = $3`}
      ORDER BY je.entry_date, je.posted_at, jl.id`,
    isUnknown ? [businessId, accountId] : [businessId, accountId, supplierId],
  );

  let balance = 0;
  return rows.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance += credit - debit;
    const type: ApStatementLine["type"] =
      l.source_type === "purchase" ? "bill" : l.source_type === "ap_payment" ? "payment" : l.source_type === "supplier_return" ? "return" : "other";
    const description =
      type === "bill"
        ? (l.note ?? "فاکتور خرید")
        : type === "payment"
          ? (l.memo ?? "پرداخت به تأمین‌کننده")
          : type === "return"
            ? "برگشت به تأمین‌کننده"
            : (l.memo ?? "سند دستی");
    return {
      entryId: l.entry_id,
      date: l.entry_date,
      type,
      description,
      debit,
      credit,
      balance,
      source: {
        type: l.source_type,
        id: l.source_id,
        label: apStatementSourceLabel(l),
        purchaseId: l.purchase_id,
      },
    };
  });
}

export interface AgingRow extends AgingSummary {
  supplierId: string;
  supplierName: string;
}

export interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: AgingSummary;
}

const EMPTY_AGING_SUMMARY: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };

/**
 * Standard 30/60/90-day AP aging, per supplier, as of `asOfDate` (defaults to
 * the *business's* today — see `getArAging` for why a UTC date slice put the
 * late shift's documents in the wrong bucket).
 *
 * Aggregated in PostgreSQL like its A/R mirror: bills are the credits,
 * payments and returns the debits, and the database returns one row per
 * supplier with the buckets already summed.
 */
export async function getApAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  if (asOfDate !== undefined && !isValidIsoDate(asOfDate)) throw new ApError("invalid_date");
  const effectiveAsOf = asOfDate ?? (await businessToday(businessId));
  const accountId = await apAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { ...EMPTY_AGING_SUMMARY } };

  const { rows } = await query<{
    supplier_id: string | null;
    name: string;
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
              -- being scanned rather than joined back on a per-party total —
              -- see getArAging for the plan that made this necessary.
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
            ${AP_SUPPLIER_NAME_SQL} AS name,
            p.current::text AS current,
            p.d31_60::text AS d31_60,
            p.d61_90::text AS d61_90,
            p.over90::text AS over90,
            (p.current + p.d31_60 + p.d61_90 + p.over90)::text AS total
       FROM per_party p
       ${apSupplierJoins("p.supplier_id")}
      WHERE (p.current + p.d31_60 + p.d61_90 + p.over90) <> 0
      ORDER BY (p.current + p.d31_60 + p.d61_90 + p.over90) DESC, ${AP_SUPPLIER_NAME_SQL} NULLS LAST`,
    [businessId, accountId, effectiveAsOf],
  );

  const rowsOut: AgingRow[] = rows.map((r) => ({
    supplierId: r.supplier_id ?? UNKNOWN_SUPPLIER_KEY,
    supplierName: r.name,
    current: Number(r.current),
    d31_60: Number(r.d31_60),
    d61_90: Number(r.d61_90),
    over90: Number(r.over90),
    total: Number(r.total),
  }));
  const totals = rowsOut.reduce<AgingSummary>(
    (sum, r) => ({
      current: sum.current + r.current,
      d31_60: sum.d31_60 + r.d31_60,
      d61_90: sum.d61_90 + r.d61_90,
      over90: sum.over90 + r.over90,
      total: sum.total + r.total,
    }),
    { ...EMPTY_AGING_SUMMARY },
  );
  return { asOfDate: effectiveAsOf, rows: rowsOut, totals };
}

export interface ApPayment {
  id: string;
  supplierId: string;
  paymentDate: string;
  method: "cash" | "bank";
  amount: number;
  memo: string | null;
}

/**
 * Records the business paying down a supplier's AP balance: Debit Accounts
 * Payable, Credit Cash/Bank-Clearing, in the same transaction as the
 * ap_payments row both reference (source_type='ap_payment',
 * source_id=payment.id).
 */
export async function payBill(params: {
  businessId: string;
  locationId: string | null;
  supplierId: string;
  method: "cash" | "bank";
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
  /** Holoo imports create local payments but must not push them back to Holoo. */
  skipHolooPush?: boolean;
}): Promise<ApPayment> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ApError("invalid_amount");
  }
  // A non-uuid supplier id cannot match a row, and asking Postgres anyway
  // raises a syntax error rather than returning none — see `isUuid`.
  if (!isUuid(params.supplierId)) throw new ApError("supplier_not_found", 404);
  // The repo's one calendar-aware check: the regex it replaces accepted a
  // well-shaped impossible date, which Postgres then refused with a 500.
  if (params.paymentDate != null && !isValidIsoDate(params.paymentDate)) throw new ApError("invalid_date");

  // The business's «امروز», not the DB server's UTC date — the same argument
  // `receivePayment` in ar-service.ts makes for receipts.
  const paymentDate = params.paymentDate ?? (await businessToday(params.businessId));

  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");

    // suppliers has no business_id column — verify the match through its
    // (mandatory) location instead.
    const { rows: supplierRows } = await client.query<{ id: string }>(
      `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
        WHERE s.id = $1 AND l.business_id = $2`,
      [params.supplierId, params.businessId],
    );
    if (!supplierRows[0]) throw new ApError("supplier_not_found", 404);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.accountsPayable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    const cashAccount = accounts.get(params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing)!;

    const { rows } = await client.query<{
      id: string;
      supplier_id: string;
      payment_date: string;
      method: "cash" | "bank";
      amount: string;
      memo: string | null;
    }>(
      `INSERT INTO ap_payments (business_id, location_id, supplier_id, payment_date, method, amount, memo, created_by)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8)
       RETURNING id, supplier_id, payment_date::text AS payment_date, method, amount::text AS amount, memo`,
      [
        params.businessId,
        params.locationId,
        params.supplierId,
        paymentDate,
        params.method,
        params.amount,
        params.memo?.trim() || null,
        params.createdBy,
      ],
    );
    const payment = rows[0];

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: payment.payment_date,
      memo: params.memo?.trim() || "پرداخت به تأمین‌کننده",
      sourceType: "ap_payment",
      sourceId: payment.id,
      createdBy: params.createdBy,
      postingKind: "ap_payment",
      lines: [
        { accountId: apAccount, debit: params.amount, credit: 0 },
        { accountId: cashAccount, debit: 0, credit: params.amount },
      ],
    });

    if (!params.skipHolooPush) {
      await enqueueHolooReceiptForApPayment(client, params.businessId, payment.id);
    }

    await client.query("COMMIT");
    return {
      id: payment.id,
      supplierId: payment.supplier_id,
      paymentDate: payment.payment_date,
      method: payment.method,
      amount: Number(payment.amount),
      memo: payment.memo,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
