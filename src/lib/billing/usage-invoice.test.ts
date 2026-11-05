/**
 * Issue #902 §9 item 3 (second half) — the arithmetic of a usage invoice.
 *
 * The database suite proves the rows land; this one proves the numbers are what
 * they claim to be, and pins the three invariants the database cannot express:
 *
 *   - a line's amount is the sum of the ratings behind it (never the unit price
 *     multiplied back);
 *   - a line is one meter + one price version, so "which version priced this?"
 *     always has a single true answer;
 *   - a rating is never dropped for being awkward — a zero-rated one is simply
 *     not billed, and a pre-0270 one is billed without a citation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  groupUsageInvoiceLines,
  provenanceLabel,
  type BillableRating,
} from "./usage-invoice";
import { PRICE_BASIS_LABELS } from "./rating-basis";

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

function rating(overrides: Partial<BillableRating> = {}): BillableRating {
  return {
    usageEventId: crypto.randomUUID(),
    meterKey: "messaging.sms_segment",
    quantity: 1,
    ratedAmountRial: 1_000,
    priceBasis: "retail_price_version",
    priceVersionId: null,
    retailPriceVersionId: "00000000-0000-0000-0000-000000000007",
    retailPriceVersion: 7,
    ...overrides,
  };
}

describe("a line is one meter on one set of terms", () => {
  it("folds ratings of the same meter and version into a single line", () => {
    const first = rating({ quantity: 2, ratedAmountRial: 2_400 });
    const second = rating({ quantity: 3, ratedAmountRial: 3_600 });
    const body = groupUsageInvoiceLines([first, second]);

    expect(body.lines).toHaveLength(1);
    const line = body.lines[0]!;
    expect(line.amountRial).toBe(6_000);
    expect(line.quantity).toBe(5);
    expect(line.unitAmountRial).toBe(1_200);
    expect(line.ratings.map((entry) => entry.usageEventId).sort()).toEqual(
      [first.usageEventId, second.usageEventId].sort(),
    );
    // The line adds up to its parts, which is what the write asserts row by row.
    expect(line.ratings.reduce((sum, entry) => sum + entry.amountRial, 0)).toBe(line.amountRial);
    expect(body.subtotalRial).toBe(6_000);
    expect(body.totalRial).toBe(6_000);
    expect(body.ratingCount).toBe(2);
    expect(body.billedCount).toBe(2);
  });

  it("splits a mid-month price change into two lines, each citing its own version", () => {
    // A promotion ended on the 15th: same meter, same month, different terms.
    const body = groupUsageInvoiceLines([
      rating({
        retailPriceVersion: 7,
        retailPriceVersionId: "00000000-0000-0000-0000-000000000007",
        ratedAmountRial: 1_200,
      }),
      rating({
        retailPriceVersion: 8,
        retailPriceVersionId: "00000000-0000-0000-0000-000000000008",
        ratedAmountRial: 1_500,
      }),
    ]);

    expect(body.lines).toHaveLength(2);
    const byVersion = [...body.lines].sort(
      (a, b) => (a.retailPriceVersion ?? 0) - (b.retailPriceVersion ?? 0),
    );
    expect(byVersion.map((line) => line.retailPriceVersion)).toEqual([7, 8]);
    // Biggest first, so the invoice reads with the largest charge on top.
    expect(body.lines[0]!.amountRial).toBe(1_500);
    // Each line cites exactly one version — never a blend of both.
    expect(new Set(body.lines.map((line) => line.retailPriceVersionId)).size).toBe(2);
    expect(new Set(body.lines.map((line) => line.amountRial))).toEqual(new Set([1_200, 1_500]));
  });

  it("keeps a meter-priced line and a retail-priced line for the same meter apart", () => {
    const body = groupUsageInvoiceLines([
      rating({ priceBasis: "retail_price_version", retailPriceVersion: 7, ratedAmountRial: 1_200 }),
      rating({
        priceBasis: "meter_price_version",
        priceVersionId: "11111111-1111-1111-1111-111111111111",
        retailPriceVersion: null,
        retailPriceVersionId: null,
        ratedAmountRial: 900,
      }),
    ]);
    expect(body.lines).toHaveLength(2);
    const retail = body.lines.find((line) => line.priceBasis === "retail_price_version")!;
    const meter = body.lines.find((line) => line.priceBasis === "meter_price_version")!;
    // The catalogues never cross: a retail line cites no meter version and the
    // meter line cites no retail one (0275's CHECK would refuse it anyway).
    expect(retail.priceVersionId).toBeNull();
    expect(retail.retailPriceVersion).toBe(7);
    expect(meter.retailPriceVersion).toBeNull();
    expect(meter.priceVersionId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("nothing is billed that cannot be paid, and nothing owed is dropped", () => {
  it("produces no line for usage entirely inside an allowance, but still counts it", () => {
    const body = groupUsageInvoiceLines([rating({ ratedAmountRial: 0, quantity: 40 })]);
    expect(body.lines).toHaveLength(0);
    expect(body.subtotalRial).toBe(0);
    // The distinction that matters to an operator: "no usage" (0 counted) versus
    // "usage, all of it free" (1 counted, 0 billed).
    expect(body.ratingCount).toBe(1);
    expect(body.billedCount).toBe(0);
  });

  it("bills a pre-0270 rating without inventing a citation for it", () => {
    const body = groupUsageInvoiceLines([
      rating({
        priceBasis: null,
        priceVersionId: null,
        retailPriceVersion: null,
        retailPriceVersionId: null,
        ratedAmountRial: 4_200,
      }),
    ]);
    const line = body.lines[0]!;
    expect(line.amountRial).toBe(4_200);
    expect(line.priceBasis).toBeNull();
    expect(line.priceVersionId).toBeNull();
    expect(line.retailPriceVersion).toBeNull();
    // No provenance suffix, because there is no provenance to state.
    expect(provenanceLabel({ priceBasis: null, retailPriceVersion: null })).toBe("");
  });

  it("never recomputes the amount from the unit price", () => {
    // 10 Rial over 3 units does not divide evenly. The amount is what the ratings
    // said; the unit is a rounded display figure. A caller that multiplied them
    // back would bill 9 and leave a Rial unexplained on every such line.
    const body = groupUsageInvoiceLines([rating({ quantity: 3, ratedAmountRial: 10 })]);
    const line = body.lines[0]!;
    expect(line.unitAmountRial).toBe(3);
    expect(line.amountRial).toBe(10);
    expect(line.unitAmountRial * line.quantity).not.toBe(line.amountRial);
  });

  it("drops a negative amount rather than crediting it into the total", () => {
    // Ratings cannot be negative today (`rated_amount_rial >= 0` and the writer
    // floors at 0), so a negative here means a corrupt row. Billing 0 for it is
    // the safe read; letting it subtract would silently reduce a real bill.
    const body = groupUsageInvoiceLines([rating({ ratedAmountRial: -5_000 })]);
    expect(body.lines).toHaveLength(0);
    expect(body.subtotalRial).toBe(0);
  });
});

describe("the description says which price produced the line", () => {
  it("uses the catalogue's own Persian name and the retail version number", () => {
    const body = groupUsageInvoiceLines([rating({ retailPriceVersion: 7 })]);
    const description = body.lines[0]!.description;
    expect(description).toContain("پیامک");
    expect(description).toContain(PRICE_BASIS_LABELS.retail_price_version);
    // Persian digits, because this is text a business reads.
    expect(description).toContain("۷");
    expect(description).not.toMatch(/kavenegar|provider|API|supplier/i);
  });

  it("falls back to the meter key for a meter the catalogue does not know", () => {
    const body = groupUsageInvoiceLines([
      rating({ meterKey: "future.unknown_meter", priceBasis: "explicit_amount", retailPriceVersion: null }),
    ]);
    expect(body.lines[0]!.description).toBe("future.unknown_meter — " + PRICE_BASIS_LABELS.explicit_amount);
  });

  it("orders lines by amount, then by description, deterministically", () => {
    const a = groupUsageInvoiceLines([
      rating({ meterKey: "ai.request", ratedAmountRial: 100, retailPriceVersion: 1 }),
      rating({ meterKey: "media.storage_byte_hour", ratedAmountRial: 500, retailPriceVersion: 1 }),
    ]);
    const b = groupUsageInvoiceLines([
      rating({ meterKey: "media.storage_byte_hour", ratedAmountRial: 500, retailPriceVersion: 1 }),
      rating({ meterKey: "ai.request", ratedAmountRial: 100, retailPriceVersion: 1 }),
    ]);
    expect(a.lines.map((line) => line.description)).toEqual(b.lines.map((line) => line.description));
    expect(a.lines[0]!.amountRial).toBe(500);
  });
});

describe("the schema and the writer agree with this arithmetic", () => {
  it("adds the provenance columns with 0270's pairing rules", () => {
    const migration = read("migrations/0275_billing_usage_invoice_lines.sql");
    expect(migration).toMatch(/ADD COLUMN price_basis text/);
    expect(migration).toMatch(
      /CHECK \(\(price_basis = 'retail_price_version'\) = \(retail_price_version IS NOT NULL\)\)/,
    );
    expect(migration).toMatch(/price_basis IS DISTINCT FROM 'retail_price_version' OR price_version_id IS NULL/);
    // Only a usage line may claim a usage basis; a plan line keeps its plan price.
    expect(migration).toMatch(/CHECK \(price_basis IS NULL OR kind = 'usage'\)/);
  });

  it("makes one rating billable once, ever", () => {
    const migration = read("migrations/0275_billing_usage_invoice_lines.sql");
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX billing_invoice_line_usage_once\s*\n\s*ON billing_invoice_line_usage \(usage_event_id\)/,
    );
    // And it is tenant data, forced, like every other business-owned table.
    expect(migration).toMatch(/ALTER TABLE billing_invoice_line_usage FORCE ROW LEVEL SECURITY/);
  });

  it("links every rating it bills, with the amount it contributed", () => {
    const service = read("src/lib/billing/usage-invoice-service.ts");
    expect(service).toMatch(/INSERT INTO billing_invoice_line_usage/);
    expect(service).toMatch(/\[\s*lineId,\s*rating\.usageEventId,\s*businessId,\s*line\.meterKey,\s*rating\.amountRial,?\s*\]/);
    // A retail line must not carry a meter price version into the row — 0275's
    // CHECK would reject it, but the writer should not rely on a bounce.
    expect(service).toMatch(
      /line\.priceBasis === "meter_price_version" \? line\.priceVersionId : null/,
    );
  });

  it("bills only what the wallet has not already collected", () => {
    const service = read("src/lib/billing/usage-invoice-service.ts");
    // Same predicate as the spend breakdown (`getMonthlySpendBreakdown`): one
    // definition of "billable outside the wallet", not two that can disagree.
    const predicate = /COALESCE\(\(e\.dimensions->>'walletBacked'\)::boolean, false\) = false/;
    expect(service).toMatch(predicate);
    expect(read("src/lib/billing/runtime.ts")).toMatch(predicate);
    // Already-invoiced ratings are excluded inside the same read that writes the
    // links, so two issuers cannot both see a rating as unbilled.
    expect(service).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM billing_invoice_line_usage u WHERE u\.usage_event_id = r\.usage_event_id/);
  });

  it("claims the month before writing lines, and says so by reference", () => {
    const service = read("src/lib/billing/usage-invoice-service.ts");
    expect(service).toMatch(/ON CONFLICT \(business_id, reference\) DO NOTHING/);
    expect(service).toMatch(/export function usageInvoiceReference\(periodMonth: string\): string \{\s*return `usage:\$\{periodMonth\}`;/);
    // Issuing is scoped: an invoice line is that business's own data.
    expect(service).toMatch(/withTenant\(input\.businessId/);
  });

  it("guards both halves of the operator route", () => {
    const route = read("src/app/api/platform/billing/usage-invoices/route.ts");
    expect(route).toMatch(/requirePlatformCapability\("billing\.view"\)/);
    expect(route).toMatch(/requirePlatformCapability\("billing\.manage"\)/);
    // Issuing is a money action: it must be audited with the invoice it created.
    expect(route).toMatch(/platformAudit\(/);
  });
});
