/**
 * Persian digit formatting — display layer only.
 * Data is always stored with Latin (ASCII) digits.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Options shared by localized numeric inputs and numeric display text. */
export interface NumericTextOptions {
  /** Whether a fractional part is allowed. Defaults to true. */
  allowDecimal?: boolean;
  /** Whether a leading minus sign is allowed. Defaults to true. */
  allowNegative?: boolean;
  /** Whether the integer part receives Persian thousands separators. Defaults to true. */
  grouping?: boolean;
}

/** Convert ASCII digits in a string (or a number) to Persian digits. */
export function toPersianDigits(value: string | number | bigint): string {
  return String(value).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

/** Convert Persian and Arabic-Indic digits back to ASCII. */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

/**
 * Normalize a security-code entry (SMS OTP, PIN, TOTP) before validation:
 * Persian and Arabic-Indic digits become ASCII, every non-digit is dropped,
 * and an optional maximum length is enforced. Issue #854 (pass 4) — the old
 * inputs stripped localized digits with `/\D/g`, so a member typing «۱۲۳» on
 * a Persian keyboard ended up with an empty field instead of «123»; every
 * security code input normalizes through this single helper now.
 */
export function normalizeSecurityDigits(value: string, maxLength?: number): string {
  const digits = toLatinDigits(String(value)).replace(/\D/g, "");
  return maxLength === undefined ? digits : digits.slice(0, maxLength);
}

/**
 * Convert a potentially localized, grouped number to the canonical text used
 * by state and APIs: ASCII digits, an optional leading `-`, and an optional
 * ASCII decimal point. It intentionally accepts both Persian and Arabic-Indic
 * digits, Arabic decimal/group marks, conventional commas, and pasted spaces.
 * When grouping is disabled and decimals are allowed, a conventional comma is
 * treated as a decimal separator too, which matches many mobile keyboards.
 *
 * This is display/input plumbing rather than a numeric parser: it preserves a
 * trailing decimal point while a person is still typing and never goes through
 * `Number`, so a long value is not rounded here.
 */
export function normalizeNumericText(value: string, options: NumericTextOptions = {}): string {
  const { allowDecimal = true, allowNegative = true, grouping = true } = options;
  const source = toLatinDigits(String(value))
    .replace(/[−–—]/g, "-")
    .replace(/٫/g, ".");

  let result = "";
  let hasDecimal = false;
  let ignoringFraction = false;

  for (const char of source) {
    if (char >= "0" && char <= "9") {
      if (!ignoringFraction) result += char;
      continue;
    }
    if (char === "-" && allowNegative && result === "") {
      result = "-";
      continue;
    }
    if (char === "." || (char === "," && allowDecimal && !grouping)) {
      if (allowDecimal && !hasDecimal) {
        hasDecimal = true;
        result += ".";
      } else if (!allowDecimal) {
        // Never turn an attempted `12.5` into `125` in a whole-number
        // field — silently multiplying a price is worse than rejecting the
        // fractional part. Keep the integer portion instead.
        ignoringFraction = true;
      }
    }
    // Every other character is display punctuation or an accidental paste
    // character: grouping commas, «٬», whitespace, currency text, and so on.
  }

  const sign = result.startsWith("-") ? "-" : "";
  const unsigned = sign ? result.slice(1) : result;
  const [integer = "", fraction] = unsigned.split(".", 2);
  // Leading zeros should not turn 0001 into the surprising «۰٬۰۰۱». Keep a
  // single zero for an in-progress decimal such as «۰٫۵».
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "") || (unsigned.includes(".") ? "0" : "");
  const normalizedUnsigned = fraction === undefined
    ? normalizedInteger
    : `${normalizedInteger || "0"}.${fraction}`;

  return sign + normalizedUnsigned;
}

/**
 * Render an integer or decimal as Persian numeric text, including a Persian
 * thousands separator «٬» and decimal mark «٫». The result is intended for
 * read-outs and text inputs; persistence should use `normalizeNumericText`.
 */
export function formatPersianNumericText(value: string | number | bigint, options: NumericTextOptions = {}): string {
  const { grouping = true } = options;
  const canonical = normalizeNumericText(String(value), options);
  if (!canonical) return "";
  if (canonical === "-") return "-";

  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const hasDecimal = unsigned.includes(".");
  const [integer = "", fraction = ""] = unsigned.split(".", 2);
  const grouped = grouping
    ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, "٬")
    : integer;
  const rendered = `${negative ? "-" : ""}${grouped || "0"}${hasDecimal ? `٫${fraction}` : ""}`;
  return toPersianDigits(rendered);
}

/** Group an integer with thousands separators (Persian comma «٬»). */
export function groupDigits(value: number | bigint, separator = "٬"): string {
  const negative = typeof value === "bigint" ? value < 0n : value < 0;
  const abs = (typeof value === "bigint" ? (value < 0n ? -value : value) : Math.abs(value)).toString();
  const grouped = abs.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return negative ? `-${grouped}` : grouped;
}

/** Grouped + Persian digits, ready for display. */
export function formatPersianNumber(value: number | bigint): string {
  return toPersianDigits(groupDigits(value));
}

/**
 * Format a decimal quantity for display, trimming to `maxDecimals` places and
 * dropping trailing zeros. Inventory quantities are stored with 9 decimal
 * places of exact cost-basis precision (see migrations/0015), which must
 * never leak into the UI as e.g. "18.000000000" — this is display-only,
 * storage/calculations keep the full string precision.
 */
export function formatQuantity(value: string | number, maxDecimals = 3): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return toPersianDigits(String(value));
  const fixed = n.toFixed(maxDecimals);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return formatPersianNumericText(trimmed, { allowDecimal: true });
}
