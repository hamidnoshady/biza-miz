/**
 * Authorized, registered tenant navigation candidates for the AI assistant.
 *
 * Source of truth is the exact same menu builder as the tenant shell; the model
 * never proposes arbitrary URLs. A destination page must still perform its own
 * existing authorization on entry.
 */
import { memberAccessForUser } from "@/lib/member-access";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { effectiveFeatures } from "@/lib/features";
import { effectiveAppAvailability } from "@/lib/app-availability-service";
import { isAppUsable } from "@/lib/app-availability";
import { appForModule } from "@/lib/apps";
import { visibleSettingsTabs } from "@/lib/settings-tabs";
import { accessibleNavItemsFor } from "@/app/dashboard/workspace-shell";
import type { NavItem } from "@/app/dashboard/dashboard-sidebar";
import { PERMISSIONS } from "@/lib/permissions";

export interface AuthorizedAiDestination {
  id: string;
  label: string;
  href: string;
}

/** Read current member, enabled apps, and flags anew for every navigation. */
export async function authorizedAiDestinations(
  businessId: string,
  userId: string,
  locationId: string | null = null,
): Promise<AuthorizedAiDestination[]> {
  const access = await memberAccessForUser(businessId, userId, locationId);
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.aiUse)) return [];
  const [industry, features, availability] = await Promise.all([
    getBusinessIndustry(businessId),
    effectiveFeatures(businessId),
    effectiveAppAvailability(businessId),
  ]);
  if (!industry) return [];
  const tabs = visibleSettingsTabs(access.permissions, {
    role: access.role,
    industry,
    features,
  });
  const menu = accessibleNavItemsFor(
    industry, { settingsTabs: tabs }, access.role, access.permissions, features,
  );

  const candidates: AuthorizedAiDestination[] = [];
  const recurse = (entries: NavItem[]) => {
    for (const item of entries) {
      if (item.flag && !features[item.flag]) continue;
      const app = appForModule(item.module);
      if (app && !isAppUsable(availability, app)) continue;
      // Only internally registered relative routes, never AI-selected URLs.
      if (typeof item.href === "string" && /^\/[a-zA-Z][a-zA-Z0-9/_?=&%-]*$/.test(item.href)) {
        candidates.push({ id: item.href, href: item.href, label: item.label });
      }
      if (item.children?.length) recurse(item.children);
    }
  };
  recurse(menu);
  return candidates.filter((item, index) => candidates.findIndex((other) => other.id === item.id) === index);
}

const normalize = (input: string) =>
  input.normalize("NFKC").toLocaleLowerCase("fa")
    .replace(/[ي]/g, "ی").replace(/[ك]/g, "ک")
    .replace(/[\u200c\u200f\u200e]/g, " ").trim();

/** Uses the user's own registered labels; no LLM-produced route may bypass it. */
export function findAuthorizedAiDestinations(
  candidates: readonly AuthorizedAiDestination[],
  query: string,
): AuthorizedAiDestination[] {
  const terms = normalize(query).split(/\s+/).filter((x) => x.length > 1);
  if (terms.length === 0) return [];
  return candidates.map((item) => {
    const haystack = normalize(item.label + " " + item.href.replace(/[/?&=_-]/g, " "));
    return { item, score: terms.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0) };
  }).filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8).map(({ item }) => item);
}
