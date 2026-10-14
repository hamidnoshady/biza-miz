"use client";

/**
 * The dashboard's main content area (Phase 36b revision).
 *
 * Most pages want the normal padded, pull-to-refresh scroller. The assistant
 * surfaces (`/dashboard/ai` and, with the `workspace` flag, the chat home
 * `/dashboard`) are different: they are full-height, ChatGPT-like columns with
 * their own in-app nav and a pinned composer, so they take the whole height
 * with no padding and no mobile bottom-bar offset — the assistant provides its
 * own navigation there instead.
 */

import { usePathname } from "next/navigation";
import { isAssistantSurface } from "@/lib/assistant-route";
import { isSiteLocalRoute } from "@/lib/site-routes";
import { OfflineBanner } from "./offline-banner";
import { PullToRefresh } from "@/components/pull-to-refresh";

export function DashboardMain({
  children,
  hybridSite = false,
}: {
  children: React.ReactNode;
  /** A Hybrid desktop, where every non-till screen is a full-height cloud pane. */
  hybridSite?: boolean;
}) {
  const pathname = usePathname();
  const isAssistant = isAssistantSurface(pathname);
  const isCloudPane = hybridSite && !isSiteLocalRoute(pathname);

  if (isAssistant || isCloudPane) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <OfflineBanner />
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <OfflineBanner />
      <PullToRefresh className="relative flex-1 overflow-y-auto overscroll-y-contain p-2 pb-[calc(var(--app-bottom-nav)+2rem)] md:p-4 md:pb-4">
        {children}
      </PullToRefresh>
    </div>
  );
}
