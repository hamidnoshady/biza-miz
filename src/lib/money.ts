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

/**
 * Why a money field cannot be posted *yet*.
 *
 * These are not errors — they are the ordinary states of a field somebody is
 * typing into. Half a number («-», «.») and an emptied field («») are what a
 * person produces on the way from one price to the next, so a money input
 * must never throw while it is in one of them.
 */
export type MoneyInputProblem =
  /** Nothing typed (or only separators/whitespace) — mid-edit or untouched. */
  | "empty"
  /** A sign or separator with no digits yet: «-», «.». */
  | "incomplete"
  /** Characters that are not part of a number at all. */
  | "invalid"
  /** A signed amount where only a non-negative one can be stored. */
  | "negative"
  /** A fractional amount that is not a whole number of Rial. */
  | "fractional"
  /** A magnitude past the integer range money is stored in. */
  | "unsafe";

export type MoneyParseResult = { ok: true; rial: Rial } | { ok: false; problem: MoneyInputProblem };

/** Long enough for any storable amount; short enough that a pasted blob cannot cost real work. */
const MONEY_INPUT_MAX_LENGTH = 64;

/**
 * Parse a money field the operator is still typing, without throwing.
 *
 * `parseToRial` exists for values that are already known to be amounts; this
 * is the one a controlled input calls on every keystroke. An empty field, a
 * lone «-» or «.», a negative or unsafe number and a fraction that is not a
 * whole number of Rial each come back as a *problem to show*, so the screen
 * can keep the raw text, explain it in Persian and re-enable saving the moment
 * the value becomes valid — instead of raising out of render.
 *
 * `0` is a valid amount (a free or not-yet-priced item) and parses as 0 Rial.
 * A fraction is accepted when it lands on a whole Rial — «۱۲٫۵» Toman is
 * 125 Rial — and refused otherwise, the same rule `isWholeRial` applies
 * everywhere else: an amount that still has a fraction once converted cannot
 * be posted at all, and must be refused rather than quietly repaired.
 */
export function tryParseToRial(input: string, unit: MoneyUnit = "toman"): MoneyParseResult {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "");
  if (cleaned === "") return { ok: false, problem: "empty" };
  if (cleaned.length > MONEY_INPUT_MAX_LENGTH) return { ok: false, problem: "unsafe" };
  if (cleaned === "-" || cleaned === "." || cleaned === "-.") {
    return { ok: false, problem: "incomplete" };
  }
  if (!/^-?\d+(\.\d*)?$/.test(cleaned)) return { ok: false, problem: "invalid" };

  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole = "", fraction] = unsigned.split(".");
  // Exact throughout: the decimal shift and the Toman × 10 are integer
  // arithmetic, so nothing here depends on a float rounding the same way
  // twice.
  const digits = BigInt(`${whole}${fraction || ""}`);
  const rialBig = unit === "toman" ? digits * 10n : digits;
  const scale = BigInt("1" + "0".repeat(fraction?.length ?? 0));
  if (scale > 1n && rialBig % scale !== 0n) return { ok: false, problem: "fractional" };
  const rialBigInt = rialBig / scale;
  if (!Number.isSafeInteger(Number(rialBigInt))) return { ok: false, problem: "unsafe" };
  if (negative && rialBigInt !== 0n) return { ok: false, problem: "negative" };
  return { ok: true, rial: Number(rialBigInt) };
}

/** `tryParseToRial` in a business's chosen unit. */
export function tryParseMoneyToRial(input: string, unit: MoneyUnit): MoneyParseResult {
  return tryParseToRial(input, unit);
}

/**
 * The Persian sentence a money field shows for a parse problem — inline, next
 * to the value, never as an application error. One map so the price dialog
 * and the create form word the same state the same way.
 */
export function moneyInputProblemMessage(
  problem: MoneyInputProblem,
  unit: MoneyUnit = "toman",
): string {
  switch (problem) {
    case "empty":
      return "مبلغ را وارد کنید.";
    case "incomplete":
      return "عدد را کامل کنید.";
    case "invalid":
      return "تنها عدد وارد کنید.";
    case "negative":
      return "مبلغ نمی‌تواند منفی باشد.";
    case "fractional":
      return unit === "rial"
        ? "مبلغ باید به ریال و بدون اعشار باشد."
        : "مبلغ باید دقیقاً بر حسب ریال باشد (حداکثر یک رقم اعشار در تومان).";
    case "unsafe":
      return "مبلغ بسیار بزرگ است؛ عدد کوچک‌تری وارد کنید.";
  }
}

/** Rial → the number a numeric input should show in the chosen unit. */
export function moneyToInput(rial: Rial, unit: MoneyUnit): number {
  return unit === "rial" ? rial : rialToToman(rial);
}

/** A numeric input's value → Rial in the chosen unit. */
export function moneyFromInput(value: number, unit: MoneyUnit): Rial {
  return unit === "rial" ? value : tomanToRial(value);
}

/**
 * String-safe `moneyToInput`: Rial text → the integer text a money input shows
 * in the chosen unit, never converted through `Number`. Toman drops the single
 * Rial digit (always 0 in practice) exactly as `rialToToman` does. The inverse
 * is `parseToRialText(input, unit)`.
 */
export function moneyToInputText(rialText: string, unit: MoneyUnit): string {
  if (!/^\d+$/.test(rialText)) throw new Error(`Not a valid amount: ${rialText}`);
  const value = BigInt(rialText);
  return (unit === "rial" ? value : value / 10n).toString();
}

/** The exact sum of Rial amounts given as integer text — `BigInt` throughout, so it cannot round past 2^53. */
export function sumRialText(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total.toString();
}

/** Exact signed export text; unlike integer inputs, a Toman file preserves the last Rial digit. */
export function moneyToExportText(rialText: string, unit: MoneyUnit): string {
  if (!/^-?\d+$/.test(rialText)) throw new Error(`Not a valid amount: ${rialText}`);
  const value = BigInt(rialText);
  if (unit === "rial") return value.toString();
  const magnitude = value < 0n ? -value : value;
  const fraction = magnitude % 10n;
  return `${value < 0n ? "-" : ""}${magnitude / 10n}${fraction ? `.${fraction}` : ""}`;
}
