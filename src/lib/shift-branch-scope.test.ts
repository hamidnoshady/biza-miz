/**
 * Issue #933 item 6 — the branch predicate.
 *
 * The bug was a predicate, so the test pins the predicate: every query that
 * asks "is this shift this branch's?" must go through the attribution function
 * and must never fall back to `location_id IS NULL`, which attributed every
 * legacy shift to every branch.
 */
import { describe, expect, it } from "vitest";
import {
  isShiftInAllowedBranches,
  shiftBranchExpression,
  shiftInBranchesSql,
  shiftInBranchSql,
} from "./shift-branch-scope";

describe("shiftBranchExpression", () => {
  it("resolves a branch-less legacy row through the attribution function", () => {
    expect(shiftBranchExpression("s")).toBe(
      "coalesce(s.location_id, app_shift_attribution_branch(s.business_id, s.location_id, s.employee_id))",
    );
  });

  it("never treats NULL as belonging to the requested branch", () => {
    const sql = shiftInBranchSql("s", "$1");
    expect(sql).not.toContain("location_id IS NULL");
    expect(sql).toContain("= $1");
  });

  it("compares against an allowed-branch array for a scoped admin", () => {
    expect(shiftInBranchesSql("s", "$2")).toContain("= ANY($2::uuid[])");
  });
});

describe("isShiftInAllowedBranches", () => {
  it("lets an unscoped caller (null) reach anything", () => {
    expect(isShiftInAllowedBranches("a", null)).toBe(true);
    expect(isShiftInAllowedBranches(null, null)).toBe(true);
  });

  it("confines a scoped caller to their branches", () => {
    expect(isShiftInAllowedBranches("a", ["a", "b"])).toBe(true);
    expect(isShiftInAllowedBranches("c", ["a", "b"])).toBe(false);
    expect(isShiftInAllowedBranches(null, ["a"])).toBe(false);
    expect(isShiftInAllowedBranches("a", [])).toBe(false);
  });
});
