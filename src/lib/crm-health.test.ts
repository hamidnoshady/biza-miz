/**
 * The health classifier's promises, pinned.
 *
 * The one that matters most is the last block: **every answer comes with a
 * reason.** A state nobody can explain is a state people learn to ignore, so
 * the property is asserted over the whole input space rather than on a handful
 * of examples.
 */
import { describe, expect, it } from "vitest";
import {
  ATTENTION_SILENCE_DAYS,
  CUSTOMER_HEALTH_META,
  CUSTOMER_HEALTH_STATES,
  INACTIVE_SILENCE_DAYS,
  customerHealth,
  type CustomerHealthInput,
} from "./crm-health";
import { LIFECYCLE_STAGES } from "./crm-scoring";

function input(overrides: Partial<CustomerHealthInput> = {}): CustomerHealthInput {
  return {
    lifecycleStage: null,
    orderCount: 4,
    daysSinceLastPurchase: 10,
    purchaseIntervalDays: 20,
    openCases: 0,
    openDeals: 0,
    overdueRial: 0,
    ...overrides,
  };
}

describe("customerHealth", () => {
  it("says «غیرفعال» for somebody who has never bought", () => {
    const health = customerHealth(input({ orderCount: 0, daysSinceLastPurchase: null }));
    expect(health.state).toBe("inactive");
    expect(health.reasons.map((reason) => reason.code)).toContain("never_purchased");
  });

  it("turns inactive at the silence boundary and not a day before", () => {
    expect(customerHealth(input({ daysSinceLastPurchase: INACTIVE_SILENCE_DAYS - 1 })).state).toBe("at_risk");
    expect(customerHealth(input({ daysSinceLastPurchase: INACTIVE_SILENCE_DAYS })).state).toBe("inactive");
  });

  it("judges silence against the customer's own cadence, not the calendar", () => {
    // Monthly buyer, 40 days: their pattern is broken even though 40 days is
    // unremarkable for somebody who buys twice a year.
    const slow = customerHealth(input({ purchaseIntervalDays: 30, daysSinceLastPurchase: 75 }));
    expect(slow.state).toBe("at_risk");
    expect(slow.reasons[0].text).toContain("هر ۳۰ روز");

    // Weekly buyer, 12 days: later than usual, but the pattern is intact.
    const weekly = customerHealth(input({ purchaseIntervalDays: 7, daysSinceLastPurchase: 12 }));
    expect(weekly.state).toBe("healthy");
  });

  it("treats two open tickets as a risk and one as attention", () => {
    expect(customerHealth(input({ openCases: 1 })).state).toBe("needs_attention");
    expect(customerHealth(input({ openCases: 2 })).state).toBe("at_risk");
  });

  it("counts a past-due invoice as a risk, and says where the number came from", () => {
    const health = customerHealth(input({ overdueRial: 2_500_000 }));
    expect(health.state).toBe("at_risk");
    const reason = health.reasons.find((entry) => entry.code === "overdue_receivable")!;
    expect(reason.text).toContain("حسابداری");
  });

  it("shows every signal, not only the one that decided the state", () => {
    // Dormant *and* owing money: the invoice must not disappear behind the
    // louder state.
    const health = customerHealth(
      input({ orderCount: 0, daysSinceLastPurchase: null, overdueRial: 1_000_000 }),
    );
    expect(health.state).toBe("inactive");
    const codes = health.reasons.map((reason) => reason.code);
    expect(codes).toContain("never_purchased");
    expect(codes).toContain("overdue_receivable");
    // Worst first.
    expect(codes[0]).toBe("never_purchased");
  });

  it("reads the lifecycle stage the RFM job already assigned", () => {
    expect(customerHealth(input({ lifecycleStage: "at_risk" })).state).toBe("at_risk");
    expect(customerHealth(input({ lifecycleStage: "about_to_sleep" })).state).toBe("needs_attention");
    expect(customerHealth(input({ lifecycleStage: "lost" })).state).toBe("inactive");
    const champion = customerHealth(input({ lifecycleStage: "champion" }));
    expect(champion.state).toBe("excellent");
    // The reason quotes the lifecycle module's own label — one vocabulary, not
    // a second set of names maintained here.
    expect(champion.reasons.some((reason) => reason.text.includes(LIFECYCLE_STAGES.champion.label))).toBe(true);
  });

  it("reserves «عالی» for a regular, valuable buyer", () => {
    expect(customerHealth(input({ lifecycleStage: "loyal", orderCount: 2 })).state).toBe("healthy");
    expect(customerHealth(input({ lifecycleStage: "loyal", orderCount: 3 })).state).toBe("excellent");
    // A champion who has gone quiet is not excellent.
    expect(
      customerHealth(input({ lifecycleStage: "champion", purchaseIntervalDays: 10, daysSinceLastPurchase: 60 })).state,
    ).toBe("at_risk");
  });

  it("never reports a state that is healthier than one of its own reasons", () => {
    // Two signals of different weight: the answer is the heavier one.
    const health = customerHealth(input({ openCases: 1, overdueRial: 500_000 }));
    expect(health.state).toBe("at_risk");
  });

  it("always explains itself, over the whole input space", () => {
    const stages = [null, "champion", "loyal", "at_risk", "cant_lose", "hibernating", "lost", "new"];
    const orderCounts = [0, 1, 5];
    const silences = [null, 5, 30, 100, 400];
    const intervals = [null, 7, 60];
    const cases = [0, 1, 3];
    const owed = [0, 1_000_000];

    let combinations = 0;
    for (const lifecycleStage of stages) {
      for (const orderCount of orderCounts) {
        for (const daysSinceLastPurchase of silences) {
          for (const purchaseIntervalDays of intervals) {
            for (const openCases of cases) {
              for (const overdueRial of owed) {
                combinations += 1;
                const health = customerHealth({
                  lifecycleStage,
                  orderCount,
                  daysSinceLastPurchase,
                  purchaseIntervalDays,
                  openCases,
                  openDeals: 1,
                  overdueRial,
                });
                const label = JSON.stringify({
                  lifecycleStage,
                  orderCount,
                  daysSinceLastPurchase,
                  purchaseIntervalDays,
                  openCases,
                  overdueRial,
                });
                expect(CUSTOMER_HEALTH_STATES, label).toContain(health.state);
                expect(health.reasons.length, label).toBeGreaterThan(0);
                for (const reason of health.reasons) {
                  expect(reason.code.trim().length, label).toBeGreaterThan(0);
                  expect(reason.text.trim().length, label).toBeGreaterThan(0);
                }
                expect(health.label, label).toBe(CUSTOMER_HEALTH_META[health.state].label);
                expect(health.description.trim().length, label).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
    expect(combinations).toBe(stages.length * orderCounts.length * silences.length * intervals.length * cases.length * owed.length);
  });

  it("does not flag a quiet customer who has no cadence and no complaint", () => {
    // One purchase, no interval to compare against: 30 days is unremarkable.
    const health = customerHealth(input({ orderCount: 1, daysSinceLastPurchase: 30, purchaseIntervalDays: null }));
    expect(health.state).toBe("healthy");
    expect(customerHealth(input({ orderCount: 1, daysSinceLastPurchase: ATTENTION_SILENCE_DAYS, purchaseIntervalDays: null })).state).toBe(
      "needs_attention",
    );
  });
});
