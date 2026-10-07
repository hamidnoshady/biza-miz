import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("/platform/ai ownership boundary", () => {
  it("contains no billing, wallet, allowance or revenue controls", () => {
    const page = readFileSync("src/app/platform/ai/page.tsx", "utf8");
    for (const stale of [
      "درآمد هوش مصنوعی پلتفرم",
      "هزینه‌گذاری و اعتبار",
      "حاشیه سود پلتفرم",
      "نرخ تبدیل دلار به ریال",
      "سقف رزرو اعتبار هر درخواست",
      "platformRevenue",
      "businessUsage",
      "monthlyAiCreditRial",
      "allowanceRemainingRial",
      "balanceRial",
      "chargedRial",
      "spendUsd",
      "modelOverride",
      "publishedModels",
      "allowBusinessModels",
    ]) {
      expect(page, stale).not.toContain(stale);
    }
  });

  it("separates configuration readiness from live probe state and preserves the last probe", () => {
    const page = readFileSync("src/app/platform/ai/page.tsx", "utf8");
    expect(page).toContain("Gateway configuration:");
    expect(page).toContain("Gateway connection:");
    expect(page).toContain("status: result.data.status ?? current.status");
  });

  it("keeps the gateway API free of revenue aggregation SQL", () => {
    const route = readFileSync("src/app/api/platform/ai/gateway/route.ts", "utf8");
    for (const stale of [
      "ai_wallet_settlements",
      "business_wallets",
      "billing_plans",
      "ai_plan_allowance_usage",
      "platformRevenue",
      "businessUsage",
    ]) {
      expect(route, stale).not.toContain(stale);
    }
  });

  it("leaves monthly AI allowance owned by the plan builder", () => {
    // Migration 0176: the plan builder lives in the Billing Control Center
    // now (the old /platform/plans page is a redirect).
    const plansTab = readFileSync(
      "src/app/platform/_components/billing/plans-tab.tsx",
      "utf8",
    );
    expect(plansTab).toContain("monthlyAiCreditRial");
    const retired = readFileSync("src/app/platform/plans/page.tsx", "utf8");
    expect(retired).toContain('redirect("/platform/billing?tab=plans")');
  });
});
