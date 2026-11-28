/**
 * Centralized adaptive policy resolver (issue #1590 / ESH-233, Wave 1).
 *
 * ## Why this file exists
 *
 * The CRM and Growth apps must adapt to *industry*, *business size*, *goals*,
 * *readiness* and *explicit user preference* WITHOUT ever conflating those
 * recommendation signals with *authorization*. A one-person business can still
 * open every advanced screen a large enterprise can; headcount changes
 * recommendations and complexity defaults only, never what a member may do.
 *
 * The issue is explicit that one resolver separate five axes, and this module
 * keeps them as five distinct outputs so a caller cannot accidentally read a
 * recommendation as a permission:
 *
 *   1. `authorization`   — actual entitlements + member permissions + app/module
 *                          readiness. Server-resolved; passed IN. Never inferred
 *                          from industry/size/goals. Never widened by preference.
 *   2. `profile`         — industry, size, goals, readiness, locale context.
 *   3. `recommendation`  — deterministic profile inputs for `rankPlaybooks`.
 *   4. `presentation`    — density (simple/advanced), My Tools/All Tools, pins,
 *                          favorites, explicit overrides. Never a security gate.
 *   5. `overrides`       — explicit user overrides, applied last, reported back.
 *
 * Framework-free and database-free: the DB-touching half (reading membership,
 * enabled apps, industry, messaging config) lives in `adaptive-context-service.ts`.
 * Recommendations are deterministic and require no AI model call.
 */
import type { Industry } from "./industries";
import { INDUSTRIES } from "./industries";
import type { AppKey } from "./apps";
import type { Permission } from "./permissions";
import type { ModuleKey } from "./industry-profile";

// ---------------------------------------------------------------------------
// Business size
// ---------------------------------------------------------------------------

/** Canonical size profiles. Defaults only — never an authorization boundary. */
export const BUSINESS_SIZES = ["solo", "small", "growing", "organization"] as const;
export type BusinessSize = (typeof BUSINESS_SIZES)[number];

export const BUSINESS_SIZE_META: Record<
  BusinessSize,
  { key: BusinessSize; label: string; minMembers: number; maxMembers: number | null; description: string }
> = {
  solo: { key: "solo", label: "تک‌نفره", minMembers: 1, maxMembers: 1, description: "یک نفر؛ بدون نیاز به پیکربندی تیم." },
  small: { key: "small", label: "تیم کوچک", minMembers: 2, maxMembers: 5, description: "۲ تا ۵ نفر." },
  growing: { key: "growing", label: "کسب‌وکار در حال رشد", minMembers: 6, maxMembers: 25, description: "۶ تا ۲۵ نفر." },
  organization: { key: "organization", label: "سازمان بزرگ", minMembers: 26, maxMembers: null, description: "۲۶ نفر به بالا." },
};

/**
 * Map an active-member count to a size profile. Count `null`/unknown/0 (no
 * membership row yet) safely degrades to `solo`; it never changes authorization.
 */
export function businessSizeFromMemberCount(activeMembers: number | null | undefined): BusinessSize {
  const n = typeof activeMembers === "number" && Number.isFinite(activeMembers) ? Math.trunc(activeMembers) : 0;
  if (n >= 26) return "organization";
  if (n >= 6) return "growing";
  if (n >= 2) return "small";
  return "solo";
}

// ---------------------------------------------------------------------------
// Goals / readiness
// ---------------------------------------------------------------------------

/** Canonical business-goal keys (also playbook `businessGoals` vocabulary). */
export const BUSINESS_GOALS = [
  "increase_sales", // فروش بیشتر
  "repeat_purchase", // خرید مجدد / بازگشت مشتری
  "retention", // حفظ مشتری
  "loyalty", // وفاداری
  "acquisition", // کسب مشتری جدید / سرنخ
  "lead_generation", // تولید سرنخ
  "brand_awareness", // آگاهی از برند
  "customer_satisfaction", // رضایت مشتری
  "follow_up", // پیگیری
  "b2b", // کسب‌وکار B2B
  "operational_efficiency", // بهره‌وری
  "promotions", // کمپین و تبلیغات
] as const;
export type BusinessGoal = (typeof BUSINESS_GOALS)[number];

export function isBusinessGoal(value: unknown): value is BusinessGoal {
  return typeof value === "string" && (BUSINESS_GOALS as readonly string[]).includes(value);
}

/** Readiness signals — facts about available data/channels, not permissions. */
export interface ReadinessSignals {
  hasCustomers: boolean;
  hasTransactions: boolean;
  hasDeals: boolean;
  hasCases: boolean;
  hasConsentData: boolean; // any marketing consent recorded
  smsReady: boolean; // messaging configured + any sms-consented reachable
  emailReady: boolean;
  messagingConfigured: boolean;
  hasBirthdays: boolean;
  hasRenewalDates: boolean; // trustworthy renewal/service dates
  hasInventory: boolean;
  hasWebsiteEvents: boolean; // reliable cart/identity events
  hasReferralSupport: boolean; // #900
  hasCampaignExecutor: boolean; // #901 live
  hasBranches: boolean;
}

export const EMPTY_READINESS: ReadinessSignals = {
  hasCustomers: false,
  hasTransactions: false,
  hasDeals: false,
  hasCases: false,
  hasConsentData: false,
  smsReady: false,
  emailReady: false,
  messagingConfigured: false,
  hasBirthdays: false,
  hasRenewalDates: false,
  hasInventory: false,
  hasWebsiteEvents: false,
  hasReferralSupport: false,
  hasCampaignExecutor: false,
  hasBranches: false,
};

// ---------------------------------------------------------------------------
// Authorization axis (passed in; never derived)
// ---------------------------------------------------------------------------

export interface AuthorizationContext {
  /** Effective permission keys, resolved server-side. */
  permissions: ReadonlySet<Permission>;
  /** Enabled apps for this business (migration 0128), resolved server-side. */
  enabledApps: ReadonlySet<AppKey>;
  /** Enabled industry modules, resolved server-side. */
  enabledModules: ReadonlySet<ModuleKey>;
  /** Branch/site scope; `null` = all. */
  locationScope: "all" | "selected" | "home" | "none" | null;
  /** Any extra capability keys the product gates on (plan/entitlement). */
  capabilities: ReadonlySet<string>;
}

export const EMPTY_AUTHORIZATION: AuthorizationContext = {
  permissions: new Set(),
  enabledApps: new Set(),
  enabledModules: new Set(),
  locationScope: null,
  capabilities: new Set(),
};

export function hasPermission(auth: AuthorizationContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}

export function hasAllPermissions(auth: AuthorizationContext, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => auth.permissions.has(p));
}

export function hasAnyPermission(auth: AuthorizationContext, permissions: readonly Permission[]): boolean {
  return permissions.length === 0 || permissions.some((p) => auth.permissions.has(p));
}

// ---------------------------------------------------------------------------
// Presentation / overrides
// ---------------------------------------------------------------------------

export const VIEW_DENSITIES = ["simple", "advanced"] as const;
export type ViewDensity = (typeof VIEW_DENSITIES)[number];

export const TOOLS_VIEWS = ["my_tools", "all_tools"] as const;
export type ToolsView = (typeof TOOLS_VIEWS)[number];

export interface UserPreferences {
  /** Explicit user choice; `null` = derive from size. Always reachable when authorized. */
  density: ViewDensity | null;
  toolsView: ToolsView;
  /** Pinned favorite tool keys (route or tool key). Max 2 pins emphasized; more allowed. */
  pinnedTools: string[];
  /** Favorited playbook keys. */
  favoritePlaybooks: string[];
  /** User override of size; `null` = derive from active member count. */
  sizeOverride: BusinessSize | null;
  /** User-selected goals; `null` = use detected. */
  goalsOverride: BusinessGoal[] | null;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  density: null,
  toolsView: "my_tools",
  pinnedTools: [],
  favoritePlaybooks: [],
  sizeOverride: null,
  goalsOverride: null,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface AdaptiveInputs {
  authorization: AuthorizationContext;
  /** Canonical industry key or `null` when unknown. Unknown never invents a key. */
  industry: Industry | null;
  /** Count of active members; used only for size defaults. */
  activeMembers: number | null;
  readiness: ReadinessSignals;
  preferences: UserPreferences;
  /** Detected goals from data; explicit `goalsOverride` in preferences wins. */
  detectedGoals: BusinessGoal[];
  /** Headcount-independent baseline density for size; used only when no explicit override. */
  locale?: string;
}

export interface AdaptiveContext {
  authorization: AuthorizationContext; // axis 1 — untouched
  profile: {
    industry: Industry | null;
    industryKnown: boolean;
    size: BusinessSize;
    sizeSource: "override" | "member_count" | "default";
    activeMembers: number | null;
    goals: BusinessGoal[];
    goalsSource: "override" | "detected" | "default";
    readiness: ReadinessSignals;
    locale: string;
    rtl: boolean;
  };
  recommendation: {
    size: BusinessSize;
    industry: Industry | null;
    goals: BusinessGoal[];
    readiness: ReadinessSignals;
  };
  presentation: {
    density: ViewDensity;
    densitySource: "override" | "derived";
    toolsView: ToolsView;
    pinnedTools: string[];
    favoritePlaybooks: string[];
    /** Advanced features are ALWAYS reachable when authorized; this only affects default disclosure. */
    advancedAlwaysReachable: true;
  };
}

const KNOWN_INDUSTRIES = new Set<string>(INDUSTRIES);

export function isKnownIndustry(value: unknown): value is Industry {
  return typeof value === "string" && KNOWN_INDUSTRIES.has(value);
}

/**
 * Size default density: solo/small start `simple`; larger orgs start `advanced`.
 * An explicit user `densityOverride` always wins. Authorization is unaffected.
 */
function deriveDensity(size: BusinessSize, prefs: UserPreferences): { density: ViewDensity; source: "override" | "derived" } {
  if (prefs.density) return { density: prefs.density, source: "override" };
  return { density: size === "solo" || size === "small" ? "simple" : "advanced", source: "derived" };
}

export function resolveAdaptiveContext(input: AdaptiveInputs): AdaptiveContext {
  const prefs = { ...DEFAULT_USER_PREFERENCES, ...input.preferences };

  let size: BusinessSize;
  let sizeSource: "override" | "member_count" | "default";
  if (prefs.sizeOverride && (BUSINESS_SIZES as readonly string[]).includes(prefs.sizeOverride)) {
    size = prefs.sizeOverride;
    sizeSource = "override";
  } else if (typeof input.activeMembers === "number" && Number.isFinite(input.activeMembers)) {
    size = businessSizeFromMemberCount(input.activeMembers);
    sizeSource = "member_count";
  } else {
    size = "solo";
    sizeSource = "default";
  }

  const industry = isKnownIndustry(input.industry) ? input.industry : null;

  let goals: BusinessGoal[];
  let goalsSource: "override" | "detected" | "default";
  const overrideGoals = (prefs.goalsOverride ?? []).filter(isBusinessGoal);
  if (overrideGoals.length > 0) {
    goals = dedupe(overrideGoals);
    goalsSource = "override";
  } else if (input.detectedGoals.length > 0) {
    goals = dedupe(input.detectedGoals.filter(isBusinessGoal));
    goalsSource = "detected";
  } else {
    goals = [];
    goalsSource = "default";
  }

  const { density, source: densitySource } = deriveDensity(size, prefs);

  return {
    // Axis 1 passed through verbatim — size/industry/goal can never edit it.
    authorization: input.authorization,
    profile: {
      industry,
      industryKnown: industry !== null,
      size,
      sizeSource,
      activeMembers: input.activeMembers ?? null,
      goals,
      goalsSource,
      readiness: { ...EMPTY_READINESS, ...input.readiness },
      locale: input.locale ?? "fa-IR",
      rtl: (input.locale ?? "fa-IR").startsWith("fa") || (input.locale ?? "fa-IR").startsWith("ar"),
    },
    recommendation: { size, industry, goals, readiness: { ...EMPTY_READINESS, ...input.readiness } },
    presentation: {
      density,
      densitySource,
      toolsView: prefs.toolsView,
      pinnedTools: dedupe(prefs.pinnedTools),
      favoritePlaybooks: dedupe(prefs.favoritePlaybooks),
      advancedAlwaysReachable: true,
    },
  };
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * My Tools / All Tools filtering. A tool is shown only if authorized; `my_tools`
 * additionally restricts to pinned/favorited keys, but NEVER hides an authorized
 * advanced tool permanently — `all_tools` always returns everything authorized.
 */
export function filterToolsForPresentation<T extends { key: string }>(
  tools: readonly T[],
  ctx: AdaptiveContext,
  isAuthorized: (tool: T, ctx: AdaptiveContext) => boolean,
): T[] {
  const authorized = tools.filter((t) => isAuthorized(t, ctx));
  if (ctx.presentation.toolsView === "all_tools") return authorized;
  const pinned = new Set(ctx.presentation.pinnedTools);
  if (pinned.size === 0) return authorized; // no pins yet: don't show an empty My Tools
  return authorized.filter((t) => pinned.has(t.key));
}
