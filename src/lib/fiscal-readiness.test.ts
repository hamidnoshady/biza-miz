import { describe, expect, it } from "vitest";
import {
  evaluateFiscalReadiness,
  fiscalReadinessNotice,
  jalaliYearOf,
  yearBlockedByUncoveredEntries,
  type FiscalCoverageFacts,
} from "./fiscal-readiness";

const YEAR_1405 = { label: "1405", startsOn: "2026-03-21", endsOn: "2027-03-20", closedAt: null };
const YEAR_1404 = { label: "1404", startsOn: "2025-03-21", endsOn: "2026-03-20", closedAt: null };
const NONE = { count: 0, earliest: null, latest: null };

function facts(overrides: Partial<FiscalCoverageFacts> = {}): FiscalCoverageFacts {
  return { fiscalYears: [YEAR_1405], today: "2026-10-07", todayCovered: true, uncovered: NONE, ...overrides };
}

describe("evaluateFiscalReadiness", () => {
  it("is ready when a year covers today and every entry", () => {
    const r = evaluateFiscalReadiness(facts());
    expect(r.ready).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.canClose).toBe(true);
    expect(r.closableYearLabels).toEqual(["1405"]);
    expect(fiscalReadinessNotice(r)).toBeNull();
  });

  it("reports no fiscal year and every entry as uncovered, and cannot close", () => {
    const r = evaluateFiscalReadiness(
      facts({ fiscalYears: [], todayCovered: true, uncovered: { count: 3, earliest: "2026-01-02", latest: "2026-10-01" } }),
    );
    expect(r.ready).toBe(false);
    expect(r.issues).toEqual(["no_fiscal_year", "uncovered_entries"]);
    // A stray `todayCovered: true` without any year cannot make today covered.
    expect(r.todayCovered).toBe(false);
    expect(r.canClose).toBe(false);
    const notice = fiscalReadinessNotice(r)!;
    expect(notice.lines[0]).toContain("سال مالی ۱۴۰۵");
    expect(notice.lines[1]).toContain("۳ سند");
    expect(notice.lines[1]).toContain("رد یا جابه‌جا نمی‌شوند");
  });

  it("flags today outside every period without blocking an earlier closable year", () => {
    const r = evaluateFiscalReadiness(
      facts({
        fiscalYears: [YEAR_1404],
        todayCovered: false,
        uncovered: { count: 2, earliest: "2026-04-01", latest: "2026-10-07" },
      }),
    );
    expect(r.issues).toEqual(["today_uncovered", "uncovered_entries"]);
    expect(r.closableYearLabels).toEqual(["1404"]);
    expect(r.canClose).toBe(true);
    const notice = fiscalReadinessNotice(r)!;
    expect(notice.lines[0]).toContain("سال مالی ۱۴۰۵");
    expect(notice.lines.join(" ")).not.toContain("2026");
  });

  it("blocks closing a year when uncovered history is dated on or before its end", () => {
    const r = evaluateFiscalReadiness(
      facts({ uncovered: { count: 40, earliest: "2024-05-01", latest: "2025-01-01" } }),
    );
    expect(r.closableYearLabels).toEqual([]);
    expect(r.canClose).toBe(false);
    expect(fiscalReadinessNotice(r)!.lines.at(-1)).toContain("بستن نهایی");
  });

  it("does not offer an already closed year", () => {
    const r = evaluateFiscalReadiness(facts({ fiscalYears: [{ ...YEAR_1405, closedAt: "2027-04-01T00:00:00Z" }] }));
    expect(r.closableYearLabels).toEqual([]);
    expect(r.canClose).toBe(false);
  });

  it("normalises a zero count to no dates", () => {
    const r = evaluateFiscalReadiness(facts({ uncovered: { count: 0, earliest: "2026-01-01", latest: "2026-01-01" } }));
    expect(r.uncovered).toEqual(NONE);
  });
});

describe("yearBlockedByUncoveredEntries", () => {
  it("compares the earliest uncovered date against the year end inclusively", () => {
    expect(yearBlockedByUncoveredEntries("2026-03-20", null)).toBe(false);
    expect(yearBlockedByUncoveredEntries("2026-03-20", "2026-03-20")).toBe(true);
    expect(yearBlockedByUncoveredEntries("2026-03-20", "2026-03-21")).toBe(false);
  });
});

describe("jalaliYearOf", () => {
  it("maps Nowruz boundaries", () => {
    expect(jalaliYearOf("2026-03-20")).toBe(1404);
    expect(jalaliYearOf("2026-03-21")).toBe(1405);
  });
});
