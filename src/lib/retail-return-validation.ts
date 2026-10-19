/**
 * Issue #918 — server-side input contract for the retail supplier-return
 * voucher (حواله بازگشت).
 *
 * The old route read `body.lines as never[]`, defaulted a missing settlement
 * to `accounts_payable`, and replaced a missing idempotency key with a random
 * one — so a retried request after a lost response minted a second voucher.
 * Every field is now parsed here: bounded arrays, UUIDs, allowed enums, a
 * trimmed reason, canonical positive quantities (≤ 9 fractional digits), and
 * a client-supplied idempotency key that the form generates once per draft
 * and reuses on retry.
 *
 * The fingerprint binds that key to the tenant, the warehouse, the operation
 * and the canonical payload: same key + same payload replays the original
 * voucher, same key + changed payload is a 409. Server-only (node:crypto) —
 * the error codes and Persian messages live in the client-safe
 * retail-return-errors.ts.
 */
import { createHash } from "node:crypto";
import { isUuid } from "./uuid";
import { positiveQuantityText, quantityText } from "./inventory-exact";
import { RetailReturnError } from "./retail-return-errors";

export const RETURN_SETTLEMENT_METHODS = [
  "accounts_payable",
  "cash",
  "bank",
  "supplier_receivable",
] as const;

export type ReturnSettlementMethod = (typeof RETURN_SETTLEMENT_METHODS)[number];

export function isReturnSettlementMethod(value: unknown): value is ReturnSettlementMethod {
  return (
    typeof value === "string" &&
    (RETURN_SETTLEMENT_METHODS as readonly string[]).includes(value)
  );
}

export const MAX_RETURN_LINES = 100;
export const MAX_RETURN_REASON_LENGTH = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_SERIAL_NUMBER_LENGTH = 100;

export interface ParsedReturnLine {
  itemId: string;
  /** Canonical positive quantity text (≤ 9 fractional digits). */
  quantity: string;
  batchId: string | null;
  serialId: string | null;
  serialNumber: string | null;
  purchaseItemId: string | null;
}

export interface ParsedSupplierReturnInput {
  purchaseId: string | null;
  supplierId: string | null;
  settlementMethod: ReturnSettlementMethod;
  reason: string;
  idempotencyKey: string;
  lines: ParsedReturnLine[];
}

function optionalUuid(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isUuid(value)) throw new RetailReturnError(code, 400);
  return value;
}

function parseLine(raw: unknown): ParsedReturnLine {
  if (typeof raw !== "object" || raw === null) throw new RetailReturnError("invalid_line");
  const line = raw as Record<string, unknown>;
  if (!isUuid(line.itemId)) throw new RetailReturnError("invalid_line");

  let quantity: string;
  if (typeof line.quantity !== "string") throw new RetailReturnError("quantity_invalid");
  try {
    // Canonical form ("1.50" → "1.5"), positive, and — via quantityText —
    // at most 9 fractional digits, which is what numeric(24,9) stores.
    quantity = positiveQuantityText(quantityText(line.quantity.trim()));
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "quantity_precision_exceeded") throw new RetailReturnError("quantity_precision_exceeded");
    throw new RetailReturnError("quantity_invalid");
  }

  const batchId = optionalUuid(line.batchId, "invalid_line");
  const serialId = optionalUuid(line.serialId, "invalid_line");
  let serialNumber: string | null = null;
  if (line.serialNumber !== undefined && line.serialNumber !== null && line.serialNumber !== "") {
    if (typeof line.serialNumber !== "string") throw new RetailReturnError("invalid_line");
    serialNumber = line.serialNumber.trim();
    if (!serialNumber || serialNumber.length > MAX_SERIAL_NUMBER_LENGTH) {
      throw new RetailReturnError("invalid_line");
    }
  }
  const purchaseItemId = optionalUuid(line.purchaseItemId, "invalid_line");

  // One line relieves one tracking path: a batch-tracked line names its lot,
  // a serialized line names its exact unit — never both, and a serialized
  // line names the unit once (by id for a scanned row, or by number).
  if (batchId && (serialId || serialNumber)) throw new RetailReturnError("invalid_line");
  if (serialId && serialNumber) throw new RetailReturnError("invalid_line");

  return { itemId: line.itemId, quantity, batchId, serialId, serialNumber, purchaseItemId };
}

/**
 * Parses the POST /api/stock/returns body. Every refusal is a
 * RetailReturnError with a stable code and status — never a TypeError, never
 * a Postgres error leaking a column name.
 */
export function parseSupplierReturnBody(body: unknown): ParsedSupplierReturnInput {
  if (typeof body !== "object" || body === null) throw new RetailReturnError("return_invalid");
  const raw = body as Record<string, unknown>;

  const purchaseId = optionalUuid(raw.purchaseId, "purchase_not_found");
  const supplierId = optionalUuid(raw.supplierId, "supplier_not_found");

  // No silent default: the old `?? "accounts_payable"` posted an AP debit
  // against no supplier whenever the caller omitted the field. The voucher
  // editor always sends an explicit, validated choice.
  if (raw.settlementMethod === undefined || raw.settlementMethod === null || raw.settlementMethod === "") {
    throw new RetailReturnError("settlement_required");
  }
  if (!isReturnSettlementMethod(raw.settlementMethod)) throw new RetailReturnError("settlement_invalid");

  if (typeof raw.reason !== "string" || !raw.reason.trim()) throw new RetailReturnError("reason_required");
  const reason = raw.reason.trim();
  if (reason.length > MAX_RETURN_REASON_LENGTH) throw new RetailReturnError("reason_too_long");

  // Required and stable per draft: the form generates it once and reuses it
  // on retry, which is what makes a retried POST replay instead of double.
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey.trim()) {
    throw new RetailReturnError("idempotency_key_required");
  }
  const idempotencyKey = raw.idempotencyKey.trim();
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new RetailReturnError("idempotency_key_required");

  if (!Array.isArray(raw.lines) || raw.lines.length === 0) throw new RetailReturnError("lines_required");
  if (raw.lines.length > MAX_RETURN_LINES) throw new RetailReturnError("too_many_lines");
  const lines = raw.lines.map(parseLine);

  return {
    purchaseId,
    supplierId,
    settlementMethod: raw.settlementMethod,
    reason,
    idempotencyKey,
    lines,
  };
}

/**
 * The canonical payload hash bound to an idempotency key (the ap_payments
 * `request_fingerprint` pattern). Lines are sorted so two submissions of the
 * same voucher hash identically regardless of row order; quantities are
 * already canonical text by the time they reach here.
 */
export function returnRequestFingerprint(input: {
  businessId: string;
  locationId: string;
  purchaseId: string | null;
  supplierId: string | null;
  settlementMethod: string;
  reason: string;
  lines: ParsedReturnLine[];
}): string {
  const lines = [...input.lines]
    .map((l) => [l.itemId, l.quantity, l.batchId ?? "", l.serialId ?? "", l.serialNumber ?? "", l.purchaseItemId ?? ""])
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    });
  const canonical = JSON.stringify({
    b: input.businessId,
    l: input.locationId,
    p: input.purchaseId ?? "",
    s: input.supplierId ?? "",
    m: input.settlementMethod,
    r: input.reason,
    lines,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
