import { describe, expect, it } from "vitest";
import { canAccessHolooConnectionLocation } from "./guard";

describe("Holoo connection branch scope", () => {
  it("allows connections bound to an accessible location and rejects another branch", () => {
    const access = { locationIds: new Set(["branch-a"]), canAccessUnboundConnection: false };
    expect(canAccessHolooConnectionLocation(access, "branch-a")).toBe(true);
    expect(canAccessHolooConnectionLocation(access, "branch-b")).toBe(false);
    expect(canAccessHolooConnectionLocation(access, null)).toBe(false);
  });

  it("allows an unbound legacy connection only when the member can access every business location", () => {
    const allLocations = { locationIds: new Set(["branch-a", "branch-b"]), canAccessUnboundConnection: true };
    expect(canAccessHolooConnectionLocation(allLocations, null)).toBe(true);
    expect(canAccessHolooConnectionLocation(allLocations, "branch-b")).toBe(true);
  });
});
