/**
 * «انتقال وجه» — the framework-free half of the internal-transfer document
 * (issue #862).
 *
 * What a transfer request has to look like, what entry it must produce, and
 * which transitions a posted document still allows. The DB-touching half is
 * `financial-transfers-service.ts`; the API route parses its raw JSON with the
 * functions here before it touches the database, and the screen draws the
 * journal preview from `buildTransferLines` — the same function the service
 * posts, so the preview cannot promise an entry the server would refuse to
 * write.
 *
 * MONEY
 *
 * Every amount in this module is integer Rial *text* and every sum is a BigInt
 * sum. The one place a `number` is accepted is an API body that sent one
 * (`amountToRialText`), and it is converted to text at the door: a transfer of
 * ۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ ریال is a valid `bigint` and a lossy `number`, and the
 * difference between the two is money.
 *
 * THE ENTRY
 *
 *   fee payer «source»       Dr destination A, Dr fee F, Cr source (A+F)
 *   fee payer «destination»  Dr destination (A−F), Dr fee F, Cr source A
 *
 * Both are balanced by construction, both move the fee to a real expense
 * account, and neither invents a rate: a transfer between two accounts of
 * different currencies is refused (`currency_mismatch`) rather than converted.
 */

import { isCanonicalUnsignedIntegerText } from "./numeric-validation";
import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { MAX_RIAL } from "./inventory-exact";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TRANSFER_STATUSES = ["posted", "reversed"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_POSTING_MODES = ["transfer", "reversal"] as const;
export type TransferPostingMode = (typeof TRANSFER_POSTING_MODES)[number];

export const TRANSFER_FEE_PAYERS = ["source", "destination"] as const;
export type TransferFeePayer = (typeof TRANSFER_FEE_PAYERS)[number];

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  posted: "ثبت‌شده",
  reversed: "برگشت‌خورده",
};

export const TRANSFER_FEE_PAYER_LABELS: Record<TransferFeePayer, string> = {
  source: "کارمزد از حساب مبدأ کسر می‌شود",
  destination: "کارمزد از مبلغ رسیده به مقصد کسر می‌شود",
};

/**
 * Longest a description or a reference may be — the same bounds the database
 * columns carry, so a request that passes here can never be rejected by the
 * CHECK that would have raised a 500 instead of a field error.
 */
export const TRANSFER_DESCRIPTION_MAX = 400;
export const TRANSFER_REFERENCE_MAX = 60;
export const TRANSFER_REVERSAL_REASON_MAX = 400;

export function isTransferStatus(value: unknown): value is TransferStatus {
  return typeof value === "string" && (TRANSFER_STATUSES as readonly string[]).includes(value);
}

export function isTransferFeePayer(value: unknown): value is TransferFeePayer {
  return typeof value === "string" && (TRANSFER_FEE_PAYERS as readonly string[]).includes(value);
}

/**
 * The document's number: `TR-000123`, from the tenant's own sequence.
 *
 * A stable, sortable, human-readable identity that never depends on the date:
 * a transfer's number is what a person quotes on the phone, and re-numbering a
 * year would move documents between statements.
 */
export function transferNumberFor(sequenceNo: number | bigint | string): string {
  const value =
    typeof sequenceNo === "bigint"
      ? sequenceNo
      : typeof sequenceNo === "string"
        ? BigInt(sequenceNo.trim() || "0")
        : BigInt(Math.trunc(sequenceNo));
  if (value <= 0n) throw new Error("invalid_transfer_sequence");
  return `TR-${value.toString().padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * A posted amount as integer Rial text.
 *
 * Accepts the canonical text the API and the screen send, and — for a caller
 * that sent a JSON number, which is what a legacy client does — a safe integer
 * that is already whole Rial. A fractional amount is refused rather than
 * rounded: `isWholeRial`-style tolerance belongs to user *input*, not to an
 * amount that has already been denominated.
 */
export function amountToRialText(value: unknown, field: string): string | null {
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (!isCanonicalUnsignedIntegerText(cleaned)) return null;
    return BigInt(cleaned) <= MAX_RIAL ? BigInt(cleaned).toString() : null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value.toString();
  }
  return null;
}

/** The exact sum of two unsigned amounts as text (used by the fee arithmetic). */
export function addAmounts(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

export function subtractAmounts(left: string, right: string): string {
  return (BigInt(left) - BigInt(right)).toString();
}

export function isPositiveAmountText(value: string): boolean {
  return isCanonicalUnsignedIntegerText(value) && BigInt(value) > 0n;
}

// ---------------------------------------------------------------------------
// The entry a transfer builds
// ---------------------------------------------------------------------------

export interface TransferLine {
  accountId: string;
  /** Integer Rial text. */
  debit: string;
  credit: string;
}

export interface TransferPostingAccounts {
  sourceGlAccountId: string;
  destinationGlAccountId: string;
  /** Required when the transfer carries a fee. */
  feeGlAccountId: string | null;
}

export interface TransferPostingInput {
  amount: string;
  feeAmount: string;
  feePayer: TransferFeePayer;
}

export interface TransferBuildResult {
  lines: TransferLine[];
  /** What the source account is credited — the whole outflow including a fee taken from it. */
  sourceOutflow: string;
  /** What the destination account is debited — the amount actually received. */
  destinationInflow: string;
}

/**
 * The balanced entry a transfer posts, or `null` when the inputs cannot make
 * one (a zero amount, a fee with no expense account, a fee larger than the
 * transfer it is taken out of, both accounts resolving to the same GL identity).
 *
 * `null` rather than a thrown error because two callers ask this question for
 * different reasons: the route turns it into a typed 400 and the form into a
 * disabled button. `transferPostingProblem` is what names the reason.
 */
export function buildTransferLines(
  accounts: TransferPostingAccounts,
  input: TransferPostingInput,
): TransferBuildResult | null {
  if (!isPositiveAmountText(input.amount)) return null;
  if (!isCanonicalUnsignedIntegerText(input.feeAmount)) return null;
  const fee = BigInt(input.feeAmount);
  if (fee > 0n && !accounts.feeGlAccountId) return null;
  if (accounts.sourceGlAccountId === accounts.destinationGlAccountId) return null;
  const amount = BigInt(input.amount);

  if (input.feePayer === "destination") {
    if (fee >= amount) return null;
    const received = (amount - fee).toString();
    const lines: TransferLine[] = [
      { accountId: accounts.destinationGlAccountId, debit: received, credit: "0" },
      { accountId: accounts.feeGlAccountId!, debit: input.feeAmount, credit: "0" },
      { accountId: accounts.sourceGlAccountId, debit: "0", credit: input.amount },
    ];
    return { lines, sourceOutflow: input.amount, destinationInflow: received };
  }

  const outflow = (amount + fee).toString();
  const lines: TransferLine[] = [
    { accountId: accounts.destinationGlAccountId, debit: input.amount, credit: "0" },
  ];
  if (fee > 0n) lines.push({ accountId: accounts.feeGlAccountId!, debit: input.feeAmount, credit: "0" });
  lines.push({ accountId: accounts.sourceGlAccountId, debit: "0", credit: outflow });
  return { lines, sourceOutflow: outflow, destinationInflow: input.amount };
}

/** Why `buildTransferLines` returned null, as a code the API translates. */
export function transferPostingProblem(
  accounts: TransferPostingAccounts,
  input: TransferPostingInput,
): string | null {
  if (!isPositiveAmountText(input.amount)) return "invalid_amount";
  if (!isCanonicalUnsignedIntegerText(input.feeAmount)) return "invalid_fee";
  if (accounts.sourceGlAccountId === accounts.destinationGlAccountId) return "same_gl_account";
  const fee = BigInt(input.feeAmount);
  if (fee > 0n && !accounts.feeGlAccountId) return "fee_account_required";
  if (input.feePayer === "destination" && fee >= BigInt(input.amount)) return "fee_exceeds_amount";
  return null;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export interface TransferRequestInput {
  transferDate?: unknown;
  sourceAccountId?: unknown;
  destinationAccountId?: unknown;
  amount?: unknown;
  feeAmount?: unknown;
  feeAccountId?: unknown;
  feePayer?: unknown;
  referenceNumber?: unknown;
  description?: unknown;
  projectId?: unknown;
  attachmentAssetId?: unknown;
  idempotencyKey?: unknown;
}

export interface TransferRequestProblem {
  code: string;
  field: string | null;
}

function optionalBoundedText(
  value: unknown,
  field: string,
  max: number,
): TransferRequestProblem | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { code: `invalid_${field}`, field };
  if (value.trim().length > max) return { code: `${field}_too_long`, field };
  return null;
}

/**
 * Everything a create request must satisfy before the database sees it.
 *
 * The rules that need the ledger — eligibility of the two accounts, their
 * currency, the branch scope, the fee account's role — are enforced by the
 * service, which is the only layer that can read the chart. What is here is
 * what a *request* can be wrong about on its own.
 */
export function transferRequestProblem(input: TransferRequestInput): TransferRequestProblem | null {
  if (input.transferDate === undefined || input.transferDate === null || input.transferDate === "") {
    return { code: "transfer_date_required", field: "transferDate" };
  }
  if (typeof input.transferDate !== "string" || !isValidIsoDate(input.transferDate)) {
    return { code: "invalid_transfer_date", field: "transferDate" };
  }
  if (typeof input.sourceAccountId !== "string" || !isUuid(input.sourceAccountId)) {
    return { code: "source_account_required", field: "sourceAccountId" };
  }
  if (typeof input.destinationAccountId !== "string" || !isUuid(input.destinationAccountId)) {
    return { code: "destination_account_required", field: "destinationAccountId" };
  }
  if (input.sourceAccountId === input.destinationAccountId) {
    return { code: "same_account", field: "destinationAccountId" };
  }
  const amount = amountToRialText(input.amount, "amount");
  if (amount === null || !isPositiveAmountText(amount)) return { code: "invalid_amount", field: "amount" };

  if (input.feeAmount !== undefined && input.feeAmount !== null && input.feeAmount !== "") {
    const fee = amountToRialText(input.feeAmount, "feeAmount");
    if (fee === null) return { code: "invalid_fee", field: "feeAmount" };
    if (BigInt(fee) > 0n) {
      if (typeof input.feeAccountId !== "string" || !isUuid(input.feeAccountId)) {
        return { code: "fee_account_required", field: "feeAccountId" };
      }
      if (input.feePayer !== undefined && !isTransferFeePayer(input.feePayer)) {
        return { code: "invalid_fee_payer", field: "feePayer" };
      }
      if (input.feePayer === "destination" && BigInt(fee) >= BigInt(amount)) {
        return { code: "fee_exceeds_amount", field: "feeAmount" };
      }
    }
  } else if (input.feeAccountId !== undefined && input.feeAccountId !== null && input.feeAccountId !== "") {
    // A fee account with no fee is not an error a person can make in the form
    // (the field is hidden), so it is a caller's mistake worth naming.
    return { code: "fee_account_without_fee", field: "feeAccountId" };
  }

  for (const [field, max] of [
    ["description", TRANSFER_DESCRIPTION_MAX],
    ["referenceNumber", TRANSFER_REFERENCE_MAX],
  ] as const) {
    const problem = optionalBoundedText(input[field as keyof TransferRequestInput], field, max);
    if (problem) return problem;
  }

  for (const field of ["projectId", "attachmentAssetId"] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !isUuid(value)) return { code: `invalid_${field}`, field };
  }
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey !== "") {
    if (typeof input.idempotencyKey !== "string") return { code: "invalid_idempotency_key", field: "idempotencyKey" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** A posted transfer may only be reversed; a reversed one may do nothing at all. */
export function canReverseTransfer(status: TransferStatus): boolean {
  return status === "posted";
}

/**
 * Whether a posted transfer's own fields may still be edited.
 *
 * Never. A transfer is a financial document: the amount, the accounts and the
 * date are what its journal entry says, and editing them would leave the entry
 * describing something that no longer exists. Corrections go through reversal.
 */
export function canEditTransfer(): false {
  return false;
}

/** What a repeated reversal request means: the already-posted mirror, or a refusal. */
export function reversalDisposition(params: {
  status: TransferStatus;
  /** The idempotency key the reversal document was posted with, when it has one. */
  reversalKey: string | null;
  /** The key this request carries, when it carries one. */
  requestKey: string | null;
}): { kind: "idempotent" } | { kind: "refuse"; code: string } | { kind: "proceed" } {
  if (params.status !== "reversed") return { kind: "proceed" };
  if (params.requestKey && params.reversalKey && params.requestKey === params.reversalKey) {
    return { kind: "idempotent" };
  }
  return { kind: "refuse", code: "transfer_already_reversed" };
}

/** Net effect of a document and its mirror — always zero, and asserted by the tests. */
export function transferNetEffect(original: readonly TransferLine[], reversal: readonly TransferLine[]): Map<string, string> {
  const net = new Map<string, bigint>();
  for (const line of original) {
    net.set(line.accountId, (net.get(line.accountId) ?? 0n) + BigInt(line.debit) - BigInt(line.credit));
  }
  for (const line of reversal) {
    net.set(line.accountId, (net.get(line.accountId) ?? 0n) + BigInt(line.debit) - BigInt(line.credit));
  }
  return new Map([...net].map(([accountId, value]) => [accountId, value.toString()]));
}
