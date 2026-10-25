/**
 * Identity normalisation for reconciliation — pure.
 *
 * Matching is only as trustworthy as the keys it compares, so every key an
 * adapter hands the engine goes through one function here. Persian and Arabic
 * digits fold to ASCII, Arabic letter variants fold to their Persian forms,
 * zero-width and bidi marks disappear, and an empty or placeholder value is
 * `null` — never an identity. A key that is `null` can never match anything.
 */

import { normalizeBarcode } from "../barcode";
import { toLatinDigits } from "../digits";
import { normalizePhone } from "../phone";

// Zero-width joiner/non-joiner, bidi marks, BOM, soft hyphen, tatweel.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿­ـ]/g;
// Arabic diacritics (harakat) — they never distinguish two products.
const DIACRITICS = /[ً-ٰٟ]/g;

/** Placeholder spellings a spreadsheet uses for "no value". They must not become keys. */
const PLACEHOLDERS = new Set(["-", "--", "---", "n/a", "na", "null", "none", "undefined", "ندارد", "نامشخص"]);

function clean(raw: string | null | undefined): string {
  if (raw == null) return "";
  return toLatinDigits(String(raw)).replace(INVISIBLE, "").trim();
}

function isPlaceholder(value: string): boolean {
  return value === "" || PLACEHOLDERS.has(value.toLowerCase());
}

/** SKU key: ASCII digits, upper case, single spaces. Null when blank or a placeholder. */
export function normalizeSkuKey(raw: string | null | undefined): string | null {
  const value = clean(raw).replace(/\s+/g, " ");
  if (isPlaceholder(value)) return null;
  return value.toUpperCase();
}

/** Barcode key: digits only, as `barcode.ts` folds them. Null when blank or a placeholder. */
export function normalizeBarcodeKey(raw: string | null | undefined): string | null {
  const value = clean(raw);
  if (isPlaceholder(value)) return null;
  const folded = normalizeBarcode(value).replace(/[\s-]/g, "");
  return /^\d{6,}$/.test(folded) ? folded : null;
}

/** Display-name key for *weak* evidence: Persian letter forms, no spacing noise, lower case. */
export function normalizeNameKey(raw: string | null | undefined): string | null {
  const value = clean(raw)
    .replace(DIACRITICS, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ە|ہ|ۀ/g, "ه")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return isPlaceholder(value) ? null : value;
}

export function normalizeEmailKey(raw: string | null | undefined): string | null {
  const value = clean(raw).toLowerCase();
  if (isPlaceholder(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

/** Canonical `+98…` phone, or null for anything that is not a recognisable Iranian number. */
export function normalizePhoneKey(raw: string | null | undefined): string | null {
  const value = clean(raw);
  if (isPlaceholder(value)) return null;
  return normalizePhone(value).e164;
}

/** An external reference (order number, invoice number): case- and digit-folded, never blank. */
export function normalizeReferenceKey(raw: string | null | undefined): string | null {
  const value = clean(raw).replace(/\s+/g, "");
  if (isPlaceholder(value)) return null;
  return value.toUpperCase();
}

export type ImportMoneyUnit = "rial" | "toman";

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * An amount as the source states it → whole Rial, exactly.
 *
 * Never floating point. Toman is ×10; a value that would land between two Rial
 * (a fraction that survives the conversion) is refused (`null`) rather than
 * rounded: an accounting amount nobody typed is an amount that will not
 * reconcile. Thousands separators of any digit script are tolerated.
 */
export function importAmountToRial(raw: string | number | null | undefined, unit: ImportMoneyUnit): string | null {
  if (raw == null) return null;
  const text = toLatinDigits(String(raw))
    .replace(INVISIBLE, "")
    .replace(/[,٬،\s]/g, "")
    .replace(/٫/g, ".");
  if (!DECIMAL_RE.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, frac = ""] = (negative ? text.slice(1) : text).split(".");
  const scale = unit === "toman" ? 10n : 1n;
  const fracDigits = frac.replace(/0+$/, "");
  let rial = BigInt(whole) * scale;
  if (fracDigits) {
    if (unit === "rial") return null;
    // Toman fractions are tenths of a Toman at most: 12.5 Toman = 125 Rial.
    if (fracDigits.length > 1) return null;
    rial += BigInt(fracDigits);
  }
  return (negative ? -rial : rial).toString();
}

/** Exact decimal equality for quantities and amounts held as strings. */
export function decimalEquals(a: string, b: string): boolean {
  return compareDecimal(a, b) === 0;
}

/** Compare two decimal strings exactly. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [ai, af = ""] = a.trim().replace(/^\+/, "").split(".");
  const [bi, bf = ""] = b.trim().replace(/^\+/, "").split(".");
  const width = Math.max(af.length, bf.length);
  const scaledA = BigInt(ai + af.padEnd(width, "0"));
  const scaledB = BigInt(bi + bf.padEnd(width, "0"));
  return scaledA === scaledB ? 0 : scaledA < scaledB ? -1 : 1;
}

/** `incoming − canonical`, exact, as a decimal string. */
export function decimalDelta(incoming: string, canonical: string): string {
  const [ii, ifr = ""] = incoming.trim().split(".");
  const [ci, cf = ""] = canonical.trim().split(".");
  const width = Math.max(ifr.length, cf.length);
  const diff = BigInt(ii + ifr.padEnd(width, "0")) - BigInt(ci + cf.padEnd(width, "0"));
  if (width === 0) return diff.toString();
  const negative = diff < 0n;
  const digits = (negative ? -diff : diff).toString().padStart(width + 1, "0");
  const whole = digits.slice(0, -width);
  const fraction = digits.slice(-width).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
