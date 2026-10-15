import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { authorize } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import {
  effectiveFeatures,
  featureLockedForPage,
  isFeatureEnabled,
} from "@/lib/features";
import { isAppUsable } from "@/lib/app-availability";
import { effectiveAppAvailability } from "@/lib/app-availability-service";
import {
  canManageAi,
  resolveAllowedAiPanelSections,
} from "@/lib/ai-panel";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import {
  resolveAccessibleFocuses,
  resolveEligibleTasks,
  resolveStarterPrompts,
  resolveTenantTaskFeatures,
} from "@/lib/ai-tasks";
import { FeatureLock } from "@/components/feature-lock";
import { AiChatHub } from "./ai/ai-chat-hub";
import { cardClass } from "./page-chrome";
import { withTenant } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { isHybridSite, siteHomeFor } from "@/lib/site-routes";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { hasModule } from "@/lib/industry-profile";
import { memberAccessFor } from "@/lib/member-access";

/**
 * `/dashboard` — the tenant's home, and the assistant's one canonical address.
 *
 * Issue #905: Hydrates safe server-derived UI capabilities (`deepResearchEnabled`,
 * `allowedPanelSections`, `eligibleTaskIds`, `starterPrompts`, `accessibleFocuses`,
 * `industry`, `canManageAi`, `canAutoApply`) while keeping all secrets and raw
 * provider settings on the server.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // Phase 46: on a Hybrid desktop the assistant is the cloud's, shown in the
  // till window's cloud pane by the layout's gate. Members who cannot use it
  // (till staff) open on their till screen instead.
  const deployment = await withTenant(session.businessId, () =>
    readDeploymentProfile(session.businessId),
  );
  if (isHybridSite(deployment.profile, deploymentRole())) {
    const [industry, reservations, member, assistantOn] = await Promise.all([
      getBusinessIndustry(session.businessId),
      isFeatureEnabled(session.businessId, "reservations"),
      memberAccessFor(session),
      isFeatureEnabled(session.businessId, "ai_assistant"),
    ]);
    if (assistantOn && member?.permissions.has(PERMISSIONS.aiUse)) return null;
    const home = siteHomeFor({
      role: session.role,
      // Fails open on an unreadable industry, exactly as `isModuleEnabled` does.
      hasModule: (module) => industry === null || hasModule(industry, module),
      reservations,
      permissions: member?.permissions ?? new Set<string>(),
    });
    // Never redirect to a till screen that would send this member straight back here.
    if (home) redirect(home);
    return (
      <div className="flex min-h-full items-center justify-center p-6" dir="rtl">
        <div className={`${cardClass} w-full max-w-lg p-6 text-center`}>
          <h1 className="text-lg font-semibold text-foreground">
            صفحه‌ای از صندوق برای شما باز نیست
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            صندوق، سفارش‌ها، میزها و آشپزخانه برای نقش شما فعال نیست. بخش‌های دیگر را از منو باز کنید، یا از مدیر کسب‌وکار بخواهید دسترسی لازم را بدهد.
          </p>
        </div>
      </div>
    );
  }

  const [
    locked,
    access,
    industry,
    deepResearchMode,
    rawFeatures,
    appAvailability,
  ] = await Promise.all([
    featureLockedForPage(session.businessId, "ai_assistant"),
    authorize(session, { permission: PERMISSIONS.aiUse }),
    getBusinessIndustry(session.businessId).catch(() => null),
    getPlatformAiMode("deep_research").catch(() => ({ is_active: false })),
    effectiveFeatures(session.businessId).catch(() => null),
    effectiveAppAvailability(session.businessId).catch(() => undefined),
  ]);

  // A universal dashboard must not invite a member to type into a surface that
  // the chat endpoint will reject. Keep the entitlement preview above, but use
  // the same effective-permission decision as the API for member visibility.
  if (!access.ok) {
    return (
      <div className="flex min-h-full items-center justify-center p-6" dir="rtl">
        <div className={`${cardClass} w-full max-w-lg p-6 text-center`}>
          <h1 className="text-lg font-semibold text-foreground">
            دستیار هوشمند در دسترس شما نیست
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            دسترسی «استفاده از دستیار» برای این نقش فعال نشده است. از مدیر کسب‌وکار بخواهید مجوز مناسب را به نقش شما اضافه کند.
          </p>
        </div>
      </div>
    );
  }

  const permissions = access.membership.permissions;
  const deepResearchEnabled = Boolean(deepResearchMode?.is_active);
  const allowedPanelSections = resolveAllowedAiPanelSections(permissions, {
    deepResearchEnabled,
  });
  const taskFeatures = resolveTenantTaskFeatures(rawFeatures, {
    industry,
    usableApps: {
      accounting: isAppUsable(appAvailability, "accounting"),
      crm: isAppUsable(appAvailability, "crm"),
      growth: isAppUsable(appAvailability, "growth"),
      website: isAppUsable(appAvailability, "website"),
    },
  });
  const eligibilityContext = {
    mode: "dashboard" as const,
    industry,
    features: taskFeatures,
    permissions,
  };
  const eligibleTaskIds = resolveEligibleTasks(eligibilityContext, {
    includeCustom: false,
  }).map((t) => t.id);
  const accessibleFocuses = resolveAccessibleFocuses(eligibilityContext);
  const starterPrompts = resolveStarterPrompts({
    ...eligibilityContext,
    eligibleTaskIds,
    accessibleFocuses,
    count: 3,
  });

  return (
    <FeatureLock locked={locked} title="دستیار هوشمند">
      <AiChatHub
        canManageAi={canManageAi(permissions, undefined, {
          deepResearchEnabled,
        })}
        canAutoApply={session.role === "owner"}
        allowedPanelSections={allowedPanelSections}
        deepResearchEnabled={deepResearchEnabled}
        eligibleTaskIds={eligibleTaskIds}
        starterPrompts={starterPrompts}
        accessibleFocuses={accessibleFocuses}
        industry={industry}
      />
    </FeatureLock>
  );
}
