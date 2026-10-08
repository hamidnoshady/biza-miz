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
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * aging math (shared with AR) lives in aging.ts. Covered here by
 * integration/ap.integration.test.ts.
 */
import { getPool, query } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { ageOpenItems, summarizeAging, unappliedCredit, UNKNOWN_SUPPLIER_KEY, type AgingSummary } from "./aging";
import { enqueueHolooReceiptForApPayment } from "./integrations/holoo/outbox-producer";
import { normalizeBankReference } from "./payables-input";
import { resolveVoucherCashAccount } from "./voucher-cash-account";

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

/** An actual calendar date in ISO form — see `ar-service.ts` for why the regex alone is not enough. */
const isIsoDateOnly = isValidIsoDate;

async function apAccountId(businessId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, WELL_KNOWN_CODES.accountsPayable],
  );
  return rows[0]?.id ?? null;
}

interface ApLineRow extends Record<string, unknown> {
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_phone: string | null;
  party_id: string | null;
  entry_date: string;
  source_type: string | null;
  note: string | null;
  memo: string | null;
  debit: string;
  credit: string;
}

/**
 * Every journal line posted to the AP account, oldest first, with whatever
 * supplier it's attributable to.
 *
 * The name and phone come from the *party* when the branch alias is linked to
 * one, falling back to the alias's own copy — the same single COALESCE
 * `getInventoryOverview` uses, and what the one-party rule requires: `suppliers`
 * keeps a copy of the name only so an unlinked legacy row still displays, and
 * reading it in preference to the party's meant renaming a counterparty in
 * «طرف‌حساب‌ها» left A/P showing the old name for ever.
 */
async function apLines(businessId: string, accountId: string): Promise<ApLineRow[]> {
  const { rows } = await query<ApLineRow>(
    `SELECT s.id AS supplier_id,
            COALESCE(pa.name, s.name) AS supplier_name,
            COALESCE(pa.phone, s.phone) AS supplier_phone,
            s.party_id AS party_id,
            je.entry_date::text AS entry_date, je.source_type,
            COALESCE(p.note, p2.note, ex.memo) AS note, je.memo,
            jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       LEFT JOIN purchases p ON je.source_type = 'purchase' AND p.id = je.source_id
       LEFT JOIN supplier_returns sr ON je.source_type = 'supplier_return' AND sr.id = je.source_id
       LEFT JOIN purchases p2 ON sr.purchase_id = p2.id
       LEFT JOIN ap_payments ap ON je.source_type = 'ap_payment' AND ap.id = je.source_id
       LEFT JOIN cheques ch ON je.source_type = 'cheque' AND ch.id = je.source_id
       -- Audit F11: an expense recorded «پرداخت بعدی» credits A/P for the
       -- supplier it names, so it is that supplier's bill like a purchase.
       LEFT JOIN expenses ex ON je.source_type = 'expense' AND ex.id = je.source_id
       -- An endorsed received cheque has no supplier_id on its original row:
       -- the supplier is the one recorded by the endorsement event. Reuse it
       -- for a later bounce too, so that debit and reversing credit stay in
       -- the same supplier statement.
       LEFT JOIN LATERAL (
         SELECT endorsed_to_supplier_id
           FROM cheque_events
          WHERE cheque_id = ch.id AND endorsed_to_supplier_id IS NOT NULL
          ORDER BY created_at, id
          LIMIT 1
       ) endorsed ON ch.id IS NOT NULL
       LEFT JOIN suppliers s ON s.id = COALESCE(
         p.supplier_id,
         p2.supplier_id,
         ap.supplier_id,
         ex.supplier_id,
         ch.supplier_id,
         endorsed.endorsed_to_supplier_id
       )
       LEFT JOIN parties pa ON pa.id = s.party_id
      WHERE je.business_id = $1 AND jl.account_id = $2
      ORDER BY je.entry_date, je.posted_at`,
    [businessId, accountId],
  );
  return rows;
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

/** Every supplier with a nonzero AP balance, largest first. */
export async function listSupplierBalances(businessId: string): Promise<SupplierBalance[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const lines = await apLines(businessId, accountId);

  const bySupplier = new Map<string, SupplierBalance>();
  for (const l of lines) {
    const key = l.supplier_id ?? UNKNOWN_SUPPLIER_KEY;
    const entry = bySupplier.get(key) ?? {
      supplierId: key,
      supplierName: l.supplier_name ?? "بدون تأمین‌کننده مشخص",
      supplierPhone: l.supplier_phone,
      supplierPartyId: l.party_id,
      balance: 0,
    };
    // Liability normal balance: credit-debit.
    entry.balance += Number(l.credit) - Number(l.debit);
    bySupplier.set(key, entry);
  }
  return [...bySupplier.values()].filter((s) => s.balance !== 0).sort((a, b) => b.balance - a.balance);
}

export interface ApStatementLine {
  date: string;
  type: "bill" | "payment" | "return" | "other";
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/** One supplier's full activity against A/P, oldest first, with a running balance. `supplierId` may be UNKNOWN_SUPPLIER_KEY. */
export async function getSupplierStatement(businessId: string, supplierId: string): Promise<ApStatementLine[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];
  const lines = await apLines(businessId, accountId);
  const filtered = lines.filter((l) => (l.supplier_id ?? UNKNOWN_SUPPLIER_KEY) === supplierId);

  let balance = 0;
  return filtered.map((l) => {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    balance += credit - debit;
    const type: ApStatementLine["type"] =
      l.source_type === "purchase" || l.source_type === "expense" ? "bill" : l.source_type === "ap_payment" ? "payment" : l.source_type === "supplier_return" ? "return" : "other";
    const description =
      type === "bill"
        ? (l.note ?? (l.source_type === "expense" ? "هزینه" : "فاکتور خرید"))
        : type === "payment"
          ? (l.memo ?? "پرداخت به تأمین‌کننده")
          : type === "return"
            ? "برگشت به تأمین‌کننده"
            : (l.memo ?? "سند دستی");
    return { date: l.entry_date, type, description, debit, credit, balance };
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

/**
 * Standard 30/60/90-day AP aging, per supplier, as of `asOfDate` (defaults to
 * the *business's* today — see `getArAging` for why a UTC date slice put the
 * late shift's documents in the wrong bucket).
 */
export async function getApAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  if (asOfDate !== undefined && !isIsoDateOnly(asOfDate)) throw new ApError("invalid_date");
  const effectiveAsOf = asOfDate ?? (await businessToday(businessId));
  const accountId = await apAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } };

  const lines = (await apLines(businessId, accountId)).filter((l) => l.entry_date <= effectiveAsOf);

  const bySupplier = new Map<string, { name: string; bills: { id: string; date: string; amount: number }[]; payments: { id: string; date: string; amount: number }[] }>();
  lines.forEach((l, i) => {
    const key = l.supplier_id ?? UNKNOWN_SUPPLIER_KEY;
    const entry = bySupplier.get(key) ?? { name: l.supplier_name ?? "بدون تأمین‌کننده مشخص", bills: [], payments: [] };
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    // Liability: a credit raises the bill, a debit (payment or return) pays it down.
    if (credit > 0) entry.bills.push({ id: `${key}-${i}`, date: l.entry_date, amount: credit });
    if (debit > 0) entry.payments.push({ id: `${key}-${i}`, date: l.entry_date, amount: debit });
    bySupplier.set(key, entry);
  });

  const rows: AgingRow[] = [];
  const totals: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const [supplierId, { name, bills, payments }] of bySupplier) {
    const aged = ageOpenItems(bills, payments, effectiveAsOf);
    const summary = summarizeAging(aged);
    // Advance payments to a supplier have no open bill to age; carry them as
    // negative «current» so the report still agrees with the control account
    // (the mirror of the same rule in `getArAging`).
    const credit = unappliedCredit(bills, payments);
    summary.current -= credit;
    summary.total -= credit;
    if (summary.total === 0) continue;
    rows.push({ supplierId, supplierName: name, ...summary });
    totals.current += summary.current;
    totals.d31_60 += summary.d31_60;
    totals.d61_90 += summary.d61_90;
    totals.over90 += summary.over90;
    totals.total += summary.total;
  }
  rows.sort((a, b) => b.total - a.total);
  return { asOfDate: effectiveAsOf, rows, totals };
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
  /** Audit F11 — the cash/bank account the money left from; null = the method's default account. */
  cashAccountId?: string | null;
  /** Audit F11 — the bank's tracking/reference number. */
  bankReference?: string | null;
}): Promise<ApPayment> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ApError("invalid_amount");
  }
  // A non-uuid supplier id cannot match a row, and asking Postgres anyway
  // raises a syntax error rather than returning none — see `isUuid`.
  if (!isUuid(params.supplierId)) throw new ApError("supplier_not_found", 404);
  if (params.paymentDate != null && !isIsoDateOnly(params.paymentDate)) throw new ApError("invalid_date");

  // The business's «امروز», not the DB server's UTC date — the same argument
  // `receivePayment` in ar-service.ts makes for receipts.
  const paymentDate = params.paymentDate ?? (await businessToday(params.businessId));
  // Throws PayablesInputError («invalid_bank_reference»), which the route answers as a 400.
  const bankReference = normalizeBankReference(params.bankReference);

  const client = await getPool().connect();
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

    const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsPayable]);
    const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    const cash = await resolveVoucherCashAccount(client, params.businessId, params.method, params.cashAccountId);
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
      `INSERT INTO ap_payments (business_id, location_id, supplier_id, payment_date, method, amount, memo, created_by, cash_account_id, bank_reference)
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8, $9, $10)
       RETURNING id, supplier_id, payment_date::text AS payment_date, method, amount::text AS amount, memo, cash_account_id, bank_reference`,
      [
        params.businessId,
        params.locationId,
        params.supplierId,
        paymentDate,
        params.method,
        params.amount,
        params.memo?.trim() || null,
        params.createdBy,
        cash.chosen ? cash.accountId : null,
        bankReference,
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
      cashAccountId: payment.cash_account_id,
      bankReference: payment.bank_reference,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
