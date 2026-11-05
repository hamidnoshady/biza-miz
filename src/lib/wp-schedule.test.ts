import { describe, expect, it } from "vitest";
import {
  isFutureSchedule,
  isoToTehranWallClock,
  parseWordPressGmt,
  tehranWallClockToIso,
  toWordPressGmt,
  zoneOffsetMinutes,
} from "./wp-schedule";

describe("Tehran wall clock", () => {
  it("knows the current offset from the zone database, not from a constant", () => {
    // Iran dropped daylight saving in 2022: +03:30 since, +04:30 during the old
    // summer rule. Both must come out of the same code path.
    expect(zoneOffsetMinutes(new Date("2026-11-10T00:00:00Z"))).toBe(210);
    expect(zoneOffsetMinutes(new Date("2021-07-01T00:00:00Z"))).toBe(270);
  });

  it("turns a picked day and time into one instant", () => {
    expect(tehranWallClockToIso("2026-11-10", "09:00")).toBe("2026-11-10T05:30:00.000Z");
    expect(tehranWallClockToIso("2026-11-10", "23:45")).toBe("2026-11-10T20:15:00.000Z");
    // And back, so the field the owner sees is the field they set.
    expect(isoToTehranWallClock("2026-11-10T05:30:00.000Z")).toEqual({ date: "2026-11-10", time: "09:00" });
  });

  it("keeps a midnight schedule on its own day instead of sliding to the previous one", () => {
    expect(tehranWallClockToIso("2026-11-11", "00:00")).toBe("2026-11-10T20:30:00.000Z");
    expect(isoToTehranWallClock("2026-11-10T20:30:00.000Z")).toEqual({ date: "2026-11-11", time: "00:00" });
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    expect(tehranWallClockToIso("2026-02-31", "09:00")).toBeNull();
    expect(tehranWallClockToIso("2026-13-01", "09:00")).toBeNull();
    expect(tehranWallClockToIso("2026-11-10", "24:00")).toBeNull();
    expect(tehranWallClockToIso("", "09:00")).toBeNull();
    expect(tehranWallClockToIso("2026-11-10", "9:00")).toBeNull();
    expect(isoToTehranWallClock("not-a-date")).toBeNull();
  });
});

describe("WordPress date_gmt", () => {
  it("carries the instant in WordPress's own shape", () => {
    expect(toWordPressGmt("2026-11-10T05:30:00.000Z")).toBe("2026-11-10T05:30:00");
    expect(toWordPressGmt("nonsense")).toBeNull();
  });

  it("reads every shape a mirror may hold back to one instant", () => {
    expect(parseWordPressGmt("2026-11-10T05:30:00")).toBe("2026-11-10T05:30:00.000Z");
    expect(parseWordPressGmt("2026-11-10 05:30:00")).toBe("2026-11-10T05:30:00.000Z");
    expect(parseWordPressGmt("2026-11-10T09:00:00+03:30")).toBe("2026-11-10T05:30:00.000Z");
    expect(parseWordPressGmt("")).toBeNull();
    expect(parseWordPressGmt(null)).toBeNull();
    expect(parseWordPressGmt(42)).toBeNull();
  });
});

describe("isFutureSchedule", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");

  it("accepts only an instant still ahead", () => {
    expect(isFutureSchedule("2026-11-10T00:00:01Z", now)).toBe(true);
    expect(isFutureSchedule("2026-11-10T00:00:00Z", now)).toBe(false);
    expect(isFutureSchedule("2026-11-09T23:59:59Z", now)).toBe(false);
    expect(isFutureSchedule("", now)).toBe(false);
    expect(isFutureSchedule(null, now)).toBe(false);
  });
});
