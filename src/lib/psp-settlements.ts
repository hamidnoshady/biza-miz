import { createHash } from "node:crypto";
import { toLatinDigits } from "./digits";
import { amountToRialText, TRANSFER_REFERENCE_MAX, type TransferRequestInput } from "./financial-transfers";
import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";

export const PSP_SETTLEMENT_KEY_PREFIX = "psp-settlement:";

export interface PspSettlementMetadata {
  batchReference: string;
  movementReference: string;
  batchGrossAmount: string;
  expectedOn: string | null;
}

function reference(value: unknown): string | null {
  const text = typeof value === "string" ? toLatinDigits(value.trim().normalize("NFC")) : "";
  return text && text.length <= TRANSFER_REFERENCE_MAX && !/\p{C}/u.test(text) ? text : null;
}

function optional(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

export function pspSettlementKey(terminalId: string, movementReference: string): string {
  const digest = createHash("sha256").update(JSON.stringify([terminalId.toLowerCase(), movementReference])).digest("hex");
  return `${PSP_SETTLEMENT_KEY_PREFIX}${digest}`;
}

export function pspSettlementProblem(input: Record<string, unknown>): string | null {
  if (!isUuid(input.terminalAccountId) || !isUuid(input.bankAccountId) ||
      input.terminalAccountId.toLowerCase() === input.bankAccountId.toLowerCase()) return "invalid_psp_accounts";
  if (!reference(input.batchReference) || !reference(input.movementReference)) return "invalid_psp_reference";
  if (!isValidIsoDate(input.settledOn)) return "invalid_transfer_date";
  if (!optional(input.expectedOn) && !isValidIsoDate(input.expectedOn)) return "invalid_psp_expected_date";
  const batchGross = amountToRialText(input.batchGrossAmount, "batchGrossAmount");
  const net = amountToRialText(input.netAmount, "netAmount");
  const fee = optional(input.feeAmount) ? "0" : amountToRialText(input.feeAmount, "feeAmount");
  if (!batchGross || batchGross === "0" || !net || net === "0" || fee === null) return "invalid_psp_amount";
  if (fee === "0" ? !optional(input.feeAccountId) : !isUuid(input.feeAccountId)) return "invalid_psp_fee_account";
  if (BigInt(net) + BigInt(fee) > BigInt(batchGross)) return "psp_batch_amount_exceeded";
  return null;
}

/** Only an actual, confirmed deposit belongs in the transfer journal. */
export function parsePspSettlement(body: Record<string, unknown>): (PspSettlementMetadata & { input: TransferRequestInput }) | null {
  if (pspSettlementProblem(body)) return null;
  const batchReference = reference(body.batchReference)!;
  const movementReference = reference(body.movementReference)!;
  const terminalId = String(body.terminalAccountId).toLowerCase();
  const net = amountToRialText(body.netAmount, "netAmount")!;
  const fee = optional(body.feeAmount) ? "0" : amountToRialText(body.feeAmount, "feeAmount")!;
  return {
    batchReference, movementReference,
    batchGrossAmount: amountToRialText(body.batchGrossAmount, "batchGrossAmount")!,
    expectedOn: optional(body.expectedOn) ? null : String(body.expectedOn),
    input: {
      sourceAccountId: terminalId,
      destinationAccountId: String(body.bankAccountId).toLowerCase(),
      transferDate: body.settledOn,
      amount: (BigInt(net) + BigInt(fee)).toString(),
      feeAmount: fee,
      feePayer: "destination",
      feeAccountId: fee === "0" ? null : String(body.feeAccountId).toLowerCase(),
      referenceNumber: movementReference,
      description: body.description,
      attachmentAssetId: body.attachmentAssetId,
      idempotencyKey: pspSettlementKey(terminalId, movementReference),
    },
  };
}
