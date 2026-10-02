/**
 * The Growth & Marketing app's capability contract (issue #764).
 *
 * Before this file the app had two permission vocabularies that drifted
 * independently: the page gates in `growth-routes.ts` named one set of keys,
 * the route handlers another, and the launcher a third. The result was both
 * kinds of failure at once — delegated roles that saw a page whose data
 * refused them, and a cashier who could not see the Growth dashboard or the
 * commission screen but could fetch both straight from their APIs.
 *
 * So there is one definition, here, and everything reads it:
 *
 *   1. route gate         — `canViewGrowthSection` (growth-routes.ts)
 *   2. sidebar            — `growthNavItemsForPermissions` (growth-nav.ts)
 *   3. buttons            — `growthAbilities` below
 *   4. API read guard     — `GROWTH_API_PERMISSIONS` (asserted against every
 *   5. API mutation guard   route handler's source by growth-access.test.ts)
 *   6. launcher           — `GROWTH_APP_PERMISSIONS` (apps.ts, capabilities.ts,
 *                           the workspace nav)
 *
 * The AI catalogue's growth tools (`ai-capabilities.ts`) map to the same keys;
 * the test checks them too.
 *
 * Framework-free and type-only on its imports of other modules, so the client
 * sidebar, the server pages and `apps.ts` can all import it without a cycle.
 */
import { PERMISSIONS, type Permission } from "./permissions";
import type { GrowthOverview } from "./growth-overview";

/** The app's sections, in menu order. One route per key under `/growth`. */
export const GROWTH_SECTION_KEYS = [
  "overview",
  // Audience & customer insights over the shared `parties` record. Identity
  // and profile edits belong to the CRM; this screen links there.
  "customers",
  "campaigns",
  // Consent-aware SMS/email templates and outbox campaigns.
  "messaging",
  "gift-cards",
  "loyalty",
  "commission",
  // Growth's *own* settings — never the platform's `/settings`.
  "settings",
] as const;

export type GrowthSectionKey = (typeof GROWTH_SECTION_KEYS)[number];

/**
 * The single permission that opens each section. One key per section, never a
 * list: an "any of" gate is how a page ended up opening for a permission its
 * data endpoint did not accept.
 */
export const GROWTH_SECTION_PERMISSION: Readonly<Record<GrowthSectionKey, Permission>> = {
  overview: PERMISSIONS.growthView,
  customers: PERMISSIONS.growthView,
  campaigns: PERMISSIONS.campaignsView,
  messaging: PERMISSIONS.campaignsView,
  "gift-cards": PERMISSIONS.giftCardsView,
  loyalty: PERMISSIONS.loyaltyView,
  commission: PERMISSIONS.commissionView,
  settings: PERMISSIONS.marketingConfigure,
};

/**
 * Who may open the app at all: the union of the section keys, derived — not
 * restated — so the launcher can never admit a member to an app with no
 * section for them, or hide it from one who has a section.
 */
export const GROWTH_APP_PERMISSIONS: readonly Permission[] = [
  ...new Set(Object.values(GROWTH_SECTION_PERMISSION)),
];

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Every Growth-owned API, by method. A value that is a list means the handler
 * picks one of them from the request (store credit: `issue` vs `use`) — the
 * test then requires each listed key to appear in that handler.
 */
export const GROWTH_API_PERMISSIONS: Readonly<Record<string, Partial<Record<HttpMethod, Permission | readonly Permission[]>>>> = {
  "/api/growth/overview": { GET: PERMISSIONS.growthView },
  "/api/growth/customers": { GET: PERMISSIONS.growthView },
  "/api/growth/accounting": { GET: PERMISSIONS.growthView },
  "/api/growth/settings": { GET: PERMISSIONS.marketingConfigure, PATCH: PERMISSIONS.marketingConfigure },
  // A read sent as POST, but it can return the matched members themselves —
  // composing a send, not browsing one.
  "/api/growth/campaign-audience": { POST: PERMISSIONS.campaignsManage },
  "/api/promotions": { GET: PERMISSIONS.campaignsView, POST: PERMISSIONS.campaignsManage, PATCH: PERMISSIONS.campaignsManage },
  "/api/promotions/reports": { GET: PERMISSIONS.campaignsView },
  "/api/promotions/targets": { GET: PERMISSIONS.campaignsView },
  "/api/promotions/gift-cards": { GET: PERMISSIONS.giftCardsView, POST: PERMISSIONS.giftCardsIssue },
  "/api/promotions/gift-cards/redeem": { POST: PERMISSIONS.giftCardsRedeem },
  "/api/loyalty/programs": { GET: PERMISSIONS.loyaltyView, POST: PERMISSIONS.loyaltyManage },
  "/api/loyalty/customers/[id]": { GET: PERMISSIONS.loyaltyView },
  "/api/loyalty/customers/[id]/redeem": { POST: PERMISSIONS.loyaltyRedeem },
  "/api/loyalty/customers/[id]/store-credit": { POST: [PERMISSIONS.storeCreditIssue, PERMISSIONS.storeCreditPayout] },
  "/api/loyalty/repurchase": { GET: PERMISSIONS.loyaltyView },
  "/api/loyalty/reports": { GET: PERMISSIONS.loyaltyView },
  "/api/commission/rules": { GET: PERMISSIONS.commissionView, POST: PERMISSIONS.commissionManage, PATCH: PERMISSIONS.commissionManage },
  "/api/commission/report": { GET: PERMISSIONS.commissionView },
  "/api/messaging": { GET: PERMISSIONS.campaignsView, POST: PERMISSIONS.campaignsManage },
  "/api/messaging/preview": { POST: PERMISSIONS.campaignsManage },
};

/**
 * The reads each section fires on load. Each must be guarded by exactly the
 * section's own permission — the parity the issue asks for: whoever can open
 * the page can load it, and nobody else can load it.
 */
export const GROWTH_SECTION_READS: Readonly<Record<GrowthSectionKey, readonly `${HttpMethod} ${string}`[]>> = {
  overview: ["GET /api/growth/overview"],
  customers: ["GET /api/growth/customers"],
  campaigns: ["GET /api/promotions", "GET /api/promotions/reports", "GET /api/promotions/targets"],
  messaging: ["GET /api/messaging"],
  "gift-cards": ["GET /api/promotions/gift-cards"],
  loyalty: ["GET /api/loyalty/programs", "GET /api/loyalty/repurchase", "GET /api/loyalty/customers/[id]"],
  commission: ["GET /api/commission/rules", "GET /api/commission/report"],
  settings: ["GET /api/growth/settings"],
};

/** The permission a route+method requires, as declared above. */
export function growthApiPermission(path: string, method: HttpMethod): readonly Permission[] {
  const value = GROWTH_API_PERMISSIONS[path]?.[method];
  if (!value) return [];
  return typeof value === "string" ? [value] : value;
}

/** Whether a member may open a section. */
export function canViewGrowthSection(permissions: ReadonlySet<string>, key: GrowthSectionKey): boolean {
  return permissions.has(GROWTH_SECTION_PERMISSION[key]);
}

/** Whether a member may open the app at all — any section. */
export function canOpenGrowth(permissions: ReadonlySet<string>): boolean {
  return GROWTH_APP_PERMISSIONS.some((permission) => permissions.has(permission));
}

/**
 * The buttons inside the sections. Each is the exact key its endpoint checks,
 * so a button is never shown for a request that would come back 403.
 */
export interface GrowthAbilities {
  manageCampaigns: boolean;
  manageLoyaltyPrograms: boolean;
  redeemPoints: boolean;
  issueStoreCredit: boolean;
  payOutStoreCredit: boolean;
  issueGiftCards: boolean;
  redeemGiftCards: boolean;
  manageCommission: boolean;
  /** Commission figures on the dashboard (totals, top sellers). */
  viewCommission: boolean;
}

export function growthAbilities(permissions: ReadonlySet<string>): GrowthAbilities {
  return {
    manageCampaigns: permissions.has(PERMISSIONS.campaignsManage),
    manageLoyaltyPrograms: permissions.has(PERMISSIONS.loyaltyManage),
    redeemPoints: permissions.has(PERMISSIONS.loyaltyRedeem),
    issueStoreCredit: permissions.has(PERMISSIONS.storeCreditIssue),
    payOutStoreCredit: permissions.has(PERMISSIONS.storeCreditPayout),
    issueGiftCards: permissions.has(PERMISSIONS.giftCardsIssue),
    redeemGiftCards: permissions.has(PERMISSIONS.giftCardsRedeem),
    manageCommission: permissions.has(PERMISSIONS.commissionManage),
    viewCommission: permissions.has(PERMISSIONS.commissionView),
  };
}

/**
 * Compensation is its own boundary inside the dashboard too. `growth.view`
 * opens the overview; the commission card, the commission rows of the
 * activity feed and the payroll-side bridge accounts (۲۳۰۰ salaries payable,
 * ۵۲۱۰ commission expense) are only sent to a member who also holds
 * `commission.view`. Removed on the server, not hidden in the page.
 */
export const COMPENSATION_BRIDGE_CODES: readonly string[] = ["2300", "5210"];

export function redactGrowthOverview(
  overview: GrowthOverview,
  permissions: ReadonlySet<string>,
): GrowthOverview {
  if (permissions.has(PERMISSIONS.commissionView)) return overview;
  return {
    ...overview,
    commission: null,
    bridge: overview.bridge.filter((row) => !COMPENSATION_BRIDGE_CODES.includes(row.code)),
    activity: overview.activity.filter((row) => row.kind !== "commission"),
  };
}
