/**
 * Which wizard candidates need an explicit activation (GitHub #1580).
 *
 * The import step already knows, per target, whether the owning app is
 * effective. This module turns that answer into the small list the activation
 * panel shows: the apps whose only blocker is that they are selected but not
 * yet active (or whose complimentary grant ended). Everything else — an app the
 * owner did not select, an ineligible industry, a disabled service — is not an
 * activation offer and must not be presented as one.
 *
 * Pure and client-safe: the panel and its unit test share it.
 */
import type { AppKey } from "./apps";
import type { SetupImportCandidate } from "./setup-imports";

export interface ActivatableApp {
  appKey: AppKey;
  label: string;
}

const ACTIVATABLE_REASONS = new Set(["awaiting_activation", "grant_inactive"]);

/**
 * Distinct apps that may be activated from the wizard, in first-seen order.
 * A target whose `access.reason` is not an activation state is excluded, and a
 * Workspace target (no `appKey`) is never an app activation.
 */
export function activatableApps(
  candidates: readonly SetupImportCandidate[],
): ActivatableApp[] {
  const seen = new Map<AppKey, ActivatableApp>();
  for (const candidate of candidates) {
    if (!candidate.appKey) continue;
    if (!candidate.reason || !ACTIVATABLE_REASONS.has(candidate.reason)) continue;
    if (seen.has(candidate.appKey)) continue;
    seen.set(candidate.appKey, {
      appKey: candidate.appKey,
      label: candidate.appLabel ?? candidate.appKey,
    });
  }
  return [...seen.values()];
}
