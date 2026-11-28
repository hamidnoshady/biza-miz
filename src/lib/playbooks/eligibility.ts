/**
 * Deterministic template eligibility + recommendation ranking (issue #1590).
 *
 * No AI call. Reads an already-resolved `AdaptiveContext`. Authorization is
 * checked FIRST and independently of profile; a restricted member never sees a
 * launchable control the server would refuse. Unknown data degrades to
 * `requires_setup`, never a fake `available`.
 */
import type { AdaptiveContext } from "../adaptive-context";
import type { PlaybookTemplate, AvailabilityState } from "./types";

export interface TemplateEligibility {
  key: string;
  /** Can this member even *see* it? */
  visible: boolean;
  /** Can this member launch it right now? */
  launchable: boolean;
  state: AvailabilityState;
  /** Machine-readable reasons; UI renders Persian. */
  reasons: EligibilityReason[];
}

export type EligibilityReason =
  | { code: "app_disabled"; app: string }
  | { code: "module_disabled"; module: string }
  | { code: "missing_permission"; permission: string }
  | { code: "missing_launch_permission"; permission: string }
  | { code: "capability_missing"; capability: string }
  | { code: "industry_unsupported"; industry: string | null }
  | { code: "data_missing"; key: string; labelFa: string }
  | { code: "not_published" }
  | { code: "archived" }
  | { code: "messaging_not_configured" }
  | { code: "no_consented_audience" }
  | { code: "campaign_executor_unavailable" }
  | { code: "offline_unsupported" };

/** Map a `dataRequirement.key` to a readiness signal; unknown keys require explicit setup. */
function dataSatisfied(key: string, ctx: AdaptiveContext): boolean {
  const r = ctx.profile.readiness;
  switch (key) {
    case "customers":
      return r.hasCustomers;
    case "transactions":
      return r.hasTransactions;
    case "deals":
      return r.hasDeals;
    case "cases":
      return r.hasCases;
    case "consent":
      return r.hasConsentData;
    case "sms_reachable":
      return r.smsReady;
    case "email_reachable":
      return r.emailReady;
    case "messaging":
      return r.messagingConfigured;
    case "birthdays":
      return r.hasBirthdays;
    case "renewal_dates":
      return r.hasRenewalDates;
    case "inventory":
      return r.hasInventory;
    case "website_events":
      return r.hasWebsiteEvents;
    case "referral":
      return r.hasReferralSupport;
    case "campaign_executor":
      return r.hasCampaignExecutor;
    case "branches":
      return r.hasBranches;
    default:
      return false; // unknown required data → truthful setup-required
  }
}

export function evaluateEligibility(t: PlaybookTemplate, ctx: AdaptiveContext): TemplateEligibility {
  const reasons: EligibilityReason[] = [];

  // --- publication (nothing invalid is ever executable) ---
  if (t.publicationState === "archived") reasons.push({ code: "archived" });
  else if (t.publicationState !== "published") reasons.push({ code: "not_published" });

  // --- axis 1: authorization, independent of profile ---
  const appKey = t.executionBinding.executor === "crm" ? "crm" : "growth";
  if (!ctx.authorization.enabledApps.has(appKey)) reasons.push({ code: "app_disabled", app: appKey });

  for (const m of t.requiredCapabilities.modules) {
    if (!ctx.authorization.enabledModules.has(m)) reasons.push({ code: "module_disabled", module: m });
  }
  for (const app of t.requiredCapabilities.apps) {
    if (!ctx.authorization.enabledApps.has(app)) reasons.push({ code: "app_disabled", app });
  }
  for (const cap of t.requiredCapabilities.capabilities) {
    if (!ctx.authorization.capabilities.has(cap)) reasons.push({ code: "capability_missing", capability: cap });
  }
  for (const p of t.requiredPermissions) {
    if (!ctx.authorization.permissions.has(p)) reasons.push({ code: "missing_permission", permission: p });
  }
  const missingLaunch = !ctx.authorization.permissions.has(t.launchPermission);
  if (missingLaunch) reasons.push({ code: "missing_launch_permission", permission: t.launchPermission });

  // --- industry support (unknown industry never invents a match) ---
  const industrySupported =
    t.supportedIndustries.includes("all") ||
    (ctx.profile.industry !== null && t.supportedIndustries.includes(ctx.profile.industry));
  if (!industrySupported) reasons.push({ code: "industry_unsupported", industry: ctx.profile.industry });

  // --- data readiness → setup-required, not blocked-forever, not fake available ---
  const missingRequiredData = t.requiredData
    .filter((d) => d.requirement === "required")
    .filter((d) => !dataSatisfied(d.key, ctx));
  for (const d of missingRequiredData) reasons.push({ code: "data_missing", key: d.key, labelFa: d.labelFa });

  // --- Growth-specific runtime truthfulness ---
  if (t.executionBinding.executor === "growth") {
    if (t.requiredCapabilities.capabilities.includes("messaging") && !ctx.profile.readiness.messagingConfigured) {
      reasons.push({ code: "messaging_not_configured" });
    }
    if (t.executionBinding.action === "growth.campaign_builder_draft" && !ctx.profile.readiness.hasCampaignExecutor) {
      reasons.push({ code: "campaign_executor_unavailable" });
    }
    if (t.executionBinding.requiresOnline && ctx.authorization.locationScope === "none") {
      reasons.push({ code: "offline_unsupported" });
    }
  }

  // Visibility = authorization OK + industry OK + published; data readiness does NOT hide.
  const authorizationBlocked = reasons.some(
    (r) =>
      r.code === "app_disabled" ||
      r.code === "module_disabled" ||
      r.code === "missing_permission" ||
      r.code === "capability_missing" ||
      r.code === "not_published" ||
      r.code === "archived",
  );
  const industryBlocked = reasons.some((r) => r.code === "industry_unsupported");
  const visible = !authorizationBlocked && !industryBlocked;

  // Launchable = visible + no authorization block + no missing data + runtime ready.
  const dataBlocked = missingRequiredData.length > 0;
  const runtimeBlocked = reasons.some(
    (r) => r.code === "messaging_not_configured" || r.code === "campaign_executor_unavailable" || r.code === "offline_unsupported",
  );
  const launchable = visible && !missingLaunch && !dataBlocked && !runtimeBlocked && !authorizationBlocked;

  let state: AvailabilityState;
  if (!visible) state = "unavailable";
  else if (dataBlocked || runtimeBlocked) state = "requires_setup";
  else if (t.availability === "coming_later") state = "coming_later";
  else if (t.availability !== "available" && t.availability !== "requires_setup") state = "unavailable";
  else if (!launchable) state = "requires_setup";
  else state = "available";

  return { key: t.key, visible, launchable, state, reasons };
}

// ---------------------------------------------------------------------------
// Deterministic recommendation ranking
// ---------------------------------------------------------------------------

export interface RankedPlaybook {
  template: PlaybookTemplate;
  eligibility: TemplateEligibility;
  score: number;
  /** Human-readable Persian reasons for the ordering. */
  reasonsFa: string[];
}

const GOAL_LABELS_FA: Record<string, string> = {
  increase_sales: "فروش بیشتر",
  repeat_purchase: "خرید مجدد",
  retention: "حفظ مشتری",
  loyalty: "وفاداری",
  acquisition: "کسب مشتری جدید",
  lead_generation: "تولید سرنخ",
  brand_awareness: "آگاهی از برند",
  customer_satisfaction: "رضایت مشتری",
  follow_up: "پیگیری",
  b2b: "B2B",
  operational_efficiency: "بهره‌وری",
  promotions: "کمپین و تبلیغات",
};

export function rankPlaybooks(templates: readonly PlaybookTemplate[], ctx: AdaptiveContext): RankedPlaybook[] {
  const favorites = new Set(ctx.presentation.favoritePlaybooks);
  const goals = new Set(ctx.profile.goals);

  return templates
    .map((template) => {
      const eligibility = evaluateEligibility(template, ctx);
      const reasonsFa: string[] = [];
      let score = 0;

      // Hard gate: invisible templates are excluded from recommendations entirely.
      if (!eligibility.visible) return { template, eligibility, score: -1, reasonsFa };

      // Launchable now beats setup-required; deterministic, no AI.
      if (eligibility.launchable) {
        score += 100;
        reasonsFa.push("همین حالا قابل اجرا است");
      } else if (eligibility.state === "requires_setup") {
        score += 20;
        reasonsFa.push("نیاز به تکمیل تنظیمات دارد");
      }

      // Industry match.
      if (
        template.supportedIndustries.includes("all") === false &&
        ctx.profile.industry &&
        template.supportedIndustries.includes(ctx.profile.industry)
      ) {
        score += 30;
      }
      if (ctx.profile.industry && template.industryBoost?.includes(ctx.profile.industry)) {
        score += 15;
        reasonsFa.push("متناسب با صنف شما");
      }

      // Goal overlap.
      let goalHits = 0;
      for (const g of template.businessGoals) if (goals.has(g)) goalHits++;
      if (goalHits > 0) {
        score += goalHits * 12;
        const matched = template.businessGoals.filter((g) => goals.has(g)).map((g) => GOAL_LABELS_FA[g] ?? g);
        reasonsFa.push(`هدف شما: ${matched.join("، ")}`);
      }

      // Size default (recommendation only).
      if (template.sizeDefaults.includes(ctx.profile.size)) score += 5;

      // User favorite.
      if (favorites.has(template.key)) {
        score += 8;
        reasonsFa.push("نشان‌شده توسط شما");
      }

      return { template, eligibility, score, reasonsFa };
    })
    .filter((r) => r.eligibility.visible)
    // Deterministic: score desc, then key asc for stable order. NO model call.
    .sort((a, b) => (b.score - a.score) || a.template.key.localeCompare(b.template.key));
}

/** Featured selection for a home page: top N launchable/setup templates for the app. */
export function featuredPlaybooks(
  templates: readonly PlaybookTemplate[],
  ctx: AdaptiveContext,
  app: "crm" | "growth",
  limit = 6,
): RankedPlaybook[] {
  return rankPlaybooks(
    templates.filter((t) => t.owningApp === app),
    ctx,
  ).slice(0, Math.max(1, limit));
}
