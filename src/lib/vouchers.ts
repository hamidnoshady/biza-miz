/**
 * Accounting voucher identity — the pure half (issue #867).
 *
 * Every journal entry carries `voucher_no` = `JV-<Jalali year>-<6 digits>`,
 * assigned by the database (migration 0216). This module is the one place the
 * TypeScript side formats or validates that identity, so a screen, a PDF and an
 * API response cannot disagree about how a voucher is written.
 *
 * Stored as ASCII. Persian digits are display-only (CLAUDE.md "Numbers"), so
 * a reference typed with Persian digits is normalised to ASCII before it is
 * stored or compared.
 */
import { toLatinDigits } from "./digits";

export const VOUCHER_NO_PREFIX = "JV";
export const VOUCHER_NUMBER_WIDTH = 6;
export const EXTERNAL_REFERENCE_MAX_LENGTH = 60;
export const VOUCHER_REASON_MAX_LENGTH = 500;

/** `JV-1405-000042`. Throws on anything that is not a positive whole number. */
export function formatVoucherNo(voucherYear: number, voucherNumber: number): string {
  if (!Number.isSafeInteger(voucherYear) || voucherYear < 1 || voucherYear > 9999) {
    throw new Error("invalid_voucher_year");
  }
  if (!Number.isSafeInteger(voucherNumber) || voucherNumber < 1) {
    throw new Error("invalid_voucher_number");
  }
  return `${VOUCHER_NO_PREFIX}-${voucherYear}-${String(voucherNumber).padStart(VOUCHER_NUMBER_WIDTH, "0")}`;
}

export type VoucherReferenceResult =
  | { ok: true; value: string | null }
  | { ok: false; error: "reference_too_long" | "reference_invalid_characters" };

/**
 * A controlled reference is the number the business already prints on its own
 * paper. Allowed: letters (any script), digits (Latin or Persian), space,
 * `-`, `_`, `/`, `.`, `#`. An empty value means "no reference" and is `null`.
 */
export function normalizeVoucherReference(input: string | null | undefined): VoucherReferenceResult {
  if (input === null || input === undefined) return { ok: true, value: null };
  const value = toLatinDigits(String(input)).replace(/\s+/g, " ").trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > EXTERNAL_REFERENCE_MAX_LENGTH) return { ok: false, error: "reference_too_long" };
  // \p{L} covers Persian and Latin letters; \p{N} covers any digit class left.
  if (!/^[\p{L}\p{N} \-_/.#]+$/u.test(value)) return { ok: false, error: "reference_invalid_characters" };
  return { ok: true, value };
}

/** A change to a voucher's identity must say why. Returns the trimmed reason or null. */
export function normalizeVoucherChangeReason(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value === "" || value.length > VOUCHER_REASON_MAX_LENGTH) return null;
  return value;
}

/**
 * A renumber target must be a number the sequence has already issued and that
 * no document now holds — a gap. Anything above the sequence's last issued
 * number would be re-issued by a future posting, so it is refused.
 */
export function renumberTargetError(
  target: unknown,
  current: number,
  lastIssued: number,
): "invalid_voucher_number" | "same_voucher_number" | "voucher_number_out_of_range" | null {
  if (typeof target !== "number" || !Number.isSafeInteger(target) || target < 1) {
    return "invalid_voucher_number";
  }
  if (target === current) return "same_voucher_number";
  if (target > lastIssued) return "voucher_number_out_of_range";
  return null;
}
