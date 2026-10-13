import { AR_CUSTOMER_ATTRIBUTION_SQL, AR_CUSTOMER_ID_SQL, arCustomerAttributionSql } from "./ar-attribution";
import { subledgerNextOffset, validateSubledgerWindow } from "./subledger-pagination";
/**
 * Phase 16 — AR subledger, the DB-touching part.
 *
 * A customer's balance, statement, and aging are all reconstructed from the
 * same source: every journal line ever posted to the Accounts Receivable
 * account, attributed to a customer via the order (source_type='order'),
 * receipt (source_type='ar_receipt'), or received cheque (source_type='cheque')
 * that caused it. This is the same "compute from the ledger, never a shadow copy" discipline the financial
 * statements use (reports-service.ts), so a customer's balance always agrees
 * with the control account to the Rial by construction rather than by care.
 *
 * Every one of those three reports is computed *in SQL* — grouped, joined and
 * aged by PostgreSQL. The read path used to load every A/R journal line the
 * business had ever posted into Node and group it there (`arLines()`), which is
 * fine for a shop in its first year and a whole-history scan for a tenant in
 * its fifth: opening one customer's statement read every other customer's
 * rows, and an aging run shipped history it then filtered by date in JS. The
 * attribution rule is unchanged and still lives in
 * {@link AR_CUSTOMER_ATTRIBUTION_SQL}, so the balance list, a statement, the
 * aging report and the CRM's segment engine cannot disagree about who owes
 * what.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * aging math (shared with the AP subledger) lives in aging.ts and is what
 * aging.test.ts covers. Covered here by integration/ar.integration.test.ts.
 *
 * Issue #829 hardening: idempotent creation (per-business idempotency key),
 * the cash/bank/clearing account the money moved through (cash → 1100,
 * bank → 1110, clearing → 1120), canonical customer validation, and
 * first-class source-level reversal that keeps A/R party attribution (same
 * source_type/source_id, `*_reversal` posting kind).
 */
import { createHash } from "node:crypto";
import { getPool, query, type PoolClient } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { PARTY_ROLE_STORAGE } from "./parties";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";
import { accountIdsByCode, MissingLedgerAccountError, postExactMirrorEntry, postJournalEntry } from "./ledger-service";
import { ageOpenItems, agingBucketCaseSql, UNKNOWN_CUSTOMER_KEY, type AgingSummary } from "./aging";
import { toPersianDigits } from "./digits";
import { foldForSearch, searchPattern } from "./sql-search";
import {
  enqueueHolooReceiptForArReceipt,
  enqueueHolooReversalForArReceipt,
} from "./integrations/holoo/outbox-producer";
import { isVoucherMethod, normalizeBankReference, type VoucherMethod } from "./payables-input";
import {
  resolveVoucherCashAccount,
  resolveVoucherPostedAccount,
  VOUCHER_POSTED_ACCOUNT_SELECT,
  voucherPostedAccountJoin,
} from "./voucher-cash-account";

export { MissingLedgerAccountError };

/** Group key for AR lines that carry no customer attribution. Defined in the pure `aging` module so client components can import it without pulling in `pg`; re-exported here because this is where callers expect to find it. */
export { UNKNOWN_CUSTOMER_KEY };

export class ArError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** How a party with no name yet is shown — one copy, because the list, the statement and the aging report all need it. */
const UNATTRIBUTED_CUSTOMER_NAME = "بدون مشتری مشخص";

async function arAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsReceivable],
  );
  return rows[0]?.id ?? null;
}

export interface CustomerBalance {
  customerId: string; // UNKNOWN_CUSTOMER_KEY for unattributed lines
  customerName: string;
  customerPhone: string | null;
  balance: number;
}

/**
 * Every customer *record*, with whatever A/R balance it carries — the picker's
 * list, as opposed to {@link listCustomerBalances}'s report.
 *
 * The two are different questions and were being answered by one function: a
 * receipt, a cheque or an installment plan can perfectly well name a customer
 * who owes nothing right now (an advance, a first cheque, a plan agreed before
 * the first invoice), and the balances list contains no such row. It also
 * contains one row that is not a customer at all — the `UNKNOWN_CUSTOMER_KEY`
 * bucket for unattributed lines — which a picker would happily submit to a
 * write endpoint. Neither problem exists here: real parties only, every one of
 * them, ordered by name.
 */
export async function listCustomerDirectory(businessId: string): Promise<CustomerBalance[]> {
  const { rows } = await query<{ id: string; name: string; phone: string | null }>(
    // A merged duplicate keeps its row so it can still be found, but it must
    // not be offered as a fresh counterparty (crm merge, migration 0118).
    `SELECT id, name, phone
       FROM parties
      WHERE business_id = $1 AND roles @> ARRAY[$2]::text[] AND is_active AND merged_into_id IS NULL
      ORDER BY name`,
    [businessId, PARTY_ROLE_STORAGE.Customer],
  );
  const balances = new Map((await listCustomerBalances(businessId)).map((c) => [c.customerId, c.balance]));
  return rows.map((r) => ({
    customerId: r.id,
    customerName: r.name,
    customerPhone: r.phone,
    balance: balances.get(r.id) ?? 0,
  }));
}

/**
 * The balance list, grouped in SQL and bounded by the caller's window: one row
 * per customer with a non-zero balance, largest first.
 *
 * `q` filters on the customer's name, phone or accounting code (folded the way
 * the app's pickers fold a typed needle), `limit`/`offset` page it, and `total`
 * is how many rows the
 * filter matches *before* the window — so the screen can say «۲۵ از ۳۱۰» and
 * keep paging without believing the first page is the whole book. Passing
 * `limit: null` answers the whole list, which is what the callers outside the
 * screen (the directory's balance column, the assistant's collections digest)
 * have always asked for.
 */
async function customerBalanceRows(
  businessId: string,
  accountId: string,
  options: { q: string | null; limit: number | null; offset: number },
): Promise<{ customers: CustomerBalance[]; total: number }> {
  const pattern = searchPattern(options.q);
  const { rows } = await query<{
    customer_id: string | null;
    name: string;
    phone: string | null;
    balance: string;
    total: string;
    present: boolean | null;
  }>(
    /*
     * `HAVING … <> 0` rather than filtering after the fact: a customer who has
     * settled in full has nothing to show, and a row carrying a zero would
     * read as a debt of nothing.
     *
     * Count the filtered relation independently of the window. The LEFT JOIN
     * retains its count even when the requested page is empty; present marks
     * real rows, including the null-key unknown bucket.
     */
    `WITH filtered AS (
     SELECT g.customer_id,
            coalesce(p.name, '${UNATTRIBUTED_CUSTOMER_NAME}') AS name,
            p.phone,
            g.balance AS balance
       FROM (
         SELECT ${AR_CUSTOMER_ID_SQL} AS customer_id,
                sum(jl.debit - jl.credit) AS balance
         ${AR_CUSTOMER_ATTRIBUTION_SQL}
          WHERE je.business_id = $1 AND jl.account_id = $2
          GROUP BY ${AR_CUSTOMER_ID_SQL}
         HAVING sum(jl.debit - jl.credit) <> 0
       ) g
       LEFT JOIN parties p ON p.id = g.customer_id
      WHERE $3::text IS NULL
         -- Name first, then the two other things a person would type to find
         -- a customer: the phone number on the file and the accounting code
         -- the directory prints beside it. Folded the same way as every other
         -- picker in the app, so «علي» finds «علی» and «۱۲» finds «12».
         OR ${foldForSearch(`coalesce(p.name, '${UNATTRIBUTED_CUSTOMER_NAME}')`)} ILIKE $3 ESCAPE '\\'
         OR ${foldForSearch("coalesce(p.phone, '')")} ILIKE $3 ESCAPE '\\'
         OR ${foldForSearch("coalesce(p.accounting_code, '')")} ILIKE $3 ESCAPE '\\'
     )
     SELECT page.*, counts.total
       FROM (SELECT count(*)::text AS total FROM filtered) counts
       LEFT JOIN LATERAL (
         SELECT *, true AS present FROM filtered
          ORDER BY balance DESC, customer_id NULLS LAST
          LIMIT $4::int OFFSET $5::bigint
       ) page ON true
      ORDER BY balance DESC, customer_id NULLS LAST`,
    [businessId, accountId, pattern, options.limit, options.offset],
  );
  return {
    customers: rows.filter((row) => row.present).map((r) => ({
      customerId: r.customer_id ?? UNKNOWN_CUSTOMER_KEY,
      customerName: r.name,
      customerPhone: r.phone,
      balance: Number(r.balance),
    })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}

/** Every customer with a nonzero AR balance, largest first — the unbounded read the callers outside the A/R screen need. */
export async function listCustomerBalances(businessId: string): Promise<CustomerBalance[]> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return [];
  const { customers } = await customerBalanceRows(businessId, accountId, { q: null, limit: null, offset: 0 });
  return customers;
}

/**
 * What the whole subledger adds up to, as of now — the numbers the balances
 * screen shows above its rows so an accountant can see the report reconcile to
 * the control account instead of taking it on faith.
 *
 * Every figure comes from the same journal lines as the rows themselves (and
 * the same attribution SQL), not from a second calculation in React:
 *
 *  - `receivableTotal` — what customers owe (the positive balances);
 *  - `advanceTotal` — advances and overpayments the business holds (the
 *    negative balances, as a positive number);
 *  - `netTotal` — the two combined, signed the way an asset is;
 *  - `controlBalance` — the A/R control account's own balance, read straight
 *    from `journal_lines`;
 *  - `difference` — `netTotal − controlBalance`, and `reconciles` its being
 *    zero.
 *
 * The two are equal by construction — the subledger *is* a regrouping of the
 * control account's lines — which is exactly why they are both shown: a
 * difference that cannot happen is the cheapest possible early warning that
 * something has (a line posted to a different A/R account, a business whose
 * chart has two).
 */
export interface ArReconciliationSummary {
  receivableTotal: number;
  advanceTotal: number;
  netTotal: number;
  controlBalance: number;
  difference: number;
  reconciles: boolean;
  /** How many parties carry a non-zero balance — the count the rows add up to. */
  parties: number;
  /** The balance sitting in the explicit unknown bucket, if any. */
  unattributedBalance: number;
}

function toSummary(row: {
  receivable: string;
  advances: string;
  net: string;
  control: string;
  parties: number;
  unattributed: string;
}): ArReconciliationSummary {
  const netTotal = Number(row.net);
  const controlBalance = Number(row.control);
  return {
    receivableTotal: Number(row.receivable),
    advanceTotal: Number(row.advances),
    netTotal,
    controlBalance,
    difference: netTotal - controlBalance,
    reconciles: netTotal === controlBalance,
    parties: Number(row.parties),
    unattributedBalance: Number(row.unattributed),
  };
}

const EMPTY_AR_SUMMARY: ArReconciliationSummary = {
  receivableTotal: 0,
  advanceTotal: 0,
  netTotal: 0,
  controlBalance: 0,
  difference: 0,
  reconciles: true,
  parties: 0,
  unattributedBalance: 0,
};

/** The whole-subledger totals, in one round trip, over the same attribution as every row. */
export async function getArReconciliationSummary(businessId: string): Promise<ArReconciliationSummary> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return { ...EMPTY_AR_SUMMARY };
  const { rows } = await query<{
    receivable: string;
    advances: string;
    net: string;
    control: string;
    parties: number;
    unattributed: string;
  }>(
    `WITH grouped AS (
       SELECT ${AR_CUSTOMER_ID_SQL} AS customer_id,
              sum(jl.debit - jl.credit) AS balance
       ${AR_CUSTOMER_ATTRIBUTION_SQL}
        WHERE je.business_id = $1 AND jl.account_id = $2
        GROUP BY ${AR_CUSTOMER_ID_SQL}
     ),
     subledger AS (
       SELECT coalesce(sum(balance) FILTER (WHERE balance > 0), 0) AS receivable,
              coalesce(sum(-balance) FILTER (WHERE balance < 0), 0) AS advances,
              coalesce(sum(balance), 0) AS net,
              count(*) FILTER (WHERE balance <> 0)::int AS parties,
              coalesce(sum(balance) FILTER (WHERE customer_id IS NULL), 0) AS unattributed
         FROM grouped
     ),
     control AS (
       SELECT coalesce(sum(jl.debit - jl.credit), 0) AS balance
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2
     )
     SELECT s.receivable::text AS receivable, s.advances::text AS advances, s.net::text AS net,
            s.parties, s.unattributed::text AS unattributed, c.balance::text AS control
       FROM subledger s, control c`,
    [businessId, accountId],
  );
  return rows[0]
    ? toSummary(rows[0])
    : { ...EMPTY_AR_SUMMARY };
}

/** One page of the balances list, with the totals the page must not change. */
export interface CustomerBalancePage {
  nextOffset: number | null;
  customers: CustomerBalance[];
  /** Rows matching the search, before the window — «۲۵ از ۳۱۰». */
  total: number;
  /** Whole-subledger totals, deliberately *not* narrowed by the search: they reconcile to the control account and must do so whatever the table is filtered to. */
  summary: ArReconciliationSummary;
}

/**
 * The balances list as the screen asks for it: a search, a window, the total
 * behind the window, and the reconciliation summary.
 *
 * The summary is fetched beside the page rather than derived from the rows:
 * paginating or searching a table must never change what the business is owed.
 */
export async function listCustomerBalancePage(
  businessId: string,
  options: { q?: string | null; limit: number; offset: number },
): Promise<CustomerBalancePage> {
  validateSubledgerWindow(options.limit, options.offset);
  const accountId = await arAccountId(businessId);
  if (!accountId) return { customers: [], total: 0, nextOffset: null, summary: { ...EMPTY_AR_SUMMARY } };
  const [{ customers, total }, summary] = await Promise.all([
    customerBalanceRows(businessId, accountId, {
      q: options.q?.trim() || null,
      limit: options.limit,
      offset: options.offset,
    }),
    getArReconciliationSummary(businessId),
  ]);
  return { customers, total, summary, nextOffset: subledgerNextOffset(options.offset, customers.length, total) };
}

/**
 * The A/R balances of a *named* set of customers — the till's picker, which
 * knows the twenty rows it is showing and must not scan the whole subledger
 * to price them. Same attribution as every other A/R number (the shared SQL
 * above); an empty id list answers an empty map without touching the ledger.
 */
export async function arBalancesForCustomers(
  businessId: string,
  customerIds: readonly string[],
): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map();
  const accountId = await arAccountId(businessId);
  if (!accountId) return new Map();
  const { rows } = await query<{ customer_id: string; balance: string }>(
    `SELECT ${AR_CUSTOMER_ID_SQL} AS customer_id,
            sum(jl.debit - jl.credit)::text AS balance
     ${AR_CUSTOMER_ATTRIBUTION_SQL}
     WHERE je.business_id = $1 AND jl.account_id = $2
       AND ${AR_CUSTOMER_ID_SQL} = ANY($3::uuid[])
     GROUP BY ${AR_CUSTOMER_ID_SQL}`,
    [businessId, accountId, customerIds],
  );
  return new Map(rows.map((row) => [row.customer_id, Number(row.balance)]));
}

/**
 * The canonical "which customer does this A/R line belong to?" SQL.
 *
 * Exported as a fragment because there are two legitimate shapes for the same
 * question and neither can be expressed in terms of the other:
 *
 * - **One customer at a time** — `getCustomerArBalance`, for a customer file.
 * - **Every customer at once, as a CTE** — the segment engine, which joins A/R
 *   against tens of thousands of parties and cannot call a per-customer
 *   function without turning one query into an N+1 over the whole directory.
 *
 * What must not vary is the *attribution*, and that is the hard part: an A/R
 * line names a customer through the order, the receipt or the cheque that
 * caused it, and closed-order corrections arrive through `order_amendments`
 * pointing at the original order. Miss the amendment bridge and a corrected
 * invoice silently detaches from its customer. Since that logic lives here,
 * in the app that owns the ledger, a segment and a customer file cannot come
 * to different conclusions about the same debt.
 *
 * `$1` is the business id. The caller supplies the account filter.
 */
// Re-export the public contract for CRM and existing service consumers.
export { AR_CUSTOMER_ATTRIBUTION_SQL, AR_CUSTOMER_ID_SQL } from "./ar-attribution";

/**
 * A ready-made CTE body giving every customer's A/R balance in one pass.
 *
 * For callers that need the whole directory's balances inside a larger query —
 * the segment engine, principally. Same attribution as every other A/R number
 * in the system, because it is literally the same SQL.
 */
export function arBalanceByCustomerSql(accountCode: string): string {
  return `SELECT ${AR_CUSTOMER_ID_SQL} AS customer_id,
                 coalesce(sum(jl.debit - jl.credit), 0)::bigint AS ar_balance
          ${AR_CUSTOMER_ATTRIBUTION_SQL}
          JOIN accounts a ON a.id = jl.account_id
           WHERE je.business_id = $1
             AND a.business_id = $1
             AND a.code = '${accountCode}'
             AND ${AR_CUSTOMER_ID_SQL} IS NOT NULL
           GROUP BY ${AR_CUSTOMER_ID_SQL}`;
}

/**
 * The signed balance of one well-known account, as the trial balance computes
 * it.
 *
 * Exists so screens outside Accounting — the CRM overview's store-credit
 * figure, principally — can show a ledger number without writing their own
 * `journal_lines` aggregation. The sign convention (assets and expenses are
 * debit-positive, everything else credit-positive) is the one piece of this
 * that is easy to get backwards, and getting it backwards renders a liability
 * as a negative asset.
 *
 * Returns null when the account does not exist, which is different from zero:
 * a business that has never configured a chart of accounts has no answer, and
 * "۰ ریال اعتبار" is a claim it cannot support.
 */
export async function wellKnownAccountBalance(
  businessId: string,
  accountCode: string,
): Promise<number | null> {
  const { rows } = await query<{ type: string; debit: string; credit: string }>(
    `SELECT a.type::text,
            coalesce(sum(jl.debit), 0)::text AS debit,
            coalesce(sum(jl.credit), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
      WHERE a.business_id = $1 AND a.code = $2
      GROUP BY a.type`,
    [businessId, accountCode],
  );
  const row = rows[0];
  if (!row) return null;
  const debit = BigInt(row.debit);
  const credit = BigInt(row.credit);
  const signed = row.type === "asset" || row.type === "expense" ? debit - credit : credit - debit;
  return Number(signed);
}

export interface CustomerArBalance {
  /** Positive means the customer owes the business. */
  balance: number;
  /** False when the chart of accounts has no A/R account yet. */
  hasLedger: boolean;
}

/**
 * One customer's AR balance, computed directly instead of through
 * {@link listCustomerBalances}'s whole-book scan. `getCustomerFile` only
 * ever needed a single customer's figure out of that list — asking for it
 * directly means the customer-file screen no longer redoes a
 * business-history-sized aggregation (every AR journal line, every
 * customer) just to read one row back out of it.
 */
export async function getCustomerArBalance(businessId: string, customerId: string): Promise<CustomerArBalance> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return { balance: 0, hasLedger: false };

  const { rows } = await query<{ debit: string; credit: string }>(
    // Same attribution fragment the segment engine uses, so one customer's
    // file and a segment built on «بدهکار» can never disagree.
    `SELECT COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
     ${AR_CUSTOMER_ATTRIBUTION_SQL}
      WHERE je.business_id = $1 AND jl.account_id = $2 AND ${AR_CUSTOMER_ID_SQL} = $3`,
    [businessId, accountId, customerId],
  );
  return { balance: Number(rows[0]?.debit ?? 0) - Number(rows[0]?.credit ?? 0), hasLedger: true };
}

/**
 * Where a statement line came from, as the source record itself describes it.
 *
 * The description on a line is written for a person («سفارش #۱۲۳», «دریافت
 * وجه»); it is not an identifier, and a screen must never take an address back
 * out of it. These fields are the identifiers behind the line, so the statement
 * can offer a real link instead of a plausible one.
 */
export interface StatementSource {
  /** The journal entry's own `source_type` — 'order', 'order_amendment', 'ar_receipt', 'cheque', or null for a plain manual entry. */
  type: string | null;
  /** The source row's id (the order, the receipt, or the cheque). */
  id: string | null;
  /** A short label taken from the source record — «چک ۱۲۳۴۵ — بانک ملت» — never parsed out of the description. */
  label: string | null;
  /** The order behind the line, including the original order a closed-order amendment corrects. */
  orderId: string | null;
  orderNumber: number | string | null;
}

export interface ArStatementLine {
  /** The journal entry this line belongs to — what a drill-down opens. */
  entryId: string;
  date: string;
  type: "invoice" | "receipt" | "reversal" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: StatementSource;
}

interface ArStatementRow extends Record<string, unknown> {
  entry_id: string;
  entry_date: string;
  source_type: string | null;
  source_id: string | null;
  /** Set on reversal entries: what distinguishes a برگشت from the receipt it undoes. */
  reverses_entry_id: string | null;
  order_id: string | null;
  order_number: number | string | null;
  serial_number: string | null;
  bank_name: string | null;
  receipt_method: "cash" | "bank" | "clearing" | null;
  memo: string | null;
  debit: string;
  credit: string;
}

/** The label a receipt or cheque line wears — the counterparty's own document, in its own words. */
function statementSourceLabel(row: ArStatementRow): string | null {
  if (row.source_type === "ar_receipt") {
    if (row.receipt_method === "bank") return "دریافت بانکی";
    if (row.receipt_method === "clearing") return "دریافت در جریان وصول";
    return "دریافت نقدی";
  }
  if (row.source_type === "cheque" && row.serial_number) {
    return row.bank_name ? `چک ${row.serial_number} — ${row.bank_name}` : `چک ${row.serial_number}`;
  }
  return null;
}

/**
 * One customer's full activity against A/R, oldest first, with a running
 * balance. `customerId` may be UNKNOWN_CUSTOMER_KEY.
 *
 * The rows are attributed in SQL and only this customer's leave the database —
 * the pre-fix version pulled every A/R line the business had ever posted into
 * Node and filtered there. Named statements now start from the canonical
 * source relation filtered to this customer, using the journal source index;
 * the unknown bucket necessarily checks unmatched sources across the account.
 * Attribution is shared with balances, aging and CRM, never restated here.
 */
export async function getCustomerStatement(businessId: string, customerId: string): Promise<ArStatementLine[]> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return [];
  const isUnknown = customerId === UNKNOWN_CUSTOMER_KEY;
  // A non-uuid customer id cannot match an attributed line. Asking Postgres
  // anyway raises `invalid input syntax for type uuid` rather than returning
  // none — and the unknown bucket is not a uuid at all, so it is `IS NULL`.
  if (!isUnknown && !isUuid(customerId)) return [];

  const { rows } = await query<ArStatementRow>(
    // The same attribution fragment as every other A/R number; here it also
    // supplies the source joins the drill-down metadata is read from.
    `SELECT je.id AS entry_id, je.entry_date::text AS entry_date, je.source_type, je.source_id,
            je.reverses_entry_id::text AS reverses_entry_id,
            ar_source.order_id, ar_source.order_number,
            ar_source.serial_number, ar_source.bank_name,
            ar_source.receipt_method,
            je.memo, jl.debit::text AS debit, jl.credit::text AS credit
     ${isUnknown ? AR_CUSTOMER_ATTRIBUTION_SQL : arCustomerAttributionSql("$3::uuid")}
      WHERE je.business_id = $1 AND jl.account_id = $2
        AND ${isUnknown ? `${AR_CUSTOMER_ID_SQL} IS NULL` : `${AR_CUSTOMER_ID_SQL} = $3`}
      ORDER BY je.entry_date, je.posted_at, jl.id`,
    isUnknown ? [businessId, accountId] : [businessId, accountId, customerId],
  );

  let balance = 0;
  return rows.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance += debit - credit;
    // A closed-order amendment posts against the order it corrects, so its
    // reversal and re-posting belong on the customer's statement as that
    // order's own activity rather than as an unexplained "other". A receipt
    // reversal keeps the receipt's source identity (that is what preserves
    // attribution) and is told apart by its reverses_entry_id.
    const type: ArStatementLine["type"] =
      l.source_type === "order" || l.source_type === "order_amendment"
        ? "invoice"
        : l.source_type === "ar_receipt"
          ? l.reverses_entry_id
            ? "reversal"
            : "receipt"
          : "other";
    const description =
      type === "invoice" && l.order_number != null
        ? // The UI is Persian-first; a Latin «#1002» in the middle of an RTL
          // statement reads as a data glitch next to every Persian-digit
          // amount and date around it.
          `سفارش #${toPersianDigits(String(l.order_number))}`
        : (l.memo ?? (type === "receipt" ? "دریافت وجه" : type === "reversal" ? "برگشت دریافت" : "سند دستی"));
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
        label: statementSourceLabel(l),
        orderId: l.order_id,
        orderNumber: l.order_number,
      },
    };
  });
}

export interface AgingRow extends AgingSummary {
  customerId: string;
  customerName: string;
}

export interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: AgingSummary;
}

const EMPTY_AGING_SUMMARY: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };

/**
 * The aging report, aggregated in PostgreSQL as of a date.
 *
 * It used to load every A/R line the business had ever posted, drop the ones
 * after the as-of date in JS, and age each customer in memory. The arithmetic
 * is the same — open invoices oldest-first against the payments received, then
 * 30/60/90 buckets (aging.ts defines the boundaries, and the `CASE` below is
 * generated from them) — but the work now happens where the rows are: the
 * database returns *one row per customer*, not one per journal line, and it
 * never sends the report a line dated after the as-of date.
 *
 * `asOfDate` defaults to the *business's* today: `new Date().toISOString()`
 * is yesterday for the first three and a half hours of every Tehran day and
 * for the whole late shift of a café trading 18:00→03:00.
 *
 * Two shapes were changed after reading the plan on a 138k-line ledger, and
 * only because of what it showed. The per-customer payment total is a window
 * over the rows being scanned rather than a join back onto a per-party total:
 * as a join it planned as a nested loop with `NOT (… IS DISTINCT FROM …)` as
 * its filter, comparing every party against every line (2.7M comparisons at
 * 300 parties × 9,000 lines, and quadratic from there). And the parties are
 * keyed by a text attribution key, so the buckets join is a hash join on
 * equality instead of the same nested-loop filter, and the unattributed bucket
 * — whose id is NULL and therefore matches nothing — gets a key of its own.
 * Same numbers, same order, ~4× faster on that ledger.
 *
 * No index was added for this report: the plan already reaches the A/R lines
 * through `idx_journal_lines_account` (they are one business's, because the
 * account id is) and the entries through the join on their primary key.
 */
export async function getArAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  if (asOfDate !== undefined && !isValidIsoDate(asOfDate)) throw new ArError("invalid_date");
  const effectiveAsOf = asOfDate ?? (await businessToday(businessId));
  const accountId = await arAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { ...EMPTY_AGING_SUMMARY } };

  /*
   * `open_items` is the FIFO rule of `ageOpenItems` expressed as a window
   * function: a customer's payments pay off their invoices oldest-first, so
   * what is left of invoice *i* is `max(0, cum_i − paid) − max(0, cum_{i−1} −
   * paid)`. The ordering (`entry_date, posted_at, line_id`) is the order the
   * JS implementation received the lines in, made explicit so two lines dated
   * the same day can never be applied in a different order on two runs.
   */
  const { rows } = await query<{
    customer_id: string | null;
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
       -- no join can match (an empty string cannot collide with a uuid).
       SELECT coalesce(${AR_CUSTOMER_ID_SQL}::text, '') AS customer_key,
              ${AR_CUSTOMER_ID_SQL} AS customer_id,
              je.entry_date,
              je.posted_at,
              jl.id AS line_id,
              jl.debit AS debit,
              jl.credit AS credit,
              -- The customer's payments, carried as a window over the rows
              -- being scanned rather than joined back on a per-party total:
              -- the join version planned as a nested loop whose filter
              -- compared every party against every line (2.7M comparisons on
              -- a 300-customer book, and quadratic from there).
              sum(jl.credit) OVER (PARTITION BY coalesce(${AR_CUSTOMER_ID_SQL}::text, '')) AS paid
       ${AR_CUSTOMER_ATTRIBUTION_SQL}
        WHERE je.business_id = $1 AND jl.account_id = $2 AND je.entry_date <= $3::date
     ),
     totals AS (
       SELECT customer_key, customer_id, sum(debit) AS owed, sum(credit) AS paid
         FROM scoped GROUP BY customer_key, customer_id
     ),
     items AS (
       SELECT customer_key, entry_date, posted_at, line_id, paid,
              sum(debit) OVER (
                PARTITION BY customer_key ORDER BY entry_date, posted_at, line_id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS cumulative
         FROM scoped
        WHERE debit > 0
     ),
     open_items AS (
       -- What is left of each invoice once the payments are applied to the
       -- oldest first: max(0, cum_i - paid) - max(0, cum_{i-1} - paid).
       SELECT customer_key, bucket, outstanding
         FROM (
           SELECT customer_key,
                  ${agingBucketCaseSql("($3::date - entry_date)")} AS bucket,
                  greatest(0, cumulative - paid)
                    - coalesce(
                        greatest(0, lag(cumulative) OVER (
                          PARTITION BY customer_key ORDER BY entry_date, posted_at, line_id
                        ) - paid),
                        0
                      ) AS outstanding
             FROM items
         ) x
        WHERE outstanding > 0
     ),
     buckets AS (
       SELECT customer_key,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'current'), 0) AS current,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'd31_60'), 0) AS d31_60,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'd61_90'), 0) AS d61_90,
              coalesce(sum(outstanding) FILTER (WHERE bucket = 'over90'), 0) AS over90
         FROM open_items GROUP BY customer_key
     ),
     per_party AS (
       SELECT t.customer_key,
              t.customer_id,
              -- An advance or overpayment has no open invoice to age, so it is
              -- carried as a *negative* current amount, the way a running-balance
              -- subledger does: each row's «جمع» stays exactly the customer's net
              -- balance, and the report's «جمع کل» stays exactly the control account.
              coalesce(b.current, 0) - greatest(0, t.paid - t.owed) AS current,
              coalesce(b.d31_60, 0) AS d31_60,
              coalesce(b.d61_90, 0) AS d61_90,
              coalesce(b.over90, 0) AS over90
         FROM totals t
         LEFT JOIN buckets b ON b.customer_key = t.customer_key
     )
     SELECT p.customer_id,
            coalesce(c.name, '${UNATTRIBUTED_CUSTOMER_NAME}') AS name,
            p.current::text AS current,
            p.d31_60::text AS d31_60,
            p.d61_90::text AS d61_90,
            p.over90::text AS over90,
            (p.current + p.d31_60 + p.d61_90 + p.over90)::text AS total
       FROM per_party p
       LEFT JOIN parties c ON c.id = p.customer_id
      WHERE (p.current + p.d31_60 + p.d61_90 + p.over90) <> 0
      ORDER BY (p.current + p.d31_60 + p.d61_90 + p.over90) DESC, c.name NULLS LAST`,
    [businessId, accountId, effectiveAsOf],
  );

  const rowsOut: AgingRow[] = rows.map((r) => ({
    customerId: r.customer_id ?? UNKNOWN_CUSTOMER_KEY,
    customerName: r.name,
    current: Number(r.current),
    d31_60: Number(r.d31_60),
    d61_90: Number(r.d61_90),
    over90: Number(r.over90),
    total: Number(r.total),
  }));
  // One row per customer, so this is the report's own arithmetic — the same
  // sums the screen draws in its footer.
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

export interface ArReceipt {
  id: string;
  customerId: string;
  receiptDate: string;
  method: VoucherMethod;
  amount: number;
  memo: string | null;
  /**
   * The cash/bank/clearing account named on the voucher (migration 0212);
   * null = the method's default account took it.
   */
  cashAccountId: string | null;
  /** The bank's tracking number, when one was recorded. */
  bankReference: string | null;
  /** Client idempotency key. Required for every submission since migration 0216. */
  idempotencyKey: string | null;
  /** Stable per-business document number. */
  voucherNumber: number | null;
  reversedAt: string | null;
  reversalEntryId: string | null;
  /**
   * True when this call was a retry that returned the original row instead of
   * posting again. Not a column — set by `receivePayment` only — so the route
   * can answer 200 (replay) vs 201 (created).
   */
  duplicate?: boolean;
}

interface ReceiptDbRow {
  id: string;
  customer_id: string;
  receipt_date: string;
  method: VoucherMethod;
  amount: string;
  memo: string | null;
  cash_account_id: string | null;
  bank_reference: string | null;
  idempotency_key: string | null;
  voucher_number: string | null;
  reversed_at: string | null;
  reversal_entry_id: string | null;
}

function toReceipt(row: ReceiptDbRow, duplicate: boolean): ArReceipt {
  return {
    id: row.id,
    customerId: row.customer_id,
    receiptDate: row.receipt_date,
    method: row.method,
    amount: Number(row.amount),
    memo: row.memo,
    cashAccountId: row.cash_account_id,
    bankReference: row.bank_reference,
    idempotencyKey: row.idempotency_key,
    voucherNumber: row.voucher_number != null ? Number(row.voucher_number) : null,
    reversedAt: row.reversed_at,
    reversalEntryId: row.reversal_entry_id,
    duplicate,
  };
}

const RECEIPT_RETURNING = `id, customer_id, receipt_date::text AS receipt_date, method, amount::text AS amount, memo,
  cash_account_id, bank_reference, idempotency_key, voucher_number::text AS voucher_number,
  reversed_at::text AS reversed_at, reversal_entry_id::text AS reversal_entry_id`;

/**
 * The receipt the key already posted, locked for this transaction — or null
 * when the key is new. The row lock serializes two simultaneous submissions
 * of one key: the loser waits here (or on the insert's unique index below)
 * and then answers the winner's row instead of posting twice.
 */
async function findReceiptByIdempotencyKey(
  client: PoolClient,
  businessId: string,
  idempotencyKey: string,
): Promise<(ReceiptDbRow & { request_fingerprint: string | null }) | null> {
  const { rows } = await client.query<ReceiptDbRow & { request_fingerprint: string | null }>(
    `SELECT ${RECEIPT_RETURNING}, request_fingerprint
       FROM ar_receipts WHERE business_id = $1 AND idempotency_key = $2 FOR UPDATE`,
    [businessId, idempotencyKey],
  );
  return rows[0] ?? null;
}

/**
 * Next per-business receipt document number, concurrency-safe.
 * A single upsert increments the business's counter under its row lock, so two
 * simultaneous submissions cannot take the same number.
 */
async function nextReceiptVoucherNumber(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ last_ar_voucher_number: string }>(
    `INSERT INTO ar_ap_voucher_counters (business_id, last_ar_voucher_number, last_ap_voucher_number)
     VALUES ($1, 1, 0)
     ON CONFLICT (business_id) DO UPDATE
       SET last_ar_voucher_number = ar_ap_voucher_counters.last_ar_voucher_number + 1
     RETURNING last_ar_voucher_number::text AS last_ar_voucher_number`,
    [businessId],
  );
  return Number(rows[0].last_ar_voucher_number);
}

/**
 * Every receipt submission carries a client-generated key (migration 0216
 * made the column NOT NULL): a retry replays the original voucher instead of
 * posting a second one. The error code is the same one the A/P side answers
 * with, so clients handle one vocabulary for both registers.
 */
function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new ArError("idempotency_key_required");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) throw new ArError("idempotency_key_required");
  return trimmed;
}

/**
 * Optional free text off the wire (memo, back-date, account choice): absent
 * or blank means unset, but a wrong-typed value (a number, an object) is a
 * 400 — never a TypeError from `.trim()`. The routes check first, and this
 * is the fail-closed backstop for internal callers (AI apply, installment
 * settlement) that bypass them.
 */
function normalizeOptionalText(value: unknown, code: "invalid_memo" | "invalid_date" | "invalid_cash_account"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ArError(code);
  return value.trim() || null;
}

/**
 * The canonical receipt-request tuple, mirroring A/P's
 * `paymentRequestFingerprint` field for field. An ordered tuple keeps
 * normalization/versioning explicit and avoids key order dependence. Date
 * omission remains null so a retry after midnight still refers to the
 * original intended receipt date. Voucher account and bank reference are
 * also part of the operation: reusing a key with a changed destination must
 * be rejected rather than silently accepted as a retry.
 */
function receiptRequestFingerprint(params: {
  customerId: string;
  locationId: string | null;
  method: VoucherMethod;
  amount: number;
  receiptDate: string | null;
  memo: string | null;
  cashAccountId: string | null;
  bankReference: string | null;
}): string {
  const canonical = JSON.stringify([
    params.customerId,
    params.locationId,
    params.method,
    params.amount,
    params.receiptDate,
    params.memo,
    params.cashAccountId,
    params.bankReference,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * May this party receive a customer payment?
 *
 * The check is the same set of invariants the customer directory applies
 * (`listCustomerDirectory`), asked in the one transaction that is about to
 * write the receipt: the party belongs to this business, holds the Customer
 * role, is active, and has not been merged into another party.
 *
 * The weaker `WHERE id = $1 AND business_id = $2` that used to stand here was
 * written when `ar_receipts.customer_id` referenced a table that could only
 * hold customers. Migration 0137 renamed that table to `parties`, whose rows
 * are customers, suppliers *and* employees — so the foreign key can no longer
 * say what the id means, and only this check can. Without it a crafted request
 * could post a receipt against a supplier, a former employee, a deactivated
 * customer, or a duplicate that was merged away.
 */
async function assertReceivableCustomer(
  client: PoolClient,
  businessId: string,
  customerId: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM parties
      WHERE id = $1 AND business_id = $2
        AND roles @> ARRAY[$3]::text[]
        AND is_active
        AND merged_into_id IS NULL`,
    [customerId, businessId, PARTY_ROLE_STORAGE.Customer],
  );
  if (!rows[0]) throw new ArError("customer_not_found", 404);
}

/**
 * Records a customer paying down their AR balance: Debit cash/bank/clearing,
 * Credit Accounts Receivable, in the same transaction as the ar_receipts row
 * both reference (source_type='ar_receipt', source_id=receipt.id).
 *
 * Idempotent per business on `idempotencyKey`: a retry with the same key
 * returns the original receipt instead of posting a second one. A key reused
 * with changed intent is a 409 `idempotency_conflict`, never a silent second
 * money movement — the same contract `payBill` keeps.
 */
export async function receivePayment(params: {
  businessId: string;
  locationId: string | null;
  customerId: string;
  method: VoucherMethod;
  amount: number;
  receiptDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
  /** Client-generated key per logical voucher submission (retry-safe). Required since migration 0216. */
  idempotencyKey: string;
  /** Holoo imports create local receipts but must not push them back to Holoo. */
  skipHolooPush?: boolean;
  /** The cash/bank/clearing account the money went into; null = the method's default account. */
  cashAccountId?: string | null;
  /** The bank's tracking/reference number. */
  bankReference?: string | null;
}): Promise<ArReceipt> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ArError("invalid_amount");
  }

  // A non-uuid customer id cannot match a row, and asking Postgres anyway
  // raises a syntax error rather than returning none — see `isUuid`.
  if (!isUuid(params.customerId)) throw new ArError("customer_not_found", 404);
  // Same story for a date off the wire: reject it here, in the error
  // vocabulary the API answers with, rather than as Postgres's parse error.
  const requestedReceiptDate = normalizeOptionalText(params.receiptDate, "invalid_date");
  if (requestedReceiptDate && !isValidIsoDate(requestedReceiptDate)) throw new ArError("invalid_date");
  if (!isVoucherMethod(params.method)) throw new ArError("invalid_method");
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);
  const memo = normalizeOptionalText(params.memo, "invalid_memo");
  const requestedCashAccountId = normalizeOptionalText(params.cashAccountId, "invalid_cash_account");
  // Throws PayablesInputError («invalid_bank_reference»), which the route answers as a 400.
  const bankReference = normalizeBankReference(params.bankReference);
  const fingerprint = receiptRequestFingerprint({
    customerId: params.customerId,
    locationId: params.locationId,
    method: params.method,
    amount: params.amount,
    receiptDate: requestedReceiptDate,
    memo,
    cashAccountId: requestedCashAccountId,
    bankReference,
  });

  /*
   * «امروز» here is the business's own date, not the database server's.
   * `CURRENT_DATE` (what the insert used to fall back to) is the date in the
   * server's timezone — UTC in the Docker image — so a receipt taken during
   * the first 3½ hours of a Tehran day, or anywhere in a café's post-midnight
   * late shift, was filed under the wrong day: the aging report (which counts
   * in `businessToday`) aged it a day early, and a late-shift receipt could
   * land inside a fiscal period the business had already closed. The same
   * discipline `installments-service` documents: today is `businessToday`,
   * never a UTC date slice.
   */
  const receiptDate = requestedReceiptDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Fast retry path, including when the active branch/business date changed
    // after the first request committed. A key reused with changed intent is a
    // hard conflict, never a silent second money movement.
    const existing = await findReceiptByIdempotencyKey(client, params.businessId, idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new ArError("idempotency_conflict", 409);
      await client.query("COMMIT");
      return toReceipt(existing, true);
    }

    // Canonical customer validation lives in one helper: a receipt needs a
    // real, active, non-merged customer — not a supplier-only or
    // employee-only party that happens to live in the same business.
    // Multi-role parties qualify when Customer is one of the roles. The
    // picker already filters this way; the service is authoritative so a
    // crafted request cannot bypass it.
    await assertReceivableCustomer(client, params.businessId, params.customerId);

    const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsReceivable]);
    const arAccount = accounts.get(WELL_KNOWN_CODES.accountsReceivable)!;
    // Throws PayablesInputError (invalid_cash_account /
    // cash_account_method_mismatch), which the route answers as a 400.
    const cash = await resolveVoucherCashAccount(client, params.businessId, params.method, params.cashAccountId);
    const cashAccountId = cash.accountId;

    const voucherNumber = await nextReceiptVoucherNumber(client, params.businessId);

    const { rows } = await client.query<ReceiptDbRow>(
      `INSERT INTO ar_receipts (business_id, location_id, customer_id, receipt_date, method, amount, memo, created_by,
                               idempotency_key, request_fingerprint, cash_account_id, bank_reference, voucher_number)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${RECEIPT_RETURNING}`,
      [
        params.businessId,
        params.locationId,
        params.customerId,
        receiptDate,
        params.method,
        params.amount,
        memo,
        params.createdBy,
        idempotencyKey,
        fingerprint,
        cash.chosen ? cash.accountId : null,
        bankReference,
        voucherNumber,
      ],
    );

    // A concurrent request may have inserted the same key after our first
    // lookup. `DO NOTHING` absorbs the conflict without aborting this
    // transaction — catching the 23505 instead would leave the transaction
    // aborted and every further query failing with 25P02 — and the unique
    // index's wait means this re-read sees the single committed voucher and
    // applies the same fingerprint guard.
    if (!rows[0]) {
      const concurrent = await findReceiptByIdempotencyKey(client, params.businessId, idempotencyKey);
      if (!concurrent || concurrent.request_fingerprint !== fingerprint) {
        throw new ArError("idempotency_conflict", 409);
      }
      await client.query("COMMIT");
      return toReceipt(concurrent, true);
    }

    const receipt = rows[0];

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: receipt.receipt_date,
      memo: memo || "دریافت وجه از مشتری",
      sourceType: "ar_receipt",
      sourceId: receipt.id,
      createdBy: params.createdBy,
      postingKind: "ar_receipt",
      lines: [
        { accountId: cashAccountId, debit: params.amount, credit: 0 },
        { accountId: arAccount, debit: 0, credit: params.amount },
      ],
    });

    if (!params.skipHolooPush) {
      await enqueueHolooReceiptForArReceipt(client, params.businessId, receipt.id);
    }

    await client.query("COMMIT");
    return toReceipt(receipt, false);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ArReceiptDetail extends ArReceipt {
  customerName: string;
  customerPhone: string | null;
  locationId: string | null;
  locationName: string | null;
  createdByName: string | null;
  createdAt: string;
  /** The named cash/bank/clearing account; null = the method's default took it. */
  cashAccount: { code: string; name: string } | null;
  /** The live journal entry this voucher posted (null for legacy rows predating the posting). */
  entryId: string | null;
  reversalDate: string | null;
  reversedByName: string | null;
}

/** One receipt voucher with the audit metadata the register drill-down shows. */
export async function getReceiptDetail(businessId: string, receiptId: string): Promise<ArReceiptDetail | null> {
  if (!isUuid(receiptId)) return null;
  const { rows } = await query<{
    id: string;
    customer_id: string;
    customer_name: string;
    customer_phone: string | null;
    location_id: string | null;
    location_name: string | null;
    receipt_date: string;
    method: VoucherMethod;
    amount: string;
    memo: string | null;
    cash_account_id: string | null;
    bank_reference: string | null;
    cash_account_code: string | null;
    cash_account_name: string | null;
    posted_account_code: string | null;
    posted_account_name: string | null;
    idempotency_key: string | null;
    voucher_number: string | null;
    created_by_name: string | null;
    created_at: string;
    entry_id: string | null;
    reversed_at: string | null;
    reversed_by_name: string | null;
    reversal_entry_id: string | null;
    reversal_date: string | null;
  }>(
    `SELECT r.id, r.customer_id,
            COALESCE(p.name, 'بدون مشتری مشخص') AS customer_name, p.phone AS customer_phone,
            r.location_id, l.name AS location_name,
            r.receipt_date::text AS receipt_date, r.method, r.amount::text AS amount, r.memo,
            r.cash_account_id, r.bank_reference,
            ca.code AS cash_account_code, ca.name AS cash_account_name,
            ${VOUCHER_POSTED_ACCOUNT_SELECT},
            r.idempotency_key, r.voucher_number::text AS voucher_number,
            u.full_name AS created_by_name, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            je.id::text AS entry_id,
            r.reversed_at::text AS reversed_at, ru.full_name AS reversed_by_name,
            r.reversal_entry_id::text AS reversal_entry_id,
            rje.entry_date::text AS reversal_date
       FROM ar_receipts r
       LEFT JOIN parties p ON p.id = r.customer_id
       LEFT JOIN locations l ON l.id = r.location_id
       LEFT JOIN accounts ca ON ca.id = r.cash_account_id
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN users ru ON ru.id = r.reversed_by
       LEFT JOIN journal_entries je
         ON je.business_id = r.business_id AND je.source_type = 'ar_receipt'
        AND je.source_id = r.id AND je.posting_kind = 'ar_receipt'
       ${voucherPostedAccountJoin("receipt")}
       LEFT JOIN journal_entries rje ON rje.id = r.reversal_entry_id
      WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, receiptId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    locationId: row.location_id,
    locationName: row.location_name,
    receiptDate: row.receipt_date,
    method: row.method,
    amount: Number(row.amount),
    memo: row.memo,
    cashAccountId: row.cash_account_id,
    bankReference: row.bank_reference,
    cashAccount: resolveVoucherPostedAccount(
      row.cash_account_code ? { code: row.cash_account_code, name: row.cash_account_name ?? "" } : null,
      row.posted_account_code ? { code: row.posted_account_code, name: row.posted_account_name ?? "" } : null,
    ),
    idempotencyKey: row.idempotency_key,
    voucherNumber: row.voucher_number != null ? Number(row.voucher_number) : null,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    entryId: row.entry_id,
    reversedAt: row.reversed_at,
    reversedByName: row.reversed_by_name,
    reversalEntryId: row.reversal_entry_id,
    reversalDate: row.reversal_date,
  };
}

/**
 * Reverses a posted receipt — the only supported correction flow.
 *
 * Never edits or deletes: it posts the exact mirror of the original live
 * journal entry (same `source_type`/`source_id`, `ar_receipt_reversal` posting
 * kind) so the reversal stays attributed to the same customer in every A/R
 * statement, balance and aging report, and marks the source row reversed.
 * Dated on the reversal date (default: the business's today), never backdated
 * into a locked period — the fiscal-period trigger refuses a locked date the
 * same way it refuses a fresh posting.
 */
export async function reverseReceipt(params: {
  businessId: string;
  receiptId: string;
  actorId: string | null;
  /** ISO date; defaults to the business's today. */
  reversalDate?: string | null;
  memo?: string | null;
  /** Holoo imports must not push reversals they did not originate. */
  skipHolooPush?: boolean;
}): Promise<ArReceiptDetail> {
  if (!isUuid(params.receiptId)) throw new ArError("receipt_not_found", 404);
  if (params.reversalDate != null && !isValidIsoDate(params.reversalDate)) throw new ArError("invalid_date");
  const reversalDate = params.reversalDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: receiptRows } = await client.query<{
      id: string;
      location_id: string | null;
      memo: string | null;
      reversed_at: string | null;
    }>(
      `SELECT id, location_id, memo, reversed_at::text AS reversed_at
         FROM ar_receipts WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.receiptId, params.businessId],
    );
    const receipt = receiptRows[0];
    if (!receipt) throw new ArError("receipt_not_found", 404);
    if (receipt.reversed_at) throw new ArError("already_reversed", 409);

    // An installment slice settled through this receipt still shows paid; an
    // unwatched reversal would leave the plan and the ledger disagreeing.
    const { rows: linked } = await client.query<{ id: string }>(
      `SELECT id FROM installment_items WHERE receipt_id = $1 LIMIT 1`,
      [params.receiptId],
    );
    if (linked[0]) throw new ArError("receipt_linked_to_installment", 409);

    const { rows: entryRows } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'ar_receipt' AND source_id = $2
          AND posting_kind = 'ar_receipt' AND reversed_at IS NULL AND reverses_entry_id IS NULL`,
      [params.businessId, params.receiptId],
    );
    const original = entryRows[0];
    if (!original) throw new ArError("receipt_has_no_entry", 409);

    const reversalEntryId = await postExactMirrorEntry(client, {
      businessId: params.businessId,
      locationId: receipt.location_id,
      originalEntryId: original.id,
      sourceType: "ar_receipt",
      sourceId: params.receiptId,
      postingKind: "ar_receipt_reversal",
      memo: normalizeOptionalText(params.memo, "invalid_memo") || `برگشت دریافت${receipt.memo ? ` — ${receipt.memo}` : ""}`,
      entryDate: reversalDate,
      createdBy: params.actorId,
    });
    if (!reversalEntryId) throw new ArError("receipt_has_no_entry", 409);

    await client.query(
      `UPDATE ar_receipts SET reversed_at = now(), reversed_by = $2, reversal_entry_id = $3 WHERE id = $1`,
      [params.receiptId, params.actorId, reversalEntryId],
    );

    if (!params.skipHolooPush) {
      await enqueueHolooReversalForArReceipt(client, params.businessId, params.receiptId, reversalEntryId);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const detail = await getReceiptDetail(params.businessId, params.receiptId);
  if (!detail) throw new ArError("receipt_not_found", 404);
  return detail;
}
