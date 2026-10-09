/**
 * Issue #866 — taxpayer e-invoicing: the server-side pure core.
 *
 * Everything here is a function of its arguments: no database, no clock, no
 * network. That is deliberate. The rules that decide whether a tax record may
 * exist, what its snapshot says, which status a failure leads to, and how the
 * register ties to the sales ledger are the rules a reviewer must be able to read
 * and a unit test must be able to pin down.
 *
 *   - money is integer Rial end to end; allocations are exact (largest remainder)
 *   - a payload is canonical JSON, hashed, and stored; the hash re-checks it later
 *   - a failure maps to a status by one function, so the retry policy lives here
 */
import { createHash, randomUUID } from "node:crypto";
import { backoffDelayMs, isDeadAfterAttempts } from "./integrations/retry";
import {
  TAX_ITEM_CODE_PATTERN,
  TAX_REFERENCE_PATTERN,
  isLiveStatus,
  type TaxEnvironment,
  type TaxKind,
  type TaxStatus,
} from "./tax-invoice";

export const TAX_PAYLOAD_VERSION = "tax-invoice-payload/v1";

/** How VAT on an order is spread over its lines. Recorded in every snapshot. */
export const TAX_VAT_METHOD = "order_total_allocated_by_line_base" as const;

// ---------------------------------------------------------------------------
// Exact allocation
// ---------------------------------------------------------------------------

/**
 * Split `amount` (integer Rial) over `weights` so the parts sum to `amount`
 * exactly. Largest-remainder: each part takes its floor share, and the leftover
 * Rial go to the parts with the biggest fractional remainders, ties to the
 * earlier line. BigInt, so an order far larger than 2^53 still divides exactly.
 */
export function allocateProportionally(amount: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError("allocateProportionally: amount must be a non-negative integer");
  }
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError("allocateProportionally: weights must be non-negative integers");
    }
  }
  if (weights.length === 0) return [];
  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (total === 0n) {
    if (amount !== 0) throw new RangeError("allocateProportionally: nothing to allocate over");
    return weights.map(() => 0);
  }
  const amountBig = BigInt(amount);
  const shares = weights.map((weight, index) => {
    const product = amountBig * BigInt(weight);
    return { index, floor: product / total, remainder: product % total };
  });
  let leftover = amountBig - shares.reduce((sum, share) => sum + share.floor, 0n);
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    share.floor += 1n;
    leftover -= 1n;
  }
  return shares.sort((a, b) => a.index - b.index).map((share) => Number(share.floor));
}

// ---------------------------------------------------------------------------
// Canonical JSON and the payload hash
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeysDeep(child);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    // Money and quantities are integers. A fraction here would hash differently
    // on two machines, so it is refused rather than rounded.
    throw new TypeError("canonicalJson: non-integer number in a tax payload");
  }
  return value;
}

/** Key-sorted, whitespace-free JSON. Two equal payloads always produce the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * The idempotency key of one decision: this business, this document, this kind,
 * this revision, this parent. A retry of the same decision derives the same key
 * and finds the existing row; a new decision (a resubmission, a correction) is a
 * new revision and so a new key.
 */
export function deriveIdempotencyKey(input: {
  businessId: string;
  orderId: string;
  kind: TaxKind;
  revision: number;
  parentSubmissionId: string | null;
}): string {
  const material = [
    "tax-invoice",
    "v1",
    input.businessId,
    input.orderId,
    input.kind,
    String(input.revision),
    input.parentSubmissionId ?? "-",
  ].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** A fresh «شناسه یکتای ارسال» — generated once per record, before its first send. */
export function newInvoiceUid(): string {
  return randomUUID();
}

const KIND_LETTER: Readonly<Record<TaxKind, string>> = { sale: "S", amendment: "A", cancellation: "C" };

/**
 * `{prefix-}{unit}-{orderNumber}-{S|A|C}{revision}`, e.g. `BIZ-K1-1042-S1`.
 *
 * The unit is the branch's tax unit code when it has one, and the first eight
 * hex digits of the location id when it does not. Order numbers are per branch,
 * so the unit is what keeps two branches' «1042» apart. The unique constraint on
 * `reference_number` is the backstop.
 */
export function buildReferenceNumber(input: {
  prefix: string;
  unitCode: string | null;
  locationId: string;
  orderNumber: number;
  kind: TaxKind;
  revision: number;
}): string {
  if (!Number.isSafeInteger(input.orderNumber) || input.orderNumber < 1) {
    throw new RangeError("buildReferenceNumber: orderNumber must be a positive integer");
  }
  const cleanUnit = (input.unitCode ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const unit = cleanUnit || input.locationId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const head = input.prefix ? `${input.prefix}-` : "";
  const reference = `${head}${unit}-${input.orderNumber}-${KIND_LETTER[input.kind]}${input.revision}`;
  if (!TAX_REFERENCE_PATTERN.test(reference)) {
    throw new RangeError("buildReferenceNumber: the result is not a valid reference number");
  }
  return reference;
}

// ---------------------------------------------------------------------------
// Building and validating the payload
// ---------------------------------------------------------------------------

export interface TaxSellerProfile {
  taxpayerId: string;
  taxpayerName: string | null;
  memoryId: string;
  unitCode: string | null;
  environment: TaxEnvironment;
  submissionMode: "direct" | "tsp";
}

export interface TaxSourceLine {
  productKind: "menu_item" | "item" | null;
  productId: string | null;
  name: string;
  quantity: number;
  unitPriceRial: number;
  /**
   * Per unit: Σ(modifier price delta × modifier quantity). Signed, since a
   * modifier can subtract. The order totals multiply it by the line quantity
   * together with the unit price, and so does a line's base here.
   */
  modifiersRial: number;
  /** The product's 13-digit «شناسه کالا/خدمت», or null when none is set. */
  taxCode: string | null;
}

/** The internal document a record reports — read from `orders` at prepare time. */
export interface TaxSourceDocument {
  orderId: string;
  orderNumber: number;
  locationId: string;
  locationName: string;
  orderStatus: string;
  closedAt: string;
  subtotalRial: number;
  discountRial: number;
  serviceChargeRial: number;
  vatRial: number;
  totalRial: number;
  buyer: { partyId: string | null; name: string | null; economicCode: string | null };
  lines: TaxSourceLine[];
}

export interface TaxParentRef {
  submissionId: string;
  kind: TaxKind;
  uid: string;
  reference: string;
  receiptId: string | null;
}

export interface TaxBuildInput {
  kind: TaxKind;
  revision: number;
  reference: string;
  uid: string;
  issuedAt: string;
  seller: TaxSellerProfile;
  source: TaxSourceDocument;
  parent: TaxParentRef | null;
  reason: string | null;
}

export interface TaxPayloadLine {
  no: number;
  productKind: "menu_item" | "item" | null;
  productId: string | null;
  taxCode: string;
  name: string;
  quantity: number;
  unitPriceRial: number;
  modifiersRial: number;
  baseRial: number;
  discountRial: number;
  taxableRial: number;
  vatRial: number;
  totalRial: number;
}

export interface TaxPayloadV1 {
  version: typeof TAX_PAYLOAD_VERSION;
  kind: TaxKind;
  revision: number;
  reference: string;
  uid: string;
  issuedAt: string;
  seller: TaxSellerProfile;
  buyer: TaxSourceDocument["buyer"];
  source: { orderId: string; orderNumber: number; locationId: string; locationName: string; closedAt: string };
  parent: TaxParentRef | null;
  reason: string | null;
  vatMethod: typeof TAX_VAT_METHOD;
  lines: TaxPayloadLine[];
  totals: { subtotalRial: number; discountRial: number; vatRial: number; totalRial: number };
}

/**
 * A reason a record may not be prepared. Blockers are returned as a list so the
 * operator sees every missing piece at once, not one per attempt.
 */
export interface TaxBlocker {
  code: string;
  message: string;
  productKind?: "menu_item" | "item";
  productId?: string;
  productName?: string;
}

export type TaxBuildResult =
  | { ok: true; payload: TaxPayloadV1; hash: string }
  | { ok: false; blockers: TaxBlocker[] };

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Build the v1 payload from a source document, or say exactly why it cannot be
 * built. Pure: the same inputs always yield the same payload, the same hash.
 *
 * Refused (not repaired): a missing taxpayer or memory identifier, an order that
 * is not completed, a line without its item code, a non-zero service charge
 * (this version does not report it yet), and totals that do not add up. The
 * last one matters most: a snapshot whose lines disagree with its totals would
 * be reported as if it were right.
 */
export function buildTaxPayload(input: TaxBuildInput): TaxBuildResult {
  const { seller, source } = input;
  const blockers: TaxBlocker[] = [];

  if (!seller.taxpayerId) blockers.push({ code: "profile_not_configured", message: "شناسه مؤدی تنظیم نشده است." });
  if (!seller.memoryId) blockers.push({ code: "unit_not_configured", message: "حافظه مالیاتی این شعبه تنظیم نشده است." });
  if (source.orderStatus !== "completed") {
    blockers.push({ code: "order_not_completed", message: "فقط فروش تکمیل‌شده را می‌توان گزارش کرد." });
  }
  if (source.lines.length === 0) blockers.push({ code: "no_lines", message: "این فروش هیچ قلمی ندارد." });
  if (source.serviceChargeRial !== 0) {
    blockers.push({
      code: "service_charge_unsupported",
      message: "این فروش خدمات جداگانه دارد؛ گزارش آن هنوز پشتیبانی نمی‌شود.",
    });
  }

  const missingCodes = new Map<string, TaxBlocker>();
  for (const line of source.lines) {
    if (!line.taxCode || !TAX_ITEM_CODE_PATTERN.test(line.taxCode)) {
      const key = `${line.productKind ?? "none"}:${line.productId ?? line.name}`;
      if (!missingCodes.has(key)) {
        missingCodes.set(key, {
          code: "item_code_missing",
          message: `برای «${line.name}» شناسه کالا/خدمت ۱۳ رقمی ثبت نشده است.`,
          ...(line.productKind ? { productKind: line.productKind } : {}),
          ...(line.productId ? { productId: line.productId } : {}),
          productName: line.name,
        });
      }
    }
  }
  blockers.push(...missingCodes.values());

  const amountsValid =
    [source.subtotalRial, source.discountRial, source.vatRial, source.totalRial].every(isNonNegativeInteger) &&
    source.lines.every(
      (line) =>
        Number.isSafeInteger(line.quantity) &&
        line.quantity > 0 &&
        isNonNegativeInteger(line.unitPriceRial) &&
        Number.isSafeInteger(line.modifiersRial),
    );
  if (!amountsValid) {
    blockers.push({ code: "invalid_amount", message: "مبلغ‌ها باید عدد صحیح ریالی باشند." });
  }

  if (input.kind === "sale" && source.totalRial <= 0) {
    blockers.push({ code: "zero_total", message: "فروش صفر ریال صورتحساب ندارد." });
  }

  // A line's base is what the order totals sum: (unit price + modifiers) × quantity,
  // the same formula as computeLineSubtotal in src/lib/orders.ts. A line whose
  // modifiers push it below zero cannot be allocated over.
  const bases = source.lines.map((line) => line.quantity * (line.unitPriceRial + line.modifiersRial));
  const baseSum = bases.reduce((sum, base) => sum + base, 0);
  if (amountsValid && bases.some((base) => base < 0)) {
    blockers.push({ code: "invalid_amount", message: "قلمی با مبلغ منفی در فروش وجود دارد." });
  }
  if (amountsValid && baseSum !== source.subtotalRial) {
    blockers.push({ code: "totals_mismatch", message: "جمع قلم‌ها با جمع فرعی فروش برابر نیست." });
  }
  if (amountsValid && source.subtotalRial - source.discountRial + source.vatRial !== source.totalRial) {
    blockers.push({ code: "totals_mismatch", message: "جمع فرعی، تخفیف و مالیات با مبلغ کل برابر نیست." });
  }
  // The allocation below spreads the discount and the VAT over the lines' bases.
  // It can only do that when the bases can carry them, so a discount larger than
  // the lines, or VAT on nothing, is refused here rather than thrown later.
  if (amountsValid && source.discountRial > baseSum) {
    blockers.push({ code: "invalid_amount", message: "تخفیف بیش از جمع اقلام فروش است." });
  }
  if (amountsValid && baseSum - source.discountRial === 0 && source.vatRial !== 0) {
    blockers.push({ code: "invalid_amount", message: "مالیات بر مبلغ مشمول صفر ریالی محاسبه شده است." });
  }

  if (blockers.length > 0 || !amountsValid) return { ok: false, blockers };

  const discounts = allocateProportionally(source.discountRial, bases);
  const taxables = bases.map((base, index) => base - discounts[index]);
  const vats = allocateProportionally(source.vatRial, taxables);

  const lines: TaxPayloadLine[] = source.lines.map((line, index) => ({
    no: index + 1,
    productKind: line.productKind,
    productId: line.productId,
    taxCode: line.taxCode as string,
    name: line.name,
    quantity: line.quantity,
    unitPriceRial: line.unitPriceRial,
    modifiersRial: line.modifiersRial,
    baseRial: bases[index],
    discountRial: discounts[index],
    taxableRial: taxables[index],
    vatRial: vats[index],
    totalRial: taxables[index] + vats[index],
  }));

  const payload: TaxPayloadV1 = {
    version: TAX_PAYLOAD_VERSION,
    kind: input.kind,
    revision: input.revision,
    reference: input.reference,
    uid: input.uid,
    issuedAt: input.issuedAt,
    seller,
    buyer: source.buyer,
    source: {
      orderId: source.orderId,
      orderNumber: source.orderNumber,
      locationId: source.locationId,
      locationName: source.locationName,
      closedAt: source.closedAt,
    },
    parent: input.parent,
    reason: input.reason,
    vatMethod: TAX_VAT_METHOD,
    lines,
    totals: {
      subtotalRial: source.subtotalRial,
      discountRial: source.discountRial,
      vatRial: source.vatRial,
      totalRial: source.totalRial,
    },
  };
  return { ok: true, payload, hash: hashPayload(payload) };
}

/** Re-derive a stored snapshot's hash. False means the stored payload no longer matches what was prepared. */
export function verifyPayloadHash(snapshot: unknown, expectedHash: string): boolean {
  return hashPayload(snapshot) === expectedHash;
}

// ---------------------------------------------------------------------------
// Failures and what they do to a record
// ---------------------------------------------------------------------------

export interface ProviderIssue {
  code: string;
  message: string;
  field?: string;
}

/**
 * What went wrong when the record was sent. The adapter classifies each failure
 * into one of these; the policy below decides what the record does next.
 *
 *   not_delivered    the packet certainly did not reach the authority (refused
 *                    connection, DNS failure, 5xx before acceptance). Safe to
 *                    resend later with the same uid.
 *   unknown_delivery the request may have reached it (a timeout after the write,
 *                    a dropped response). Never resent blind: inquire first.
 *   rejected         the authority read the packet and refused it. Resending the
 *                    same content cannot help; the operator resubmits a revision.
 *   permanent        configuration or authentication failed. Stops until an
 *                    operator changes something.
 */
export type SendFailure =
  | { kind: "not_delivered"; code: string; message: string }
  | { kind: "unknown_delivery"; code: string; message: string }
  | { kind: "rejected"; issues: ProviderIssue[] }
  | { kind: "permanent"; code: string; message: string };

export interface SendOutcomeDecision {
  status: "queued" | "awaiting_inquiry" | "rejected" | "error";
  attempts: number;
  nextAttemptAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerErrors: ProviderIssue[];
}

export function decideAfterSendFailure(
  failure: SendFailure,
  attemptsBefore: number,
  now: Date,
): SendOutcomeDecision {
  const attempts = attemptsBefore + 1;
  switch (failure.kind) {
    case "not_delivered": {
      if (isDeadAfterAttempts(attempts)) {
        return {
          status: "error",
          attempts,
          nextAttemptAt: null,
          errorCode: "retries_exhausted",
          errorMessage: failure.message,
          providerErrors: [],
        };
      }
      return {
        status: "queued",
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
        errorCode: failure.code,
        errorMessage: failure.message,
        providerErrors: [],
      };
    }
    case "unknown_delivery":
      if (isDeadAfterAttempts(attempts)) {
        return {
          status: "error",
          attempts,
          nextAttemptAt: null,
          errorCode: "retries_exhausted",
          errorMessage: failure.message,
          providerErrors: [],
        };
      }
      return {
        status: "awaiting_inquiry",
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
        errorCode: failure.code,
        errorMessage: failure.message,
        providerErrors: [],
      };
    case "rejected":
      return {
        status: "rejected",
        attempts,
        nextAttemptAt: null,
        errorCode: "provider_rejected",
        errorMessage: failure.issues[0]?.message ?? "سامانه صورتحساب را رد کرد.",
        providerErrors: failure.issues,
      };
    case "permanent":
      return {
        status: "error",
        attempts,
        nextAttemptAt: null,
        errorCode: failure.code,
        errorMessage: failure.message,
        providerErrors: [],
      };
  }
}

/** What the authority reports when asked about a record. */
export type InquiryOutcome =
  | { state: "accepted"; receiptId: string | null }
  | { state: "rejected"; issues: ProviderIssue[] }
  | { state: "processing"; receiptId: string | null }
  | { state: "not_found" }
  | { state: "unreachable"; code: string; message: string };

export interface InquiryDecision {
  to: TaxStatus;
  receiptId: string | null;
  nextAttemptAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerErrors: ProviderIssue[];
}

/**
 * The status an inquiry leads to. `not_found` from `awaiting_inquiry` is the one
 * case that sends a record back to the queue: the authority has no packet under
 * this uid, so a resend (with the same uid, which the authority deduplicates on)
 * is safe. `not_found` from `submitted` is not expected, and is kept under watch
 * rather than resent.
 */
export function decideAfterInquiry(current: TaxStatus, outcome: InquiryOutcome, attempts: number, now: Date): InquiryDecision {
  const later = (n: number) => new Date(now.getTime() + backoffDelayMs(Math.max(1, n)));
  const none = { receiptId: null, nextAttemptAt: null, errorCode: null, errorMessage: null, providerErrors: [] };
  switch (outcome.state) {
    case "accepted":
      return { ...none, to: "accepted", receiptId: outcome.receiptId };
    case "rejected":
      return {
        ...none,
        to: "rejected",
        errorCode: "provider_rejected",
        errorMessage: outcome.issues[0]?.message ?? "سامانه صورتحساب را رد کرد.",
        providerErrors: outcome.issues,
      };
    case "processing":
      return { ...none, to: "submitted", receiptId: outcome.receiptId, nextAttemptAt: later(attempts) };
    case "not_found":
      if (current === "awaiting_inquiry") {
        return { ...none, to: "queued", nextAttemptAt: now, errorCode: "not_received", errorMessage: "سامانه این صورتحساب را دریافت نکرده است؛ ارسال مجدد با همان شناسه انجام می‌شود." };
      }
      return { ...none, to: "awaiting_inquiry", nextAttemptAt: later(attempts), errorCode: "not_found", errorMessage: "سامانه این صورتحساب را نیافت." };
    case "unreachable":
      return {
        ...none,
        to: current === "submitted" ? "awaiting_inquiry" : current,
        nextAttemptAt: later(attempts),
        errorCode: outcome.code,
        errorMessage: outcome.message,
      };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation: the register against the sales ledger
// ---------------------------------------------------------------------------

export interface ReconSource {
  orderId: string;
  orderNumber: number;
  locationId: string;
  locationName: string;
  closedAt: string;
  status: string;
  vatRial: number;
  totalRial: number;
}

export interface ReconRecord {
  id: string;
  orderId: string;
  kind: TaxKind;
  revision: number;
  status: TaxStatus;
  reference: string;
  receiptId: string | null;
  vatRial: number;
  totalRial: number;
}

/**
 *   accepted  the authority holds a record for this sale and its totals match
 *   pending   a record exists and its outcome is not yet known
 *   error     a record stopped on a failure an operator must look at
 *   rejected  the latest record was refused; no live record stands for the sale
 *   cancelled the sale was withdrawn by an accepted cancellation
 *   mismatch  a live record disagrees with the sale's current totals
 *   missing   a completed sale that no tax record reports
 *   voided    the sale was voided and no live record stands for it (not counted)
 */
export type ReconState = "accepted" | "pending" | "error" | "rejected" | "cancelled" | "mismatch" | "missing" | "voided";

export const RECON_STATES: readonly ReconState[] = [
  "accepted",
  "pending",
  "error",
  "rejected",
  "cancelled",
  "mismatch",
  "missing",
  "voided",
];

export interface ReconRow {
  orderId: string;
  orderNumber: number;
  locationId: string;
  locationName: string;
  closedAt: string;
  state: ReconState;
  kind: TaxKind | null;
  reference: string | null;
  recordStatus: TaxStatus | null;
  recordId: string | null;
  sourceTotalRial: number;
  sourceVatRial: number;
  recordTotalRial: number;
  recordVatRial: number;
}

export interface ReconTotals {
  sourceCount: number;
  sourceTotalRial: number;
  sourceVatRial: number;
  byState: Record<ReconState, { count: number; totalRial: number; vatRial: number }>;
  /** Σ (sale total − record total) over mismatched sales: what the two books disagree by. */
  differenceTotalRial: number;
  differenceVatRial: number;
  /** Σ totals of completed sales no tax record reports. */
  unrecordedTotalRial: number;
  unrecordedVatRial: number;
}

const PENDING: readonly TaxStatus[] = ["prepared", "queued", "sending", "submitted", "awaiting_inquiry"];

/**
 * The live record that stands for a sale: an accepted amendment if there is one,
 * else the latest live sale. A cancellation is not a standing record of the sale;
 * it withdraws one, and the sale's own status says so (see `reconcileSales`).
 */
function effectiveRecord(records: readonly ReconRecord[]): ReconRecord | null {
  const live = records.filter((record) => isLiveStatus(record.status) && record.kind !== "cancellation");
  const acceptedAmendments = live
    .filter((record) => record.kind === "amendment" && record.status === "accepted")
    .sort((a, b) => b.revision - a.revision);
  if (acceptedAmendments.length > 0) return acceptedAmendments[0];
  const sales = live.filter((record) => record.kind === "sale").sort((a, b) => b.revision - a.revision);
  if (sales.length > 0) return sales[0];
  return null;
}

/**
 * Tie every completed sale to the tax record that reports it. Voided sales are
 * excluded from the totals unless a live record still stands for them, which is
 * itself a mismatch to resolve. Pure: the service supplies both lists.
 */
export function reconcileSales(
  sources: readonly ReconSource[],
  records: readonly ReconRecord[],
): { rows: ReconRow[]; totals: ReconTotals } {
  const byOrder = new Map<string, ReconRecord[]>();
  for (const record of records) {
    const list = byOrder.get(record.orderId) ?? [];
    list.push(record);
    byOrder.set(record.orderId, list);
  }

  const rows: ReconRow[] = [];
  for (const source of sources) {
    const orderRecords = byOrder.get(source.orderId) ?? [];
    const effective = effectiveRecord(orderRecords);
    const latestSale = orderRecords
      .filter((record) => record.kind === "sale")
      .sort((a, b) => b.revision - a.revision)[0];
    // A voided sale is worth nothing to the books. If the authority still holds a
    // live record for it, that record is what the difference is made of.
    const completed = source.status === "completed";
    const base = {
      orderId: source.orderId,
      orderNumber: source.orderNumber,
      locationId: source.locationId,
      locationName: source.locationName,
      closedAt: source.closedAt,
      kind: effective?.kind ?? latestSale?.kind ?? null,
      reference: effective?.reference ?? latestSale?.reference ?? null,
      recordStatus: effective?.status ?? latestSale?.status ?? null,
      recordId: effective?.id ?? latestSale?.id ?? null,
      sourceTotalRial: completed ? source.totalRial : 0,
      sourceVatRial: completed ? source.vatRial : 0,
      recordTotalRial: effective?.totalRial ?? 0,
      recordVatRial: effective?.vatRial ?? 0,
    };

    let state: ReconState;
    if (!completed) {
      // Any live record for a voided sale is a record the books do not hold.
      state = effective !== null ? "mismatch" : "voided";
    } else if (!effective) {
      state = latestSale?.status === "cancelled" ? "cancelled" : latestSale ? "rejected" : "missing";
    } else if (effective.status === "accepted" || PENDING.includes(effective.status)) {
      const agrees = effective.totalRial === source.totalRial && effective.vatRial === source.vatRial;
      state = effective.status === "accepted" ? (agrees ? "accepted" : "mismatch") : agrees ? "pending" : "mismatch";
    } else if (effective.status === "error") {
      state = "error";
    } else {
      state = "rejected";
    }

    rows.push({ ...base, state });
  }

  const byState = Object.fromEntries(
    RECON_STATES.map((state) => [state, { count: 0, totalRial: 0, vatRial: 0 }]),
  ) as ReconTotals["byState"];
  const totals: ReconTotals = {
    sourceCount: 0,
    sourceTotalRial: 0,
    sourceVatRial: 0,
    byState,
    differenceTotalRial: 0,
    differenceVatRial: 0,
    unrecordedTotalRial: 0,
    unrecordedVatRial: 0,
  };
  for (const row of rows) {
    if (row.state === "voided") {
      byState.voided.count += 1;
      continue;
    }
    totals.sourceCount += 1;
    totals.sourceTotalRial += row.sourceTotalRial;
    totals.sourceVatRial += row.sourceVatRial;
    const bucket = byState[row.state];
    bucket.count += 1;
    bucket.totalRial += row.sourceTotalRial;
    bucket.vatRial += row.sourceVatRial;
    if (row.state === "mismatch") {
      totals.differenceTotalRial += row.sourceTotalRial - row.recordTotalRial;
      totals.differenceVatRial += row.sourceVatRial - row.recordVatRial;
    }
    if (row.state === "missing") {
      totals.unrecordedTotalRial += row.sourceTotalRial;
      totals.unrecordedVatRial += row.sourceVatRial;
    }
  }
  return { rows, totals };
}
