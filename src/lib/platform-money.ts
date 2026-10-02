/**
 * Money helpers for the super-admin console — the ONE place the Rial↔Toman
 * conversion lives (§41). Storage, the ledger, invoices and every API
 * contract are integer Rial; the console *displays* Toman.
 *
 *   1 Toman = 10 Rial — never spell `value * 10` in a component again.
 */
import { toPersianDigits } from "./digits";

export const RIAL_PER_TOMAN = 10;

const PERSIAN_DIGIT_BASE = 0x06f0;
const ARABIC_DIGIT_BASE = 0x0660;

/**
 * Normalize Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII (0-9) and
 * strip thousand separators (`,`, `٬`, `،`, `_`, spaces, ZWNJ).
 */
export function normalizeNumericString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= PERSIAN_DIGIT_BASE && code <= PERSIAN_DIGIT_BASE + 9) {
      out += String(code - PERSIAN_DIGIT_BASE);
    } else if (code >= ARABIC_DIGIT_BASE && code <= ARABIC_DIGIT_BASE + 9) {
      out += String(code - ARABIC_DIGIT_BASE);
    } else if (code === 0x066b) {
      out += ".";
    } else if (
      code === 0x002c || // ,
      code === 0x066c || // ٬
      code === 0x060c || // ،
      code === 0x005f || // _
      code === 0x200c || // ZWNJ
      code === 0x0020 ||
      code === 0x00a0 ||
      code === 0x2009 ||
      code === 0x202f
    ) {
      // thousand separator / grouping space — strip
      continue;
    } else {
      out += raw[i];
    }
  }
  return out.trim();
}

export interface SafeIntParseOptions {
  min?: number;
  max?: number;
  allowZero?: boolean;
}

/**
 * Parse a user- or API-supplied value into a validated safe integer.
 * Accepts numbers or strings with Persian/Arabic digits and thousand separators.
 * Returns `null` when malformed, negative (unless min < 0), decimal, or outside
 * safe integer bounds.
 */
export function parseSafeIntInput(
  value: unknown,
  options: SafeIntParseOptions = {},
): number | null {
  const min = options.min ?? (options.allowZero === false ? 1 : 0);
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    if (value < min || value > max) return null;
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = normalizeNumericString(trimmed);
    if (!/^-?\d+$/.test(normalized)) return null;
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) return null;
    if (parsed < min || parsed > max) return null;
    return parsed;
  }

  return null;
}

/**
 * Parse an optional integer input where `undefined`, `null`, or `""` means "empty / unset".
 * Returns `{ ok: true, value: number | null }` or `{ ok: false }`.
 */
export function parseOptionalSafeIntInput(
  value: unknown,
  options: SafeIntParseOptions = {},
): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string" && value.trim() === "") return { ok: true, value: null };
  const parsed = parseSafeIntInput(value, options);
  if (parsed === null) return { ok: false };
  return { ok: true, value: parsed };
}

/**
 * Parse a comma/Persian-comma separated list of integer percentage thresholds (1..100).
 */
export function parseThresholdsInput(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const nums: number[] = [];
    for (const item of value) {
      const n = parseSafeIntInput(item, { min: 1, max: 100 });
      if (n === null) return null;
      nums.push(n);
    }
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  if (typeof value === "string") {
    const parts = value
      .split(/[,،٬\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return [];
    const nums: number[] = [];
    for (const part of parts) {
      const n = parseSafeIntInput(part, { min: 1, max: 100 });
      if (n === null) return null;
      nums.push(n);
    }
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  return null;
}

/** Integer Toman from integer Rial (banker-free, always floored). */
export function rialToToman(rial: number): number {
  return Math.floor(rial / RIAL_PER_TOMAN);
}

/** Integer Rial from integer Toman. */
export function tomanToRial(toman: number): number {
  return Math.floor(toman) * RIAL_PER_TOMAN;
}

/** Format integer Rial as a Persian-digit Toman string with «٬» grouping. */
export function formatToman(rial: number): string {
  return toPersianDigits(
    rialToToman(rial).toLocaleString("en-US").replace(/,/g, "٬"),
  );
}

/** Format integer Rial as a Persian-digit Rial string with «٬» grouping. */
export function formatRial(rial: number): string {
  return toPersianDigits(Math.floor(rial).toLocaleString("en-US").replace(/,/g, "٬"));
}

/** `«۱٬۲۰۰٬۰۰۰ تومان»` in one call — the console's standard money label. */
export function tomanLabel(rial: number): string {
  return `${formatToman(rial)} تومان`;
}
