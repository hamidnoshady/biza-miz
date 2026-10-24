import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_TIME_ZONE,
  formatBranchTimestamp,
  formatBusinessDate,
  formatDocumentDate,
  timeZoneLabel,
} from "./business-date-display";

/**
 * The register's date display has one real hazard: a date-only value rendered
 * through a zone behind UTC shifts to the previous day. These tests pin the
 * two behaviours (date = calendar day, timestamp = branch instant) so a future
 * "simplify to formatJalali everywhere" refactor fails here instead of on a
 * branch manager's printout.
 */
describe("formatBusinessDate", () => {
  it("keeps the calendar day whatever the runtime's zone is", () => {
    // 2026-03-21 is 1405-01-01 (Nowruz). A UTC-pinned format cannot move it.
    expect(formatBusinessDate("2026-03-21")).toBe("۱۴۰۵/۰۱/۰۱");
  });

  it("accepts a timestamp-shaped value by taking its date part", () => {
    expect(formatBusinessDate("2026-03-21T23:30:00Z")).toBe("۱۴۰۵/۰۱/۰۱");
  });

  it("renders a missing or malformed date as an em dash, not Invalid Date", () => {
    expect(formatBusinessDate(null)).toBe("—");
    expect(formatBusinessDate("")).toBe("—");
    expect(formatBusinessDate("not-a-date")).toBe("—");
  });

  it("can name the month for the printable sheet", () => {
    expect(formatBusinessDate("2026-03-21", { withMonthName: true })).toContain("فروردین");
  });
});

describe("formatBranchTimestamp", () => {
  it("shows the clock in the branch's own zone", () => {
    // 20:00 UTC is 23:30 in Tehran and 00:00 the next day in Dubai.
    expect(formatBranchTimestamp("2026-03-21T20:00:00Z", "Asia/Tehran", { withTime: true })).toBe(
      "۱۴۰۵/۰۱/۰۱ ۲۳:۳۰",
    );
    expect(formatBranchTimestamp("2026-03-21T20:00:00Z", "Asia/Dubai", { withTime: true })).toBe(
      "۱۴۰۵/۰۱/۰۲ ۰۰:۰۰",
    );
  });

  it("defaults to the platform zone when a row carries none", () => {
    expect(DEFAULT_DISPLAY_TIME_ZONE).toBe("Asia/Tehran");
    expect(formatBranchTimestamp("2026-03-21T20:00:00Z", null, { withTime: true })).toBe(
      "۱۴۰۵/۰۱/۰۱ ۲۳:۳۰",
    );
  });

  it("never prints Invalid Date", () => {
    expect(formatBranchTimestamp(null, "Asia/Tehran")).toBe("—");
    expect(formatBranchTimestamp("garbage", "Asia/Tehran")).toBe("—");
  });
});

describe("formatDocumentDate", () => {
  it("prefers the stored business date", () => {
    expect(formatDocumentDate("2026-03-21", "2026-03-22T01:00:00Z", "Asia/Dubai")).toBe("۱۴۰۵/۰۱/۰۱");
  });

  it("falls back to the posting instant in the branch's zone for legacy rows", () => {
    expect(formatDocumentDate(null, "2026-03-21T20:30:00Z", "Asia/Dubai")).toBe("۱۴۰۵/۰۱/۰۲");
    // 20:00 UTC is still 23:30 on the 21st in Tehran — the day does not move.
    expect(formatDocumentDate(null, "2026-03-21T20:00:00Z", "Asia/Tehran")).toBe("۱۴۰۵/۰۱/۰۱");
  });
});

describe("timeZoneLabel", () => {
  it("only names a zone when it differs from the platform default", () => {
    expect(timeZoneLabel("Asia/Tehran")).toBeNull();
    expect(timeZoneLabel(null)).toBeNull();
    expect(timeZoneLabel("Asia/Dubai")).toBe("Asia/Dubai");
  });
});
