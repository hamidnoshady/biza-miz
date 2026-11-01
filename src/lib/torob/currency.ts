/**
 * Issue #894 Wave 2 — money, as Torob requires it.
 *
 * Two facts decide this file:
 *
 *   1. **Torob prices are integer Toman.** Not a decimal, not a string, not a
 *      currency code — an integer, because a marketplace price has to be
 *      comparable and a float is not.
 *   2. **«بیزامیز» stores integer Rial** (README, and every money column in the
 *      schema). So the feed is the one place the platform's unit meets Torob's,
 *      and it does so for every product of every shop, on every refresh.
 *
 * Therefore: Rial → Toman is a division by ten, and it is either **exact** or it
 * is refused. Rounding is the tempting shortcut and it is wrong here — a feed
 * price that disagrees with the storefront by a few Rial is a price the merchant
 * never set, and the shop's own checkout (and «بیزامیز»'s own order) will disagree
 * with what Torob shows. The cost of refusing is one product listed with a reason
 * the merchant can fix; the cost of rounding is a number nobody owns.
 *
 * A currency that is not Rial or Toman is refused outright rather than converted
 * through some rate: this platform holds no exchange rate, and inventing one
 * would price a Tehran shop in yesterday's guess. The issue says "reject
 * unsupported currency", and this is what that looks like.
 *
 * Pure: no database, no `fetch`, no ambient clock. Every branch is in
 * `currency.test.ts`.
 */

/** The only two currencies a Torob feed may be priced in. */
export const TOROB_CURRENCIES = ["IRR", "IRT"] as const;
export type TorobCurrency = (typeof TOROB_CURRENCIES)[number];

/** What Torob is sent: whole Toman, as a JSON integer. */
export const TOROB_PRICE_CURRENCY: TorobCurrency = "IRT";

/**
 * Why a price could not be expressed in Torob's unit. A closed vocabulary: it
 * reaches a merchant (translated) and a log, so it must not be a free string.
 */
export type TorobPriceProblem =
  | "unsupported_currency"
  | "negative_price"
  | "not_an_integer"
  | "rial_not_whole_toman"
  | "price_out_of_range";

export class TorobPriceError extends Error {
  constructor(public readonly problem: TorobPriceProblem) {
    super(problem);
    this.name = "TorobPriceError";
  }
}

/**
 * Torob's own ceiling for a price, in Toman.
 *
 * Not a business rule so much as a safety rail: JSON integers are exact only to
 * 2^53, and a number large enough to lose precision is a bug in whatever wrote
 * it rather than a product. ۱۰۰ میلیارد تومان is far above any real listing.
 */
export const TOROB_MAX_PRICE_TOMAN = 100_000_000_000;

/** Does this deployment's currency vocabulary contain `value`? */
export function isTorobCurrency(value: string | null | undefined): value is TorobCurrency {
  return typeof value === "string" && (TOROB_CURRENCIES as readonly string[]).includes(value.toUpperCase());
}

/**
 * The site's currency, in the form this module speaks.
 *
 * The registries disagree: `integration_connections.currency_unit` is
 * `'rial' | 'toman'` (how WooCommerce decimals are written) while
 * `eshobe_cms_connections.site_currency` is `'IRT' | 'IRR' | 'EUR' | 'USD'`. This
 * is the single place those two vocabularies become one — and the place an
 * unsupported one surfaces, rather than being coerced into Rial by a caller that
 * assumed Iran.
 */
export function torobCurrencyFromRegistry(value: string | null | undefined): TorobCurrency {
  const normalised = (value ?? "").trim().toUpperCase();
  if (normalised === "IRR" || normalised === "RIAL") return "IRR";
  if (normalised === "IRT" || normalised === "TOMAN") return "IRT";
  // Includes EUR, USD and an empty registry value. The caller decides whether
  // that is a skipped product or a shop-level "needs attention"; either way it is
  // never treated as Rial.
  throw new TorobPriceError("unsupported_currency");
}

/** A price in the database: bigint, a numeric string, or a (safe) JS integer. */
export type RialAmount = bigint | number | string;

function toRialBigInt(amount: RialAmount): bigint {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) throw new TorobPriceError("not_an_integer");
    if (!Number.isSafeInteger(amount)) throw new TorobPriceError("price_out_of_range");
    return BigInt(amount);
  }
  const text = amount.trim();
  // Deliberately no decimal point accepted: a price with a fraction of a Rial is
  // a number this platform cannot store, so it is a caller bug, not a rounding
  // decision to make here.
  if (!/^-?\d+$/.test(text)) throw new TorobPriceError("not_an_integer");
  return BigInt(text);
}

/**
 * The selling price Torob is sent, in Toman.
 *
 * `currency` is the *site's* currency, not a hint: an `IRT` amount is already
 * Toman, an `IRR` amount is divided by ten, and anything else is refused.
 */
export function sellingPriceInToman(input: { amount: RialAmount; currency: string }): number {
  const currency = torobCurrencyFromRegistry(input.currency);
  const amount = toRialBigInt(input.amount);

  if (amount < 0n) throw new TorobPriceError("negative_price");

  const toman = currency === "IRR" ? wholeTomanFromRial(amount) : amount;
  if (toman > BigInt(TOROB_MAX_PRICE_TOMAN)) throw new TorobPriceError("price_out_of_range");
  return Number(toman);
}

/** Exact Rial → Toman, or `rial_not_whole_toman`. */
function wholeTomanFromRial(rial: bigint): bigint {
  if (rial % 10n !== 0n) throw new TorobPriceError("rial_not_whole_toman");
  return rial / 10n;
}

/**
 * The same conversion, for a value that is *already* in Toman.
 *
 * Used by the cross-check below and by the WooCommerce adapter, whose
 * `currency_unit` says whether the store's decimals are Toman or Rial.
 */
export function tomanFromAmount(input: { amount: RialAmount; currency: TorobCurrency }): number {
  return sellingPriceInToman({ amount: input.amount, currency: input.currency });
}

/**
 * Whether a stored Rial price can be published at all — the check a screen runs
 * to explain a product instead of attempting the conversion and catching.
 */
export function canPriceForTorob(amount: RialAmount, currency: string): boolean {
  try {
    sellingPriceInToman({ amount, currency });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one-line explanation a merchant can act on, per problem.
 *
 * Kept here rather than in the screen for the same reason every other tenant
 * vocabulary in this app is: the API and the screen must say the same sentence,
 * and a reason code with no sentence is a mystery box.
 */
export const TOROB_PRICE_PROBLEM_COPY: Readonly<Record<TorobPriceProblem, string>> = {
  unsupported_currency: "قیمت این محصول به ارزی جز ریال یا تومان ثبت شده است.",
  negative_price: "قیمت این محصول منفی است.",
  not_an_integer: "قیمت این محصول عدد صحیح نیست.",
  rial_not_whole_toman: "قیمت این محصول به تومان صحیح تبدیل نمی‌شود (به ۱۰ بخش‌پذیر نیست).",
  price_out_of_range: "قیمت این محصول از بازهٔ مجاز بیشتر است.",
};
