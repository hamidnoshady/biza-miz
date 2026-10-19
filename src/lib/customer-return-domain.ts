import Decimal from "decimal.js";
import {
  positiveQuantityText,
  quantityText,
  type QuantityText,
} from "./inventory-exact";

export const CUSTOMER_RETURN_REFUND_METHODS = [
  "cash",
  "card",
  "card_to_card",
  "online",
] as const;

export type CustomerReturnRefundMethod =
  (typeof CUSTOMER_RETURN_REFUND_METHODS)[number];
export type CustomerReturnDisposition = "restockable" | "discarded";

export interface NormalizedCustomerReturnLine {
  orderItemId: string;
  quantity: QuantityText;
  disposition: CustomerReturnDisposition;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RETURN_LINES = 200;
export const MAX_RETURN_REASON_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and combine repeated order-item ids before any SQL insert.
 *
 * `customer_return_lines` deliberately has one row per item per return. If a
 * caller repeats an id, inserting the input as-is would either fail that unique
 * constraint late or (with a less careful schema) validate each fragment
 * against the same remaining quantity. Summing here gives one exact quantity
 * for validation and persistence. A line cannot be both restockable and
 * discarded in one intent, so contradictory duplicate dispositions are
 * rejected rather than silently choosing one.
 */
export function normalizeCustomerReturnLines(
  rawLines: unknown,
): NormalizedCustomerReturnLine[] {
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_RETURN_LINES) {
    throw new Error("invalid_return_lines");
  }

  const aggregated = new Map<string, NormalizedCustomerReturnLine>();
  for (const rawLine of rawLines) {
    if (!isRecord(rawLine)) throw new Error("invalid_return_line");
    if (Object.keys(rawLine).some((key) => !["orderItemId", "quantity", "disposition"].includes(key))) {
      throw new Error("invalid_return_line");
    }
    const rawOrderItemId = rawLine.orderItemId;
    const disposition = rawLine.disposition;
    if (typeof rawOrderItemId !== "string" || !UUID_PATTERN.test(rawOrderItemId)) {
      throw new Error("invalid_return_line");
    }
    const orderItemId = rawOrderItemId.toLowerCase();
    if (disposition !== "restockable" && disposition !== "discarded") {
      throw new Error("invalid_return_disposition");
    }

    let quantity: QuantityText;
    try {
      quantity = positiveQuantityText(rawLine.quantity as string);
    } catch {
      throw new Error("invalid_return_quantity");
    }

    const existing = aggregated.get(orderItemId);
    if (!existing) {
      aggregated.set(orderItemId, { orderItemId, quantity, disposition });
      continue;
    }
    if (existing.disposition !== disposition) {
      throw new Error("duplicate_return_line_conflict");
    }
    const sum = new Decimal(existing.quantity).plus(quantity);
    try {
      existing.quantity = quantityText(sum.toFixed());
    } catch {
      throw new Error("invalid_return_quantity");
    }
  }

  return [...aggregated.values()].sort((left, right) =>
    left.orderItemId.localeCompare(right.orderItemId),
  );
}

export function validateCustomerReturnReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throw new Error("return_reason_required");
  if (reason.length > MAX_RETURN_REASON_LENGTH) throw new Error("return_reason_too_long");
  return reason;
}

export function isCustomerReturnRefundMethod(
  value: unknown,
): value is CustomerReturnRefundMethod {
  return typeof value === "string" &&
    (CUSTOMER_RETURN_REFUND_METHODS as readonly string[]).includes(value);
}

export interface RefundCapacityInput {
  orderTotalRial: string | bigint;
  previouslyRefundedRial: string | bigint;
  /** Active cash/card/online collection, including the negative tender rows for prior refunds. */
  netNonCreditTenderRial: string | bigint;
}

export interface RefundCapacity {
  saleRemainingRial: string;
  tenderRemainingRial: string;
  remainingRefundRial: string;
}

function integerRial(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error("invalid_refund_capacity");
  }
  return BigInt(value);
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * Refundable value is bounded independently by the remaining sale and the
 * currently active non-A/R tender. In particular, tips are not included (the
 * caller passes orders.total, which excludes tips), positive A/R credit is not
 * tender, and an order paid above its face value still cannot refund more than
 * the sale consideration.
 */
export function calculateRefundCapacity(input: RefundCapacityInput): RefundCapacity {
  const saleRemaining = nonNegative(
    integerRial(input.orderTotalRial) - integerRial(input.previouslyRefundedRial),
  );
  const tenderRemaining = nonNegative(integerRial(input.netNonCreditTenderRial));
  const remaining = saleRemaining < tenderRemaining ? saleRemaining : tenderRemaining;
  return {
    saleRemainingRial: saleRemaining.toString(),
    tenderRemainingRial: tenderRemaining.toString(),
    remainingRefundRial: remaining.toString(),
  };
}

/** A stable canonical comparison for an idempotent retry's per-item payload. */
export function sameNormalizedReturnLines(
  left: readonly NormalizedCustomerReturnLine[],
  right: readonly NormalizedCustomerReturnLine[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) =>
    line.orderItemId === right[index]?.orderItemId &&
    line.quantity === right[index]?.quantity &&
    line.disposition === right[index]?.disposition,
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
