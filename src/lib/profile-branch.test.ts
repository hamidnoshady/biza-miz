/**
 * Issue #854 follow-up (F13) — the Profile header's branch facts: the active
 * branch is the one in view, the home branch is the membership's own, and the
 * relation between the two is stated, never inferred from a missing value.
 */
import { describe, expect, it } from "vitest";
import { describeProfileBranches } from "./profile-branch";

const main = { id: "loc-main", name: "شعبهٔ مرکزی" };
const north = { id: "loc-north", name: "شعبهٔ شمال" };
const south = { id: "loc-south", name: "شعبهٔ جنوب" };

describe("describeProfileBranches", () => {
  it("equal: names the home branch and says it is the one in view", () => {
    expect(
      describeProfileBranches({
        active: main,
        homeLocationId: main.id,
        businessLocations: [main, north],
        access: { canSwitch: false, locations: [main] },
      }),
    ).toEqual({ active: main, home: main, homeStatus: "same", canSwitch: false });
  });

  it("different: reports the home branch separately when the member is working elsewhere", () => {
    expect(
      describeProfileBranches({
        active: north,
        homeLocationId: main.id,
        businessLocations: [main, north, south],
        access: { canSwitch: true, locations: [main, north, south] },
      }),
    ).toEqual({ active: north, home: main, homeStatus: "different", canSwitch: true });
  });

  it("missing: a membership with no home branch is `unassigned`, never `same`", () => {
    expect(
      describeProfileBranches({
        active: north,
        homeLocationId: null,
        businessLocations: [main, north],
        access: { canSwitch: true, locations: [main, north] },
      }),
    ).toEqual({ active: north, home: null, homeStatus: "unassigned", canSwitch: true });
  });

  it("inactive: a home branch that is no longer active is `unavailable`, never `same`", () => {
    // A deactivated branch is not in `businessLocations` (only active ones are).
    expect(
      describeProfileBranches({
        active: north,
        homeLocationId: "loc-closed",
        businessLocations: [main, north],
        access: { canSwitch: true, locations: [main, north] },
      }),
    ).toEqual({ active: north, home: null, homeStatus: "unavailable", canSwitch: true });
  });

  it("inactive even when the member happens to be in the only remaining branch", () => {
    // The old shape returned `home: null` here and the screen called the active
    // branch «شعبهٔ اصلی شما» — the bug this status exists to prevent.
    const info = describeProfileBranches({
      active: main,
      homeLocationId: "loc-closed",
      businessLocations: [main],
      access: { canSwitch: false, locations: [main] },
    });
    expect(info.homeStatus).toBe("unavailable");
    expect(info.home).toBeNull();
  });

  it("never treats another business's branch as the home branch", () => {
    const info = describeProfileBranches({
      active: main,
      homeLocationId: "loc-of-another-business",
      businessLocations: [main, north],
      access: { canSwitch: true, locations: [main, north] },
    });
    expect(info).toMatchObject({ home: null, homeStatus: "unavailable" });
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
      homeLocationId: row.id,
      businessLocations: [row],
      access: { canSwitch: false, locations: [row] },
    });
    expect(info.active).toEqual({ id: "loc-x", name: "X" });
    expect(info.home).toEqual({ id: "loc-x", name: "X" });
  });

  it("handles a business with no active branch at all", () => {
    expect(
      describeProfileBranches({
        active: null,
        homeLocationId: null,
        businessLocations: [],
        access: { canSwitch: false, locations: [] },
      }),
    ).toEqual({ active: null, home: null, homeStatus: "unassigned", canSwitch: false });
  });
});
