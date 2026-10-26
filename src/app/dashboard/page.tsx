import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { authorize } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { featureLockedForPage, isFeatureEnabled } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { cardClass } from "./page-chrome";
import { withTenant } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { isHybridSite, siteHomeFor } from "@/lib/site-routes";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { hasModule } from "@/lib/industry-profile";
import { memberAccessFor } from "@/lib/member-access";

/**
 * The /dashboard page owns entitlement/refusal; the single chat instance now
 * lives in the shared tenant shell, staying mounted across other app pages.
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


  const [locked, access] = await Promise.all([
    featureLockedForPage(session.businessId, "ai_assistant"),
    authorize(session, { permission: PERMISSIONS.aiUse }),
  ]);
  if (!access.ok) {
    return (
      <div className="flex min-h-full items-center justify-center p-6" dir="rtl">
        <div className={`${cardClass} w-full max-w-lg p-6 text-center`}>
          <h1 className="text-lg font-semibold text-foreground">دستیار هوشمند در دسترس شما نیست</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            دسترسی «استفاده از دستیار» برای این نقش فعال نشده است. از مدیر کسب‌وکار بخواهید مجوز مناسب را به نقش شما اضافه کند.
          </p>
        </div>
      </div>
    );
  }
  // A locked business retains the platform's canonical read-only notice.
  if (locked) return <FeatureLock locked title="دستیار هوشمند"><div /></FeatureLock>;
  // The shell renders the full-size persistent assistant in this slot.
  return null;
}
