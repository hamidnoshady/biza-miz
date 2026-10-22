/**
 * Typed failures for warehouse document posting and reversal.
 *
 * Both reversal routes used to classify a failure by comparing the thrown
 * error's **message** against a list of strings
 * (`msg === "fiscal_period_locked" || msg === "insufficient_stock" || …`).
 * That is brittle in the way that matters: a service that rewords a message,
 * or throws the same words for a different cause, silently changes the HTTP
 * answer — and a code that is missing from the list becomes a 500 for what is
 * a normal, expected refusal (an expired stock row, a closed month).
 *
 * These classes carry the `code` and the `status` the route must answer with,
 * so the route only has to ask `instanceof WarehouseDocumentError`. The
 * `message` is deliberately kept **identical to the previous bare string**, so
 * callers that assert on it (the integration suites, the Persian copy shown to
 * the user) keep working; what changed is that the *classification* no longer
 * depends on the text.
 */

export type WarehouseDocumentErrorCode =
  /** The fiscal period covering the posting date is hard-closed. */
  | "fiscal_period_locked"
  /** The period is soft-closed and the actor is not owner/accountant. */
  | "fiscal_period_soft_closed"
  /** No fiscal calendar covers the posting date at all. */
  | "fiscal_period_not_defined"
  /** Alias some callers/tests use for a closed period. */
  | "period_closed"
  /** The lot or stock row cannot cover the requested quantity. */
  | "insufficient_stock"
  /** Stock would go negative and the caller did not accept that. */
  | "negative_stock_requires_confirm"
  /** The named lot does not exist on this item. */
  | "batch_not_found"
  /** The item does not exist in the target branch. */
  | "item_not_found"
  /** The idempotency key was reused with a different payload. */
  | "idempotency_key_conflict";

const STATUS: Record<WarehouseDocumentErrorCode, number> = {
  fiscal_period_locked: 409,
  fiscal_period_soft_closed: 409,
  fiscal_period_not_defined: 409,
  period_closed: 409,
  insufficient_stock: 409,
  negative_stock_requires_confirm: 409,
  batch_not_found: 409,
  item_not_found: 404,
  idempotency_key_conflict: 409,
};

export class WarehouseDocumentError extends Error {
  readonly code: WarehouseDocumentErrorCode;
  readonly status: number;

  constructor(code: WarehouseDocumentErrorCode, message?: string) {
    super(message ?? code);
    this.name = new.target.name;
    this.code = code;
    this.status = STATUS[code];
  }
}

/** A posting date that falls in a closed (soft- or hard-closed) period. */
export class FiscalPeriodClosedError extends WarehouseDocumentError {
  constructor(code: Extract<WarehouseDocumentErrorCode, `fiscal_period_${string}` | "period_closed">) {
    super(code);
  }
}

/**
 * A stock movement the available quantity cannot support.
 *
 * Raised for both the "lot is short" and "the row is missing entirely" cases:
 * from the caller's point of view they are the same refusal — the quantity
 * asked for is not there — and both answer 409.
 */
export class InsufficientStockError extends WarehouseDocumentError {
  constructor(message: string, code: "insufficient_stock" | "negative_stock_requires_confirm" = "insufficient_stock") {
    super(code, message);
  }
}

/** The lot named on the line does not exist on the item. */
export class BatchNotFoundError extends WarehouseDocumentError {
  constructor(message: string) {
    super("batch_not_found", message);
  }
}

/**
 * The same key was reused with a different payload.
 *
 * A *retry* of the identical request returns the original voucher instead; this
 * is only the conflict case, which must never be answered with the original.
 */
export class IdempotencyConflictError extends WarehouseDocumentError {
  constructor() {
    super("idempotency_key_conflict");
  }
}

/** Narrowing guard for the route's catch block. */
export function asWarehouseDocumentError(err: unknown): WarehouseDocumentError | null {
  return err instanceof WarehouseDocumentError ? err : null;
}
