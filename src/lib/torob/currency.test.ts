import { describe, expect, it } from "vitest";
import {
  TOROB_MAX_PRICE_TOMAN,
  canPriceForTorob,
  isTorobCurrency,
  sellingPriceInToman,
  torobCurrencyFromRegistry,
} from "./currency";

/**
 * Issue #894 Wave 2 — money, in Torob's unit.
 *
 * Every case here is a real way a feed price goes wrong: a float creeping in, a
 * Rial amount silently rounded to Toman, a euro converted through a rate the
 * platform does not have. The conversion is one division by ten, and the point of
 * the file is that it is only ever *that*.
 */

describe("the registry vocabularies", () => {
  it("reads both registries as the same two currencies", () => {
    // WooCommerce stores how its decimals are written; the CMS stores a code.
    expect(torobCurrencyFromRegistry("rial")).toBe("IRR");
    expect(torobCurrencyFromRegistry("IRR")).toBe("IRR");
    expect(torobCurrencyFromRegistry("toman")).toBe("IRT");
    expect(torobCurrencyFromRegistry(" irt ")).toBe("IRT");
  });

  it("refuses anything else rather than assuming Iran", () => {
    // EUR and USD are legitimate `site_currency` values; a rate would be a guess.
    for (const value of ["EUR", "USD", "GBP", "", null, undefined, "ریال"]) {
      expect(() => torobCurrencyFromRegistry(value as string), String(value)).toThrow(
        expect.objectContaining({ problem: "unsupported_currency" }),
      );
    }
  });

  it("knows its own vocabulary", () => {
    expect(isTorobCurrency("IRR")).toBe(true);
    expect(isTorobCurrency("irt")).toBe(true);
    expect(isTorobCurrency("EUR")).toBe(false);
    expect(isTorobCurrency(null)).toBe(false);
  });
});

describe("sellingPriceInToman", () => {
  it("passes a Toman price through unchanged", () => {
    expect(sellingPriceInToman({ amount: 250_000, currency: "IRT" })).toBe(250_000);
    expect(sellingPriceInToman({ amount: 0, currency: "IRT" })).toBe(0);
  });

  it("divides Rial by ten, exactly", () => {
    expect(sellingPriceInToman({ amount: 2_500_000, currency: "IRR" })).toBe(250_000);
    // A bigint from `pg` is the normal shape of a money column.
    expect(sellingPriceInToman({ amount: 19_990n, currency: "IRR" })).toBe(1_999);
    // A string from a JSON payload is the other normal shape.
    expect(sellingPriceInToman({ amount: "120000", currency: "IRR" })).toBe(12_000);
  });

  it("refuses a Rial amount with no exact Toman form instead of rounding", () => {
    // ۹۹۹٫۵ تومان is not a price Torob can carry. Rounding would show a shopper a
    // number the shop never set — and the shop's own checkout would disagree.
    expect(() => sellingPriceInToman({ amount: 9_995, currency: "IRR" })).toThrow(
      expect.objectContaining({ problem: "rial_not_whole_toman" }),
    );
    expect(canPriceForTorob(9_995, "IRR")).toBe(false);
    expect(canPriceForTorob(9_990, "IRR")).toBe(true);
  });

  it("refuses a price that is not a whole number, or not a number at all", () => {
    expect(() => sellingPriceInToman({ amount: 12.5, currency: "IRT" })).toThrow(
      expect.objectContaining({ problem: "not_an_integer" }),
    );
    expect(() => sellingPriceInToman({ amount: "12.5", currency: "IRT" })).toThrow(
      expect.objectContaining({ problem: "not_an_integer" }),
    );
    expect(() => sellingPriceInToman({ amount: "abc", currency: "IRT" })).toThrow(
      expect.objectContaining({ problem: "not_an_integer" }),
    );
    expect(() => sellingPriceInToman({ amount: "", currency: "IRT" })).toThrow(
      expect.objectContaining({ problem: "not_an_integer" }),
    );
  });

  it("refuses a negative price", () => {
    expect(() => sellingPriceInToman({ amount: -1, currency: "IRT" })).toThrow(
      expect.objectContaining({ problem: "negative_price" }),
    );
    expect(() => sellingPriceInToman({ amount: "-1000", currency: "IRR" })).toThrow(
      expect.objectContaining({ problem: "negative_price" }),
    );
  });

  it("refuses a price past the safe-integer rail", () => {
    // JSON integers are exact to 2^53; a bigger one is a bug in whatever wrote
    // it, and sending it would let Torob store a number we never meant.
    expect(() => sellingPriceInToman({ amount: Number.MAX_SAFE_INTEGER, currency: "IRT" })).toThrow(
      expect.objectContaining({ problem: "price_out_of_range" }),
    );
    expect(sellingPriceInToman({ amount: TOROB_MAX_PRICE_TOMAN, currency: "IRT" })).toBe(TOROB_MAX_PRICE_TOMAN);
  });

  it("is exact at the boundaries that matter", () => {
    // ۱۰ ریال = ۱ تومان, and the largest exact Rial value we accept.
    expect(sellingPriceInToman({ amount: 10, currency: "IRR" })).toBe(1);
    expect(sellingPriceInToman({ amount: BigInt(TOROB_MAX_PRICE_TOMAN) * 10n, currency: "IRR" })).toBe(
      TOROB_MAX_PRICE_TOMAN,
    );
  });
});
