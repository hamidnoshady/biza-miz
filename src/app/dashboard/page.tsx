import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { authorize } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { featureLockedForPage } from "@/lib/features";
import { canManageAi } from "@/lib/ai-panel";
import { FeatureLock } from "@/components/feature-lock";
import { AiChatHub } from "./ai/ai-chat-hub";
import { cardClass } from "./page-chrome";

/**
 * `/dashboard` — the tenant's home, and the assistant's one canonical address.
 *
 * There is exactly one dashboard: the AI chat hub, composed from the shared
 * `useAiChat` core, with the composer's task/agent selection, attachments and
 * propose→confirm actions. The old quick-report dashboard (and the
 * `workspace` rollout flag that chose between the two) are retired — every
 * tenant lands here, and the retired addresses (`/overview`, `/dashboard/overview`,
 * `/ai`, `/dashboard/ai/<section>`) resolve here too, query parameters kept
 * (the hub reads `?conversation=` / `?ctx=` / `?project=` and the
 * `?aiPanel=<section>` management panel from the URL itself).
 *
 * The `ai_assistant` entitlement is preserved, not bypassed: a business
 * without it still sees the same home, as the read-only `FeatureLock` preview
 * (the API guard in `withTenantScope` keeps refusing `/api/ai/*` regardless).
 *
 * Management of the assistant (agents, coworkers, automations, activity,
 * knowledge, usage) opens from the chat itself as the `?aiPanel=` drawer —
 * owner/manager only, the same gate the retired `/ai` application applied;
 * auto-apply authority stays owner-only.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");
  const access = await authorize(session, { permission: PERMISSIONS.aiUse });

  // A universal dashboard must not invite a member to type into a surface that
  // the chat endpoint will reject. Keep the entitlement preview above, but use
  // the same effective-permission decision as the API for member visibility.
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

  return (
    <FeatureLock locked={locked} title="دستیار هوشمند">
      <AiChatHub
        canManageAi={canManageAi(access.membership.permissions)}
        canAutoApply={session.role === "owner"}
      />
    </FeatureLock>
  );
}
