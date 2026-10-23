import { describe, expect, it } from "vitest";
import {
  findConflicts,
  formatTimeInTimeZone,
  isNoShowOverdue,
  normalizeTimeZone,
  todayIsoInTimeZone,
  windowEndMs,
  windowsOverlap,
  zonedDateTimeToIso,
  zonedDayBoundsIso,
} from "./reservations";

const t = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 3, 2, h, m, 0);
};

describe("reservation windows", () => {
  it("computes the end of a window in ms", () => {
    expect(windowEndMs({ startMs: t("19:00"), durationMinutes: 90 })).toBe(t("20:30"));
  });

  it("treats overlapping intervals as conflicting", () => {
    const a = { startMs: t("19:00"), durationMinutes: 90 }; // 19:00–20:30
    const b = { startMs: t("20:00"), durationMinutes: 60 }; // 20:00–21:00
    expect(windowsOverlap(a, b)).toBe(true);
    expect(windowsOverlap(b, a)).toBe(true);
  });

  it("allows back-to-back turns where one ends as the next starts", () => {
    const first = { startMs: t("19:00"), durationMinutes: 90 }; // → 20:30
    const second = { startMs: t("20:30"), durationMinutes: 90 };
    expect(windowsOverlap(first, second)).toBe(false);
    expect(windowsOverlap(second, first)).toBe(false);
  });

  it("finds all overlapping existing reservations and ignores self by id", () => {
    const existing = [
      { id: "r1", startMs: t("18:00"), durationMinutes: 60 }, // 18:00–19:00 (touches)
      { id: "r2", startMs: t("19:30"), durationMinutes: 60 }, // 19:30–20:30 (overlaps)
      { id: "r3", startMs: t("21:00"), durationMinutes: 60 }, // disjoint
    ];
    const hits = findConflicts({ startMs: t("19:00"), durationMinutes: 90 }, existing);
    expect(hits.map((h) => h.id)).toEqual(["r2"]);

    // Editing r2 in place shouldn't conflict with r2 itself.
    const selfEdit = findConflicts({ id: "r2", startMs: t("19:30"), durationMinutes: 60 }, existing);
    expect(selfEdit).toEqual([]);
  });

  it("flags a booked reservation as overdue once past the grace window", () => {
    const start = t("19:00");
    expect(isNoShowOverdue(start, t("19:10"))).toBe(false);
    expect(isNoShowOverdue(start, t("19:15"))).toBe(true);
    expect(isNoShowOverdue(start, t("19:45"))).toBe(true);
  });
});

describe("branch-aware timezone helpers (Issue #916 Finding 15)", () => {
  it("normalizes invalid or missing timezones to Asia/Tehran", () => {
    expect(normalizeTimeZone(null)).toBe("Asia/Tehran");
    expect(normalizeTimeZone("Invalid/Zone")).toBe("Asia/Tehran");
    expect(normalizeTimeZone("Europe/London")).toBe("Europe/London");
  });

  it("converts wall-clock date/time in Asia/Tehran (+03:30) to UTC and back", () => {
    const iso = zonedDateTimeToIso("2026-06-15", "19:30", "Asia/Tehran");
    expect(iso).toBe("2026-06-15T16:00:00.000Z");
    expect(formatTimeInTimeZone(iso, "Asia/Tehran")).toBe("19:30");
  });

  it("handles DST transitions in Europe/London (GMT +00:00 vs BST +01:00)", () => {
    const winterIso = zonedDateTimeToIso("2026-01-15", "19:30", "Europe/London");
    expect(winterIso).toBe("2026-01-15T19:30:00.000Z");
    expect(formatTimeInTimeZone(winterIso, "Europe/London")).toBe("19:30");

    const summerIso = zonedDateTimeToIso("2026-07-15", "19:30", "Europe/London");
    expect(summerIso).toBe("2026-07-15T18:30:00.000Z");
    expect(formatTimeInTimeZone(summerIso, "Europe/London")).toBe("19:30");
  });

  it("handles DST transitions in America/New_York (EST -05:00 vs EDT -04:00)", () => {
    const winterIso = zonedDateTimeToIso("2026-01-15", "19:30", "America/New_York");
    expect(winterIso).toBe("2026-01-16T00:30:00.000Z");
    expect(formatTimeInTimeZone(winterIso, "America/New_York")).toBe("19:30");

    const summerIso = zonedDateTimeToIso("2026-07-15", "19:30", "America/New_York");
    expect(summerIso).toBe("2026-07-15T23:30:00.000Z");
    expect(formatTimeInTimeZone(summerIso, "America/New_York")).toBe("19:30");
  });

  it("computes full day bounds in the active branch timezone", () => {
    const tehranBounds = zonedDayBoundsIso("2026-06-15", "Asia/Tehran");
    expect(tehranBounds.fromIso).toBe("2026-06-14T20:30:00.000Z");
    expect(tehranBounds.toIso).toBe("2026-06-15T20:29:59.999Z");

    const dubaiBounds = zonedDayBoundsIso("2026-06-15", "Asia/Dubai");
    expect(dubaiBounds.fromIso).toBe("2026-06-14T20:00:00.000Z");
    expect(dubaiBounds.toIso).toBe("2026-06-15T19:59:59.999Z");
  });

  it("resolves today's YYYY-MM-DD in the target branch timezone across midnight boundaries", () => {
    const instant = new Date("2026-06-14T21:00:00.000Z");
    expect(todayIsoInTimeZone("Asia/Tehran", instant)).toBe("2026-06-15");
    expect(todayIsoInTimeZone("America/New_York", instant)).toBe("2026-06-14");
  });
});
