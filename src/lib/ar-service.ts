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
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * aging math (shared with the AP subledger) lives in aging.ts and is what
 * aging.test.ts covers. Covered here by integration/ar.integration.test.ts.
 */
import { getPool, query } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { PARTY_ROLE_STORAGE } from "./parties";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { ageOpenItems, summarizeAging, unappliedCredit, UNKNOWN_CUSTOMER_KEY, type AgingSummary } from "./aging";
import { toPersianDigits } from "./digits";
import { enqueueHolooReceiptForArReceipt } from "./integrations/holoo/outbox-producer";

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

/**
 * An actual calendar date in ISO form. The regex alone passes «2025-13-45»,
 * which `Date.parse` then reads as NaN — and every age bucket computed from a
 * NaN «today» falls through to «بیش از ۹۰ روز» without failing the request.
 * The rule is `iso-date.ts`'s `isValidIsoDate`, shared with A/P aging, bank
 * reconciliation, the manual journal and «دفتر روزنامه».
 */
const isIsoDateOnly = isValidIsoDate;

async function arAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsReceivable],
  );
  return rows[0]?.id ?? null;
}

interface ArLineRow extends Record<string, unknown> {
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  entry_date: string;
  source_type: string | null;
  order_number: string | number | null;
  memo: string | null;
  debit: string;
  credit: string;
}

/** Every journal line posted to the AR account, oldest first, with whatever customer it's attributable to. */
async function arLines(businessId: string, accountId: string): Promise<ArLineRow[]> {
  const { rows } = await query<ArLineRow>(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
            je.entry_date::text AS entry_date, je.source_type, o.order_number, je.memo,
            jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       LEFT JOIN order_amendments am ON je.source_type = 'order_amendment' AND am.id = je.source_id
       LEFT JOIN orders o ON o.id = CASE WHEN je.source_type = 'order' THEN je.source_id ELSE am.order_id END
       LEFT JOIN ar_receipts r ON je.source_type = 'ar_receipt' AND r.id = je.source_id
       LEFT JOIN cheques ch ON je.source_type = 'cheque' AND ch.id = je.source_id
       LEFT JOIN parties c ON c.id = COALESCE(o.customer_id, r.customer_id, ch.customer_id)
      WHERE je.business_id = $1 AND jl.account_id = $2
      ORDER BY je.entry_date, je.posted_at`,
    [businessId, accountId],
  );
  return rows;
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

/** Every customer with a nonzero AR balance, largest first. */
export async function listCustomerBalances(businessId: string): Promise<CustomerBalance[]> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return [];
  const lines = await arLines(businessId, accountId);

  const byCustomer = new Map<string, CustomerBalance>();
  for (const l of lines) {
    const key = l.customer_id ?? UNKNOWN_CUSTOMER_KEY;
    const entry = byCustomer.get(key) ?? {
      customerId: key,
      customerName: l.customer_name ?? "بدون مشتری مشخص",
      customerPhone: l.customer_phone,
      balance: 0,
    };
    entry.balance += Number(l.debit) - Number(l.credit);
    byCustomer.set(key, entry);
  }
  return [...byCustomer.values()].filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance);
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
export const AR_CUSTOMER_ATTRIBUTION_SQL = `
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  LEFT JOIN order_amendments am
         ON je.source_type = 'order_amendment' AND am.id = je.source_id
  LEFT JOIN orders o
         ON o.id = CASE WHEN je.source_type = 'order' THEN je.source_id ELSE am.order_id END
  LEFT JOIN ar_receipts r
         ON je.source_type = 'ar_receipt' AND r.id = je.source_id
  LEFT JOIN cheques ch
         ON je.source_type = 'cheque' AND ch.id = je.source_id`;

/** The customer-id expression that goes with {@link AR_CUSTOMER_ATTRIBUTION_SQL}. */
export const AR_CUSTOMER_ID_SQL = "COALESCE(o.customer_id, r.customer_id, ch.customer_id)";

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

export interface ArStatementLine {
  date: string;
  type: "invoice" | "receipt" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/** One customer's full activity against A/R, oldest first, with a running balance. `customerId` may be UNKNOWN_CUSTOMER_KEY. */
export async function getCustomerStatement(businessId: string, customerId: string): Promise<ArStatementLine[]> {
  const accountId = await arAccountId(businessId);
  if (!accountId) return [];
  const lines = await arLines(businessId, accountId);
  const filtered = lines.filter((l) => (l.customer_id ?? UNKNOWN_CUSTOMER_KEY) === customerId);

  let balance = 0;
  return filtered.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance += debit - credit;
    // A closed-order amendment posts against the order it corrects, so its
    // reversal and re-posting belong on the customer's statement as that
    // order's own activity rather than as an unexplained "other".
    const type =
      l.source_type === "order" || l.source_type === "order_amendment"
        ? "invoice"
        : l.source_type === "ar_receipt"
          ? "receipt"
          : "other";
    const description =
      type === "invoice" && l.order_number != null
        ? // The UI is Persian-first; a Latin «#1002» in the middle of an RTL
          // statement reads as a data glitch next to every Persian-digit
          // amount and date around it.
          `سفارش #${toPersianDigits(String(l.order_number))}`
        : (l.memo ?? (type === "receipt" ? "دریافت وجه" : "سند دستی"));
    return { date: l.entry_date, type, description, debit, credit, balance };
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

/**
 * Standard 30/60/90-day AR aging, per customer, as of `asOfDate` (defaults to
 * the *business's* today).
 *
 * `new Date().toISOString().slice(0, 10)` — what this used to default to — is
 * today in UTC, which is yesterday for the first three and a half hours of
 * every Tehran day and for the whole late shift of a café trading 18:00→03:00.
 * An invoice raised in those hours aged into the wrong bucket, and the
 * «۳۱-۶۰ روز» column moved a day early. `businessToday` answers the same
 * question the branch's own calendar does.
 */
export async function getArAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  if (asOfDate !== undefined && !isIsoDateOnly(asOfDate)) throw new ArError("invalid_date");
  const effectiveAsOf = asOfDate ?? (await businessToday(businessId));
  const accountId = await arAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } };

  const lines = (await arLines(businessId, accountId)).filter((l) => l.entry_date <= effectiveAsOf);

  const byCustomer = new Map<string, { name: string; invoices: { id: string; date: string; amount: number }[]; receipts: { id: string; date: string; amount: number }[] }>();
  lines.forEach((l, i) => {
    const key = l.customer_id ?? UNKNOWN_CUSTOMER_KEY;
    const entry = byCustomer.get(key) ?? { name: l.customer_name ?? "بدون مشتری مشخص", invoices: [], receipts: [] };
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    if (debit > 0) entry.invoices.push({ id: `${key}-${i}`, date: l.entry_date, amount: debit });
    if (credit > 0) entry.receipts.push({ id: `${key}-${i}`, date: l.entry_date, amount: credit });
    byCustomer.set(key, entry);
  });

  const rows: AgingRow[] = [];
  const totals: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const [customerId, { name, invoices, receipts }] of byCustomer) {
    const aged = ageOpenItems(invoices, receipts, effectiveAsOf);
    const summary = summarizeAging(aged);
    /*
     * An advance or overpayment has no open invoice to age, so `summarizeAging`
     * alone drops it — and then the column of the screen's own «مانده حساب‌ها»
     * tab (and the A/R control account) says one number while this report's
     * «جمع» says another. Carry the unapplied credit as a *negative* current
     * amount, the way a running-balance subledger does, so each row's «جمع»
     * is exactly the customer's net balance and the report's «جمع کل» is
     * exactly the control account.
     */
    const credit = unappliedCredit(invoices, receipts);
    summary.current -= credit;
    summary.total -= credit;
    if (summary.total === 0) continue;
    rows.push({ customerId, customerName: name, ...summary });
    totals.current += summary.current;
    totals.d31_60 += summary.d31_60;
    totals.d61_90 += summary.d61_90;
    totals.over90 += summary.over90;
    totals.total += summary.total;
  }
  rows.sort((a, b) => b.total - a.total);
  return { asOfDate: effectiveAsOf, rows, totals };
}

export interface ArReceipt {
  id: string;
  customerId: string;
  receiptDate: string;
  method: "cash" | "bank";
  amount: number;
  memo: string | null;
}

/**
 * Records a customer paying down their AR balance: Debit Cash/Bank-Clearing,
 * Credit Accounts Receivable, in the same transaction as the ar_receipts row
 * both reference (source_type='ar_receipt', source_id=receipt.id).
 */
export async function receivePayment(params: {
  businessId: string;
  locationId: string | null;
  customerId: string;
  method: "cash" | "bank";
  amount: number;
  receiptDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
  /** Holoo imports create local receipts but must not push them back to Holoo. */
  skipHolooPush?: boolean;
}): Promise<ArReceipt> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ArError("invalid_amount");
  }

  // A non-uuid customer id cannot match a row, and asking Postgres anyway
  // raises a syntax error rather than returning none — see `isUuid`.
  if (!isUuid(params.customerId)) throw new ArError("customer_not_found", 404);
  // Same story for a date off the wire: reject it here, in the error
  // vocabulary the API answers with, rather than as Postgres's parse error.
  if (params.receiptDate != null && !isIsoDateOnly(params.receiptDate)) throw new ArError("invalid_date");

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
  const receiptDate = params.receiptDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: customerRows } = await client.query<{ id: string }>(
      `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
      [params.customerId, params.businessId],
    );
    if (!customerRows[0]) throw new ArError("customer_not_found", 404);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.accountsReceivable,
      params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing,
    ]);
    const arAccount = accounts.get(WELL_KNOWN_CODES.accountsReceivable)!;
    const cashAccount = accounts.get(params.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bankClearing)!;

    const { rows } = await client.query<{
      id: string;
      customer_id: string;
      receipt_date: string;
      method: "cash" | "bank";
      amount: string;
      memo: string | null;
    }>(
      `INSERT INTO ar_receipts (business_id, location_id, customer_id, receipt_date, method, amount, memo, created_by)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8)
       RETURNING id, customer_id, receipt_date::text AS receipt_date, method, amount::text AS amount, memo`,
      [
        params.businessId,
        params.locationId,
        params.customerId,
        receiptDate,
        params.method,
        params.amount,
        params.memo?.trim() || null,
        params.createdBy,
      ],
    );
    const receipt = rows[0];

    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: receipt.receipt_date,
      memo: params.memo?.trim() || "دریافت وجه از مشتری",
      sourceType: "ar_receipt",
      sourceId: receipt.id,
      createdBy: params.createdBy,
      postingKind: "ar_receipt",
      lines: [
        { accountId: cashAccount, debit: params.amount, credit: 0 },
        { accountId: arAccount, debit: 0, credit: params.amount },
      ],
    });

    if (!params.skipHolooPush) {
      await enqueueHolooReceiptForArReceipt(client, params.businessId, receipt.id);
    }

    await client.query("COMMIT");
    return {
      id: receipt.id,
      customerId: receipt.customer_id,
      receiptDate: receipt.receipt_date,
      method: receipt.method,
      amount: Number(receipt.amount),
      memo: receipt.memo,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
