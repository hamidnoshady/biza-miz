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
 *
 * Issue #829 hardening: mirrors `ar-service.ts` — idempotent creation,
 * the cash/bank/clearing account the money moved through, active-supplier
 * validation, and first-class source-level reversal with preserved A/P
 * attribution.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";
import { accountIdsByCode, MissingLedgerAccountError, postExactMirrorEntry, postJournalEntry } from "./ledger-service";
import { ageOpenItems, summarizeAging, unappliedCredit, UNKNOWN_SUPPLIER_KEY, type AgingSummary } from "./aging";
import {
  enqueueHolooReceiptForApPayment,
  enqueueHolooReversalForApPayment,
} from "./integrations/holoo/outbox-producer";
import { isVoucherMethod, normalizeBankReference, type VoucherMethod } from "./payables-input";
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
  reverses_entry_id: string | null;
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
            je.reverses_entry_id::text AS reverses_entry_id,
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
  type: "bill" | "payment" | "return" | "reversal" | "other";
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
    // A payment reversal keeps the payment's source identity (that is what
    // preserves attribution) and is told apart by its reverses_entry_id.
    const type: ApStatementLine["type"] =
      l.source_type === "purchase" || l.source_type === "expense"
        ? "bill"
        : l.source_type === "ap_payment"
          ? l.reverses_entry_id
            ? "reversal"
            : "payment"
          : l.source_type === "supplier_return"
            ? "return"
            : "other";
    const description =
      type === "bill"
        ? (l.note ?? (l.source_type === "expense" ? "هزینه" : "فاکتور خرید"))
        : type === "payment"
          ? (l.memo ?? "پرداخت به تأمین‌کننده")
          : type === "reversal"
            ? (l.memo ?? "برگشت پرداخت")
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
  if (asOfDate !== undefined && !isValidIsoDate(asOfDate)) throw new ApError("invalid_date");
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
  idempotencyKey: string | null;
  voucherNumber: number | null;
  reversedAt: string | null;
  reversalEntryId: string | null;
  /**
   * True when this call was a retry that returned the original row instead of
   * posting again. Not a column — set by `payBill` only — so the route can
   * answer 200 (replay) vs 201 (created).
   */
  duplicate?: boolean;
}

interface PaymentDbRow {
  id: string;
  supplier_id: string;
  payment_date: string;
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

function toPayment(row: PaymentDbRow): ApPayment {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    paymentDate: row.payment_date,
    method: row.method,
    amount: Number(row.amount),
    memo: row.memo,
    cashAccountId: row.cash_account_id,
    bankReference: row.bank_reference,
    idempotencyKey: row.idempotency_key,
    voucherNumber: row.voucher_number != null ? Number(row.voucher_number) : null,
    reversedAt: row.reversed_at,
    reversalEntryId: row.reversal_entry_id,
  };
}

const PAYMENT_RETURNING = `id, supplier_id, payment_date::text AS payment_date, method, amount::text AS amount, memo,
  cash_account_id, bank_reference, idempotency_key, voucher_number::text AS voucher_number,
  reversed_at::text AS reversed_at, reversal_entry_id::text AS reversal_entry_id`;

async function findPaymentByIdempotencyKey(
  client: PoolClient,
  businessId: string,
  idempotencyKey: string,
): Promise<ApPayment | null> {
  const { rows } = await client.query<PaymentDbRow>(
    `SELECT ${PAYMENT_RETURNING} FROM ap_payments WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, idempotencyKey],
  );
  return rows[0] ? toPayment(rows[0]) : null;
}

async function nextPaymentVoucherNumber(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ last_ap_voucher_number: string }>(
    `INSERT INTO ar_ap_voucher_counters (business_id, last_ar_voucher_number, last_ap_voucher_number)
     VALUES ($1, 0, 1)
     ON CONFLICT (business_id) DO UPDATE
       SET last_ap_voucher_number = ar_ap_voucher_counters.last_ap_voucher_number + 1
     RETURNING last_ap_voucher_number::text AS last_ap_voucher_number`,
    [businessId],
  );
  return Number(rows[0].last_ap_voucher_number);
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApError("invalid_idempotency_key");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) throw new ApError("invalid_idempotency_key");
  return trimmed;
}

/**
 * Records the business paying down a supplier's AP balance: Debit Accounts
 * Payable, Credit cash/bank/clearing, in the same transaction as the
 * ap_payments row both reference (source_type='ap_payment',
 * source_id=payment.id).
 *
 * Idempotent per business on `idempotencyKey`, mirroring `receivePayment`.
 */
export async function payBill(params: {
  businessId: string;
  locationId: string | null;
  supplierId: string;
  method: VoucherMethod;
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  createdBy: string | null;
  idempotencyKey?: string | null;
  /** Holoo imports create local payments but must not push them back to Holoo. */
  skipHolooPush?: boolean;
  /** The cash/bank/clearing account the money left from; null = the method's default account. */
  cashAccountId?: string | null;
  /** The bank's tracking/reference number. */
  bankReference?: string | null;
}): Promise<ApPayment> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new ApError("invalid_amount");
  }
  // A non-uuid supplier id cannot match a row, and asking Postgres anyway
  // raises a syntax error rather than returning none — see `isUuid`.
  if (!isUuid(params.supplierId)) throw new ApError("supplier_not_found", 404);
  if (params.paymentDate != null && !isValidIsoDate(params.paymentDate)) throw new ApError("invalid_date");
  if (!isVoucherMethod(params.method)) throw new ApError("invalid_method");
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);

  // The business's «امروز», not the DB server's UTC date — the same argument
  // `receivePayment` in ar-service.ts makes for receipts.
  const paymentDate = params.paymentDate ?? (await businessToday(params.businessId));
  // Throws PayablesInputError («invalid_bank_reference»), which the route answers as a 400.
  const bankReference = normalizeBankReference(params.bankReference);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (idempotencyKey) {
      const existing = await findPaymentByIdempotencyKey(client, params.businessId, idempotencyKey);
      if (existing) {
        await client.query("ROLLBACK");
        return { ...existing, duplicate: true };
      }
    }

    // suppliers has no business_id column — verify the match through its
    // (mandatory) location instead. The alias must also be active: the picker
    // only offers active suppliers, and a crafted request must not pay a
    // deactivated one. When the alias is linked to a party, that party must
    // still be a live, non-merged record — otherwise a stale alias bypasses
    // the merge/archive the directory already enforces.
    const { rows: supplierRows } = await client.query<{ id: string }>(
      `SELECT s.id FROM suppliers s
         JOIN locations l ON l.id = s.location_id
         LEFT JOIN parties pa ON pa.id = s.party_id
        WHERE s.id = $1 AND l.business_id = $2 AND s.is_active
          AND (s.party_id IS NULL OR (pa.is_active AND pa.merged_into_id IS NULL))`,
      [params.supplierId, params.businessId],
    );
    if (!supplierRows[0]) throw new ApError("supplier_not_found", 404);

    const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsPayable]);
    const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    // Throws PayablesInputError (invalid_cash_account /
    // cash_account_method_mismatch), which the route answers as a 400.
    const cash = await resolveVoucherCashAccount(client, params.businessId, params.method, params.cashAccountId);
    const cashAccountId = cash.accountId;

    const voucherNumber = await nextPaymentVoucherNumber(client, params.businessId);

    let payment: PaymentDbRow;
    try {
      const { rows } = await client.query<PaymentDbRow>(
        `INSERT INTO ap_payments (business_id, location_id, supplier_id, payment_date, method, amount, memo, created_by,
                                  idempotency_key, cash_account_id, bank_reference, voucher_number)
         VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${PAYMENT_RETURNING}`,
        [
          params.businessId,
          params.locationId,
          params.supplierId,
          paymentDate,
          params.method,
          params.amount,
          params.memo?.trim() || null,
          params.createdBy,
          idempotencyKey,
          cash.chosen ? cash.accountId : null,
          bankReference,
          voucherNumber,
        ],
      );
      payment = rows[0];
    } catch (err) {
      // Two simultaneous submissions with the same key both passed the fast
      // path above; the unique index admits exactly one. The loser answers
      // the winner's row rather than a 500.
      if (
        idempotencyKey &&
        (err as { code?: string; constraint?: string }).code === "23505" &&
        (err as { constraint?: string }).constraint === "uq_ap_payments_business_idempotency"
      ) {
        const existing = await findPaymentByIdempotencyKey(client, params.businessId, idempotencyKey);
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
      entryDate: payment.payment_date,
      memo: params.memo?.trim() || "پرداخت به تأمین‌کننده",
      sourceType: "ap_payment",
      sourceId: payment.id,
      createdBy: params.createdBy,
      postingKind: "ap_payment",
      lines: [
        { accountId: apAccount, debit: params.amount, credit: 0 },
        { accountId: cashAccountId, debit: 0, credit: params.amount },
      ],
    });

    if (!params.skipHolooPush) {
      await enqueueHolooReceiptForApPayment(client, params.businessId, payment.id);
    }

    await client.query("COMMIT");
    return toPayment(payment);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ApPaymentDetail extends ApPayment {
  supplierName: string;
  supplierPhone: string | null;
  supplierPartyId: string | null;
  locationId: string | null;
  locationName: string | null;
  createdByName: string | null;
  createdAt: string;
  /** The named cash/bank/clearing account; null = the method's default took it. */
  cashAccount: { code: string; name: string } | null;
  entryId: string | null;
  reversalDate: string | null;
  reversedByName: string | null;
}

/** One payment voucher with the audit metadata the register drill-down shows. */
export async function getPaymentDetail(businessId: string, paymentId: string): Promise<ApPaymentDetail | null> {
  if (!isUuid(paymentId)) return null;
  const { rows } = await query<{
    id: string;
    supplier_id: string;
    supplier_name: string;
    supplier_phone: string | null;
    supplier_party_id: string | null;
    location_id: string | null;
    location_name: string | null;
    payment_date: string;
    method: VoucherMethod;
    amount: string;
    memo: string | null;
    cash_account_id: string | null;
    bank_reference: string | null;
    cash_account_code: string | null;
    cash_account_name: string | null;
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
    `SELECT p.id, p.supplier_id,
            COALESCE(pa.name, s.name, 'بدون تأمین‌کننده مشخص') AS supplier_name,
            COALESCE(pa.phone, s.phone) AS supplier_phone,
            s.party_id AS supplier_party_id,
            p.location_id, l.name AS location_name,
            p.payment_date::text AS payment_date, p.method, p.amount::text AS amount, p.memo,
            p.cash_account_id, p.bank_reference,
            ca.code AS cash_account_code, ca.name AS cash_account_name,
            p.idempotency_key, p.voucher_number::text AS voucher_number,
            u.full_name AS created_by_name, p.created_at::text AS created_at,
            je.id::text AS entry_id,
            p.reversed_at::text AS reversed_at, ru.full_name AS reversed_by_name,
            p.reversal_entry_id::text AS reversal_entry_id,
            rje.entry_date::text AS reversal_date
       FROM ap_payments p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN parties pa ON pa.id = s.party_id
       LEFT JOIN locations l ON l.id = p.location_id
       LEFT JOIN accounts ca ON ca.id = p.cash_account_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users ru ON ru.id = p.reversed_by
       LEFT JOIN journal_entries je
         ON je.business_id = p.business_id AND je.source_type = 'ap_payment'
        AND je.source_id = p.id AND je.posting_kind = 'ap_payment'
       LEFT JOIN journal_entries rje ON rje.id = p.reversal_entry_id
      WHERE p.business_id = $1 AND p.id = $2`,
    [businessId, paymentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierPhone: row.supplier_phone,
    supplierPartyId: row.supplier_party_id,
    locationId: row.location_id,
    locationName: row.location_name,
    paymentDate: row.payment_date,
    method: row.method,
    amount: Number(row.amount),
    memo: row.memo,
    cashAccountId: row.cash_account_id,
    bankReference: row.bank_reference,
    cashAccount: row.cash_account_code
      ? { code: row.cash_account_code, name: row.cash_account_name ?? "" }
      : null,
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
 * Reverses a posted payment — the mirror of `reverseReceipt`.
 * Same guarantees: exact mirror under the same source identity (so the
 * supplier statement keeps the attribution), dated on an allowed date, source
 * row marked once, double reversal refused.
 */
export async function reversePayment(params: {
  businessId: string;
  paymentId: string;
  actorId: string | null;
  reversalDate?: string | null;
  memo?: string | null;
  skipHolooPush?: boolean;
}): Promise<ApPaymentDetail> {
  if (!isUuid(params.paymentId)) throw new ApError("payment_not_found", 404);
  if (params.reversalDate != null && !isValidIsoDate(params.reversalDate)) throw new ApError("invalid_date");
  const reversalDate = params.reversalDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: paymentRows } = await client.query<{
      id: string;
      location_id: string | null;
      memo: string | null;
      reversed_at: string | null;
    }>(
      `SELECT id, location_id, memo, reversed_at::text AS reversed_at
         FROM ap_payments WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.paymentId, params.businessId],
    );
    const payment = paymentRows[0];
    if (!payment) throw new ApError("payment_not_found", 404);
    if (payment.reversed_at) throw new ApError("already_reversed", 409);

    const { rows: linked } = await client.query<{ id: string }>(
      `SELECT id FROM installment_items WHERE payment_id = $1 LIMIT 1`,
      [params.paymentId],
    );
    if (linked[0]) throw new ApError("payment_linked_to_installment", 409);

    const { rows: entryRows } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'ap_payment' AND source_id = $2
          AND posting_kind = 'ap_payment' AND reversed_at IS NULL AND reverses_entry_id IS NULL`,
      [params.businessId, params.paymentId],
    );
    const original = entryRows[0];
    if (!original) throw new ApError("payment_has_no_entry", 409);

    const reversalEntryId = await postExactMirrorEntry(client, {
      businessId: params.businessId,
      locationId: payment.location_id,
      originalEntryId: original.id,
      sourceType: "ap_payment",
      sourceId: params.paymentId,
      postingKind: "ap_payment_reversal",
      memo: params.memo?.trim() || `برگشت پرداخت${payment.memo ? ` — ${payment.memo}` : ""}`,
      entryDate: reversalDate,
      createdBy: params.actorId,
    });
    if (!reversalEntryId) throw new ApError("payment_has_no_entry", 409);

    await client.query(
      `UPDATE ap_payments SET reversed_at = now(), reversed_by = $2, reversal_entry_id = $3 WHERE id = $1`,
      [params.paymentId, params.actorId, reversalEntryId],
    );

    if (!params.skipHolooPush) {
      await enqueueHolooReversalForApPayment(client, params.businessId, params.paymentId, reversalEntryId);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const detail = await getPaymentDetail(params.businessId, params.paymentId);
  if (!detail) throw new ApError("payment_not_found", 404);
  return detail;
}
