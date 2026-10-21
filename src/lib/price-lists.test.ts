import { describe, expect, test } from "vitest";
import {
  applyQuickUpdate,
  normalizePriceMatrixQuery,
  PRICE_MATRIX_DEFAULT_LIMIT,
  PRICE_MATRIX_MAX_LIMIT,
  PRICE_MATRIX_MAX_QUERY_LENGTH,
  isValidQuickUpdateValue,
  isValidStockVersion,
  normalizeQuickUpdateScope,
  QUICK_UPDATE_MAX_SELECTED,
  MAX_AMOUNT,
  MAX_PERCENT,
  MIN_PERCENT,
} from "./price-lists-service";

/**
 * «بروزرسانی سریع» arithmetic. The SQL in `quickUpdatePrices` is the same
 * expression written for Postgres; these cases pin the behaviour the screen
 * promises, and in particular the two ways the original rounding silently
 * destroyed a price.
 */
describe("applyQuickUpdate", () => {
  const base = { round: false } as const;

  test("a percent move scales the current price", () => {
    expect(applyQuickUpdate(100_000, { mode: "percent", value: 10, ...base })).toBe(110_000);
    expect(applyQuickUpdate(100_000, { mode: "percent", value: -25, ...base })).toBe(75_000);
  });

  test("an amount move adds Rial", () => {
    expect(applyQuickUpdate(100_000, { mode: "amount", value: 5_000, ...base })).toBe(105_000);
    expect(applyQuickUpdate(100_000, { mode: "amount", value: -5_000, ...base })).toBe(95_000);
  });

  test("a reduction below zero clamps at zero rather than going negative", () => {
    expect(applyQuickUpdate(1_000, { mode: "amount", value: -9_000, ...base })).toBe(0);
    expect(applyQuickUpdate(1_000, { mode: "percent", value: -100, ...base })).toBe(0);
  });

  test("rounding snaps to the nearest thousand Toman", () => {
    expect(applyQuickUpdate(123_000, { mode: "percent", value: 0, round: true })).toBe(120_000);
    expect(applyQuickUpdate(126_000, { mode: "percent", value: 0, round: true })).toBe(130_000);
  });

  /**
   * The bug this pins: «۴٬۰۰۰ ریال» rounded to the nearest 10,000 is 0, and a
   * price of zero means *unpriced*. For the sale column that then fails the
   * `unit_price > 0` check, so the row was skipped and the shopkeeper saw the
   * old price with no error. A real price stays a real price.
   */
  test("rounding never wipes a non-zero price down to unpriced", () => {
    expect(applyQuickUpdate(4_000, { mode: "percent", value: 0, round: true })).toBe(10_000);
    expect(applyQuickUpdate(1, { mode: "percent", value: 0, round: true })).toBe(10_000);
  });

  test("a price that really did reach zero stays zero", () => {
    expect(applyQuickUpdate(1_000, { mode: "amount", value: -1_000, round: true })).toBe(0);
  });

  test("results are whole Rial — a percent move never leaves a fraction", () => {
    const result = applyQuickUpdate(3_333, { mode: "percent", value: 7, round: false });
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe("isValidQuickUpdateValue", () => {
  test("rejects a percent cut deeper than the whole price", () => {
    // Clamping -500% to zero would have unpriced the entire branch without
    // saying so; it is refused instead.
    expect(isValidQuickUpdateValue("percent", -500)).toBe(false);
    expect(isValidQuickUpdateValue("percent", MIN_PERCENT)).toBe(true);
  });

  test("rejects an absurd percent increase", () => {
    expect(isValidQuickUpdateValue("percent", MAX_PERCENT + 1)).toBe(false);
    expect(isValidQuickUpdateValue("percent", MAX_PERCENT)).toBe(true);
  });

  test("rejects values that are not finite numbers", () => {
    expect(isValidQuickUpdateValue("percent", Number.NaN)).toBe(false);
    expect(isValidQuickUpdateValue("amount", Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("an amount move may be any finite Rial figure, in either direction", () => {
    expect(isValidQuickUpdateValue("amount", -5_000_000)).toBe(true);
    expect(isValidQuickUpdateValue("amount", 5_000_000)).toBe(true);
    expect(isValidQuickUpdateValue("amount", 0)).toBe(true);
  });

  test("rejects an amount the column arithmetic could not survive", () => {
    // The bound is 9e12 Rial — far above any real catalogue, low enough that
    // `old + amount` stays inside a signed 64-bit column. It used to live only
    // inside `quickUpdatePrices`, so the route accepted 1e15 and the service
    // answered `changed: 0`: the operator saw "nothing changed" for a value
    // that was simply refused (F10: bound the arithmetic with a descriptive
    // error). The validator every caller shares now owns the bound.
    expect(isValidQuickUpdateValue("amount", MAX_AMOUNT)).toBe(true);
    expect(isValidQuickUpdateValue("amount", MAX_AMOUNT + 1)).toBe(false);
    expect(isValidQuickUpdateValue("amount", -MAX_AMOUNT - 1)).toBe(false);
    expect(isValidQuickUpdateValue("amount", 1_000_000_000_000_000)).toBe(false);
    // A fractional Rial is not a price; the UI promises whole monetary values.
    expect(isValidQuickUpdateValue("amount", 1_500.5)).toBe(false);
  });
});

describe("isValidStockVersion", () => {
  test("accepts the microsecond bigint version the matrix loads", () => {
    expect(isValidStockVersion("1761354000123456")).toBe(true);
    expect(isValidStockVersion("0")).toBe(true);
  });

  test("accepts an absent version for legacy callers", () => {
    expect(isValidStockVersion(undefined)).toBe(true);
    expect(isValidStockVersion(null)).toBe(true);
  });

  test("rejects a double-escaped or non-numeric version", () => {
    // Regression: the pattern was once /^\\d{1,20}$/ (literal backslash),
    // which silently dropped every stock price cell from the save batch.
    expect(isValidStockVersion("123456789012345678901")).toBe(false);
    expect(isValidStockVersion("12abc")).toBe(false);
    expect(isValidStockVersion("\\d")).toBe(false);
    expect(isValidStockVersion(1761354000123456)).toBe(false);
  });
});

describe("quick-update scope (F03)", () => {
  const id = "8f14e45f-ceea-467a-9c04-9dbb1f4f6a3c";

  test("an explicit all scope is accepted", () => {
    expect(normalizeQuickUpdateScope({ scope: { kind: "all" } })).toEqual({
      ok: true,
      scope: { kind: "all" },
    });
  });

  test("matches the explicit all scope only when it is named", () => {
    // No scope and no itemIds used to mean "the whole branch" — that widening is
    // exactly the failure F03 describes.
    expect(normalizeQuickUpdateScope({})).toEqual({ ok: false, error: "missing_scope" });
    expect(normalizeQuickUpdateScope({ itemIds: "not-an-array" })).toEqual({
      ok: false,
      error: "invalid_itemIds_not_array",
    });
  });

  test("a selected scope with no ids is rejected, never widened", () => {
    expect(normalizeQuickUpdateScope({ scope: { kind: "selected", itemIds: [] } })).toEqual({
      ok: false,
      error: "selected_scope_requires_ids",
    });
    expect(normalizeQuickUpdateScope({ scope: { kind: "selected" } })).toEqual({
      ok: false,
      error: "selected_scope_requires_ids",
    });
  });

  test("selected ids must be unique UUIDs and a bounded list", () => {
    expect(normalizeQuickUpdateScope({ scope: { kind: "selected", itemIds: ["nope"] } })).toEqual({
      ok: false,
      error: "invalid_item_id",
    });
    expect(normalizeQuickUpdateScope({ scope: { kind: "selected", itemIds: [id, id] } })).toEqual({
      ok: false,
      error: "duplicate_item_id",
    });
    const tooMany = Array.from({ length: QUICK_UPDATE_MAX_SELECTED + 1 }, (_, i) =>
      `8f14e45f-ceea-467a-9c04-9dbb1f4f${String(i).padStart(4, "0")}`,
    );
    expect(normalizeQuickUpdateScope({ scope: { kind: "selected", itemIds: tooMany } })).toEqual({
      ok: false,
      error: "selected_scope_too_large",
    });
  });

  test("all scope cannot smuggle an item list", () => {
    expect(normalizeQuickUpdateScope({ scope: { kind: "all", itemIds: [id] } })).toEqual({
      ok: false,
      error: "invalid_scope",
    });
    expect(normalizeQuickUpdateScope({ scope: { kind: "everything" } })).toEqual({
      ok: false,
      error: "invalid_scope_kind",
    });
  });

  test("legacy itemIds still work when the caller sends a real selection", () => {
    expect(normalizeQuickUpdateScope({ itemIds: [id] })).toEqual({
      ok: true,
      scope: { kind: "selected", itemIds: [id] },
    });
  });

  /**
   * The P0 acceptance rule: "selected scope malformed or **empty** is rejected;
   * only an explicit all-items selection executes branch-wide operations."
   * An empty array is what a serialization or filtering bug produces — it must
   * never widen to every item in the branch.
   */
  test("an empty itemIds list is rejected, not widened to all items", () => {
    expect(normalizeQuickUpdateScope({ itemIds: [] })).toEqual({ ok: false, error: "empty_itemIds" });
    expect(normalizeQuickUpdateScope({ scope: { kind: "selected", itemIds: [] } })).toEqual({
      ok: false,
      error: "selected_scope_requires_ids",
    });
    expect(normalizeQuickUpdateScope({})).toEqual({ ok: false, error: "missing_scope" });
    // …and only the explicit object form means all.
    expect(normalizeQuickUpdateScope({ scope: { kind: "all" } })).toEqual({
      ok: true,
      scope: { kind: "all" },
    });
  });
});


/**
 * Issue #924 F12 — the matrix read is bounded. `normalizePriceMatrixQuery` is
 * the only gate between an untrusted query string and a `LIMIT`, so the
 * clamping is pinned here as well as at the route.
 */
describe("normalizePriceMatrixQuery", () => {
  test("a bare URL asks for the first page", () => {
    expect(normalizePriceMatrixQuery({})).toEqual({ q: null, limit: PRICE_MATRIX_DEFAULT_LIMIT, offset: 0 });
  });

  test("a caller cannot widen the page past the hard maximum", () => {
    expect(normalizePriceMatrixQuery({ limit: "100000" }).limit).toBe(PRICE_MATRIX_MAX_LIMIT);
    expect(normalizePriceMatrixQuery({ limit: 10_000 }).limit).toBe(PRICE_MATRIX_MAX_LIMIT);
  });

  test("zero, negative and non-numeric values fall back instead of failing", () => {
    expect(normalizePriceMatrixQuery({ limit: "0" }).limit).toBe(1);
    expect(normalizePriceMatrixQuery({ limit: "abc" }).limit).toBe(PRICE_MATRIX_DEFAULT_LIMIT);
    expect(normalizePriceMatrixQuery({ offset: "-40" }).offset).toBe(0);
    // A fractional offset truncates to the page it starts in.
    expect(normalizePriceMatrixQuery({ offset: "12.7" }).offset).toBe(12);
  });

  test("search is trimmed, emptied and bounded", () => {
    expect(normalizePriceMatrixQuery({ q: "   " }).q).toBeNull();
    expect(normalizePriceMatrixQuery({ q: "  کرم " }).q).toBe("کرم");
    expect(normalizePriceMatrixQuery({ q: "x".repeat(500) }).q).toHaveLength(PRICE_MATRIX_MAX_QUERY_LENGTH);
  });
});
