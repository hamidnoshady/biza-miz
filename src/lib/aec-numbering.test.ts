/**
 * Wave 11 cleanup — the register numbering rule, in one place.
 *
 * `formatAecNumber` and `nextNumberInSeries` were extracted from three copies
 * of the same `String(n).padStart(3, "0")` (`aec-numbering.ts` itself, the site
 * register's `nextIssueNumber`, and Wave 10's field-board RFI suggestion). The
 * tests below are the rule those copies shared, plus the two edges a copy had
 * already got wrong in one place or another: a hand-typed number that does not
 * follow the shape, and a series that has reached four digits.
 */
import { describe, expect, it } from "vitest";
import { formatAecNumber, nextNumberInSeries } from "./aec-numbering";

describe("AEC register numbering", () => {
  it("pads to three digits and keeps growing past them", () => {
    expect(formatAecNumber("RFQ", 1)).toBe("RFQ-001");
    expect(formatAecNumber("RFQ", 42)).toBe("RFQ-042");
    expect(formatAecNumber("SNG", 999)).toBe("SNG-999");
    // Four digits is not an error: the register keeps counting.
    expect(formatAecNumber("VO", 1000)).toBe("VO-1000");
    // Defensive: a negative or fractional value is clamped, never printed.
    expect(formatAecNumber("MR", -3)).toBe("MR-000");
    expect(formatAecNumber("MR", 2.7)).toBe("MR-002");
  });

  it("suggests the next number in the series it is given", () => {
    expect(nextNumberInSeries("RFI", [])).toBe("RFI-001");
    expect(nextNumberInSeries("RFI", ["RFI-001", "RFI-002"])).toBe("RFI-003");
    // Order does not matter: the highest number wins.
    expect(nextNumberInSeries("RFI", ["RFI-007", "RFI-003"])).toBe("RFI-008");
    expect(nextNumberInSeries("RFI", ["RFI-999"])).toBe("RFI-1000");
  });

  it("ignores numbers that do not follow the shape, and other prefixes", () => {
    // Hand-typed rows must never break the arithmetic (the server column is a
    // free text number per §10) and another register's numbers are not ours.
    expect(nextNumberInSeries("RFI", ["RFI-002", "پرسش ۵", "RFI-", "RFI-00x", "SNG-009"])).toBe("RFI-003");
    // Whitespace is tolerated; a prefix match is exact, not a substring.
    expect(nextNumberInSeries("RFI", ["  RFI-004  "])).toBe("RFI-005");
    expect(nextNumberInSeries("S", ["S-004"])).toBe("S-005");
  });

  it("treats a prefix as a literal, never as a pattern", () => {
    // The suggestion runs on stored strings; a prefix with regex characters
    // must not become a wildcard.
    expect(nextNumberInSeries("A+B", ["A-005"])).toBe("A+B-001");
    expect(nextNumberInSeries("A+B", ["A+B-002"])).toBe("A+B-003");
  });
});
