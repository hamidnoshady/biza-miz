/**
 * The relationship summary's promises.
 *
 * Two matter:
 *
 *  1. **It cannot invent a fact.** Every line is built from the input and names
 *     its source, so the same inputs always produce the same lines — asserted
 *     with the clock moved between two calls, which is the only way text can
 *     sneak a hidden "now" into itself.
 *  2. **It always says something.** A customer with no orders still gets a
 *     headline, a reason and (where the facts imply one) a next step.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { customerHealth } from "./crm-health";
import { relationshipSummary, SUMMARY_SOURCES, type RelationshipSummaryInput } from "./crm-summary";

const formatMoney = (rial: number) => `${rial.toLocaleString("en-US")} ریال`;

function summary(overrides: Partial<RelationshipSummaryInput> = {}) {
  const input: RelationshipSummaryInput = {
    name: "مریم احمدی",
    health: customerHealth({
      lifecycleStage: "loyal",
      orderCount: 6,
      daysSinceLastPurchase: 12,
      purchaseIntervalDays: 20,
      openCases: 0,
      openDeals: 0,
      overdueRial: 0,
    }),
    stats: {
      orderCount: 6,
      totalSpentRial: 12_000_000,
      lastPurchaseDate: "2026-09-20",
      daysSinceLastPurchase: 12,
      loyaltyPoints: 400,
      openCases: 0,
      openDeals: 0,
    },
    accounting: { receivableRial: 0, hasLedger: true, overdueRial: 0 },
    consent: { smsConsent: true, marketingConsent: false },
    rfm: { stage: "loyal" },
    timeline: [
      { at: "2026-09-20T10:00:00.000Z", kindLabel: "خرید", summary: "سفارش ۱۰۲" },
      { at: "2026-09-01T10:00:00.000Z", kindLabel: "تماس", summary: "پیگیری رضایت" },
    ],
    formatMoney,
    ...overrides,
  };
  return { input, result: relationshipSummary(input) };
}

describe("relationshipSummary", () => {
  it("leads with the person and the state, and quotes the reason", () => {
    const { result } = summary();
    expect(result.headline).toContain("مریم احمدی");
    expect(result.headline).toContain("وضعیت رابطه");
    // The fixture is a loyal customer buying on cadence: «عالی», and the
    // sentence after the state is the reason that produced it.
    expect(result.headline).toContain("عالی");
    expect(result.headline).toContain("مشتریان وفادار");
  });

  it("labels every line with the source it came from", () => {
    const { result } = summary();
    expect(result.lines.length).toBeGreaterThan(3);
    for (const line of result.lines) {
      expect(SUMMARY_SOURCES).toContain(line.source);
      expect(line.text.trim().length).toBeGreaterThan(0);
    }
    expect(result.lines.map((line) => line.source)).toContain("purchases");
    expect(result.lines.map((line) => line.source)).toContain("consent");
    expect(result.lines.map((line) => line.source)).toContain("timeline");
  });

  it("quotes the newest timeline entries, newest first", () => {
    const { result } = summary();
    const timeline = result.lines.filter((line) => line.source === "timeline");
    expect(timeline).toHaveLength(2);
    expect(timeline[0].text).toContain("سفارش ۱۰۲");
    expect(timeline[1].text).toContain("پیگیری رضایت");
  });

  it("reads the receivable through the accounting contract and says which part is overdue", () => {
    const { result } = summary({
      accounting: { receivableRial: 5_000_000, hasLedger: true, overdueRial: 2_000_000 },
    });
    const line = result.lines.find((entry) => entry.source === "accounting")!;
    expect(line.text).toContain(formatMoney(5_000_000));
    expect(line.text).toContain(formatMoney(2_000_000));
    expect(line.text).toContain("سررسید");
  });

  it("says nothing about money when the business keeps no ledger", () => {
    const { result } = summary({
      accounting: { receivableRial: 5_000_000, hasLedger: false, overdueRial: 5_000_000 },
    });
    expect(result.lines.some((line) => line.source === "accounting")).toBe(false);
  });

  it("suggests one obvious next step for each state", () => {
    const { result: atRisk } = summary({
      health: customerHealth({
        lifecycleStage: "at_risk",
        orderCount: 3,
        daysSinceLastPurchase: 90,
        purchaseIntervalDays: 20,
        openCases: 0,
        openDeals: 0,
        overdueRial: 0,
      }),
    });
    expect(atRisk.nextStep).toContain("تماس");

    const { result: debt } = summary({
      health: customerHealth({
        lifecycleStage: null,
        orderCount: 3,
        daysSinceLastPurchase: 90,
        purchaseIntervalDays: 20,
        openCases: 0,
        openDeals: 0,
        overdueRial: 1_000_000,
      }),
      accounting: { receivableRial: 1_000_000, hasLedger: true, overdueRial: 1_000_000 },
    });
    expect(debt.nextStep).toContain("بدهی");

    const { result: gone } = summary({
      health: customerHealth({
        lifecycleStage: "lost",
        orderCount: 2,
        daysSinceLastPurchase: 400,
        purchaseIntervalDays: null,
        openCases: 0,
        openDeals: 0,
        overdueRial: 0,
      }),
    });
    expect(gone.nextStep).toContain("بازگشت");

    const { result: good } = summary({
      health: customerHealth({
        lifecycleStage: "champion",
        orderCount: 9,
        daysSinceLastPurchase: 6,
        purchaseIntervalDays: 14,
        openCases: 0,
        openDeals: 0,
        overdueRial: 0,
      }),
      timeline: [],
    });
    expect(good.nextStep).toContain("معرفی");
  });

  it("always produces a headline and at least one line, even for a blank record", () => {
    const { result } = summary({
      health: customerHealth({
        lifecycleStage: null,
        orderCount: 0,
        daysSinceLastPurchase: null,
        purchaseIntervalDays: null,
        openCases: 0,
        openDeals: 0,
        overdueRial: 0,
      }),
      stats: {
        orderCount: 0,
        totalSpentRial: 0,
        lastPurchaseDate: null,
        daysSinceLastPurchase: null,
        loyaltyPoints: 0,
        openCases: 0,
        openDeals: 0,
      },
      rfm: { stage: null },
      timeline: [],
      consent: { smsConsent: false, marketingConsent: false },
    });
    expect(result.headline.trim().length).toBeGreaterThan(0);
    expect(result.lines.length).toBeGreaterThanOrEqual(2);
    expect(result.lines.some((line) => line.text.includes("ثبت نشده"))).toBe(true);
    expect(result.lines.some((line) => line.source === "consent")).toBe(true);
  });

  it("reads no clock of its own: the same facts read the same tomorrow", () => {
    const { input } = summary();
    const first = relationshipSummary(input);
    // Nothing here may consult "now": a summary that aged by itself would
    // disagree with the metrics printed beside it.
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const second = relationshipSummary(input);
    expect(second).toEqual(first);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
