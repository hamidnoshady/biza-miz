/**
 * Phase 14 — which branches a member may act in.
 *
 * Framework-free and pure (unit-tested in location-access.test.ts); the
 * DB-touching resolution that uses this lives in setup-state.ts, per the repo
 * convention that framework-free decision logic and its data lookup are
 * separate files.
 *
 * The rule, in order:
 *   1. `owner` always reaches every branch of their business. Ownership is
 *      whole-business by definition — restricting an owner to a subset of
 *      their own branches isn't a real-world case worth modelling.
 *   2. An explicit `user_locations` assignment is the access set, full stop.
 *      This is what lets an owner give one manager two of five branches.
 *   3. No assignment but a default `location_id` (the shape every cashier,
 *      waiter and kitchen member has always had) restricts to that one
 *      branch — unchanged from pre-Phase-14 behaviour.
 *   4. No assignment and no default (`location_id` NULL, the pre-Phase-14
 *      "roaming manager") reaches every branch. This is also what makes a
 *      single-location business behave exactly as before: one location, no
 *      assignments, everyone reaches the only branch there is.
 */
import type { Role } from "./auth-edge";

export type LocationScope = "all" | "selected" | "home" | "none";

export const LOCATION_SCOPES = ["all", "selected", "home", "none"] as const;

export function isLocationScope(value: unknown): value is LocationScope {
  return typeof value === "string" && (LOCATION_SCOPES as readonly string[]).includes(value);
}


export interface LocationAccessContext {
  role: Role;
  /** Explicit policy persisted on users.location_scope. */
  locationScope?: LocationScope;
  /** users.location_id — the member's default/home branch, if any. */
  defaultLocationId: string | null;
  /** user_locations rows for this member. */
  assignedLocationIds: string[];
}

/**
 * The same rule as `accessibleLocationIds`, as a SQL predicate (issue #947).
 *
 * ## Why there are two implementations, and why that is not a drift risk
 *
 * `accessibleLocationIds` answers «may this *request* act in this branch» for the
 * member making it, from a context `authorize()` has already loaded. This answers «may
 * this *other* member be scheduled/assigned here» — a question about every candidate row
 * at once (`GET /api/staff` lists the eligible waiters, `floor.validWaiterId` checks one
 * on write), which has to run in the query rather than in a JavaScript loop.
 *
 * Both doors used `users.location_id` alone, which migration 0170 demoted to the
 * member's *default* branch: a member whose policy is «selected» with `user_locations`
 * rows for two branches was invisible to the picker at the second one, and a member
 * whose policy is «none» stayed assignable at the branch their `location_id` still
 * names. Two implementations of one rule is exactly how that happens, so the arms below
 * are the numbered arms of the doc comment above, one for one — and
 * `location-access.test.ts` pins the SQL to them while
 * `integration/team.integration.test.ts` drives real memberships of every shape through
 * this predicate.
 *
 * The `location_scope IS NULL` arm is the pre-0170 inference, kept so a row written
 * before the column existed behaves as its columns say (`location_access` case 3/4
 * above) rather than falling into the widest possible answer.
 *
 * `user_locations` is joined through `locations` on the member's own business, the same
 * way `authorize()` loads assignments: a row pointing at another tenant's branch
 * contributes nothing.
 */
export function branchScopeSql(options: {
  /** The alias of the `users` row being tested, e.g. `u`. */
  alias: string;
  /** The placeholder holding the branch id, e.g. `$2`. */
  locationParam: string;
}): string {
  const { alias, locationParam } = options;
  const assigned = `EXISTS (
        SELECT 1 FROM user_locations ul
          JOIN locations l ON l.id = ul.location_id AND l.business_id = ${alias}.business_id AND l.is_active
         WHERE ul.user_id = ${alias}.id AND ul.location_id = ${locationParam})`;
  const anyAssignment = `EXISTS (SELECT 1 FROM user_locations ul0 WHERE ul0.user_id = ${alias}.id)`;
  return `(CASE
      WHEN ${alias}.location_scope = 'all' THEN true
      WHEN ${alias}.location_scope = 'none' THEN false
      WHEN ${alias}.location_scope = 'selected' THEN ${assigned}
      WHEN ${alias}.location_scope = 'home' THEN ${alias}.location_id = ${locationParam}
      ELSE (CASE
        WHEN ${anyAssignment} THEN ${assigned}
        WHEN ${alias}.location_id IS NOT NULL THEN ${alias}.location_id = ${locationParam}
        ELSE true
      END)
    END)`;
}

/**
 * Every branch (of the ones passed in, which should already be filtered to
 * the business's active locations) this member may act in.
 */
export function accessibleLocationIds(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
): string[] {
  if (ctx.role === "owner") return businessLocationIds;

  // Compatibility inference is only for callers/fixtures predating migration
  // 0170. Persisted production memberships always carry an explicit policy.
  const scope: LocationScope = ctx.locationScope ?? (
    ctx.assignedLocationIds.length > 0
      ? "selected"
      : ctx.defaultLocationId
        ? "home"
        : "all"
  );
  if (scope === "all") return businessLocationIds;
  if (scope === "none") return [];
  if (scope === "selected") {
    const assigned = new Set(ctx.assignedLocationIds);
    return businessLocationIds.filter((id) => assigned.has(id));
  }
  return ctx.defaultLocationId && businessLocationIds.includes(ctx.defaultLocationId)
    ? [ctx.defaultLocationId]
    : [];
}

export function canAccessLocation(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
  locationId: string,
): boolean {
  return accessibleLocationIds(ctx, businessLocationIds).includes(locationId);
}

/**
 * The branch that should be active when none has been explicitly (and
 * validly) chosen yet: the member's own default if it's still one they can
 * reach, otherwise the first accessible branch.
 *
 * `businessLocationIds` must be in a stable order (callers pass them sorted
 * by `created_at`) so "first accessible" is deterministic rather than
 * whatever order the database felt like returning.
 */
export function defaultAccessibleLocationId(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
): string | null {
  const accessible = accessibleLocationIds(ctx, businessLocationIds);
  if (accessible.length === 0) return null;
  if (ctx.defaultLocationId && accessible.includes(ctx.defaultLocationId)) {
    return ctx.defaultLocationId;
  }
  return accessible[0];
}

/**
 * Issue #947 (TEAM-F03) — the branch policy a membership gets, decided once,
 * here, instead of by whichever column happened to be NULL.
 *
 * ## What was wrong
 *
 * `createMembership` wrote the policy with a SQL `CASE` whose last arm was
 * `ELSE 'all'`. So a caller that named no branch policy at all — which is
 * exactly what the PIN-staff form did, sending only role/name/PIN/phone — got
 * **every branch of the business**, plus zero `user_locations` rows, so the
 * policy was invisible in the assignment UI and nobody had chosen it. The
 * branch a member works in is not a detail the product may pick for the owner
 * silently, and «همهٔ شعبهها» is the widest answer available: it also grants
 * every branch the business opens *later*.
 *
 * ## The rule now
 *
 * In order, and the `basis` records which arm was taken (it is persisted in the
 * audit entry, so "who gave this cashier every branch?" has an answer):
 *
 *   1. `owner` — every branch, as before; ownership is whole-business.
 *   2. A policy the caller **named** (`locationScope` from the body, or a custom
 *      role's `default_location_scope`) — honoured exactly, with its own
 *      invariants enforced rather than assumed: `selected` needs a branch set,
 *      `home` needs a home branch. A named policy is never widened: the old
 *      `ELSE 'all'` also swallowed "the caller asked for something we could not
 *      honour".
 *   3. A branch set with no policy — `selected`, the same inference every
 *      pre-0170 row reads as.
 *   4. A home branch with no policy — `home`.
 *   5. **Nothing named at all** — the business's own default branch (`home`), or
 *      `none` when the business has no active branch to grant. Never `all`.
 *
 * Arm 5 is the compatibility answer for a client that has not been updated: it
 * still succeeds, and it stays *narrow* — a legacy PIN-staff form now creates a
 * member bound to the default branch, not to every branch. That is the whole
 * point: the failure mode to avoid is a silent grant, not a refusal, so an old
 * client that asks for nothing gets the least it could reasonably mean.
 *
 * ## `mode`
 *
 * The same rule answers one more door, and the two differ in exactly one arm.
 * A *creation* that named nothing is an old client, so it falls to the
 * business's default branch. An *assignment* — an edit that named a branch set
 * without naming a policy, e.g. «این عضو هیچ شعبه‌ای ندارد» — is a person
 * saying something specific, and arm 5 must not read it as «همهٔ شعبه‌ها»: it is
 * `none`, because the caller just cleared every branch. (That was the defect in
 * `updateMembership`'s own `CASE … ELSE 'all'`: clearing a member's branches
 * granted them the whole business.)
 */
export interface MembershipBranchInput {
  /**
   * `creation` — a new membership (or a rehire) whose unnamed policy falls back
   * to the business's default branch. `assignment` — an edit whose unnamed and
   * empty policy means «no branch».
   */
  mode: "creation" | "assignment";
  role: Role;
  /** The policy the caller named, if any (`locationScope`, or a role's default). */
  namedScope?: LocationScope | null;
  /** Branch ids the caller asked for, already resolved to this business. */
  assignedLocationIds: readonly string[];
  /** The home branch the caller named, if any. */
  defaultLocationId?: string | null;
  /** The business's default branch (its oldest active one), for arm 5. */
  businessDefaultLocationId?: string | null;
}

export interface MembershipCreationBranchPolicy {
  scope: LocationScope;
  defaultLocationId: string | null;
  /** Which arm of the rule decided this — audited, and shown on the member. */
  basis: "owner" | "named" | "assigned" | "home" | "business_default" | "no_branch";
}

export function resolveMembershipBranchPolicy(
  input: MembershipBranchInput,
): MembershipCreationBranchPolicy | { error: "selected_locations_required" | "home_location_required" } {
  const namedHome = input.defaultLocationId ?? null;
  if (input.role === "owner") {
    return { scope: "all", defaultLocationId: namedHome, basis: "owner" };
  }

  const named = input.namedScope ?? null;
  if (named === "all") return { scope: "all", defaultLocationId: namedHome, basis: "named" };
  if (named === "none") return { scope: "none", defaultLocationId: namedHome, basis: "named" };
  if (named === "selected") {
    // `assignedLocationIds` already folds the home branch in, so a caller that
    // sent only a home and asked for `selected` means "just that branch".
    if (input.assignedLocationIds.length === 0) return { error: "selected_locations_required" };
    return { scope: "selected", defaultLocationId: namedHome, basis: "named" };
  }
  if (named === "home") {
    if (!namedHome) return { error: "home_location_required" };
    return { scope: "home", defaultLocationId: namedHome, basis: "named" };
  }

  if (input.assignedLocationIds.length > 0) {
    return { scope: "selected", defaultLocationId: namedHome, basis: "assigned" };
  }
  if (namedHome) return { scope: "home", defaultLocationId: namedHome, basis: "home" };
  if (input.mode === "assignment") return { scope: "none", defaultLocationId: namedHome, basis: "no_branch" };
  if (input.businessDefaultLocationId) {
    return { scope: "home", defaultLocationId: input.businessDefaultLocationId, basis: "business_default" };
  }
  return { scope: "none", defaultLocationId: null, basis: "no_branch" };
}

/** Whether this member may switch between branches at all, for the UI. */
export function canSwitchBranches(ctx: LocationAccessContext, businessLocationIds: string[]): boolean {
  return accessibleLocationIds(ctx, businessLocationIds).length > 1;
}
