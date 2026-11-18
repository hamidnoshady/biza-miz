/**
 * The connection badge's label — one sentence, owned by one function.
 *
 * Issue #948 split operational sync from identity health, and #988 made "the
 * security plane is gating this till" a third fact the badge has to state
 * instead of reporting «در حال اتصال» forever. Those three readings are
 * decided here rather than inside `deployment-status-indicator.tsx` so the
 * sentence can be asserted against the API response that feeds it: the
 * integration test for an upgraded install (#1000) imports this function and
 * fails if the badge stops naming a block, or names one that is not there.
 *
 * Pure and client-safe on purpose: type-only imports, no React, no database.
 */
import type { ConnectionStatus } from "./connection-state";
import type { DeploymentProfile } from "./deployment-mode";

/** The part of `/api/connection/status` (and of the shell's polled snapshot) the label reads. */
export interface DeploymentStatusBadgeSource {
  sync?: ConnectionStatus | null;
  outboundPending?: number | null;
  pairingPending?: boolean | null;
  operationalBlock?: { blocked?: boolean } | null;
  overallIdentity?: string | null;
}

/**
 * What the badge says for this install. `profile === "hybrid"` is the only
 * case that describes sync at all; the identity suffix rides on top of it,
 * because a green pipe with a broken login plane is still not "fine".
 */
export function deploymentStatusBadgeLabel(
  profile: DeploymentProfile,
  status: DeploymentStatusBadgeSource | null | undefined,
): string {
  const pending = status?.outboundPending ?? 0;
  const identityDegraded =
    status?.overallIdentity === "degraded" || status?.overallIdentity === "limited";
  const blocked = status?.operationalBlock?.blocked === true;
  const syncLabel =
    profile === "hybrid"
      ? status?.pairingPending
        ? "سایت محلی · در حال تکمیل جفت‌شدن"
        : blocked
          ? `سایت محلی · همگام‌سازی عملیاتی مسدود${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`
        : status?.sync === "connected"
          ? "سایت محلی · همگام با ابر"
          : status?.sync === "connecting"
            ? "سایت محلی · در حال اتصال به ابر"
            : `سایت محلی · همگام‌سازی متوقف${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`
      : null;
  if (profile === "cloud") return "ابر";
  if (profile === "local") return "فقط محلی · اتصال به ابر";
  return `${syncLabel}${identityDegraded ? " · نیازمند بررسی هویت و ورود کارکنان" : ""}`;
}
