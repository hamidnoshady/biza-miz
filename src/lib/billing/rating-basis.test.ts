import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRICE_BASIS_LABELS, resolveRatingBasis } from "./rating-basis";

/**
 * Issue #902 §9 item 3 — a rating may only claim the price that produced it.
 *
 * Before this slice every rating row carried the *active meter* version, even
 * when the amount beside it came from the retail catalogue or from a feature
 * price the caller computed. The column was never empty, so "which price version
 * made this charge?" had a confident, wrong answer. These tests pin the rule that
 * replaced it; the SQL constraints that make the answer unrepresentable are in
 * migration 0270 and are exercised by the database suite.
 */

const METER_VERSION = "11111111-1111-1111-1111-111111111111";
const RETAIL_VERSION = "22222222-2222-2222-2222-222222222222";

const base = {
  ratedAmountRial: null as number | null,
  priceVersionId: null as string | null,
  retailPriceVersionId: null as string | null,
  retailPriceVersion: null as number | null,
  resolvedMeterPriceVersionId: null as string | null,
};

describe("a rating cites the price that produced it", () => {
  it("cites the retail version, and nothing in the meter column", () => {
    // The two columns reference different catalogues. A retail-priced row that
    // also filled `price_version_id` would point at a `billing_price_versions`
    // entry whose numbers were never used — the false provenance this replaces.
    expect(
      resolveRatingBasis({
        ...base,
        ratedAmountRial: 2_400,
        retailPriceVersionId: RETAIL_VERSION,
        retailPriceVersion: 7,
        resolvedMeterPriceVersionId: METER_VERSION,
      }),
    ).toEqual({
      basis: "retail_price_version",
      priceVersionId: null,
      retailPriceVersionId: RETAIL_VERSION,
      retailPriceVersion: 7,
    });
  });

  it("keeps the retail version number when the default version has no row", () => {
    // Version 0 is the built-in default: it exists as a policy, never as a row.
    expect(
      resolveRatingBasis({ ...base, ratedAmountRial: 1_200, retailPriceVersion: 0 }),
    ).toMatchObject({ basis: "retail_price_version", retailPriceVersion: 0, retailPriceVersionId: null });
  });

  it("cites nothing for an amount the caller computed itself", () => {
    // AI tokens, media storage, activation: the caller rated from a config rate
    // or a feature price. No version was involved, so naming the current meter
    // version would be an assertion about a computation that never happened.
    expect(
      resolveRatingBasis({
        ...base,
        ratedAmountRial: 5_000,
        resolvedMeterPriceVersionId: METER_VERSION,
      }),
    ).toEqual({
      basis: "explicit_amount",
      priceVersionId: null,
      retailPriceVersionId: null,
      retailPriceVersion: null,
    });
  });

  it("cites an explicitly requested meter version", () => {
    expect(
      resolveRatingBasis({
        ...base,
        priceVersionId: METER_VERSION,
        resolvedMeterPriceVersionId: "33333333-3333-3333-3333-333333333333",
      }),
    ).toMatchObject({ basis: "meter_price_version", priceVersionId: METER_VERSION });
  });

  it("cites the meter version the runtime resolved, when the meter did the rating", () => {
    expect(
      resolveRatingBasis({ ...base, resolvedMeterPriceVersionId: METER_VERSION }),
    ).toMatchObject({ basis: "meter_price_version", priceVersionId: METER_VERSION });
  });

  it("prefers the retail version over an explicit amount — the more specific truth wins", () => {
    expect(
      resolveRatingBasis({
        ...base,
        ratedAmountRial: 900,
        retailPriceVersion: 3,
        retailPriceVersionId: RETAIL_VERSION,
      }),
    ).toMatchObject({ basis: "retail_price_version", retailPriceVersion: 3 });
  });

  it("normalises a nonsensical version instead of trusting it", () => {
    // Refused rather than clamped: 0 already means "the built-in default", so
    // turning a negative number into it would be a specific wrong claim.
    expect(
      resolveRatingBasis({ ...base, ratedAmountRial: 1, retailPriceVersion: -2 }),
    ).toMatchObject({ basis: "explicit_amount" });
    expect(
      resolveRatingBasis({ ...base, ratedAmountRial: 1, retailPriceVersion: 4.7 }),
    ).toMatchObject({ retailPriceVersion: 4 });
    expect(
      resolveRatingBasis({ ...base, ratedAmountRial: 1, retailPriceVersion: Number.NaN }),
    ).toMatchObject({ basis: "explicit_amount" });
  });

  it("has first-party labels for the console, and no supplier vocabulary", () => {
    for (const label of Object.values(PRICE_BASIS_LABELS)) {
      expect(label.trim()).not.toBe("");
      expect(label).not.toMatch(/kavenegar|provider|API/i);
    }
  });
});

describe("the ledger and the schema agree with this rule", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

  it("writes the basis and the retail version with the rating", () => {
    const runtime = read("src/lib/billing/runtime.ts");
    expect(runtime).toMatch(/resolveRatingBasis\(\{/);
    // Both insert branches carry the three columns; a rating written without a
    // basis would be indistinguishable from a legacy row.
    const inserts = runtime.match(/price_basis,\s*\n\s*retail_price_version_id, retail_price_version/g) ?? [];
    expect(inserts.length).toBe(2);
  });

  it("constrains the three columns so a contradictory row cannot be stored", () => {
    const migration = read("migrations/0270_billing_usage_rating_basis.sql");
    // The basis and the retail version are one fact, not two.
    expect(migration).toMatch(
      /CHECK \(\(price_basis = 'retail_price_version'\) = \(retail_price_version IS NOT NULL\)\)/,
    );
    // A retail row must not point at the meter catalogue.
    expect(migration).toMatch(/price_version_id IS NULL/);
    // Legacy rows stay unknown rather than guessed.
    expect(migration).toMatch(/ADD COLUMN price_basis text\s*\n\s*CHECK/);
    expect(migration).not.toMatch(/price_basis text NOT NULL DEFAULT/);
  });

  it("has the messaging drain name the version that priced the batch", () => {
    const outbox = read("src/lib/message-outbox-service.ts");
    // `pricing.version` is resolved ONCE for the whole batch, before any send,
    // so every row's rating can cite the same version the wallet entry did.
    expect(outbox).toMatch(/retailPriceVersionId: pricing\.version\.id,/);
    expect(outbox).toMatch(/retailPriceVersion: pricing\.version\.version,/);
    // And the amount rated is the amount reserved: `rowCost` comes from the same
    // quote that was summed into the reservation.
    expect(outbox).toMatch(/const rowCost = quote\?\.totalRial \?\?/);
    expect(outbox).toMatch(/ratedAmountRial: rowCost,/);
    expect(outbox).toMatch(
      /const totalCost = \[\.\.\.pricing\.quotes\.values\(\)\]\.reduce\(\(sum, quote\) => sum \+ quote\.totalRial, 0\)/,
    );
  });

  it("counts each accepted send once, so settlement cannot keep an unsent row's credit", () => {
    const outbox = read("src/lib/message-outbox-service.ts");
    // `settleMessageSend` charges `min(actual, reserved)`. While the success
    // path added `rowCost` twice, `actual` was twice the quote, so any batch
    // with one refused row charged the WHOLE reservation and refunded nothing —
    // money for a message the provider never accepted. Counting the increment
    // here is what keeps wallet spend equal to the sum of the ratings.
    const increments = outbox.match(/sentCost\.total \+= rowCost;/g) ?? [];
    expect(increments).toHaveLength(1);
    // The refused-with-`charge` policy still counts its own row, deliberately.
    expect(outbox).toMatch(/failedSendPolicy === "charge"/);
  });
});
