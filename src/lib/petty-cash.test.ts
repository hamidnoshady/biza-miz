import { describe, expect, it } from "vitest";
import { pettyCashMovementProblem, pettyCashCanDecide } from "./petty-cash";

describe("petty cash funding policy", () => {
  it("funds a fixed float to its exact ceiling and restores only what was spent", () => {
    const ceiling = "9007199254740993";
    expect(pettyCashMovementProblem("fund", "fixed", ceiling, "0", "9007199254740992")).toBe("fixed_float_must_fill");
    expect(pettyCashMovementProblem("fund", "fixed", ceiling, "0", ceiling)).toBeNull();
    expect(pettyCashMovementProblem("replenish", "fixed", ceiling, "9007199254740992", "1")).toBeNull();
    expect(pettyCashMovementProblem("replenish", "fixed", ceiling, "9007199254740991", "1")).toBe("fixed_float_must_fill");
  });

  it("allows a variable float to top up below the ceiling without overdrawing", () => {
    expect(pettyCashMovementProblem("fund", "variable", "1000", "0", "500")).toBeNull();
    expect(pettyCashMovementProblem("replenish", "variable", "1000", "500", "250")).toBeNull();
    expect(pettyCashMovementProblem("replenish", "variable", "1000", "500", "501")).toBe("float_ceiling_exceeded");
    expect(pettyCashMovementProblem("approve", "variable", "1000", "500", "501")).toBe("insufficient_float");
  });

  it("requires a matching independent physical count before returning the float", () => {
    expect(pettyCashMovementProblem("close", "fixed", "1000", "250", "249")).toBe("float_count_mismatch");
    expect(pettyCashMovementProblem("close", "fixed", "1000", "0", "0")).toBeNull();
    expect(pettyCashCanDecide("a", "a", "accountant", ["accountant"], true)).toBe(false);
    expect(pettyCashCanDecide("b", "a", "accountant", ["owner"], true)).toBe(false);
    expect(pettyCashCanDecide("b", "a", "accountant", ["accountant"], false)).toBe(false);
    expect(pettyCashCanDecide("b", "a", "accountant", ["accountant"], true)).toBe(true);
  });
});
