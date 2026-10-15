/**
 * Issue #854 follow-up (F13) — what the Profile header says about branches.
 *
 * Two different facts that the screen must not conflate:
 *
 *  - the **active** branch — the one this session is working in right now. The
 *    server resolves it (`resolveActiveLocation`): the session's chosen branch
 *    while the member can still reach it, otherwise their default accessible
 *    branch — the same answer every branch-scoped route uses;
 *  - the **home** branch — the membership's own `users.location_id`, set by an
 *    administrator. A roaming member can be working somewhere else today.
 *
 * Pure and client-safe (types plus one function): the page does the reads
 * under the tenant scope and hands the rows here, so the rule is unit-testable
 * without a database and nothing about a branch comes from the client.
 */

/** A branch as the Profile header shows it — a name, never a bare id. */
export interface ProfileBranch {
  id: string;
  name: string;
}

/**
 * How the membership's home branch relates to the branch in view:
 *
 *  - `same` — the member is working in their own home branch;
 *  - `different` — they are working somewhere else today (`home` names it);
 *  - `unassigned` — the membership has no home branch at all;
 *  - `unavailable` — it names a branch that is no longer an active branch of
 *    this business (deactivated, or gone), so there is no name to show.
 *
 * Stated explicitly because "no separate home row" used to mean two opposite
 * things: the home *is* the active branch, or there is no usable home — and
 * the screen labelled the active branch «شعبهٔ اصلی شما» in both cases.
 */
export type ProfileHomeBranchStatus = "same" | "different" | "unassigned" | "unavailable";

export interface ProfileBranchInfo {
  /** The branch this session is working in right now. */
  active: ProfileBranch | null;
  /**
   * The membership's home branch whenever it is an active branch of this
   * business — named whether or not it is the branch in view.
   */
  home: ProfileBranch | null;
  homeStatus: ProfileHomeBranchStatus;
  /** Whether the member may switch branches (the header switcher) — and has more than one. */
  canSwitch: boolean;
}

export function describeProfileBranches(input: {
  /** `resolveActiveLocation(session)`. */
  active: ProfileBranch | null;
  /** `users.location_id` for this membership. */
  homeLocationId: string | null;
  /** Every active branch of the business (`businessLocations`). */
  businessLocations: readonly ProfileBranch[];
  /** `accessibleLocationsFor(session)`. */
  access: { canSwitch: boolean; locations: readonly ProfileBranch[] };
}): ProfileBranchInfo {
  const homeRow = input.homeLocationId
    ? (input.businessLocations.find((l) => l.id === input.homeLocationId) ?? null)
    : null;
  const home = homeRow ? { id: homeRow.id, name: homeRow.name } : null;
  const homeStatus: ProfileHomeBranchStatus = !input.homeLocationId
    ? "unassigned"
    : !home
      ? "unavailable"
      : home.id === input.active?.id
        ? "same"
        : "different";
  return {
    active: input.active ? { id: input.active.id, name: input.active.name } : null,
    home,
    homeStatus,
    canSwitch: input.access.canSwitch && input.access.locations.length > 1,
  };
}
