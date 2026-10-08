/**
 * Shared AR/AP voucher vocabulary — Issue #829.
 *
 * Framework-free (no `db`, no `next/`) so the services, the API routes and the
 * browser forms all read the same settlement methods, cursor shape and filter
 * vocabulary. The DB half (posting, validation, pagination queries) lives in
 * `ar-service.ts`, `ap-service.ts` and `installments-service.ts`.
 */

import { WELL_KNOWN_CODES } from "./coa-template";

/**
 * Settlement classification. `method` is display/metadata; the authoritative
 * posting destination is `settlement_account_id`.
 *
 * - `cash`     → صندوق (1100)
 * - `bank`     → بانک — direct transfer/payment (1110)
 * - `clearing` → کارت‌خوان/درگاه در راه (1120)
 *
 * Pre-#829 `bank` vouchers posted to 1120; their rows keep
 * `settlement_account_id` pointing at 1120 (migration 0212 backfill), so the
 * register shows the account the money actually moved on.
 */
export const SETTLEMENT_METHODS = ["cash", "bank", "clearing"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

/** Legacy two-value shape still accepted on the wire (mapped forward). */
export const LEGACY_SETTLEMENT_METHODS = ["cash", "bank"] as const;

export const SETTLEMENT_METHOD_LABELS: Record<SettlementMethod, string> = {
  cash: "نقدی",
  bank: "بانکی",
  clearing: "اسناد در جریان وصول",
};

export function isSettlementMethod(value: unknown): value is SettlementMethod {
  return (
    typeof value === "string" &&
    (SETTLEMENT_METHODS as readonly string[]).includes(value)
  );
}

/** The well-known account code a method resolves to when no explicit settlement account is given. */
export function settlementCodeForMethod(method: SettlementMethod): string {
  switch (method) {
    case "cash":
      return WELL_KNOWN_CODES.cash;
    case "bank":
      return WELL_KNOWN_CODES.bank;
    case "clearing":
      return WELL_KNOWN_CODES.bankClearing;
  }
}

/** Voucher status filter. */
export type VoucherStatusFilter = "all" | "active" | "reversed";

export function isVoucherStatusFilter(value: unknown): value is VoucherStatusFilter {
  return value === "all" || value === "active" || value === "reversed";
}

/**
 * Server-backed register filters. Every field is optional; absent means
 * unfiltered. Dates are ISO `YYYY-MM-DD` on the wire (Shamsi at the edge).
 */
export interface VoucherListFilters {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  method?: SettlementMethod;
  settlementAccountId?: string;
  partyId?: string;
  locationId?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: VoucherStatusFilter;
}

/** Default page size for the voucher register. */
export const VOUCHER_PAGE_SIZE = 50;
/** Hard cap so a crafted `?limit=` cannot ask for the whole history at once. */
export const VOUCHER_PAGE_SIZE_MAX = 100;

/**
 * Stable newest-first cursor over (voucher date, created_at, id).
 * Opaque to callers: base64url-encoded JSON.
 */
export interface VoucherCursor {
  date: string;
  createdAt: string;
  id: string;
}

function toBase64Url(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64url");
  }
  // Browser fallback.
  return btoa(unescape(encodeURIComponent(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(cursor: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(cursor, "base64url").toString("utf8");
    }
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return null;
  }
}

export function encodeVoucherCursor(cursor: VoucherCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function decodeVoucherCursor(value: unknown): VoucherCursor | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  const text = fromBase64Url(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<VoucherCursor>;
    if (
      typeof parsed.date !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string"
    ) {
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return null;
    return { date: parsed.date, createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Client-generated idempotency key per logical voucher submission.
 * A UUID when the runtime offers one, else a timestamp + random fallback.
 * The service layer treats the key as opaque (1–128 chars).
 */
export function newIdempotencyKey(): string {
  const cryptoRef =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoRef?.randomUUID) {
    try {
      return cryptoRef.randomUUID();
    } catch {
      // fall through to the fallback below
    }
  }
  return `voucher-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Stable voucher reference shown in the register (`#` is no longer
 * `index + 1`). ASCII digits — callers wrap in `toPersianDigits` for display.
 * A null number (legacy rows predating migration 0212 backfill, or a row
 * whose counter never ran) falls back to the id prefix so the cell is never
 * blank.
 */
export function voucherReference(
  kind: "receipt" | "payment",
  voucherNumber: number | null,
  fallbackId?: string,
): string {
  const noun = kind === "receipt" ? "دریافت" : "پرداخت";
  if (voucherNumber !== null && Number.isSafeInteger(voucherNumber) && voucherNumber > 0) {
    return `${noun} #${voucherNumber}`;
  }
  if (fallbackId) return `${noun} ${fallbackId.slice(0, 8)}`;
  return noun;
}
