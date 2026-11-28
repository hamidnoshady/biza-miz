/**
 * GH #1567 Phase 6D — fashion consignment (امانی), the pure planner.
 *
 * Client-safe (no I/O). The service, the routes, the POS and the UI all use
 * these functions, so the arithmetic a cashier previews is the arithmetic the
 * ledger posts.
 *
 * ## Accounting contract
 * The shop sells goods it does not own, on behalf of an owner (the consignor),
 * under a contract that lists variants and terms.
 *
 * | Event                  | Consigned on-hand | GL                                                     |
 * |------------------------|-------------------|--------------------------------------------------------|
 * | receive                | + q               | none: never an owned asset on receipt                  |
 * | sale                   | − q               | Dr tenders; Cr VAT; Cr 2110 owner share; Cr 4700 commission; no COGS |
 * | customer return        | + q (restock only)| refund entry + reclass Dr 2110 / Dr 4700 / Cr 4400      |
 * | void                   | + q               | exact reversal of the sale entry                       |
 * | return to owner        | − q               | none                                                   |
 * | settlement             | –                 | Dr 2110 / Cr cash or bank                              |
 *
 * Owner share at sale:
 *   - `owner_price` terms: share = owner unit price × q, commission = net − share.
 *     A sale whose net is below the share is refused, so the shop never takes
 *     a hidden loss on someone else's goods.
 *   - `commission` terms: commission = round(net × bp / 10 000), share = net − commission.
 */
import Decimal from "decimal.js";

export type ConsignmentTerms = "owner_price" | "commission";

export class ConsignmentRuleError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ConsignmentRuleError";
  }
}

export interface ConsignmentLineTerms {
  terms: ConsignmentTerms;
  /** Rial per unit owed to the owner (`owner_price` terms). */
  ownerUnitPriceRial: number | null;
  /** Basis points of net the shop keeps (`commission` terms), 0..10000. */
  commissionBp: number | null;
}

export interface ConsignmentContractInput {
  reference: string;
  consignorId: string;
  startsOn: string;
  expiresOn: string | null;
  lines: (ConsignmentLineTerms & { itemId: string })[];
}

const MAX_RIAL = 1_000_000_000_000_000; // 10^15 — far above any garment, far below bigint overflow
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateLineTerms(line: ConsignmentLineTerms): void {
  if (line.terms === "owner_price") {
    const p = line.ownerUnitPriceRial;
    if (p === null || !Number.isInteger(p) || p <= 0 || p > MAX_RIAL) throw new ConsignmentRuleError("invalid_owner_price");
    if (line.commissionBp !== null) throw new ConsignmentRuleError("terms_conflict");
  } else if (line.terms === "commission") {
    const bp = line.commissionBp;
    if (bp === null || !Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new ConsignmentRuleError("invalid_commission");
    if (line.ownerUnitPriceRial !== null) throw new ConsignmentRuleError("terms_conflict");
  } else {
    throw new ConsignmentRuleError("invalid_terms");
  }
}

export function validateContract(input: ConsignmentContractInput): void {
  if (!input.reference.trim() || input.reference.length > 100) throw new ConsignmentRuleError("reference_required");
  if (!DATE.test(input.startsOn)) throw new ConsignmentRuleError("invalid_date");
  if (input.expiresOn !== null) {
    if (!DATE.test(input.expiresOn)) throw new ConsignmentRuleError("invalid_date");
    if (input.expiresOn < input.startsOn) throw new ConsignmentRuleError("expiry_before_start");
  }
  if (input.lines.length === 0) throw new ConsignmentRuleError("contract_has_no_lines");
  if (input.lines.length > 500) throw new ConsignmentRuleError("contract_too_many_lines");
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.itemId)) throw new ConsignmentRuleError("duplicate_line", { itemId: line.itemId });
    seen.add(line.itemId);
    validateLineTerms(line);
  }
}

/** Whole positive quantity (garments, shoes and bags are counted). */
export function parseConsignmentQuantity(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 100_000) throw new ConsignmentRuleError("invalid_quantity");
  return n;
}

export interface SaleShares {
  ownerShareRial: bigint;
  commissionRial: bigint;
}

/** Splits one sale line's net (Rial, after discount, before VAT) between owner and shop. */
export function consignmentShares(terms: ConsignmentLineTerms, quantity: number, netRial: bigint): SaleShares {
  validateLineTerms(terms);
  if (netRial < 0n) throw new ConsignmentRuleError("invalid_net");
  if (terms.terms === "owner_price") {
    const share = BigInt(terms.ownerUnitPriceRial!) * BigInt(quantity);
    if (netRial < share) {
      throw new ConsignmentRuleError("below_owner_price", { ownerShareRial: share.toString(), netRial: netRial.toString() });
    }
    return { ownerShareRial: share, commissionRial: netRial - share };
  }
  const commission = BigInt(new Decimal(netRial.toString()).times(terms.commissionBp!).div(10_000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
  return { ownerShareRial: netRial - commission, commissionRial: commission };
}

/**
 * The share and commission a return of `quantity` units reverses, given what
 * earlier returns of the same sale line already reversed. Cumulative
 * proration: once every unit is back, the reversals sum exactly to the sale.
 */
export function returnShares(
  sale: { quantity: number; ownerShareRial: bigint; commissionRial: bigint },
  previouslyReturned: number,
  quantity: number,
): SaleShares {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new ConsignmentRuleError("invalid_quantity");
  if (previouslyReturned + quantity > sale.quantity) throw new ConsignmentRuleError("return_exceeds_sale");
  const upTo = (amount: bigint, q: number) =>
    BigInt(new Decimal(amount.toString()).times(q).div(sale.quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
  const after = previouslyReturned + quantity;
  return {
    ownerShareRial: upTo(sale.ownerShareRial, after) - upTo(sale.ownerShareRial, previouslyReturned),
    commissionRial: upTo(sale.commissionRial, after) - upTo(sale.commissionRial, previouslyReturned),
  };
}

export interface ConsignmentLineState {
  received: number;
  sold: number;
  customerReturned: number;
  returnedToOwner: number;
}

export function onHand(line: ConsignmentLineState): number {
  return line.received - line.sold + line.customerReturned - line.returnedToOwner;
}

/** Calendar date in the business's frame (the caller passes "today"). */
export function isExpired(expiresOn: string | null, today: string): boolean {
  return expiresOn !== null && expiresOn < today;
}

export type ContractStatus = "open" | "expired" | "closed";

export function contractStatus(c: { closedAt: string | null; expiresOn: string | null }, today: string): ContractStatus {
  if (c.closedAt) return "closed";
  return isExpired(c.expiresOn, today) ? "expired" : "open";
}

/** What the shop owes the owner under a contract right now. */
export function outstandingPayable(t: { shareSoldRial: bigint; shareReturnedRial: bigint; settledRial: bigint }): bigint {
  return t.shareSoldRial - t.shareReturnedRial - t.settledRial;
}

export type ConsignmentAction = "receive" | "sell" | "customer_return" | "return_to_owner" | "settle" | "close";

/** Which actions a contract in this state allows (the service re-checks quantities and amounts). */
export function allowedActions(status: ContractStatus): ConsignmentAction[] {
  switch (status) {
    case "open":
      return ["receive", "sell", "customer_return", "return_to_owner", "settle", "close"];
    case "expired":
      // Unsold goods are due back; the shop may still take a customer's
      // return, hand goods back and pay what it owes — but sells or takes in nothing new.
      return ["customer_return", "return_to_owner", "settle", "close"];
    case "closed":
      return ["settle"];
  }
}

export function assertAllowed(status: ContractStatus, action: ConsignmentAction): void {
  if (!allowedActions(status).includes(action)) {
    throw new ConsignmentRuleError(status === "expired" ? "contract_expired" : status === "closed" ? "contract_closed" : "action_not_allowed", { status, action });
  }
}

/* ------------------------------------------------------------------ *
 * GH #1567 C5 — combinations the consignment model does not support,
 * refused explicitly (one code, one Persian message each) instead of
 * surfacing as a raw database error, a misleading "shortage" or a sale
 * the ledger cannot attribute to its owner.
 * ------------------------------------------------------------------ */

export type ConsignmentBlockCode =
  /** Owned stock may not enter a variant that holds consigned units (DB trigger, migration 0332/0336). */
  | "consigned_variant_owned_stock"
  /** A size pack expands to fungible owned-stock lines; a consigned component cannot be sold that way. */
  | "pack_contains_consigned"
  /** Online channels relieve owned item_stock only; the consignment ledger is till-only. */
  | "consigned_online_sale_unsupported";

export const CONSIGNMENT_BLOCK_MESSAGES: Record<ConsignmentBlockCode, string> = {
  consigned_variant_owned_stock:
    "این تنوع کالای امانی در دست دارد؛ تا کالای امانی به صاحبش برنگشته یا فروخته نشده، موجودیِ متعلق به فروشگاه (خرید، انتقال یا اصلاح موجودی) برای آن ثبت نمی‌شود.",
  pack_contains_consigned:
    "این بسته تنوعی دارد که کالای امانی است؛ بستهٔ سایزی فقط از موجودی خودِ فروشگاه فروخته می‌شود. تنوع امانی را جداگانه بفروشید.",
  consigned_online_sale_unsupported:
    "این سفارش آنلاین تنوعی امانی دارد؛ فروش امانی فقط از صندوق فروشگاه ثبت می‌شود تا سهم صاحب کالا درست ثبت شود. سفارش را از صندوق ثبت کنید.",
};

/** Raised by the services for a combination listed in {@link CONSIGNMENT_BLOCK_MESSAGES}. */
export class ConsignmentBlockedError extends Error {
  constructor(public readonly code: ConsignmentBlockCode, public readonly detail?: Record<string, unknown>) {
    super(CONSIGNMENT_BLOCK_MESSAGES[code]);
    this.name = "ConsignmentBlockedError";
  }
}

/**
 * Recognises a consignment block however it surfaced: the typed error, or the
 * item_stock trigger's SQLSTATE P0001 `consigned_variant_owned_stock`
 * (the message is the code by design). Null for anything else.
 */
export function consignmentBlockOf(err: unknown): { code: ConsignmentBlockCode; message: string } | null {
  if (err instanceof ConsignmentBlockedError) return { code: err.code, message: err.message };
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === "P0001" && e.message === "consigned_variant_owned_stock") {
      return { code: "consigned_variant_owned_stock", message: CONSIGNMENT_BLOCK_MESSAGES.consigned_variant_owned_stock };
    }
  }
  return null;
}
