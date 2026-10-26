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
import { BackupHealthNotice } from "./backup-health-notice";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { NavigationPendingIndicator } from "@/components/navigation/navigation-pending";
import { TourProvider } from "@/components/tours/tour-provider";

/**
 * Issue #972 — the one guided-tour runtime of the workspace shell. It lives
 * here, inside this existing client boundary, rather than as its own client
 * component in the server shell: a client boundary mounted by the shell adds
 * an entry to every page's client-reference manifest, which is what the
 * desktop runtime's size budget measures. It renders no DOM until a tour is
 * started from a page's «آموزش» button.
 */
export function DashboardMain(props: DashboardMainProps) {
  return (
    <TourProvider>
      <DashboardMainFrame {...props} />
    </TourProvider>
  );
}

interface DashboardMainProps {
  children: React.ReactNode;
  /** A Hybrid desktop, where every non-till screen is a full-height cloud pane. */
  hybridSite?: boolean;
  /** Server-derived site role and backup.manage permission. */
  showBackupHealth?: boolean;
}

function DashboardMainFrame({
  children,
  hybridSite = false,
  showBackupHealth = false,
}: DashboardMainProps) {
  const pathname = usePathname();
  const isAssistant = isAssistantSurface(pathname);
  const isCloudPane = hybridSite && !isSiteLocalRoute(pathname);

  if (isAssistant || isCloudPane) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <NavigationPendingIndicator />
        <OfflineBanner />
        {showBackupHealth ? <BackupHealthNotice /> : null}
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <NavigationPendingIndicator />
      <OfflineBanner />
      {showBackupHealth ? <BackupHealthNotice /> : null}
      <PullToRefresh className="relative flex-1 overflow-y-auto overscroll-y-contain p-2 pb-[calc(var(--app-bottom-nav)+2rem)] md:p-4 md:pb-4">
        {children}
      </PullToRefresh>
    </div>
  );
}
