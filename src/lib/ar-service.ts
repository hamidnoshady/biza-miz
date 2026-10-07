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
 *
 * Issue #829 hardening: idempotent creation (per-business idempotency key),
 * explicit settlement accounts (cash → 1100, bank → 1110, clearing → 1120),
 * canonical customer validation, and first-class source-level reversal that
 * keeps A/R party attribution (same source_type/source_id, `*_reversal`
 * posting kind).
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { PARTY_ROLE_STORAGE } from "./parties";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postExactMirrorEntry, postJournalEntry } from "./ledger-service";
import { ageOpenItems, summarizeAging, unappliedCredit, UNKNOWN_CUSTOMER_KEY, type AgingSummary } from "./aging";
import { toPersianDigits } from "./digits";
import { isValidIsoDate } from "./iso-date";
import { isSettlementMethod, type SettlementMethod } from "./voucher-shared";
import { resolveSettlementAccount, SettlementAccountError } from "./settlement-accounts";
import {
  enqueueHolooReceiptForArReceipt,
  enqueueHolooReversalForArReceipt,
} from "./integrations/holoo/outbox-producer";

export { MissingLedgerAccountError };
export type { SettlementMethod };

/** Group key for AR lines that carry no customer attribution. Defined in the pure `aging` module so client components can import it without pulling in `pg`; re-exported here because this is where callers expect to find it. */
export { UNKNOWN_CUSTOMER_KEY };

export class ArError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

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
  /** Set on reversal entries: what distinguishes a برگشت from the receipt it undoes. */
  reverses_entry_id: string | null;
  order_number: string | number | null;
  memo: string | null;
  debit: string;
  credit: string;
}

/** Every journal line posted to the AR account, oldest first, with whatever customer it's attributable to. */
async function arLines(businessId: string, accountId: string): Promise<ArLineRow[]> {
  const { rows } = await query<ArLineRow>(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
            je.entry_date::text AS entry_date, je.source_type, je.reverses_entry_id::text AS reverses_entry_id,
            o.order_number, je.memo,
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
  type: "invoice" | "receipt" | "reversal" | "other";
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
  if (asOfDate !== undefined && !isValidIsoDate(asOfDate)) throw new ArError("invalid_date");
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
  method: SettlementMethod;
  amount: number;
  memo: string | null;
  /** The explicit settlement account the voucher posted against (migration 0211). */
  settlementAccountId: string | null;
  /** Client idempotency key, when the submission carried one. */
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
  method: SettlementMethod;
  amount: string;
  memo: string | null;
  settlement_account_id: string | null;
  idempotency_key: string | null;
  voucher_number: string | null;
  reversed_at: string | null;
  reversal_entry_id: string | null;
}

function toReceipt(row: ReceiptDbRow): ArReceipt {
  return {
    id: row.id,
    customerId: row.customer_id,
    receiptDate: row.receipt_date,
    method: row.method,
    amount: Number(row.amount),
    memo: row.memo,
    settlementAccountId: row.settlement_account_id,
    idempotencyKey: row.idempotency_key,
    voucherNumber: row.voucher_number != null ? Number(row.voucher_number) : null,
    reversedAt: row.reversed_at,
    reversalEntryId: row.reversal_entry_id,
  };
}

const RECEIPT_RETURNING = `id, customer_id, receipt_date::text AS receipt_date, method, amount::text AS amount, memo,
  settlement_account_id, idempotency_key, voucher_number::text AS voucher_number,
  reversed_at::text AS reversed_at, reversal_entry_id::text AS reversal_entry_id`;

async function findReceiptByIdempotencyKey(
  client: PoolClient,
  businessId: string,
  idempotencyKey: string,
): Promise<ArReceipt | null> {
  const { rows } = await client.query<ReceiptDbRow>(
    `SELECT ${RECEIPT_RETURNING} FROM ar_receipts WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, idempotencyKey],
  );
  return rows[0] ? toReceipt(rows[0]) : null;
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

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ArError("invalid_idempotency_key");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) throw new ArError("invalid_idempotency_key");
  return trimmed;
}

/**
 * Records a customer paying down their AR balance: Debit settlement account
 * (cash/bank/clearing), Credit Accounts Receivable, in the same transaction as
 * the ar_receipts row both reference (source_type='ar_receipt',
 * source_id=receipt.id).
 *
 * Idempotent per business on `idempotencyKey`: a retry with the same key
 * returns the original receipt instead of posting a second one.
 */
export async function receivePayment(params: {
  businessId: string;
  locationId: string | null;
  customerId: string;
  method: SettlementMethod;
  amount: number;
  receiptDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
  /** Explicit settlement account; when omitted the method's well-known account is used. */
  settlementAccountId?: string | null;
  /** Client-generated key per logical voucher submission (retry-safe). */
  idempotencyKey?: string | null;
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
  if (params.receiptDate != null && !isValidIsoDate(params.receiptDate)) throw new ArError("invalid_date");
  if (!isSettlementMethod(params.method)) throw new ArError("invalid_method");
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);

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

    // Fast path for a client retry after a timeout: the original row is the answer.
    if (idempotencyKey) {
      const existing = await findReceiptByIdempotencyKey(client, params.businessId, idempotencyKey);
      if (existing) {
        await client.query("ROLLBACK");
        return { ...existing, duplicate: true };
      }
    }

    // Canonical customer validation: a receipt needs a real, active,
    // non-merged customer — not a supplier-only or employee-only party that
    // happens to live in the same business. Multi-role parties qualify when
    // Customer is one of the roles. The picker already filters this way; the
    // service is authoritative so a crafted request cannot bypass it.
    const { rows: customerRows } = await client.query<{ id: string }>(
      `SELECT id FROM parties
        WHERE id = $1 AND business_id = $2
          AND roles @> ARRAY[$3]::text[] AND is_active AND merged_into_id IS NULL`,
      [params.customerId, params.businessId, PARTY_ROLE_STORAGE.Customer],
    );
    if (!customerRows[0]) throw new ArError("customer_not_found", 404);

    let settlementAccountId: string;
    let arAccount: string;
    try {
      const settlement = await resolveSettlementAccount(client, params.businessId, params.method, params.settlementAccountId);
      settlementAccountId = settlement.id;
      const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsReceivable]);
      arAccount = accounts.get(WELL_KNOWN_CODES.accountsReceivable)!;
    } catch (err) {
      if (err instanceof SettlementAccountError) throw new ArError(err.message, err.status);
      throw err;
    }

    const voucherNumber = await nextReceiptVoucherNumber(client, params.businessId);

    let receipt: ReceiptDbRow;
    try {
      const { rows } = await client.query<ReceiptDbRow>(
        `INSERT INTO ar_receipts (business_id, location_id, customer_id, receipt_date, method, amount, memo, created_by,
                                 idempotency_key, settlement_account_id, voucher_number)
         VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${RECEIPT_RETURNING}`,
        [
          params.businessId,
          params.locationId,
          params.customerId,
          receiptDate,
          params.method,
          params.amount,
          params.memo?.trim() || null,
          params.createdBy,
          idempotencyKey,
          settlementAccountId,
          voucherNumber,
        ],
      );
      receipt = rows[0];
    } catch (err) {
      // Two simultaneous submissions with the same key both passed the fast
      // path above; the unique index admits exactly one. The loser answers
      // the winner's row rather than a 500.
      if (
        idempotencyKey &&
        (err as { code?: string; constraint?: string }).code === "23505" &&
        (err as { constraint?: string }).constraint === "uq_ar_receipts_business_idempotency"
      ) {
        const existing = await findReceiptByIdempotencyKey(client, params.businessId, idempotencyKey);
        if (existing) {
          await client.query("ROLLBACK");
          return { ...existing, duplicate: true };
        }
      }
      throw err;
    }

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
        { accountId: settlementAccountId, debit: params.amount, credit: 0 },
        { accountId: arAccount, debit: 0, credit: params.amount },
      ],
    });

    if (!params.skipHolooPush) {
      await enqueueHolooReceiptForArReceipt(client, params.businessId, receipt.id);
    }

    await client.query("COMMIT");
    return toReceipt(receipt);
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
  settlementAccountCode: string | null;
  settlementAccountName: string | null;
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
    method: SettlementMethod;
    amount: string;
    memo: string | null;
    settlement_account_id: string | null;
    settlement_account_code: string | null;
    settlement_account_name: string | null;
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
            r.settlement_account_id, a.code AS settlement_account_code, a.name AS settlement_account_name,
            r.idempotency_key, r.voucher_number::text AS voucher_number,
            u.full_name AS created_by_name, r.created_at::text AS created_at,
            je.id::text AS entry_id,
            r.reversed_at::text AS reversed_at, ru.full_name AS reversed_by_name,
            r.reversal_entry_id::text AS reversal_entry_id,
            rje.entry_date::text AS reversal_date
       FROM ar_receipts r
       LEFT JOIN parties p ON p.id = r.customer_id
       LEFT JOIN locations l ON l.id = r.location_id
       LEFT JOIN accounts a ON a.id = r.settlement_account_id
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN users ru ON ru.id = r.reversed_by
       LEFT JOIN journal_entries je
         ON je.business_id = r.business_id AND je.source_type = 'ar_receipt'
        AND je.source_id = r.id AND je.posting_kind = 'ar_receipt'
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
    settlementAccountId: row.settlement_account_id,
    settlementAccountCode: row.settlement_account_code,
    settlementAccountName: row.settlement_account_name,
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
      memo: params.memo?.trim() || `برگشت دریافت${receipt.memo ? ` — ${receipt.memo}` : ""}`,
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
