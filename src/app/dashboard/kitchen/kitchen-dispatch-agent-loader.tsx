"use client";

import dynamic from "next/dynamic";

// Keep the polling/printing worker out of every page's eager client graph.
// The worker is needed for any screen on the print-owning station, but pulling
// its printer/document dependencies into the shared WorkspaceShell inflated
// every App Router client-reference manifest and pushed the desktop runtime
// over its measured size budget. Load it only for members who can print.
const KitchenDispatchAgent = dynamic(
  () => import("./kitchen-dispatch-agent").then((module) => module.KitchenDispatchAgent),
  { ssr: false },
);

export function KitchenDispatchAgentLoader({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return <KitchenDispatchAgent enabled />;
}
