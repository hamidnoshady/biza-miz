"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FeatureLock } from "@/components/feature-lock";
import type { ConnectionKind, ConnectionKindKey } from "@/lib/connection-kinds";
import { SectionNav } from "@/app/dashboard/section-nav";
import { DesktopPanel } from "./desktop-panel";
import { LocalDevicesPanel } from "./local-devices-panel";
import { WpConnectionPanel } from "@/app/(app)/websites/wp/woocommerce-connection-panel";
import { CmsConnectionPanel } from "./cms-panel";
import { HolooPanel } from "./holoo-panel";
import { ServerSyncPanel } from "./server-sync-panel";
import { ApiTokensPanel } from "./api-tokens-panel";
import { McpPanel } from "./mcp-panel";

/**
 * The hub's tab shell.
 *
 * The active tab is mirrored into `?tab=` (via `replace`, so it does not stack
 * history entries) for one concrete reason: this is a screen people are sent
 * links to — "go to Connections → Desktop and press generate" is the support
 * answer to the failure this whole area was rebuilt for — and a tab that
 * cannot be linked to makes that instruction two steps longer.
 */
export function ConnectionsManager({
  kinds,
  initialTab,
  initialOpen = false,
  features,
}: {
  kinds: ConnectionKind[];
  initialTab: ConnectionKindKey;
  /** The URL already named a tab, so the phone's drill-down starts inside it. */
  initialOpen?: boolean;
  features: Record<string, boolean>;
}) {
  const router = useRouter();
  const [active, setActive] = useState<ConnectionKindKey>(initialTab);
  const [open, setOpen] = useState(initialOpen);
  const activeKind = kinds.find((kind) => kind.key === active) ?? kinds[0];

  function select(key: ConnectionKindKey) {
    setActive(key);
    router.replace(`/settings/connections?tab=${key}`, { scroll: false });
  }

  // A tab whose feature is off still renders — as an inert preview — so a
  // business can see what it would be buying. See connection-kinds.ts.
  const locked = Boolean(activeKind.feature && !features[activeKind.feature]);

  return (
    <SectionNav
      idPrefix="connections"
      label="نوع اتصال"
      sections={kinds}
      active={active}
      onChange={select}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="min-w-0">
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          {activeKind.description}
        </p>

        <FeatureLock locked={locked} title={activeKind.label}>
          {active === "desktop" ? (
            <div className="space-y-6">
              <DesktopPanel />
              <FeatureLock
                locked={!features.site_cloud_sync}
                title="همگام‌سازی ابری"
              >
                <ServerSyncPanel />
              </FeatureLock>
            </div>
          ) : null}
          {active === "local_devices" ? <LocalDevicesPanel /> : null}
          {active === "woocommerce" ? <WpConnectionPanel /> : null}
          {active === "website" ? <CmsConnectionPanel /> : null}
          {active === "holoo" ? <HolooPanel /> : null}
          {active === "mcp" ? <McpPanel /> : null}
          {active === "api" ? <ApiTokensPanel /> : null}
        </FeatureLock>
      </div>
    </SectionNav>
  );
}
