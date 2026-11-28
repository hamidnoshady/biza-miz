/**
 * DB-touching half of the adaptive resolver (issue #1590). Reads membership,
 * industry, enabled apps/modules, readiness signals and per-member preferences,
 * then calls the pure `resolveAdaptiveContext`. **Authorization is resolved
 * server-side and passed through; it is never inferred from industry/size.**
 */
import { query, withTenant } from "./db";
import { readBusinessIndustry } from "./business-industry";
import { effectiveAppAvailability } from "./app-availability-service";
import { resolveMembershipAuthority } from "./membership-authority";
import type { AppKey } from "./apps";
import { APP_KEYS } from "./apps";
import {
  resolveAdaptiveContext,
  DEFAULT_USER_PREFERENCES,
  EMPTY_READINESS,
  type AdaptiveContext,
  type BusinessGoal,
  type BusinessSize,
  type ReadinessSignals,
  type UserPreferences,
  type ViewDensity,
  type ToolsView,
} from "./adaptive-context";
import { getPublicMessageConfig } from "./messaging-billing";

export async function activeMemberCount(businessId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users WHERE business_id = $1 AND is_active = true AND membership_status = 'active'`,
    [businessId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function exists(businessId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  const { rows } = await query<{ e: boolean }>(`SELECT EXISTS(${sql}) AS e`, [businessId, ...params]);
  return rows[0]?.e === true;
}

export async function readReadiness(businessId: string): Promise<ReadinessSignals> {
  const [hasCustomers, hasTransactions, hasDeals, hasCases, hasConsent, hasBirthdays, hasBranches, messagingConfigured, smsReachable, emailReachable] =
    await Promise.all([
      exists(businessId, `SELECT 1 FROM parties WHERE business_id = $1 AND role='customer' AND is_active AND merged_into_id IS NULL`),
      exists(businessId, `SELECT 1 FROM orders o JOIN locations l ON l.id=o.location_id WHERE l.business_id=$1 AND o.status='completed'`),
      exists(businessId, `SELECT 1 FROM crm_deals WHERE business_id=$1 AND closed_at IS NULL`),
      exists(businessId, `SELECT 1 FROM crm_cases WHERE business_id=$1 AND status NOT IN ('resolved','closed')`),
      exists(businessId, `SELECT 1 FROM parties WHERE business_id=$1 AND (sms_consent OR marketing_consent) AND is_active`),
      exists(businessId, `SELECT 1 FROM parties WHERE business_id=$1 AND birthday IS NOT NULL AND is_active`),
      exists(businessId, `SELECT 1 FROM locations WHERE business_id=$1 AND is_active HAVING count(*) > 1`),
      getPublicMessageConfig().then((c) => c.enabled && c.configured).catch(() => false),
      exists(businessId, `SELECT 1 FROM parties WHERE business_id=$1 AND sms_consent AND is_active AND (phone_e164 IS NOT NULL OR phone IS NOT NULL)`),
      exists(businessId, `SELECT 1 FROM parties WHERE business_id=$1 AND marketing_consent AND is_active AND email IS NOT NULL`),
    ]);

  return {
    ...EMPTY_READINESS,
    hasCustomers,
    hasTransactions,
    hasDeals,
    hasCases,
    hasConsentData: hasConsent,
    smsReady: messagingConfigured && smsReachable,
    emailReady: messagingConfigured && emailReachable,
    messagingConfigured,
    hasBirthdays,
    hasRenewalDates: false, // no canonical renewal-date source in the schema; never fabricated
    hasInventory: await exists(businessId, `SELECT 1 FROM item_stock WHERE business_id=$1`).catch(() => false),
    hasWebsiteEvents: false, // no reliable cart/identity event source; never assumed
    hasReferralSupport: false, // #900 not guaranteed
    hasCampaignExecutor: true, // canonical #901 campaign builder + Phase-37 messaging are present
    hasBranches,
  };
}

export async function readPreferences(businessId: string, userId: string): Promise<UserPreferences> {
  const { rows } = await query<{
    density: ViewDensity | null;
    tools_view: ToolsView;
    pinned_tools: unknown;
    favorite_playbooks: unknown;
    size_override: BusinessSize | null;
    goals_override: unknown;
  }>(
    `SELECT density, tools_view, pinned_tools, favorite_playbooks, size_override, goals_override
       FROM playbook_preferences WHERE business_id = $1 AND user_id = $2`,
    [businessId, userId],
  );
  const r = rows[0];
  if (!r) return { ...DEFAULT_USER_PREFERENCES };
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const goals = (v: unknown): BusinessGoal[] | null => (Array.isArray(v) ? (v.filter((x): x is BusinessGoal => typeof x === "string") as BusinessGoal[]) : null);
  return {
    density: r.density ?? null,
    toolsView: r.tools_view ?? "my_tools",
    pinnedTools: strArr(r.pinned_tools),
    favoritePlaybooks: strArr(r.favorite_playbooks),
    sizeOverride: r.size_override ?? null,
    goalsOverride: goals(r.goals_override),
  };
}

export async function upsertPreferences(
  businessId: string,
  userId: string,
  prefs: Partial<UserPreferences>,
): Promise<void> {
  const current = await readPreferences(businessId, userId);
  const next = { ...current, ...prefs };
  await query(
    `INSERT INTO playbook_preferences
       (business_id, user_id, density, tools_view, pinned_tools, favorite_playbooks, size_override, goals_override, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb, now())
     ON CONFLICT (business_id, user_id) DO UPDATE SET
       density = EXCLUDED.density, tools_view = EXCLUDED.tools_view,
       pinned_tools = EXCLUDED.pinned_tools, favorite_playbooks = EXCLUDED.favorite_playbooks,
       size_override = EXCLUDED.size_override, goals_override = EXCLUDED.goals_override, updated_at = now()`,
    [
      businessId,
      userId,
      next.density ?? null,
      next.toolsView,
      JSON.stringify(next.pinnedTools ?? []),
      JSON.stringify(next.favoritePlaybooks ?? []),
      next.sizeOverride ?? null,
      next.goalsOverride === null ? null : JSON.stringify(next.goalsOverride ?? []),
    ],
  );
}

export interface ResolveContextInput {
  businessId: string;
  userId: string;
  /** Caller-resolved app availability; if omitted, read from DB. */
  enabledApps?: Set<AppKey>;
  /** Detected goals from data; optional. */
  detectedGoals?: BusinessGoal[];
  locale?: string;
}

/**
 * Build a full AdaptiveContext. Authorization (permissions/apps/modules/branch)
 * comes from canonical `resolveMembershipAuthority` + app availability + module
 * checks resolved by callers; here we read membership + apps + industry.
 */
export async function resolveAdaptiveContextForMember(input: ResolveContextInput): Promise<AdaptiveContext> {
  const businessId = input.businessId;
  const [membership, industry, appAvailability, members, readiness, preferences] = await withTenant(businessId, async () =>
    Promise.all([
      resolveMembershipAuthority(businessId, input.userId),
      readBusinessIndustry(businessId),
      effectiveAppAvailability(businessId).catch(() => ({} as Record<string, boolean>)),
      activeMemberCount(businessId),
      readReadiness(businessId),
      readPreferences(businessId, input.userId),
    ]),
  );

  const enabledApps = new Set<AppKey>();
  for (const app of APP_KEYS) {
    const v = (appAvailability as Record<string, boolean>)[app];
    if (v !== false) enabledApps.add(app); // absent = enabled by default convention
  }
  if (input.enabledApps) {
    enabledApps.clear();
    for (const a of input.enabledApps) enabledApps.add(a);
  }
  // CRM/Growth playbooks require their owning app enabled; respect membership permissions regardless.
  const permissions = membership?.actorPermissions ?? new Set();

  return resolveAdaptiveContext({
    authorization: {
      permissions,
      enabledApps,
      enabledModules: new Set(), // module enforcement is `isModuleEnabled` re-checked server-side per template
      locationScope: null, // branch-scope enforcement is re-checked server-side per operation
      capabilities: messagingCapabilities(readiness),
    },
    industry: industry ?? null,
    activeMembers: members,
    readiness,
    preferences,
    detectedGoals: input.detectedGoals ?? [],
    locale: input.locale ?? "fa-IR",
  });
}

function messagingCapabilities(r: ReadinessSignals): Set<string> {
  const caps = new Set<string>();
  if (r.messagingConfigured) caps.add("messaging");
  if (r.hasCampaignExecutor) caps.add("campaign_executor");
  if (r.hasReferralSupport) caps.add("referral");
  return caps;
}
