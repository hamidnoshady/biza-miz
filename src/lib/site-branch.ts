/**
 * Which branch a paired Hybrid / Full-Offline site may act as (issue #1573).
 *
 * A site install is paired to **one** branch, and the cloud says so in three
 * places that are written together by `pairing-apply.ts`:
 *
 *   - `server_sync` config `locationId` — the value the push query already
 *     filters on;
 *   - the local `site_devices.location_id` row;
 *   - the cloud credential the bearer token resolves to, which is what
 *     `/api/server-sync/push` enforces against (`site_location_mismatch`).
 *
 * `repairPairingSnapshot` re-writes the same three together, and
 * `resolveConfigUpdate` carries an existing `locationId` forward, so the id
 * cannot be lost by editing the sync settings. Resolution is therefore not
 * ambiguous: it is one value, set once by pairing.
 *
 * What *is* unsafe is its **absence**. The push query treats a missing
 * `locationId` as "every local branch", so a paired install that somehow lost
 * the value would send its whole queue, and the cloud would refuse the entire
 * request — stalling the branch that was correctly paired too. This guard
 * fails closed before anything leaves the machine, and keeps an unpaired
 * business-wide-token install on its previous behaviour.
 */

export interface SiteBranchConfig {
  siteDeviceId?: string | null;
  locationId?: string | null;
}

export type SiteBranchResolution =
  /** Not a paired site (legacy business-wide token): nothing to enforce here. */
  | { paired: false }
  | { paired: true; ok: true; locationId: string }
  | {
      paired: true;
      ok: false;
      reason: "branch_unresolved" | "branch_not_local";
    };

/**
 * Resolve the branch this site is paired to, against the branches that exist
 * locally. `localLocationIds` is every `locations.id` of the local business.
 */
export function resolveSiteBranch(
  config: SiteBranchConfig | null | undefined,
  localLocationIds: readonly string[],
): SiteBranchResolution {
  if (!config?.siteDeviceId) return { paired: false };
  const locationId = typeof config.locationId === "string" ? config.locationId.trim() : "";
  if (!locationId) return { paired: true, ok: false, reason: "branch_unresolved" };
  if (!localLocationIds.includes(locationId)) {
    return { paired: true, ok: false, reason: "branch_not_local" };
  }
  return { paired: true, ok: true, locationId };
}

/**
 * Whether a queued event may be sent as this site. Only a resolved branch may
 * carry events, and only its own: a paired till is never a second branch's
 * sync origin, whatever the local queue holds.
 */
export function eventAllowedForSiteBranch(
  resolution: SiteBranchResolution,
  locationId: string,
): boolean {
  if (!resolution.paired) return true;
  return resolution.ok && resolution.locationId === locationId;
}
