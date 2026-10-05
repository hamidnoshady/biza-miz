/**
 * The pure half of the canonical price service (issue #844): the source
 * vocabulary, its Persian labels and the dialog's confirmation summary.
 * Everything here is client-safe (`menu-price-sources.ts`); the transactional
 * writer is exercised by `npm run test:db`.
 */
import { describe, expect, it } from "vitest";
import { formatPersianNumber, toPersianDigits } from "./digits";
import {
  PRICE_CHANGE_SOURCES,
  PRICE_SOURCE_LABELS,
  isPriceChangeSource,
  priceChangeSummary,
} from "./menu-price-sources";

describe("price change sources", () => {
  it("lists exactly the writers the issue names, in one canonical list", () => {
    expect([...PRICE_CHANGE_SOURCES]).toEqual([
      "manual",
      "suggested",
      "import",
      "ai",
      "integration",
      "sync",
      "migration",
    ]);
  });

  it("labels every source in Persian for the history screen", () => {
    expect(PRICE_SOURCE_LABELS).toEqual({
      manual: "دستی",
      suggested: "قیمت پیشنهادی",
      import: "ورود اطلاعات",
      ai: "هوش مصنوعی",
      integration: "اتصال خارجی",
      sync: "همگام‌سازی",
      migration: "مهاجرت",
    });
    for (const source of PRICE_CHANGE_SOURCES) {
      expect(PRICE_SOURCE_LABELS[source]).not.toBe("");
    }
  });

  it("accepts stored values only from the vocabulary", () => {
    for (const source of PRICE_CHANGE_SOURCES) {
      expect(isPriceChangeSource(source)).toBe(true);
    }
    expect(isPriceChangeSource("manual")).toBe(true);
    // A history row can never be relabelled by a request body: unknown or
    // non-string values fail the guard and fall back to `manual`.
    expect(isPriceChangeSource("self-modified")).toBe(false);
    expect(isPriceChangeSource(null)).toBe(false);
    expect(isPriceChangeSource(7)).toBe(false);
  });
});

describe("priceChangeSummary", () => {
  // Production callers pass `money.format` (formatPersianNumber under the
  // hood); the summary itself only assembles the line.
  const format = (rial: number) => formatPersianNumber(rial);

  it("renders the dialog's confirmation line: ۴۰٬۰۰۰ → ۴۵٬۰۰۰ (+۱۲٫۵٪)", () => {
    const summary = priceChangeSummary(40_000, 45_000, format);
    expect(summary.text).toBe("۴۰٬۰۰۰ → ۴۵٬۰۰۰ (+۱۲٫۵٪)");
    expect(summary.deltaRial).toBe(5_000);
    expect(summary.percent).toBe(12.5);
  });

  it("signs a decrease with the typographic minus", () => {
    const summary = priceChangeSummary(45_000, 40_000, format);
    expect(summary.text).toBe("۴۵٬۰۰۰ → ۴۰٬۰۰۰ (−۱۱٫۱٪)");
    expect(summary.deltaRial).toBe(-5_000);
  });

  it("omits the percent when there is no base to compare against", () => {
    const summary = priceChangeSummary(0, 12_000, format);
    expect(summary.text).toBe("۰ → ۱۲٬۰۰۰");
    expect(summary.percent).toBeNull();
    expect(summary.deltaRial).toBe(12_000);
  });

  it("keeps Persian digits and the decimal separator Persian", () => {
    const summary = priceChangeSummary(9_999, 10_149, format);
    expect(summary.text).toContain("۹٬۹۹۹ → ۱۰٬۱۴۹");
    expect(summary.text).toMatch(/٪/);
    expect(summary.text).toContain(toPersianDigits("1.5").replace(".", "٫"));
    expect(summary.text).not.toMatch(/[0-9]/);
  });
});
