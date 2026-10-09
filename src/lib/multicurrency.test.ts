/**
 * Multicurrency pure-logic tests (issue #863).
 *
 * Every promise the posting service makes to the ledger is pinned here:
 * conversion is exact Decimal with one policy rounding, the residual a
 * document may absorb is bounded and explained, FIFO settlement allocates
 * base value exactly across however many settlements a lot takes, and a
 * revaluation's gain/loss flips with the account's normal side.
 */
import { describe, expect, it } from "vitest";
import {
  buildMulticurrencyDocument,
  convertToBaseMinor,
  consumeOpenLots,
  isValidCurrencyCode,
  isValidRateText,
  minorToMajorText,
  multicurrencyDocumentProblemMessage,
  parseMulticurrencyEntryPayload,
  parseRatePayload,
  parseSettlementPayload,
  RATE_MAX_SCALE,
  rateToCanonical,
  realizedFxDifference,
  restateForeignBalance,
  ROUNDING_POLICY_VERSION,
  roundingTolerance,
  type ForeignOpenLot,
} from "./multicurrency";

const USD = { code: "USD", precision: 2 };
/** $1 = 600,000 rial. */
const USD_RATE = "600000";
const IRR_RATE = "1";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";

describe("currency code & rate validation", () => {
  it("accepts ISO-style 3-letter uppercase codes only", () => {
    expect(isValidCurrencyCode("USD")).toBe(true);
    expect(isValidCurrencyCode("usd")).toBe(false);
    expect(isValidCurrencyCode("US")).toBe(false);
    expect(isValidCurrencyCode("USDD")).toBe(false);
    expect(isValidCurrencyCode("")).toBe(false);
    expect(isValidCurrencyCode(42)).toBe(false);
  });

  it("accepts canonical positive decimal rates and nothing else", () => {
    expect(isValidRateText("600000")).toBe(true);
    expect(isValidRateText("600000.123456")).toBe(true);
    expect(isValidRateText("0.000001")).toBe(true);
    expect(isValidRateText("-600000")).toBe(false);
    expect(isValidRateText("0")).toBe(false);
    expect(isValidRateText("1e9")).toBe(false);
    expect(isValidRateText("+1")).toBe(false);
    expect(isValidRateText("01")).toBe(false);
    expect(isValidRateText("1.")).toBe(false);
    expect(isValidRateText(".5")).toBe(false);
    expect(isValidRateText("")).toBe(false);
    expect(isValidRateText(42)).toBe(false);
    // scale beyond the declared maximum is refused
    expect(isValidRateText(`1.${"1".repeat(RATE_MAX_SCALE + 1)}`)).toBe(false);
  });

  it("strips trailing zeros from a rate", () => {
    expect(rateToCanonical("600000.00")).toBe("600000");
    expect(rateToCanonical("0.5000")).toBe("0.5");
    expect(rateToCanonical("1")).toBe("1");
  });
});

describe("convertToBaseMinor — policy v1", () => {
  it("converts exact values without loss", () => {
    // $100.00 at 600000 → 60,000,000 rial
    expect(convertToBaseMinor(10000n, USD_RATE, USD.precision)).toBe(60_000_000n);
    // $0.01 → 6,000 rial
    expect(convertToBaseMinor(1n, USD_RATE, USD.precision)).toBe(6_000n);
  });

  it("rounds half-up once, at the base side", () => {
    // 1 cent at 599,999.9 per dollar: exact 5,999.999 → 6,000
    expect(convertToBaseMinor(1n, "599999.9", USD.precision)).toBe(6_000n);
    // 1 cent at 599,940 per dollar: exact 5,999.4 → 5,999
    expect(convertToBaseMinor(1n, "599940", USD.precision)).toBe(5_999n);
    // exact .5 rounds up: 1 cent at 50 per dollar → 0.5 → 1
    expect(convertToBaseMinor(1n, "50", USD.precision)).toBe(1n);
  });

  it("handles a zero-decimal currency without scaling surprises", () => {
    // 1 whole unit of a zero-precision currency at rate 1000 → 1000
    expect(convertToBaseMinor(1n, "1000", 0)).toBe(1_000n);
    expect(convertToBaseMinor(7n, "1000", 0)).toBe(7_000n);
  });

  it("refuses negative amounts, bad rates, bad precision", () => {
    expect(() => convertToBaseMinor(-1n, USD_RATE, 2)).toThrow("negative_foreign_amount");
    expect(() => convertToBaseMinor(1n, "nope", 2)).toThrow("invalid_rate");
    expect(() => convertToBaseMinor(1n, USD_RATE, 9)).toThrow("invalid_currency_precision");
  });
});

describe("roundingTolerance", () => {
  it("allows no residual for one or two converted lines", () => {
    expect(roundingTolerance(0)).toBe(0);
    expect(roundingTolerance(1)).toBe(0);
    expect(roundingTolerance(2)).toBe(0);
  });

  it("grows slower than the line count", () => {
    expect(roundingTolerance(3)).toBe(1);
    expect(roundingTolerance(4)).toBe(1);
    expect(roundingTolerance(5)).toBe(2);
    expect(roundingTolerance(10)).toBe(4);
  });
});

describe("buildMulticurrencyDocument", () => {
  it("builds a simple balanced foreign document", () => {
    // Dr foreign bank $100 / Cr AR $100 at 600000
    const result = buildMulticurrencyDocument(
      [
        { accountId: A, side: "debit", foreignMinor: 10000n },
        { accountId: B, side: "credit", foreignMinor: 10000n },
      ],
      USD_RATE,
      USD.precision,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseTotal).toBe(60_000_000n);
    expect(result.value.foreignTotal).toBe(10_000n);
    expect(result.value.roundingDelta).toBe(0n);
    expect(result.value.lines).toHaveLength(2);
    for (const line of result.value.lines) {
      expect(line.absorbedRounding).toBe(false);
      expect(line.baseDebit === 0n).not.toBe(line.baseCredit === 0n);
    }
  });

  it("absorbs a sub-unit rounding residual on the largest line and stamps the delta", () => {
    // 1 USD cent at 50 rial per dollar → 0.5 rial, rounds up to 1; 2 cents → 1.0 → 1.
    // Two debit cents post 2, one credit of 2 cents posts 1 → residual 1.
    const rate = "50";
    const result = buildMulticurrencyDocument(
      [
        { accountId: A, side: "debit", foreignMinor: 1n },
        { accountId: A, side: "debit", foreignMinor: 1n },
        { accountId: B, side: "credit", foreignMinor: 2n },
      ],
      rate,
      USD.precision,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundingDelta).toBe(1n);
    // One debit line was absorbed down to a zero BASE — but it keeps its
    // foreign leg: dropping the line would drop 1 cent of foreign debit and
    // leave the document foreign-unbalanced (the database guard rejects
    // exactly that, and did).
    expect(result.value.lines).toHaveLength(3);
    const zeroed = result.value.lines.find((l) => l.baseDebit === 0n && l.baseCredit === 0n)!;
    expect(zeroed.foreignDebit).toBe(1n);
    const creditTotal = result.value.lines.reduce((sum, l) => sum + l.baseCredit, 0n);
    expect(creditTotal).toBe(1n);
    expect(result.value.baseTotal).toBe(1n); // balanced after absorption
    const fd = result.value.lines.reduce((sum, l) => sum + l.foreignDebit, 0n);
    const fc = result.value.lines.reduce((sum, l) => sum + l.foreignCredit, 0n);
    expect(fd).toBe(fc); // the foreign side survives the absorption intact
  });

  it("absorbs across lines when the residual exceeds any single line", () => {
    // Zero-decimal currency at rate 0.5: nine 1-unit debit lines round 0.5→1 each (Σ 9);
    // three 3-unit credit lines round 1.5→2 each (Σ 6). Residual +3, but every line is
    // worth 1..2 — one line cannot absorb it, so the walk spreads it over three
    // (each absorbed-to-zero debit line drops, leaving 6 debit + 3 credit lines).
    const lines = [
      ...Array.from({ length: 9 }, () => ({ accountId: A, side: "debit" as const, foreignMinor: 1n })),
      ...Array.from({ length: 3 }, () => ({ accountId: B, side: "credit" as const, foreignMinor: 3n })),
    ];
    const result = buildMulticurrencyDocument(lines, "0.5", 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundingDelta).toBe(3n);
    expect(result.value.baseTotal).toBe(6n);
    // All nine debit lines stay: three of them end at a zero BASE but keep
    // their foreign unit. Only truly empty lines (neither side) are dropped.
    expect(result.value.lines).toHaveLength(12);
    const debitTotal = result.value.lines.reduce((sum, l) => sum + l.baseDebit, 0n);
    const creditTotal = result.value.lines.reduce((sum, l) => sum + l.baseCredit, 0n);
    expect(debitTotal).toBe(6n);
    expect(creditTotal).toBe(6n);
    const fd = result.value.lines.reduce((sum, l) => sum + l.foreignDebit, 0n);
    const fc = result.value.lines.reduce((sum, l) => sum + l.foreignCredit, 0n);
    expect(fd).toBe(9n);
    expect(fc).toBe(9n);
    for (const line of result.value.lines) {
      // Every kept line moves something — base or foreign, never nothing.
      expect(
        line.baseDebit !== 0n || line.baseCredit !== 0n || line.foreignDebit !== 0n || line.foreignCredit !== 0n,
      ).toBe(true);
    }
  });

  it("releases a line at its booked base when the caller overrides it (settlement shape)", () => {
    // Settlement: Dr foreign bank $100 @ 610000 (base 61,000,000), Cr AR $100 released at its
    // booked base 60,000,000, Cr realized FX gain 1,000,000 as a base-only line.
    const result = buildMulticurrencyDocument(
      [
        { accountId: A, side: "debit", foreignMinor: 10000n },
        { accountId: B, side: "credit", foreignMinor: 10000n, baseMinor: 60_000_000n },
        { accountId: "44444444-4444-4444-8444-444444444444", side: "credit", baseMinor: 1_000_000n },
      ],
      "610000",
      USD.precision,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundingDelta).toBe(0n);
    expect(result.value.baseTotal).toBe(61_000_000n);
    const arLine = result.value.lines.find((l) => l.accountId === B)!;
    expect(arLine.baseCredit).toBe(60_000_000n); // booked value, NOT foreign × rate
    const fxLine = result.value.lines.find((l) => l.foreignDebit === 0n && l.foreignCredit === 0n);
    expect(fxLine?.baseCredit).toBe(1_000_000n);
  });

  it("refuses a residual the rounding policy cannot explain", () => {
    // Dr $100 at 610000 → 61,000,000; Cr $100 booked at 60,000,000; but the FX line
    // posts 999,999 instead of the 1,000,000 the legs actually differ by.
    const result = buildMulticurrencyDocument(
      [
        { accountId: A, side: "debit", foreignMinor: 10000n },
        { accountId: B, side: "credit", foreignMinor: 10000n, baseMinor: 60_000_000n },
        { accountId: "44444444-4444-4444-8444-444444444444", side: "credit", baseMinor: 999_999n },
      ],
      "610000",
      USD.precision,
    );
    expect(result).toEqual({ ok: false, problem: "fx_residual_unexplained" });
    expect(multicurrencyDocumentProblemMessage("fx_residual_unexplained")).toContain("تسعیر");
  });

  it("refuses foreign-unbalanced documents", () => {
    const result = buildMulticurrencyDocument(
      [
        { accountId: A, side: "debit", foreignMinor: 10000n },
        { accountId: B, side: "credit", foreignMinor: 9900n },
      ],
      USD_RATE,
      USD.precision,
    );
    expect(result).toEqual({ ok: false, problem: "foreign_unbalanced" });
  });

  it("refuses a document with no foreign lines at all", () => {
    const result = buildMulticurrencyDocument(
      [
        { accountId: A, side: "debit", baseMinor: 100n },
        { accountId: B, side: "credit", baseMinor: 100n },
      ],
      USD_RATE,
      USD.precision,
    );
    expect(result).toEqual({ ok: false, problem: "no_foreign_lines" });
  });

  it("validates line shape", () => {
    expect(buildMulticurrencyDocument([], USD_RATE, 2)).toEqual({ ok: false, problem: "no_lines" });
    expect(
      buildMulticurrencyDocument(
        [{ accountId: "", side: "debit", foreignMinor: 1n }, { accountId: A, side: "credit", foreignMinor: 1n }],
        USD_RATE,
        2,
      ),
    ).toEqual({ ok: false, problem: "invalid_account" });
    expect(
      buildMulticurrencyDocument(
        [
          { accountId: A, side: "debit", foreignMinor: 0n },
          { accountId: B, side: "credit", foreignMinor: 0n },
        ],
        USD_RATE,
        2,
      ),
    ).toEqual({ ok: false, problem: "neither_foreign_nor_base" });
  });
});

describe("consumeOpenLots — exact FIFO settlement", () => {
  const lot = (lineId: string, foreignRemaining: bigint, baseRemaining: bigint): ForeignOpenLot => ({
    lineId,
    entryId: `entry-${lineId}`,
    foreignRemaining,
    baseRemaining,
  });

  it("consumes a whole lot exactly", () => {
    const result = consumeOpenLots([lot("l1", 10000n, 60_000_000n)], 10000n);
    expect(result).toEqual({
      ok: true,
      value: [{ lineId: "l1", entryId: "entry-l1", foreignApplied: 10000n, baseApplied: 60_000_000n }],
    });
  });

  it("prorates a partial consumption and settles the remainder exactly on the last slice", () => {
    // A lot of $3 booked at 100 rial (base 300): settle $1 twice, then $1 again.
    // Slice 1: 100 × 1/3 = 33.33 → 33. Slice 2: from remaining 2/3 → 200×1/2=100? No —
    // allocation is per call against the *remaining* lot, so:
    const lots = [lot("l1", 300n, 100n)]; // 300 minor foreign booked at base 100
    const first = consumeOpenLots(lots, 100n);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value[0].baseApplied).toBe(33n); // round(100 × 100/300)

    const afterFirst = [lot("l1", 200n, 67n)];
    const second = consumeOpenLots(afterFirst, 100n);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // round(67 × 100/200) = 33.5 → half-up → 34
    expect(second.value[0].baseApplied).toBe(34n);

    const afterSecond = [lot("l1", 100n, 33n)];
    const third = consumeOpenLots(afterSecond, 100n);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    // the last slice empties the lot and takes the whole remaining base — exact by construction
    expect(third.value[0].baseApplied).toBe(33n);
    expect(33n + 34n + 33n).toBe(100n); // applied base sums to the booked base, no drift
  });

  it("consumes FIFO across lots", () => {
    const result = consumeOpenLots([lot("l1", 50n, 30n), lot("l2", 50n, 40n)], 80n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { lineId: "l1", entryId: "entry-l1", foreignApplied: 50n, baseApplied: 30n },
      { lineId: "l2", entryId: "entry-l2", foreignApplied: 30n, baseApplied: 24n }, // 40 × 30/50
    ]);
  });

  it("refuses settling more than the open balance", () => {
    expect(consumeOpenLots([lot("l1", 50n, 30n)], 51n)).toEqual({ ok: false, problem: "insufficient_open_balance" });
    expect(consumeOpenLots([], 1n)).toEqual({ ok: false, problem: "insufficient_open_balance" });
    expect(consumeOpenLots([lot("l1", 50n, 30n)], 0n)).toEqual({ ok: false, problem: "invalid_amount" });
    expect(consumeOpenLots([lot("l1", 50n, 30n)], -1n)).toEqual({ ok: false, problem: "invalid_amount" });
  });
});

describe("realized & unrealized FX", () => {
  it("computes the realized difference signed", () => {
    expect(realizedFxDifference(61_000_000n, 60_000_000n)).toBe(1_000_000n); // gain
    expect(realizedFxDifference(59_000_000n, 60_000_000n)).toBe(-1_000_000n); // loss
    expect(realizedFxDifference(60_000_000n, 60_000_000n)).toBe(0n);
  });

  it("restates a debit-normal account", () => {
    const outcome = restateForeignBalance({
      foreignBalanceMinor: 10_000n,
      bookBaseMinor: 60_000_000n,
      rate: "610000",
      precision: 2,
      debitNormal: true,
    });
    expect(outcome.newValue).toBe(61_000_000n);
    expect(outcome.difference).toBe(1_000_000n);
    expect(outcome.gain).toBe(1_000_000n);
    expect(outcome.loss).toBe(0n);
  });

  it("flips gain/loss for a credit-normal (liability) account", () => {
    const outcome = restateForeignBalance({
      foreignBalanceMinor: 10_000n,
      bookBaseMinor: 60_000_000n,
      rate: "610000",
      precision: 2,
      debitNormal: false,
    });
    expect(outcome.difference).toBe(1_000_000n); // the balance rose…
    expect(outcome.gain).toBe(0n);
    expect(outcome.loss).toBe(1_000_000n); // …which for a payable is a loss
  });

  it("recognizes a loss when a foreign bank weakens", () => {
    const outcome = restateForeignBalance({
      foreignBalanceMinor: 10_000n,
      bookBaseMinor: 61_000_000n,
      rate: "600000",
      precision: 2,
      debitNormal: true,
    });
    expect(outcome.loss).toBe(1_000_000n);
    expect(outcome.gain).toBe(0n);
  });
});

describe("payload parsers", () => {
  it("parses a valid entry payload with exact string amounts", () => {
    const parsed = parseMulticurrencyEntryPayload({
      currencyCode: "USD",
      entryDate: "2026-01-15",
      memo: "فاکتور ارزی",
      lines: [
        { accountId: A, side: "debit", foreignAmount: "10000" },
        { accountId: B, side: "credit", foreignAmount: "10000", partyId: P },
      ],
      idempotencyKey: "abc123",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.lines[0].foreignMinor).toBe(10000n);
    expect(parsed.value.lines[1].partyId).toBe(P);
    expect(parsed.value.rateId).toBeNull();
  });

  it("rejects malformed entry payloads with named problems", () => {
    expect(parseMulticurrencyEntryPayload(null).ok).toBe(false);
    expect(parseMulticurrencyEntryPayload({ currencyCode: "usd", lines: [] }).ok).toBe(false);
    expect(
      parseMulticurrencyEntryPayload({
        currencyCode: "USD",
        lines: [{ accountId: "not-a-uuid", side: "debit", foreignAmount: "1" }],
      }),
    ).toMatchObject({ ok: false, problem: "invalid_account_id" });
    expect(
      parseMulticurrencyEntryPayload({
        currencyCode: "USD",
        lines: [{ accountId: A, side: "sideways", foreignAmount: "1" }],
      }),
    ).toMatchObject({ ok: false, problem: "invalid_side" });
    expect(
      parseMulticurrencyEntryPayload({
        currencyCode: "USD",
        lines: [{ accountId: A, side: "debit", foreignAmount: "1.5" }],
      }),
    ).toMatchObject({ ok: false, problem: "invalid_amount" });
    expect(
      parseMulticurrencyEntryPayload({
        currencyCode: "USD",
        lines: [{ accountId: A, side: "debit", foreignAmount: "1", baseAmount: "2" }],
      }),
    ).toMatchObject({ ok: false, problem: "invalid_line" });
    // amounts above 2^53 stay exact — this is why the wire speaks text
    const big = parseMulticurrencyEntryPayload({
      currencyCode: "USD",
      lines: [{ accountId: A, side: "debit", foreignAmount: "99999999999999999999" }],
    });
    expect(big.ok).toBe(true);
    if (big.ok) expect(big.value.lines[0].foreignMinor).toBe(99_999_999_999_999_999_999n);
  });

  it("parses rate payloads canonically", () => {
    expect(parseRatePayload({ currencyCode: "USD", rate: "600000.00" })).toEqual({
      ok: true,
      value: { currencyCode: "USD", rate: "600000", effectiveFrom: null },
    });
    expect(parseRatePayload({ currencyCode: "USD", rate: "0" })).toMatchObject({ ok: false, problem: "invalid_rate" });
  });

  it("parses settlement payloads and requires exactly one of auto/items", () => {
    const auto = parseSettlementPayload({
      direction: "receivable",
      partyId: P,
      currencyCode: "USD",
      settlementAccountId: A,
      autoAmount: "5000",
    });
    expect(auto.ok).toBe(true);
    if (auto.ok) expect(auto.value.autoAmount).toBe("5000");
    const both = parseSettlementPayload({
      direction: "receivable",
      partyId: P,
      currencyCode: "USD",
      settlementAccountId: A,
      autoAmount: "5000",
      items: [{ entryId: "entry-" + A, amount: "1" }],
    });
    expect(both).toMatchObject({ ok: false, problem: "bad_request" });
    const neither = parseSettlementPayload({
      direction: "receivable",
      partyId: P,
      currencyCode: "USD",
      settlementAccountId: A,
    });
    expect(neither).toMatchObject({ ok: false, problem: "bad_request" });
  });
});

describe("minorToMajorText", () => {
  it("scales minor units up to the currency's major-unit text", () => {
    expect(minorToMajorText(10000n, 2)).toBe("100.00");
    expect(minorToMajorText(1n, 2)).toBe("0.01");
    expect(minorToMajorText(7n, 0)).toBe("7");
    expect(minorToMajorText(-5n, 2)).toBe("-0.05");
    expect(minorToMajorText(0n, 3)).toBe("0.000");
  });
});

describe("policy constants", () => {
  it("stays version 1 — bumping it is a documented decision, not an accident", () => {
    expect(ROUNDING_POLICY_VERSION).toBe(1);
  });

  it("round-trips a rate that is itself the base (IRR when base is IRR)", () => {
    expect(convertToBaseMinor(1000n, IRR_RATE, 0)).toBe(1000n);
  });
});
