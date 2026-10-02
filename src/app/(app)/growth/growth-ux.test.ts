import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #764 UX follow-ups: the stepped campaign builder, the commission
 * preview and the gift-card history. Source assertions pin the property each
 * one exists for, so a refactor cannot quietly drop it.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const CAMPAIGNS = code(read("./campaigns-section.tsx"));
const COMMISSION = code(read("./commission-section.tsx"));
const GIFT_CARDS = code(read("./gift-cards-section.tsx"));
const GIFT_CARD_ROUTE = code(read("../../api/promotions/gift-cards/route.ts"));
const GIFT_CARD_EXPIRE_ROUTE = code(read("../../api/promotions/gift-cards/expire/route.ts"));

describe("the stepped campaign builder", () => {
  it("walks offer → products → schedule → review, in that order", () => {
    const keys = [...CAMPAIGNS.matchAll(/\{ key: "(\w+)", label: "[^"]+" \}/g)].map((match) => match[1]);
    expect(keys).toEqual(["offer", "products", "schedule", "review"]);
  });

  it("validates each step with the shared campaign rules, never a second copy", () => {
    expect(CAMPAIGNS).toMatch(/const offerProblems = validateCampaignDraft\(/);
    expect(CAMPAIGNS).toMatch(/scheduleProblems = problems\.filter/);
  });

  it("does not let Enter save a campaign whose later steps were never seen", () => {
    expect(CAMPAIGNS).toMatch(/if \(step < BUILDER_STEPS\.length - 1\) \{\s*goNext\(\);\s*return;/);
  });

  it("offers distribution through messaging once the campaign is saved", () => {
    expect(CAMPAIGNS).toMatch(/saved \? \(/);
    expect(CAMPAIGNS).toMatch(/growthSectionHref\("messaging"\)\}\?promotion=\$\{encodeURIComponent\(saved\.id\)\}/);
  });
});

describe("the commission rule preview", () => {
  it("computes with the engine that books real commissions", () => {
    expect(COMMISSION).toMatch(/import \{ computeCommissionAccrual \} from "@\/lib\/commission"/);
    expect(COMMISSION).toMatch(/computeCommissionAccrual\(\{ net, cost \}/);
  });
});

describe("the gift-card history", () => {
  it("is returned by the balance lookup under the same view permission", () => {
    expect(GIFT_CARD_ROUTE).toMatch(/giftCardHistory\(session\.businessId, code\)/);
    expect(GIFT_CARD_ROUTE).toMatch(/requirePermission\(PERMISSIONS\.giftCardsView\)/);
  });

  it("is shown with Shamsi dates and kept paired with the code it was read for", () => {
    expect(GIFT_CARDS).toMatch(/formatJalali\(entry\.at\)/);
    expect(GIFT_CARDS).toMatch(/history\.code === redeemCode\.trim\(\)/);
  });
});

describe("gift-card expiry", () => {
  it("dates new cards from the Growth setting, which defaults to never", () => {
    expect(GIFT_CARD_ROUTE).toMatch(/getGrowthSettings\(session\.businessId\)/);
    expect(GIFT_CARD_ROUTE).toMatch(/validityMonths: giftCardValidityMonths/);
  });

  it("posts breakage only on a person's click, by someone who may issue cards", () => {
    expect(GIFT_CARD_EXPIRE_ROUTE).toMatch(
      /export const POST[\s\S]*requirePermission\(PERMISSIONS\.giftCardsIssue\)[\s\S]*expireGiftCards\(/,
    );
    expect(GIFT_CARDS).toMatch(/abilities\.issueGiftCards \? <ExpiredGiftCardsCard \/> : null/);
  });
});
