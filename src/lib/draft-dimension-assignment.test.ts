import { describe, it, expect } from "vitest";
import { resolveBulkAssignment } from "./draft-dimension-assignment";

const CC_A = "10000000-0000-4000-8000-00000000000a";
const CC_B = "10000000-0000-4000-8000-00000000000b";
const DEPT = "10000000-0000-4000-8000-00000000000c";

describe("resolveBulkAssignment", () => {
  it("fill_blank fills only absent kinds and never touches what is there", () => {
    const before = { cost_center: CC_A };
    const after = resolveBulkAssignment(
      before,
      { cost_center: CC_B, department: DEPT },
      "fill_blank",
    );
    expect(after).toEqual({ cost_center: CC_A, department: DEPT });
  });

  it("fill_blank on an empty line applies everything the payload names", () => {
    const after = resolveBulkAssignment({}, { cost_center: CC_A, department: DEPT }, "fill_blank");
    expect(after).toEqual({ cost_center: CC_A, department: DEPT });
  });

  it("overwrite replaces named kinds and leaves unnamed ones alone", () => {
    const before = { cost_center: CC_A, department: DEPT };
    const after = resolveBulkAssignment(before, { cost_center: CC_B }, "overwrite");
    expect(after).toEqual({ cost_center: CC_B, department: DEPT });
  });

  it("an explicit null clears a kind in overwrite mode", () => {
    const before = { cost_center: CC_A, department: DEPT };
    const after = resolveBulkAssignment(before, { cost_center: null }, "overwrite");
    expect(after).toEqual({ department: DEPT });
  });

  it("an explicit null does NOT clear in fill_blank mode (blank only)", () => {
    const before = { cost_center: CC_A };
    const after = resolveBulkAssignment(before, { cost_center: null }, "fill_blank");
    expect(after).toEqual({ cost_center: CC_A });
    // ...but it can fill an absent kind with... still nothing — null is blank.
    const empty = resolveBulkAssignment({}, { cost_center: null }, "fill_blank");
    expect(empty).toEqual({});
  });

  it("is idempotent: re-running the same fill changes nothing", () => {
    const once = resolveBulkAssignment({}, { cost_center: CC_A }, "fill_blank");
    const twice = resolveBulkAssignment(once, { cost_center: CC_A }, "fill_blank");
    expect(twice).toEqual(once);
  });
});
