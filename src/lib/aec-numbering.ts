/**
 * Per-project document numbers for the AEC registers (`MR-001`, `RFQ-001`,
 * `PO-001`, `VO-001`, `PC-001`, …).
 *
 * The rule itself — one advisory transaction lock, one prefix, one padded
 * sequence per project — now lives in `register-numbering.ts`, where it moved
 * when issue #1128's agency registers needed the same numbering rather than a
 * second copy of it. This module is the AEC-named door its five callers were
 * written against and keeps the AEC-only half of the table union, so an AEC
 * tenant sees no change at all: same numbers, same lock key, same sequence.
 *
 * Extracted in Wave 9 rather than copied: five registers number their rows, and
 * "how a register numbers its documents" is a rule, not five implementations of
 * it. Wave 8's `nextCommercialNumber` moved here unchanged, so the commercial
 * registers' numbers are bit-for-bit what they were.
 */
import {
  formatRegisterNumber,
  nextNumberInSeries,
  nextRegisterNumber,
  REGISTER_NUMBERING_LOCK_SEED,
} from "./register-numbering";

export const AEC_NUMBERING_LOCK_SEED = REGISTER_NUMBERING_LOCK_SEED;

export type AecNumberedTable =
  | "aec_variations"
  | "aec_payment_certificates"
  | "aec_material_requests"
  | "aec_rfqs"
  | "aec_commitments";

export type AecNumberedColumn =
  | "variation_number"
  | "certificate_number"
  | "request_number"
  | "rfq_number"
  | "commitment_number";

/** A register number, formatted the one way every register formats it. */
export const formatAecNumber = formatRegisterNumber;

/**
 * The next number in a series, for a *suggestion* rather than an allocation —
 * the field screen prefills an RFI number the person may keep or overwrite.
 */
export { nextNumberInSeries };

/**
 * The next number for a project, inside the caller's transaction.
 *
 * Must be called inside one: the lock it takes is released at commit, and the
 * insert it exists to serialise has to be in the same transaction or the lock
 * guards nothing.
 */
export async function nextAecNumber(
  table: AecNumberedTable,
  projectId: string,
  prefix: string,
): Promise<string> {
  return nextRegisterNumber(table, projectId, prefix);
}
