import { describe, expect, it } from "vitest";
import {
  defaultSortDirection,
  isBusinessSortValue,
  parseSortDirection,
  resolveBusinessSort,
} from "./business-sort";

describe("business directory sort contract (audit F14)", () => {
  it("accepts the canonical keys and the legacy created-date values", () => {
    for (const v of ["newest", "oldest", "created", "name", "orders", "members", "activity"]) {
      expect(isBusinessSortValue(v)).toBe(true);
    }
    expect(isBusinessSortValue("revenue")).toBe(false);
    expect(isBusinessSortValue(undefined)).toBe(false);
  });

  it("keeps legacy newest/oldest meaning when no direction is sent", () => {
    expect(resolveBusinessSort("newest")).toEqual({ key: "created", dir: "desc" });
    expect(resolveBusinessSort("oldest")).toEqual({ key: "created", dir: "asc" });
  });

  it("applies an explicit direction to every sortable key", () => {
    expect(resolveBusinessSort("name", "desc")).toEqual({ key: "name", dir: "desc" });
    expect(resolveBusinessSort("orders", "asc")).toEqual({ key: "orders", dir: "asc" });
    expect(resolveBusinessSort("members", "asc")).toEqual({ key: "members", dir: "asc" });
    expect(resolveBusinessSort("activity", "asc")).toEqual({ key: "activity", dir: "asc" });
  });

  it("uses each key's natural default when no direction is sent", () => {
    expect(resolveBusinessSort("name").dir).toBe("asc");
    expect(resolveBusinessSort("orders").dir).toBe("desc");
    expect(resolveBusinessSort("members").dir).toBe("desc");
    expect(resolveBusinessSort("activity").dir).toBe("desc");
    expect(defaultSortDirection("name")).toBe("asc");
  });

  it("ignores invalid directions and unknown keys instead of passing them to SQL", () => {
    expect(parseSortDirection("sideways")).toBeUndefined();
    expect(parseSortDirection("ASC; DROP TABLE x")).toBeUndefined();
    expect(resolveBusinessSort("name", "sideways")).toEqual({ key: "name", dir: "asc" });
    expect(resolveBusinessSort("created; drop", null)).toEqual({ key: "created", dir: "desc" });
  });
});
