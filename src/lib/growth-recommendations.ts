/**
 * «قدم بعدی» — the Growth dashboard's next best actions (issue #764).
 *
 * The dashboard answered "what happened?"; the issue asks it to also answer
 * "what should I do next to grow revenue and retention?". These are plain,
 * deterministic rules over figures the overview already computed — no model,
 * no guess — each pointing at the one section that acts on it, and only
 * offered to a member who may open that section.
 *
 * Framework-free so it is unit-tested directly; the overview section renders
 * whatever this returns, in order.
 */
import { formatPersianNumber as fa } from "./digits";
import { discountBudgetUsage } from "./growth-settings";
import type { GrowthSectionKey } from "./growth-access";

export interface GrowthRecommendationInput {
  hasLocation: boolean;
  liveCampaigns: number;
  scheduledCampaigns: number;
  loyaltyPrograms: number;
  repurchaseDue: number;
  customersTotal: number;
  customersWithPoints: number;
  discountRial: number;
  discountBudgetRial: number | null;
}

export type RecommendationTone = "warning" | "opportunity" | "setup";

export interface GrowthRecommendation {
  key: string;
  tone: RecommendationTone;
  title: string;
  detail: string;
  action: string;
  section: GrowthSectionKey;
}

/**
 * Ordered by urgency: something already wrong (over budget) first, then money
 * left on the table (customers due back), then missing set-up.
 */
export function growthRecommendations(
  input: GrowthRecommendationInput,
  canOpen: (section: GrowthSectionKey) => boolean,
): GrowthRecommendation[] {
  const out: GrowthRecommendation[] = [];

  const budget = discountBudgetUsage(input.discountRial, input.discountBudgetRial);
  if (budget?.exceeded) {
    out.push({
      key: "discount-over-budget",
      tone: "warning",
      title: "تخفیف کمپین‌ها از سقف ۳۰ روزه گذشته است",
      detail: `${fa(budget.percent)}٪ سقفی که در تنظیمات رشد تعیین کرده‌اید مصرف شده است. کمپین‌های پرهزینه را بازبینی کنید.`,
      action: "بازبینی کمپین‌ها",
      section: "campaigns",
    });
  }

  if (input.hasLocation && input.repurchaseDue > 0) {
    out.push({
      key: "repurchase-due",
      tone: "opportunity",
      title: `${fa(input.repurchaseDue)} مشتری موعد خرید دوباره‌شان گذشته است`,
      detail: "پیش از آن‌که از دست بروند، با یک پیام یادآوری یا پیشنهاد به آن‌ها سر بزنید.",
      action: "ارسال پیام",
      section: "messaging",
    });
  }

  if (input.loyaltyPrograms === 0) {
    out.push({
      key: "no-loyalty",
      tone: "setup",
      title: "برنامهٔ وفاداری ندارید",
      detail: "بدون آن، خریدها امتیاز نمی‌گیرند و دلیلی برای بازگشت مشتری ثبت نمی‌شود.",
      action: "تعریف برنامهٔ وفاداری",
      section: "loyalty",
    });
  } else if (input.customersTotal > 0 && input.customersWithPoints / input.customersTotal < 0.2) {
    out.push({
      key: "low-loyalty-engagement",
      tone: "opportunity",
      title: "بیشتر مشتریان امتیازی ندارند",
      detail: `فقط ${fa(input.customersWithPoints)} از ${fa(input.customersTotal)} مشتری امتیاز مصرف‌نشده دارند؛ هنگام فروش مشتری را روی فاکتور ثبت کنید.`,
      action: "مشاهدهٔ مخاطبان",
      section: "customers",
    });
  }

  if (input.liveCampaigns === 0 && input.scheduledCampaigns === 0) {
    out.push({
      key: "no-campaign",
      tone: "setup",
      title: "هیچ کمپینی در حال اجرا یا زمان‌بندی‌شده نیست",
      detail: "یک تخفیف هدفمند روی کالاها یا ساعت‌های کم‌فروش، ساده‌ترین راه آوردن مشتری است.",
      action: "ساخت کمپین",
      section: "campaigns",
    });
  }

  return out.filter((recommendation) => canOpen(recommendation.section));
}
