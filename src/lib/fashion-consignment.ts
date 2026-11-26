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
