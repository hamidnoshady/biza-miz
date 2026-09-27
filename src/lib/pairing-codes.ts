/**
 * One-time pairing codes — the credential a desktop install presents to claim
 * an existing online business.
 *
 * Pure by design (only node:crypto), so it is unit-tested directly; the
 * database side lives in pairing-service.ts.
 *
 * The alphabet excludes O/0 and I/1 because a code's whole job is to survive
 * being read aloud over the phone and typed by someone who is not a
 * developer. normalizePairingCode folds the excluded characters back onto
 * their look-alikes rather than rejecting them, so a code typed as "0" still
 * matches the "O" that was issued.
 */
import { createHash, randomInt } from "node:crypto";
import { PAIRING_CODE_ALPHABET, foldDigits } from "./code-alphabet";

export { PAIRING_CODE_ALPHABET };

/** How long an issued code stays redeemable. Long enough to post it, short enough to matter. */
export const PAIRING_CODE_TTL_HOURS = 72;
/** A desktop has this long to apply the prepared snapshot and acknowledge it. */
export const PAIRING_RESERVATION_TTL_MINUTES = 30;

const GROUPS = 3;
const GROUP_LENGTH = 4;

/** A fresh code in display form: XXXX-XXXX-XXXX. */
export function generatePairingCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      group += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Display form (or anything close to it) -> the 12 characters that get hashed. */
export function normalizePairingCode(raw: string): string {
  return foldDigits(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replaceAll("0", "O")
    .replaceAll("1", "I");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code)).digest("hex");
}

export type PairingEnrollmentState = "issued" | "reserved" | "snapshot_prepared" | "active" | "failed";
export type PairingCodeState =
  | "valid"
  | "code_pending_activation"
  | "code_expired"
  | "code_already_redeemed"
  | "code_revoked";

export interface PairingCodeRow {
  expiresAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  enrollmentState?: PairingEnrollmentState;
}

/**
 * Why a code can't be used, or "valid".
 *
 * A snapshot reservation is intentionally not reported as a redeem. It is a
 * recoverable pending enrollment: it becomes usable again when the reservation
 * expires and is cleaned up, whereas an activated code is irreversibly spent.
 */
export function pairingCodeState(row: PairingCodeRow, now: Date): PairingCodeState {
  if (row.redeemedAt || row.enrollmentState === "active") return "code_already_redeemed";
  if (row.revokedAt) return "code_revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "code_expired";
  if (row.enrollmentState === "reserved" || row.enrollmentState === "snapshot_prepared") {
    return "code_pending_activation";
  }
  return "valid";
}
