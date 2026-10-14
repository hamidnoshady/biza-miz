"use client";

import Link from "next/link";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { LoadingSkeleton } from "./page-chrome";
import { useOfflineQueue } from "./offline-queue";

/**
 * Compact consumer of the shell's single connection-state poller.
 *
 * Since issue #843 the badge is not allowed to be green on operational sync
 * alone: a Hybrid site whose memberships are converged but whose replicated
 * login credentials are missing (the owner-only login screen) reports
 * `overallIdentity: "degraded"` and reads «نیازمند بررسی» here, pointing at
 * the connection panel where the credential row explains what is missing.
 */
export function DeploymentStatusIndicator({ profile }: { profile: DeploymentProfile }) {
  const { serverStatus } = useOfflineQueue();
  if (profile === "hybrid" && !serverStatus) return <LoadingSkeleton className="h-9 w-full rounded-lg" />;
  const pending = serverStatus?.outboundPending ?? 0;
  const identityDegraded =
    serverStatus?.overallIdentity === "degraded" || serverStatus?.overallIdentity === "limited";
  const label =
    profile === "cloud"
      ? "ابر"
      : profile === "local"
        ? "فقط محلی · اتصال به ابر"
        : identityDegraded
          ? "سایت محلی · نیازمند بررسی هویت و ورود کارکنان"
          : serverStatus?.sync === "connected"
            ? "سایت محلی · همگام با ابر"
            : `سایت محلی · همگام‌سازی متوقف${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`;
  const tone =
    profile === "hybrid" && (serverStatus?.sync !== "connected" || identityDegraded)
      ? "bg-amber-500 dark:bg-amber-400"
      : profile === "local"
        ? "bg-stone-400 dark:bg-stone-500"
        : "bg-emerald-500 dark:bg-emerald-400";
  return (
    <Link
      href="/settings/cloud-sync"
      className="flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      title="وضعیت محیط و همگام‌سازی"
    >
      <span className={`size-2 rounded-full ${tone}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}
