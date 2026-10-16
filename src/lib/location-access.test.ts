import { describe, expect, it } from "vitest";
import {
  accessibleLocationIds,
  branchScopeSql,
  resolveMembershipBranchPolicy,
  type MembershipBranchInput,
} from "./location-access";

/**
 * Issue #947 (TEAM-F03) — the branch policy of a membership, decided once.
 *
 * Each case here is a shape the four onboarding doors actually produce (the PIN
 * staff form, the invite form, the setup wizard, the IAM replica), plus the two the
 * finding is about: a caller that names *nothing* at all, and an edit that clears a
 * member's branches. Before this rule both of those ended at `ELSE 'all'` in SQL, so
 * the widest possible answer was also the default one — and it was invisible on the
 * member's own card, because no `user_locations` row was written to show it.
 */

const HOME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function decide(input: Partial<MembershipBranchInput> & Pick<MembershipBranchInput, "mode">) {
  return resolveMembershipBranchPolicy({
    role: "cashier",
    assignedLocationIds: [],
    ...input,
  });
}

describe("resolveMembershipBranchPolicy — creation (issue #947, TEAM-F03)", () => {
  it("never widens an unnamed policy to every branch", () => {
    /*
     * The finding itself. A creation that names no branch policy — the shape the old
     * PIN-staff form sent — falls to the business's default branch, not to «all».
     */
    const policy = decide({ mode: "creation", businessDefaultLocationId: HOME });
    expect(policy).toEqual({ scope: "home", defaultLocationId: HOME, basis: "business_default" });
  });

  it("records «no branch» when the business has none to grant", () => {
    // A business with no active branch: a member who can reach nothing, stated as
    // such, rather than a membership that claims every branch of an empty set.
    expect(decide({ mode: "creation" })).toEqual({
      scope: "none",
      defaultLocationId: null,
      basis: "no_branch",
    });
  });

  it("honours an explicit policy exactly, including the widest one", () => {
    expect(decide({ mode: "creation", namedScope: "all" })).toEqual({
      scope: "all",
      defaultLocationId: null,
      basis: "named",
    });
    expect(decide({ mode: "creation", namedScope: "none" })).toMatchObject({ scope: "none", basis: "named" });
  });

  it("infers «selected» from a set and «home» from a branch, and says which", () => {
    expect(decide({ mode: "creation", assignedLocationIds: [HOME, OTHER] })).toEqual({
      scope: "selected",
      defaultLocationId: null,
      basis: "assigned",
    });
    expect(decide({ mode: "creation", defaultLocationId: HOME })).toEqual({
      scope: "home",
      defaultLocationId: HOME,
      basis: "home",
    });
  });

  it("refuses an unhonourable named policy instead of widening it", () => {
    // Both of these were `ELSE 'all'` cases: `selected` with nothing selected and
    // `home` with no home branch produced a member holding the whole business.
    expect(decide({ mode: "creation", namedScope: "selected" })).toEqual({
      error: "selected_locations_required",
    });
    expect(decide({ mode: "creation", namedScope: "home" })).toEqual({ error: "home_location_required" });
    expect(decide({ mode: "creation", namedScope: "home", assignedLocationIds: [HOME] })).toEqual({
      error: "home_location_required",
    });
  });

  it("treats «selected» with a home branch as that one branch", () => {
    // `resolveMemberLocations` folds the home into the assignment set, so this is the
    // shape a form that ticks one branch and marks it as home produces.
    const policy = decide({
      mode: "creation",
      namedScope: "selected",
      assignedLocationIds: [HOME],
      defaultLocationId: HOME,
    });
    expect(policy).toEqual({ scope: "selected", defaultLocationId: HOME, basis: "named" });
  });

  it("gives an owner every branch regardless of anything named", () => {
    // Ownership is whole-business by definition; a narrowed owner is not a case the
    // product models, and `location-access.ts`'s reader agrees (arm 1).
    expect(decide({ mode: "creation", role: "owner", namedScope: "none" })).toEqual({
      scope: "all",
      defaultLocationId: null,
      basis: "owner",
    });
  });

  it("agrees with the reader that resolves the policy back into branches", () => {
    /*
     * The decision and the reader are two halves of one rule, and the failure mode of
     * splitting them is a policy that reads as something else. For every arm: the
     * branch set the reader computes from the decided policy is what the arm meant.
     */
    const business = [HOME, OTHER];
    const unnamed = decide({ mode: "creation", businessDefaultLocationId: OTHER });
    expect(unnamed).not.toHaveProperty("error");
    if ("error" in unnamed) return;
    expect(
      accessibleLocationIds(
        { role: "cashier", locationScope: unnamed.scope, defaultLocationId: unnamed.defaultLocationId, assignedLocationIds: [] },
        business,
      ),
    ).toEqual([OTHER]);

    const selected = decide({ mode: "creation", namedScope: "selected", assignedLocationIds: [HOME] });
    if ("error" in selected) throw new Error("selected policy refused");
    expect(
      accessibleLocationIds(
        { role: "cashier", locationScope: selected.scope, defaultLocationId: selected.defaultLocationId, assignedLocationIds: [HOME] },
        business,
      ),
    ).toEqual([HOME]);
  });
});

describe("resolveMembershipBranchPolicy — assignment (issue #947, TEAM-F03)", () => {
  it("reads a cleared branch set as «none», never as «all»", () => {
    /*
     * The edit-side half of the finding: `updateMembership`'s `UPDATE` also ended in
     * `ELSE 'all'`, so an owner who cleared a member's branches granted them the whole
     * business — including branches opened later.
     */
    expect(decide({ mode: "assignment", assignedLocationIds: [] })).toEqual({
      scope: "none",
      defaultLocationId: null,
      basis: "no_branch",
    });
  });

  it("still follows a policy the caller named", () => {
    expect(decide({ mode: "assignment", namedScope: "all" })).toMatchObject({ scope: "all", basis: "named" });
    expect(
      decide({ mode: "assignment", namedScope: "selected", assignedLocationIds: [HOME] }),
    ).toMatchObject({ scope: "selected", basis: "named" });
    expect(decide({ mode: "assignment", defaultLocationId: HOME })).toMatchObject({
      scope: "home",
      basis: "home",
    });
  });

  it("does not fall back to the business's default branch — there is no such arm", () => {
    // An assignment states the answer: the branch set. The default-branch arm exists
    // only for a creation that named nothing (the legacy-client case), and reaching it
    // from an edit would re-create the silent grant this rule removes.
    expect(
      decide({ mode: "assignment", businessDefaultLocationId: HOME }),
    ).toEqual({ scope: "none", defaultLocationId: null, basis: "no_branch" });
  });

  it("keeps an owner's scope absolute", () => {
    expect(decide({ mode: "assignment", role: "owner", assignedLocationIds: [] })).toMatchObject({
      scope: "all",
      basis: "owner",
    });
  });
});

/**
 * The SQL twin of `accessibleLocationIds` (issue #947, consumer seam).
 *
 * A pure test cannot run the predicate, so it pins the *arms*: one per scope, the
 * pre-0170 inference for a null column, and the tenant guard on the assignment join. The
 * behaviour is proven against real memberships in the database suite
 * (`integration/team.integration.test.ts`, «floor eligibility»); this is what stops the
 * query drifting away from the function the rest of the product authorises with.
 */
describe("branchScopeSql — the same rule, in SQL", () => {
  const sql = branchScopeSql({ alias: "u", locationParam: "$2" });

  it("has one arm per scope, including the two the old floor queries were missing", () => {
    expect(sql).toContain("u.location_scope = 'all' THEN true");
    expect(sql).toContain("u.location_scope = 'none' THEN false");
    expect(sql).toContain("u.location_scope = 'selected' THEN");
    expect(sql).toContain("u.location_scope = 'home' THEN u.location_id = $2");
  });

  it("infers the pre-0170 shape from the columns rather than defaulting wide", () => {
    // «no policy» is not «all branches»: an explicit assignment means «selected», a
    // default branch means «home», and only a row with neither is the roaming manager.
    expect(sql).toContain("EXISTS (SELECT 1 FROM user_locations ul0 WHERE ul0.user_id = u.id) THEN");
    expect(sql).toContain("WHEN u.location_id IS NOT NULL THEN u.location_id = $2");
    expect(sql).toContain("ELSE true");
  });

  it("reads an assignment through the member's own business and branch id", () => {
    // A `user_locations` row pointing at another tenant's branch must contribute
    // nothing — the same join `authorize()` loads assignments with.
    expect(sql).toContain("JOIN locations l ON l.id = ul.location_id AND l.business_id = u.business_id AND l.is_active");
    expect(sql).toContain("ul.location_id = $2");
    // Every branch id in the predicate is the caller's placeholder.
    expect(sql.match(/\$2/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).not.toContain("$1");
  });

  it("honours the alias it is given, so it composes into a join", () => {
    expect(branchScopeSql({ alias: "staff", locationParam: "$7" })).toContain("staff.location_scope = 'all'");
    expect(branchScopeSql({ alias: "staff", locationParam: "$7" })).toContain("staff.location_id = $7");
  });
});
