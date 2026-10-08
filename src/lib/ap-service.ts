/**
 * Accounts Payable subledger and supplier-payment workflows.
 *
 * The subledger is reconstructed from journal lines on the control account;
 * no mutable/shadow balance is stored. Liability balances are credit minus
 * debit. All reads share the canonical source attribution in ap-attribution.ts
 * and keep the unattributed bucket visible so the total reconciles to GL 2100.
 *
 * Issue #829 layers the voucher-register hardening on top: the money
 * moves through an explicit cash/bank/clearing account, every voucher takes
 * a per-business sequential number, and reversals additionally mark the
 * source row so the register reads correction state without a journal join.
 */
import { getPool, query } from "./db";
import { businessToday } from "./business-day-service";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { ageOpenItems, summarizeAging, unappliedCredit, UNKNOWN_SUPPLIER_KEY, type AgingSummary } from "./aging";
import { AP_SOURCE_ATTRIBUTION_CONTRACT, AP_SUPPLIER_ATTRIBUTION_SQL, AP_SUPPLIER_ID_SQL, apAttributionStatus } from "./ap-attribution";
import {
  enqueueHolooReceiptForApPayment,
  enqueueHolooReversalForApPayment,
} from "./integrations/holoo/outbox-producer";
import { isVoucherMethod, normalizeBankReference, PayablesInputError, type VoucherMethod } from "./payables-input";
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

interface ApLineFilters {
  businessId: string;
  accountId: string;
  supplierId?: string;
  asOfDate?: string;
}

/**
 * Line-level A/P activity for statement/aging calculations. Unlike the old
 * whole-history helper, this pushes both supplier selection and the as-of date
 * into PostgreSQL before any rows reach Node.
 */
async function queryApLines(filters: ApLineFilters): Promise<ApLineRow[]> {
  const values: unknown[] = [filters.businessId, filters.accountId];
  const predicates = ["je.business_id = $1", "jl.account_id = $2"];
  if (filters.asOfDate) {
    values.push(filters.asOfDate);
    predicates.push(`je.entry_date <= $${values.length}::date`);
  }
  if (filters.supplierId !== undefined) {
    values.push(filters.supplierId);
    const supplierParameter = `$${values.length}::text`;
    predicates.push(
      `CASE WHEN ${supplierParameter} = '${UNKNOWN_SUPPLIER_KEY}'
            THEN ${AP_SUPPLIER_ID_SQL} IS NULL
            ELSE ${AP_SUPPLIER_ID_SQL}::text = ${supplierParameter}
       END`,
    );
  }

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
            COALESCE(p.note, p2.note, ip.note, ipr.note, exp.memo) AS note,
            COALESCE(sr.reason, isr.reason) AS return_reason,
            je.memo,
            jl.debit::text AS debit,
            jl.credit::text AS credit,
            COALESCE(p.id, p2.id)::text AS purchase_id,
            COALESCE(ip.id, ipr.id)::text AS item_purchase_id,
            sr.id::text AS supplier_return_id,
            isr.id::text AS item_supplier_return_id,
            ap.id::text AS payment_id,
            ch.id::text AS cheque_id,
            ins.id::text AS installment_plan_id
       ${AP_SUPPLIER_ATTRIBUTION_SQL}
      WHERE ${predicates.join(" AND ")}
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

/** Supplier balances aggregated in PostgreSQL; no journal history is copied into application memory. */
export async function listSupplierBalances(businessId: string): Promise<SupplierBalance[]> {
  const accountId = await apAccountId(businessId);
  if (!accountId) return [];

  const { rows } = await query<{
    supplier_id: string | null;
    supplier_name: string | null;
    supplier_phone: string | null;
    party_id: string | null;
    location_id: string | null;
    location_name: string | null;
    balance: string;
  }>(
    `SELECT ${AP_SUPPLIER_ID_SQL} AS supplier_id,
            COALESCE(pa.name, s.name, 'بدون تأمین‌کننده مشخص') AS supplier_name,
            COALESCE(pa.phone, s.phone) AS supplier_phone,
            s.party_id AS party_id,
            supplier_location.id AS location_id,
            supplier_location.name AS location_name,
            SUM(jl.credit - jl.debit)::text AS balance
       ${AP_SUPPLIER_ATTRIBUTION_SQL}
      WHERE je.business_id = $1 AND jl.account_id = $2
      GROUP BY ${AP_SUPPLIER_ID_SQL}, pa.name, s.name, pa.phone, s.phone, s.party_id,
               supplier_location.id, supplier_location.name
     HAVING SUM(jl.credit - jl.debit) <> 0
      ORDER BY SUM(jl.credit - jl.debit) DESC,
               COALESCE(pa.name, s.name, 'بدون تأمین‌کننده مشخص'),
               supplier_location.name NULLS FIRST,
               ${AP_SUPPLIER_ID_SQL} NULLS FIRST`,
    [businessId, accountId],
  );

  return rows.map((row) => ({
    supplierId: row.supplier_id ?? UNKNOWN_SUPPLIER_KEY,
    supplierName: row.supplier_name ?? "بدون تأمین‌کننده مشخص",
    supplierPhone: row.supplier_phone,
    supplierPartyId: row.party_id,
    locationId: row.location_id,
    locationName: row.location_name,
    balance: Number(row.balance),
  }));
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

/** Standard 30/60/90-day A/P aging; SQL applies the as-of bound before FIFO math. */
export async function getApAging(businessId: string, asOfDate?: string): Promise<AgingReport> {
  if (asOfDate !== undefined && !isValidIsoDate(asOfDate)) throw new ApError("invalid_date");
  const effectiveAsOf = asOfDate ?? (await businessToday(businessId));
  const accountId = await apAccountId(businessId);
  if (!accountId) return { asOfDate: effectiveAsOf, rows: [], totals: { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 } };

  const lines = await queryApLines({ businessId, accountId, asOfDate: effectiveAsOf });
  const bySupplier = new Map<string, {
    name: string;
    locationId: string | null;
    locationName: string | null;
    bills: { id: string; date: string; amount: number }[];
    payments: { id: string; date: string; amount: number }[];
  }>();
  for (const line of lines) {
    const key = line.supplier_id ?? UNKNOWN_SUPPLIER_KEY;
    const entry = bySupplier.get(key) ?? {
      name: line.supplier_name ?? "بدون تأمین‌کننده مشخص",
      locationId: line.supplier_location_id,
      locationName: line.supplier_location_name,
      bills: [],
      payments: [],
    };
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    // Liability: credit raises the balance; a debit pays down a bill/records a return.
    if (credit > 0) entry.bills.push({ id: line.journal_line_id, date: line.entry_date, amount: credit });
    if (debit > 0) entry.payments.push({ id: line.journal_line_id, date: line.entry_date, amount: debit });
    bySupplier.set(key, entry);
  }

  const rows: AgingRow[] = [];
  const totals: AgingSummary = { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const [supplierId, { name, locationId, locationName, bills, payments }] of bySupplier) {
    const summary = summarizeAging(ageOpenItems(bills, payments, effectiveAsOf));
    // Supplier advances/overpayments have no bill to age; retain the debit
    // balance as negative current so the report reconciles to control account 2100.
    const credit = unappliedCredit(bills, payments);
    summary.current -= credit;
    summary.total -= credit;
    if (summary.total === 0) continue;
    rows.push({ supplierId, supplierName: name, locationId, locationName, ...summary });
    totals.current += summary.current;
    totals.d31_60 += summary.d31_60;
    totals.d61_90 += summary.d61_90;
    totals.over90 += summary.over90;
    totals.total += summary.total;
  }
  rows.sort((a, b) => b.total - a.total || a.supplierName.localeCompare(b.supplierName) || (a.locationName ?? "").localeCompare(b.locationName ?? "") || a.supplierId.localeCompare(b.supplierId));
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
  /** True only when this call reused the result for an earlier matching request id. */
  duplicate: boolean;
  /**
   * The per-business sequential voucher number (migration 0215); null for
   * vouchers posted before numbering existed (e.g. installment slices).
   */
  voucherNumber: number | null;
  /** Set once the voucher's entry is reversed; null while it stands. */
  reversedAt: string | null;
  reversalEntryId: string | null;
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
  method: VoucherMethod;
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
  method: VoucherMethod;
  amount: string;
  memo: string | null;
  cash_account_id: string | null;
  bank_reference: string | null;
  voucher_number: string | null;
  reversed_at: string | null;
  reversal_entry_id: string | null;
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
    voucherNumber: row.voucher_number != null ? Number(row.voucher_number) : null,
    reversedAt: row.reversed_at,
    reversalEntryId: row.reversal_entry_id,
  };
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

/**
 * Records a supplier payment atomically and idempotently. The supplier alias
 * and the payment/journal location must be the same branch (strict branch
 * liability semantics); the GL and supplier row are committed together.
 *
 * The money moves through an explicit cash/bank/clearing account (#829 adds
 * clearing to the method set); every voucher takes the next per-business AP
 * voucher number.
 */
export async function payBill(params: {
  businessId: string;
  locationId: string | null;
  supplierId: string;
  method: VoucherMethod;
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  clientRequestId: string;
  createdBy: string | null;
  /** Holoo imports create local payments but must not push them back to Holoo. */
  skipHolooPush?: boolean;
  /** The cash/bank/clearing account the money left from; null uses the method default. */
  cashAccountId?: string | null;
  /** Bank tracking number; normalized and validated before posting. */
  bankReference?: string | null;
}): Promise<ApPayment> {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) throw new ApError("invalid_amount");
  if (!isUuid(params.supplierId)) throw new ApError("supplier_not_found", 404);
  if (!isVoucherMethod(params.method)) throw new ApError("invalid_method");
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
      method: VoucherMethod;
      amount: string;
      memo: string | null;
      request_fingerprint: string | null;
      cash_account_id: string | null;
      bank_reference: string | null;
      voucher_number: string | null;
      reversed_at: string | null;
      reversal_entry_id: string | null;
    }>(
      `SELECT id, supplier_id, payment_date::text AS payment_date, method,
              amount::text AS amount, memo, request_fingerprint, cash_account_id, bank_reference,
              voucher_number::text AS voucher_number, reversed_at::text AS reversed_at,
              reversal_entry_id::text AS reversal_entry_id
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

    // suppliers has no business_id column — the match is verified through its
    // (mandatory) location. The alias must also be active, and when it is
    // linked to a party that party must still be live and non-merged, so a
    // crafted request cannot pay a supplier the directory already retired.
    const { rows: supplierRows } = await client.query<{ id: string; location_id: string }>(
      `SELECT s.id, s.location_id
         FROM suppliers s
         JOIN locations l ON l.id = s.location_id
         LEFT JOIN parties pa ON pa.id = s.party_id
        WHERE s.id = $1 AND l.business_id = $2 AND s.is_active
          AND (s.party_id IS NULL OR (pa.is_active AND pa.merged_into_id IS NULL))`,
      [params.supplierId, params.businessId],
    );
    const supplier = supplierRows[0];
    if (!supplier) throw new ApError("supplier_not_found", 404);
    if (params.locationId !== supplier.location_id) throw new ApError("supplier_location_mismatch", 409);

    const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.accountsPayable]);
    const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
    const cash = await resolveVoucherCashAccount(client, params.businessId, params.method, requestedCashAccountId);
    // Throws PayablesInputError (invalid_cash_account /
    // cash_account_method_mismatch), which the route answers as a 400.
    const cashAccountId = cash.accountId;

    const voucherNumber = await nextPaymentVoucherNumber(client, params.businessId);

    const { rows } = await client.query<{
      id: string;
      supplier_id: string;
      payment_date: string;
      method: VoucherMethod;
      amount: string;
      memo: string | null;
      cash_account_id: string | null;
      bank_reference: string | null;
      voucher_number: string | null;
      reversed_at: string | null;
      reversal_entry_id: string | null;
    }>(
      `INSERT INTO ap_payments
         (business_id, location_id, supplier_id, payment_date, method, amount, memo,
          client_request_id, request_fingerprint, created_by, cash_account_id, bank_reference,
          voucher_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (business_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING id, supplier_id, payment_date::text AS payment_date,
                 method, amount::text AS amount, memo, cash_account_id, bank_reference,
                 voucher_number::text AS voucher_number, reversed_at::text AS reversed_at,
                 reversal_entry_id::text AS reversal_entry_id`,
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
        voucherNumber,
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
        method: VoucherMethod;
        amount: string;
        memo: string | null;
        request_fingerprint: string | null;
        cash_account_id: string | null;
        bank_reference: string | null;
        voucher_number: string | null;
        reversed_at: string | null;
        reversal_entry_id: string | null;
      }>(
        `SELECT id, supplier_id, payment_date::text AS payment_date, method,
                amount::text AS amount, memo, request_fingerprint, cash_account_id, bank_reference,
                voucher_number::text AS voucher_number, reversed_at::text AS reversed_at,
                reversal_entry_id::text AS reversal_entry_id
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
        { accountId: cashAccountId, debit: 0, credit: params.amount },
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
 * branch and the date's fiscal period. The source row is additionally marked
 * (reversed_at/by/entry) so the register reads correction state without a
 * journal join; an installment-linked voucher is refused, not unpicked.
 */
export async function reverseApPayment(params: {
  businessId: string;
  locationId: string | null;
  paymentId: string;
  actorId: string | null;
  reversalDate?: string | null;
  memo?: string | null;
  /** Holoo imports must not push their own corrections back to Holoo. */
  skipHolooPush?: boolean;
}): Promise<ApPaymentReversal> {
  if (!isUuid(params.paymentId)) throw new ApError("payment_not_found", 404);
  const requestedDate = params.reversalDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) throw new ApError("invalid_date");
  const reversalDate = requestedDate ?? (await businessToday(params.businessId));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Lock the voucher row itself: a row already marked reversed is refused
    // here, and the mark below is what the register and drill-down read.
    const { rows: paymentRows } = await client.query<{ id: string; reversed_at: string | null }>(
      `SELECT id, reversed_at::text AS reversed_at FROM ap_payments
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.paymentId],
    );
    if (!paymentRows[0]) throw new ApError("payment_not_found", 404);
    if (paymentRows[0].reversed_at) throw new ApError("already_reversed", 409);

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

    // An installment slice's payment is part of the plan's posted history;
    // reversing it here would strand the slice as paid with no money moved.
    const { rows: linked } = await client.query<{ id: string }>(
      `SELECT id FROM installment_items WHERE payment_id = $1 LIMIT 1`,
      [params.paymentId],
    );
    if (linked[0]) throw new ApError("payment_linked_to_installment", 409);

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
    await client.query(
      `UPDATE ap_payments SET reversed_at = now(), reversed_by = $2, reversal_entry_id = $3 WHERE id = $1`,
      [params.paymentId, params.actorId, reversalEntryId],
    );

    if (!params.skipHolooPush) {
      await enqueueHolooReversalForApPayment(client, params.businessId, params.paymentId, reversalEntryId);
    }

    await client.query("COMMIT");
    return { paymentId: original.payment_id, reversalEntryId, reversalDate };
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
            p.voucher_number::text AS voucher_number,
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
    duplicate: false,
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
