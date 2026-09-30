"use client";

import { usePathname } from "next/navigation";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { resolveCapability, type CapabilityKey } from "@/lib/capabilities";
import { CloudRequiredState } from "@/components/cloud-required-state";
import { CloudHandoffState } from "@/components/cloud-handoff-state";
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
  // Phase 45: on a Hybrid desktop only the till renders locally; every other
  // screen is the cloud's (src/lib/site-routes.ts).
  if (isHybridSite(profile, runtimeRole)) {
    // `/dashboard` is the desktop's home: its page redirects to the first till
    // screen the member can open, or explains that there is none.
    if (pathname === "/dashboard") return <>{children}</>;
    if (!isSiteLocalRoute(pathname)) return <CloudHandoffState pathname={pathname} cloudUrl={cloudUrl} />;
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
