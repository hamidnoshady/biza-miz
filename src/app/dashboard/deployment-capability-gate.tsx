"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { resolveCapability, type CapabilityKey } from "@/lib/capabilities";
import { CloudRequiredState } from "@/components/cloud-required-state";
import { CloudPane } from "@/components/cloud-pane";
import { isHybridSite, isSiteLocalRoute } from "@/lib/site-routes";

const PAGE_CAPABILITIES: readonly [string, CapabilityKey, string][] = [
  ["/growth", "app.growth", "رشد و بازاریابی"],
  ["/websites", "app.website", "مدیریت وب‌سایت"],
  ["/workspace", "app.workspace", "میز کار من"],
  ["/settings/billing", "platform.billing", "اعتبار و پرداخت‌ها"],
  ["/settings/subscription", "platform.billing", "اشتراک"],
  // Support is deliberately absent: it is one of Local-only's two cloud
  // exceptions (the other is the global bug-report dialog).
  // /dashboard is the assistant home in this repository. Match exactly so
  // operational children that may still redirect through /dashboard/* are not
  // accidentally classified as AI.
  ["/dashboard", "app.ai", "دستیار هوشمند"],
];

export function DeploymentCapabilityGate({
  profile,
  children,
  runtimeRole,
  cloudUrl,
}: {
  profile: DeploymentProfile;
  runtimeRole: "central" | "site";
  cloudUrl: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // Phase 45/46: on a Hybrid desktop only the till renders locally; every
  // other screen is the cloud's (src/lib/site-routes.ts), shown in this
  // window's content area. `/dashboard` (the assistant) included: its page
  // first sends till-only staff to their till screen.
  if (isHybridSite(profile, runtimeRole) && !isSiteLocalRoute(pathname)) {
    return <CloudPane pathAndQuery={search ? `${pathname}?${search}` : pathname} cloudUrl={cloudUrl} />;
  }
  const match = PAGE_CAPABILITIES.find(([prefix]) =>
    prefix === "/dashboard" ? pathname === prefix : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!match) return <>{children}</>;
  const resolution = resolveCapability(match[1], { deployment: profile, runtimeRole });
  if (resolution.status === "requires_cloud" || resolution.code === "WRONG_EXECUTION_TARGET") {
    const cloudHref = resolution.code === "WRONG_EXECUTION_TARGET" && cloudUrl
      ? new URL(pathname, cloudUrl).toString()
      : null;
    return <CloudRequiredState featureName={match[2]} cloudUrl={cloudHref} />;
  }
  return <>{children}</>;
}
