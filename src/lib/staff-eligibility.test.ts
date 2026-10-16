import { describe, expect, it } from "vitest";
import { FLOOR_STAFF_ROLES, staffEligibilitySql } from "./staff-eligibility";

/**
 * The shared eligibility predicate (issue #947, consumer seam).
 *
 * `floor.validWaiterId` and `GET /api/staff` used to answer «is this member staff at this
 * branch» from `users.location_id` alone, which migration 0170 turned into the member's
 * *default* branch. The rule now lives in one place, and these cases pin the three
 * questions it asks — live membership, role, branch — plus the fact that the branch half
 * is `branchScopeSql` rather than a second, narrower reading of the same columns.
 *
 * The real memberships of every scope shape are driven through the *database* functions
 * in `integration/team.integration.test.ts`; what is pinned here is the SQL's composition
 * (a missing arm would silently answer «eligible everywhere»).
 */
describe("staff eligibility predicate (issue #947)", () => {
  const sql = staffEligibilitySql({ alias: "u", businessParam: "$1", locationParam: "$2" });

  it("asks all three questions, on the row's own tenant", () => {
    expect(sql).toContain("u.business_id = $1");
    // Live membership: `authorize()` suspends and offboards through both columns, so a
    // predicate that read only one of them would keep giving a suspended member work.
    expect(sql).toContain("u.is_active");
    expect(sql).toContain("u.membership_status IS NULL OR u.membership_status = 'active'");
    expect(sql).toContain("u.role::text IN ('waiter')");
  });

  it("asks the branch question through the shared resolver, not a second one", () => {
    // The four explicit scopes are `accessibleLocationIds`' arms, one for one.
    expect(sql).toContain("u.location_scope = 'all'");
    expect(sql).toContain("u.location_scope = 'none'");
    expect(sql).toContain("u.location_scope = 'selected'");
    expect(sql).toContain("u.location_scope = 'home'");
    // The pre-0170 inference, and the assignment join carrying its tenant.
    expect(sql).toContain("WHEN EXISTS (SELECT 1 FROM user_locations ul0 WHERE ul0.user_id = u.id)");
    expect(sql).toContain("l.business_id = u.business_id");
    // `location_id` is the *home/default* branch, never the whole answer.
    expect(sql).not.toMatch(/^\s*AND u\.location_id = \$2\s*$/m);
  });

  it("takes the roles a caller asks about, and defaults to the floor's own set", () => {
    const cashiers = staffEligibilitySql({
      alias: "m",
      businessParam: "$1",
      locationParam: "$3",
      roles: ["cashier", "manager"],
    });
    expect(cashiers).toContain("m.role::text IN ('cashier', 'manager')");
    expect(cashiers).toContain("m.location_id = $3");
    expect(FLOOR_STAFF_ROLES).toEqual(["waiter"]);
  });
});
