import { describe, expect, it } from "vitest";
import {
  BOTTOM_NAV_MAX,
  parseBottomNavHrefs,
  resolveAdaptiveBottomNavHrefs,
  resolveBottomNavHrefs,
  toggleBottomNavHref,
} from "./bottom-nav";

const ALL = [
  "/dashboard",
  "/accounting/orders",
  "/accounting/pos",
  "/accounting/reports",
  "/accounting/inventory",
  "/settings",
];

describe("parseBottomNavHrefs", () => {
  it("reads a stored list", () => {
    expect(parseBottomNavHrefs('["/dashboard","/accounting/pos"]')).toEqual([
      "/dashboard",
      "/accounting/pos",
    ]);
  });

  it("returns null for nothing stored, and for junk", () => {
    expect(parseBottomNavHrefs(null)).toBeNull();
    expect(parseBottomNavHrefs("not json")).toBeNull();
    expect(parseBottomNavHrefs('{"a":1}')).toBeNull();
  });

  it("drops non-string entries rather than rendering them", () => {
    expect(parseBottomNavHrefs('["/dashboard",7,null]')).toEqual([
      "/dashboard",
    ]);
  });
});

describe("resolveBottomNavHrefs", () => {
  it("falls back to the shipped default when nothing is configured", () => {
    expect(resolveBottomNavHrefs(null, ALL, false)).toEqual([
      "/dashboard",
      "/accounting/orders",
      "/accounting/reports",
    ]);
  });

  it("swaps reports for the sell screen while on it", () => {
    expect(resolveBottomNavHrefs(null, ALL, true)).toEqual([
      "/dashboard",
      "/accounting/pos",
      "/accounting/orders",
    ]);
  });

  it("upgrades a stored legacy shortcut to the configured canonical route", () => {
    expect(
      resolveBottomNavHrefs(["/dashboard/inventory", "/dashboard"], ALL, true),
    ).toEqual(["/accounting/inventory", "/dashboard"]);
  });

  it("drops a page the member can no longer see", () => {
    const stored = ["/dashboard", "/accounting/reports"];
    expect(resolveBottomNavHrefs(stored, ["/dashboard"], false)).toEqual([
      "/dashboard",
    ]);
  });

  it("never renders more than the cap, and never renders a duplicate", () => {
    const stored = [...ALL, "/dashboard"];
    const resolved = resolveBottomNavHrefs(stored, ALL, false);
    expect(resolved).toHaveLength(BOTTOM_NAV_MAX);
    expect(new Set(resolved).size).toBe(BOTTOM_NAV_MAX);
  });

  it("treats an empty stored list as unconfigured", () => {
    expect(resolveBottomNavHrefs([], ALL, false)).toEqual(
      resolveBottomNavHrefs(null, ALL, false),
    );
  });
});

describe("toggleBottomNavHref", () => {
  it("adds and removes", () => {
    expect(toggleBottomNavHref([], "/dashboard")).toEqual(["/dashboard"]);
    expect(toggleBottomNavHref(["/dashboard"], "/dashboard")).toEqual([]);
  });

  it("refuses to add past the cap but still lets you take one out", () => {
    const full = ALL.slice(0, BOTTOM_NAV_MAX);
    expect(toggleBottomNavHref(full, "/settings")).toEqual(full);
    expect(toggleBottomNavHref(full, full[0])).toEqual(full.slice(1));
  });
});

describe("resolveAdaptiveBottomNavHrefs", () => {
  it("prioritizes primary modules up to 4 and places remaining authorized routes in moreHrefs", () => {
    expect(
      resolveAdaptiveBottomNavHrefs(
        null,
        ["/dashboard", "/accounting/orders", "/accounting/reports", "/accounting/pos", "/crm/customers", "/settings"],
        false,
      ),
    ).toEqual({
      primaryHrefs: [
        "/dashboard",
        "/accounting/orders",
        "/accounting/reports",
        "/accounting/pos",
      ],
      moreHrefs: ["/crm/customers", "/settings"],
    });
  });

  it("caps adaptive slots at 4 and drops unauthorized routes", () => {
    expect(
      resolveAdaptiveBottomNavHrefs(
        null,
        ["/dashboard", "/accounting/orders"],
        false,
      ),
    ).toEqual({
      primaryHrefs: ["/dashboard", "/accounting/orders"],
      moreHrefs: [],
    });
  });
});

