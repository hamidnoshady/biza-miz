/**
 * Pure input rules for audit F11 (the non-payroll half) — the fields that make
 * an expense, a purchase and a receipt/payment voucher a complete document:
 *
 * - an expense may be owed rather than paid («پرداخت بعدی»): it then credits
 *   Accounts Payable for a named supplier and is settled later by the ordinary
 *   A/P payment;
 * - a purchase carries its supplier's invoice number and date, the VAT on it in
 *   integer Rial, and the payment terms / due date;
 * - a voucher names the cash or bank account the money moved through and the
 *   bank's tracking number.
 *
 * Framework- and database-free (client components import it); the services that
 * store these fields re-run the same rules, so a form and the API cannot
 * disagree about what is valid.
 */
import { classifyAccounts, type AccountRole, type ClassifiableAccount } from "./account-classification";
import { WELL_KNOWN_CODES } from "./coa-template";
import { toLatinDigits } from "./digits";
import { isValidIsoDate } from "./iso-date";

export class PayablesInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PayablesInputError";
  }
}

// ---------------------------------------------------------------------------
// Expense settlement
// ---------------------------------------------------------------------------

export const EXPENSE_SETTLEMENTS = ["paid", "credit"] as const;
export type ExpenseSettlement = (typeof EXPENSE_SETTLEMENTS)[number];

export const EXPENSE_SETTLEMENT_LABELS: Record<ExpenseSettlement, string> = {
  paid: "پرداخت‌شده",
  credit: "پرداخت بعدی",
};

export interface ExpenseSettlementInput {
  settlement: ExpenseSettlement;
  /** The supplier's branch alias (`suppliers.id`) — what `payBill` settles against. Credit only. */
  supplierId: string | null;
  dueDate: string | null;
}

/**
 * «پرداخت بعدی» needs a supplier: the payable it creates is settled through
 * the A/P payment, which pays a supplier, and a payable nobody can settle from
 * the screen is a trap. A paid expense carries neither a supplier nor a due
 * date — the money already left.
 */
export function parseExpenseSettlement(raw: {
  settlement?: unknown;
  supplierId?: unknown;
  dueDate?: unknown;
}): ExpenseSettlementInput {
  const settlement = raw.settlement === undefined || raw.settlement === null || raw.settlement === "" ? "paid" : raw.settlement;
  if (!(EXPENSE_SETTLEMENTS as readonly unknown[]).includes(settlement)) {
    throw new PayablesInputError("invalid_settlement");
  }
  if (settlement === "paid") return { settlement: "paid", supplierId: null, dueDate: null };

  const supplierId = typeof raw.supplierId === "string" ? raw.supplierId.trim() : "";
  if (!supplierId) throw new PayablesInputError("supplier_required");
  const dueDate = optionalIsoDate(raw.dueDate, "invalid_due_date");
  return { settlement: "credit", supplierId, dueDate };
}

// ---------------------------------------------------------------------------
// Supplier invoice on a purchase
// ---------------------------------------------------------------------------

export const MAX_SUPPLIER_INVOICE_NUMBER_LENGTH = 64;
export const MAX_PAYMENT_TERMS_DAYS = 3650;

export interface SupplierInvoiceInput {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** Integer Rial; 0 when the invoice carries no VAT. */
  vatAmount: number;
  paymentTermsDays: number | null;
  /** An explicit due date; null lets the service derive one from the terms. */
  dueDate: string | null;
}

export const EMPTY_SUPPLIER_INVOICE: SupplierInvoiceInput = {
  invoiceNumber: null,
  invoiceDate: null,
  vatAmount: 0,
  paymentTermsDays: null,
  dueDate: null,
};

function optionalIsoDate(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isValidIsoDate(value.trim())) throw new PayablesInputError(code);
  return value.trim();
}

function optionalNonNegativeInteger(value: unknown, code: string, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(toLatinDigits(String(value)).trim());
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new PayablesInputError(code);
  return n;
}

/**
 * The supplier-invoice block of a purchase. VAT is integer Rial (the client
 * converts the business's display unit before sending, like every money
 * input); omitted means 0, never a rate the server guessed.
 */
export function parseSupplierInvoice(raw: unknown): SupplierInvoiceInput {
  if (raw === undefined || raw === null) return { ...EMPTY_SUPPLIER_INVOICE };
  if (typeof raw !== "object") throw new PayablesInputError("invalid_supplier_invoice");
  const r = raw as Record<string, unknown>;

  let invoiceNumber: string | null = null;
  if (r.invoiceNumber !== undefined && r.invoiceNumber !== null) {
    if (typeof r.invoiceNumber !== "string") throw new PayablesInputError("invalid_invoice_number");
    invoiceNumber = toLatinDigits(r.invoiceNumber).trim() || null;
    if (invoiceNumber && invoiceNumber.length > MAX_SUPPLIER_INVOICE_NUMBER_LENGTH) {
      throw new PayablesInputError("invalid_invoice_number");
    }
  }

  return {
    invoiceNumber,
    invoiceDate: optionalIsoDate(r.invoiceDate, "invalid_invoice_date"),
    vatAmount: optionalNonNegativeInteger(r.vatAmount, "invalid_vat_amount", Number.MAX_SAFE_INTEGER) ?? 0,
    paymentTermsDays: optionalNonNegativeInteger(r.paymentTermsDays, "invalid_payment_terms", MAX_PAYMENT_TERMS_DAYS),
    dueDate: optionalIsoDate(r.dueDate, "invalid_due_date"),
  };
}

/**
 * The VAT a goods value carries at `vatPercent`, rounded half-up to the Rial.
 * Exact: the percent is taken to two decimals (what `tax.config` stores) and
 * the product is computed in BigInt, so a large invoice cannot drift through a
 * float. The rate is always the caller's — the business's own setting — never
 * a constant here.
 */
export function vatAmountForRate(goodsTotalRial: string | number | bigint, vatPercent: number): number {
  if (!Number.isFinite(vatPercent) || vatPercent <= 0) return 0;
  const goods = BigInt(goodsTotalRial);
  if (goods <= 0n) return 0;
  const basisPoints = BigInt(Math.round(vatPercent * 100));
  return Number((goods * basisPoints + 5000n) / 10000n);
}

/** What the supplier is owed for a purchase: the goods plus the invoice's VAT. */
export function purchasePayableRial(goodsTotalRial: string | number | bigint, vatAmountRial: string | number | bigint): bigint {
  return BigInt(goodsTotalRial) + BigInt(vatAmountRial);
}

/** `isoDate` plus `days`, in UTC so no timezone can shift the calendar date. */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * The due date a purchase shows: an explicit one wins; otherwise the invoice
 * date (or, without one, the purchase date) plus the payment terms. No terms
 * and no explicit date means no due date — never "today".
 */
export function resolvePaymentDueDate(params: {
  dueDate: string | null;
  paymentTermsDays: number | null;
  invoiceDate: string | null;
  purchaseDate: string | null;
}): string | null {
  if (params.dueDate) return params.dueDate;
  if (params.paymentTermsDays === null) return null;
  const base = params.invoiceDate ?? params.purchaseDate;
  return base ? addDaysIso(base, params.paymentTermsDays) : null;
}

// ---------------------------------------------------------------------------
// Receipt / payment voucher: the cash, bank or clearing account and the bank reference
// ---------------------------------------------------------------------------

export type VoucherMethod = "cash" | "bank" | "clearing";

export const VOUCHER_METHODS = ["cash", "bank", "clearing"] as const;

export function isVoucherMethod(value: unknown): value is VoucherMethod {
  return typeof value === "string" && (VOUCHER_METHODS as readonly string[]).includes(value);
}

/**
 * Optional text off a JSON body: absent (or blank) is null — unset — while a
 * wrong-typed value (a number, an object) is undefined, so the route answers
 * its own field-specific 400 instead of `.trim()` throwing a TypeError 500.
 */
export function optionalBodyText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

export const VOUCHER_METHOD_LABELS: Record<VoucherMethod, string> = {
  cash: "نقدی",
  bank: "بانکی",
  clearing: "در جریان وصول",
};

export const MAX_BANK_REFERENCE_LENGTH = 64;

/**
 * Which voucher method an account can carry. Cash and petty cash are «نقدی»;
 * the business's bank accounts are «بانکی»; the card/PSP clearing account is
 * «در جریان وصول» — its own method since issue #829, when «بانکی» stopped
 * posting to it (see `voucherDefaultAccountCode`). Anything else —
 * receivables, payables, VAT — is not where a voucher's money moves.
 */
export function voucherMethodForRole(role: AccountRole | null | undefined): VoucherMethod | null {
  if (role === "cash" || role === "petty_cash") return "cash";
  if (role === "bank") return "bank";
  if (role === "payment_clearing") return "clearing";
  return null;
}

/**
 * The well-known account code a voucher method posts to when the voucher
 * names no explicit account: cash → 1100 صندوق, bank → 1110 بانک,
 * clearing → 1120 کارت‌خوان (در راه).
 *
 * The `bank` default changed with issue #829: before it, «بانکی» posted to
 * the 1120 clearing account, so a plain bank transfer sat in
 * «کارت‌خوان (در راه)» forever. Bank transfers now post to the real bank
 * account (1110); card/POS/PSP money still in transit is recorded with the
 * `clearing` method, which kept 1120. Legacy bank vouchers (stored cash
 * account NULL, or an explicit 1120) still show their true posting — the
 * NULL convention means \"the method's default took it\", and the journal
 * mirrors the original entry's own lines, never a re-resolved default.
 */
export function voucherDefaultAccountCode(method: VoucherMethod): string {
  switch (method) {
    case "cash":
      return WELL_KNOWN_CODES.cash;
    case "bank":
      return WELL_KNOWN_CODES.bank;
    case "clearing":
      return WELL_KNOWN_CODES.bankClearing;
  }
}

export interface VoucherAccountChoice {
  id: string;
  code: string;
  name: string;
  method: VoucherMethod;
}

/**
 * The accounts a voucher may name, from the active chart as
 * `GET /api/ledger/accounts` returns it (`parent_code`, not `parent_id`, so the
 * parent is resolved by code here). Classification is the one shared
 * `account-classification` — the same answer the cash-flow statement gives.
 */
export function voucherAccountChoices(
  accounts: { id: string; code: string; name: string; type: ClassifiableAccount["type"]; parent_code?: string | null }[],
): VoucherAccountChoice[] {
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
  const roles = classifyAccounts(
    accounts.map((a) => ({
      id: a.id,
      code: a.code,
      type: a.type,
      parentId: a.parent_code ? (idByCode.get(a.parent_code) ?? null) : null,
    })),
  );
  const out: VoucherAccountChoice[] = [];
  for (const a of accounts) {
    const method = voucherMethodForRole(roles.get(a.id));
    if (method) out.push({ id: a.id, code: a.code, name: a.name, method });
  }
  return out;
}

/** The bank's tracking number, digits normalised to ASCII; empty means none. */
export function normalizeBankReference(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new PayablesInputError("invalid_bank_reference");
  const value = toLatinDigits(raw).trim();
  if (!value) return null;
  if (value.length > MAX_BANK_REFERENCE_LENGTH) throw new PayablesInputError("invalid_bank_reference");
  return value;
}

// ---------------------------------------------------------------------------
// Supplier return of a purchase that carried input VAT
// ---------------------------------------------------------------------------

/**
 * How much of a purchase's input VAT one supplier return reverses, in integer
 * Rial. Allocated *cumulatively*: the VAT reversed by all returns so far is
 * `vat × returned goods ÷ purchase goods` rounded half-up (the whole VAT once
 * every Rial of goods is back), and this return takes the difference from
 * what earlier returns already reversed. So any sequence of partial returns
 * that adds up to the whole purchase reverses exactly the whole VAT — no Rial
 * stranded in 1220 or on the supplier's payable by rounding — and a purchase
 * without VAT reverses nothing.
 */
export function supplierReturnVatReversal(params: {
  purchaseVat: string | number | bigint;
  purchaseGoods: string | number | bigint;
  /** Goods value returned by earlier returns of this purchase. */
  priorReturnedGoods: string | number | bigint;
  /** Goods value this return gives back. */
  returnedGoods: string | number | bigint;
  /** Input VAT earlier returns already reversed. */
  priorReversedVat: string | number | bigint;
}): bigint {
  const vat = BigInt(params.purchaseVat);
  const goods = BigInt(params.purchaseGoods);
  if (vat <= 0n || goods <= 0n) return 0n;
  const cumulativeGoods = BigInt(params.priorReturnedGoods) + BigInt(params.returnedGoods);
  const cumulativeVat = cumulativeGoods >= goods ? vat : (vat * cumulativeGoods * 2n + goods) / (2n * goods);
  const thisReturn = cumulativeVat - BigInt(params.priorReversedVat);
  if (thisReturn <= 0n) return 0n;
  return thisReturn > vat ? vat : thisReturn;
}
