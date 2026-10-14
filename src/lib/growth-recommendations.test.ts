import { describe, expect, it } from "vitest";
import { growthRecommendations, type GrowthRecommendationInput } from "./growth-recommendations";

const healthy: GrowthRecommendationInput = {
  hasLocation: true,
  liveCampaigns: 2,
  scheduledCampaigns: 0,
  loyaltyPrograms: 1,
  repurchaseDue: 0,
  customersTotal: 100,
  customersWithPoints: 60,
  discountRial: 1_000_000,
  discountBudgetRial: 5_000_000,
};
const all = () => true;
const keys = (input: GrowthRecommendationInput, canOpen: (section: string) => boolean = all) => growthRecommendations(input, canOpen).map((r) => r.key);

describe("growthRecommendations", () => {
  it("has nothing to say about a business that is set up and within budget", () => {
    expect(keys(healthy)).toEqual([]);
  });

  it("puts an exceeded budget first, then customers due back, then set-up gaps", () => {
    expect(
      keys({ ...healthy, discountRial: 6_000_000, repurchaseDue: 4, loyaltyPrograms: 0, liveCampaigns: 0 }),
    ).toEqual(["discount-over-budget", "repurchase-due", "no-loyalty", "no-campaign"]);
  });

  it("never warns about a budget that was not set", () => {
    expect(keys({ ...healthy, discountBudgetRial: null, discountRial: 99_000_000 })).toEqual([]);
  });

  it("does not claim customers are due back when no branch was in context", () => {
    expect(keys({ ...healthy, hasLocation: false, repurchaseDue: 9 })).toEqual([]);
  });

  it("nudges loyalty engagement only when a program exists and few customers hold points", () => {
    expect(keys({ ...healthy, customersWithPoints: 10 })).toEqual(["low-loyalty-engagement"]);
    expect(keys({ ...healthy, customersTotal: 0, customersWithPoints: 0 })).toEqual([]);
  });

  it("counts a scheduled campaign as a plan, not a gap", () => {
    expect(keys({ ...healthy, liveCampaigns: 0, scheduledCampaigns: 1 })).toEqual([]);
  });

  it("only offers what the member may open", () => {
    // A cashier-shaped member: loyalty only.
    const loyaltyOnly = (section: string) => section === "loyalty";
    expect(
      keys({ ...healthy, discountRial: 6_000_000, repurchaseDue: 3, loyaltyPrograms: 0, liveCampaigns: 0 }, loyaltyOnly),
    ).toEqual(["no-loyalty"]);
  });

  it("points every recommendation at a real section with a label for its button", () => {
    const every = growthRecommendations(
      { ...healthy, discountRial: 6_000_000, repurchaseDue: 3, loyaltyPrograms: 0, liveCampaigns: 0 },
      all,
    );
    for (const recommendation of every) {
      expect(recommendation.action.trim().length).toBeGreaterThan(0);
      expect(["campaigns", "messaging", "loyalty", "customers"]).toContain(recommendation.section);
    }
  });
});
