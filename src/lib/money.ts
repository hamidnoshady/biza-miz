/**
 * Money utilities.
 *
 * STORAGE: integer amounts in the smallest unit — Rial — everywhere
 * (DB BIGINT, API payloads, calculations).
 * DISPLAY: formatted as Toman (÷10) or Rial with Persian digits and
 * thousands grouping. 1 Toman = 10 Rial.
 */
import { formatPersianNumber, toLatinDigits } from "./digits";

export type Rial = number; // integer; JS number is safe up to 2^53-1 rial

/** Which unit a business wants money entered/displayed in. Storage is always Rial. */
export type MoneyUnit = "toman" | "rial";

/** Rial → whole Toman (truncates the single-rial digit, which is always 0 in practice). */
export function rialToToman(rial: Rial): number {
  return Math.trunc(rial / 10);
}

export function tomanToRial(toman: number): Rial {
  return toman * 10;
}

/**
 * Is this value a whole number of Rial?
 *
 * Storage is integer Rial everywhere, and a Toman-denominated entry becomes
 * `value * 10` in floating point — so ۱۵/۷ تومان lands as 1507.0000000000002,
 * which is a binary artefact and not a fraction of a Rial. The tolerance is what
 * separates the two: an amount that still has a fraction once rounded cannot be
 * posted at all, and must be refused rather than quietly repaired.
 *
 * Every channel that accepts money shares this predicate — the expense API, the
 * form and the data-transfer engine's `money` field — so none of them can round
 * where another refuses.
 */
export function isWholeRial(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 && Number.isSafeInteger(rounded);
}

/** e.g. 1_250_000 rial → «۱۲۵٬۰۰۰ تومان» */
export function formatToman(rial: Rial, opts: { withUnit?: boolean } = {}): string {
  const { withUnit = true } = opts;
  const s = formatPersianNumber(rialToToman(rial));
  return withUnit ? `${s} تومان` : s;
}

/** e.g. 1_250_000 rial → «۱٬۲۵۰٬۰۰۰ ریال» */
export function formatRial(rial: Rial, opts: { withUnit?: boolean } = {}): string {
  const { withUnit = true } = opts;
  const s = formatPersianNumber(rial);
  return withUnit ? `${s} ریال` : s;
}

export function formatTomanText(rial: string, opts: { withUnit?: boolean } = {}): string {
  if (!/^-?\d+$/.test(rial)) throw new Error(`Not a valid amount: ${rial}`);
  const toman = BigInt(rial) / 10n;
  const value = formatPersianNumber(toman);
  return opts.withUnit === false ? value : `${value} تومان`;
}

export function parseToRialText(input: string, unit: "toman" | "rial" = "toman"): string {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "");
  if (!/^-?\d+$/.test(cleaned)) throw new Error(`Not a valid amount: ${input}`);
  const value = BigInt(cleaned);
  return (unit === "toman" ? value * 10n : value).toString();
}

/**
 * Parse user input (possibly Persian digits, with separators) into integer
 * Rial. `unit` says which unit the input is denominated in.
 */
export function parseToRial(input: string, unit: "toman" | "rial" = "toman"): Rial {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    throw new Error(`Not a valid amount: ${input}`);
  }
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Amount out of range: ${input}`);
  }
  return unit === "toman" ? tomanToRial(n) : n;
}

/** e.g. 1_250_000 rial → «۱٬۲۵۰٬۰۰۰ ریال» — string-safe (BigInt), mirrors formatTomanText. */
export function formatRialText(rial: string, opts: { withUnit?: boolean } = {}): string {
  const { withUnit = true } = opts;
  if (!/^-?\d+$/.test(rial)) throw new Error(`Not a valid amount: ${rial}`);
  const value = formatPersianNumber(BigInt(rial));
  return withUnit ? `${value} ریال` : value;
}

/** Format Rial for display in a business's chosen unit. */
export function formatMoney(rial: Rial, unit: MoneyUnit, opts: { withUnit?: boolean } = {}): string {
  return unit === "rial" ? formatRial(rial, opts) : formatToman(rial, opts);
}

/** String-safe formatRialText/formatTomanText dispatch for a business's chosen unit. */
export function formatMoneyText(rialText: string, unit: MoneyUnit, opts: { withUnit?: boolean } = {}): string {
  return unit === "rial" ? formatRialText(rialText, opts) : formatTomanText(rialText, opts);
}

/** Parse user input to Rial in a business's chosen unit. */
export function parseMoneyToRial(input: string, unit: MoneyUnit): Rial {
  return parseToRial(input, unit);
}

/** Rial → the number a numeric input should show in the chosen unit. */
export function moneyToInput(rial: Rial, unit: MoneyUnit): number {
  return unit === "rial" ? rial : rialToToman(rial);
}

/** A numeric input's value → Rial in the chosen unit. */
export function moneyFromInput(value: number, unit: MoneyUnit): Rial {
  return unit === "rial" ? value : tomanToRial(value);
}
