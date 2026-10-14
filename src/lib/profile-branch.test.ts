/**
 * Issue #854 follow-up (F13) — the Profile header's branch facts: the active
 * branch is the one in view, the home branch is the membership's own, and the
 * two are never conflated.
 */
import { describe, expect, it } from "vitest";
import { describeProfileBranches } from "./profile-branch";

const main = { id: "loc-main", name: "شعبهٔ مرکزی" };
const north = { id: "loc-north", name: "شعبهٔ شمال" };
const south = { id: "loc-south", name: "شعبهٔ جنوب" };

describe("describeProfileBranches", () => {
  it("names the active branch and reports no separate home when they are the same", () => {
    expect(
      describeProfileBranches({
        active: main,
        homeLocationId: main.id,
        businessLocations: [main, north],
        access: { canSwitch: false, locations: [main] },
      }),
    ).toEqual({ active: main, home: null, canSwitch: false });
  });

  it("reports the home branch separately when the member is working elsewhere", () => {
    expect(
      describeProfileBranches({
        active: north,
        homeLocationId: main.id,
        businessLocations: [main, north, south],
        access: { canSwitch: true, locations: [main, north, south] },
      }),
    ).toEqual({ active: north, home: main, canSwitch: true });
  });

  it("never invents a home branch: a missing or deactivated one is simply absent", () => {
    expect(
      describeProfileBranches({
        active: north,
        homeLocationId: "loc-closed",
        businessLocations: [main, north],
        access: { canSwitch: true, locations: [main, north] },
      }).home,
    ).toBeNull();
    expect(
      describeProfileBranches({
        active: north,
        homeLocationId: null,
        businessLocations: [main, north],
        access: { canSwitch: true, locations: [main, north] },
      }).home,
    ).toBeNull();
  });

  it("does not advertise switching when there is only one reachable branch", () => {
    expect(
      describeProfileBranches({
        active: main,
        homeLocationId: main.id,
        businessLocations: [main, north],
        access: { canSwitch: true, locations: [main] },
      }).canSwitch,
    ).toBe(false);
  });

  it("copies only id and name — no other row field reaches the client", () => {
    const row = { id: "loc-x", name: "X", address: "secret street", timezone: "Asia/Tehran" };
    const info = describeProfileBranches({
      active: row,
      homeLocationId: null,
      businessLocations: [row],
      access: { canSwitch: false, locations: [row] },
    });
    expect(info.active).toEqual({ id: "loc-x", name: "X" });
  });

  it("handles a business with no active branch at all", () => {
    expect(
      describeProfileBranches({
        active: null,
        homeLocationId: null,
        businessLocations: [],
        access: { canSwitch: false, locations: [] },
      }),
    ).toEqual({ active: null, home: null, canSwitch: false });
  });
});
