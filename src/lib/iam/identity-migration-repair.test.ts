import { describe, expect, it } from "vitest";
import { maskPhoneForReport } from "./identity-migration-repair";

describe("maskPhoneForReport", () => {
  it("masks the middle digits of Iranian mobile and landline numbers without exposing full PII", () => {
    const masked = maskPhoneForReport("+989121234567");
    expect(masked).toBe("+9891***567");
    expect(masked).not.toContain("21234");
  });

  it("handles empty or short inputs safely", () => {
    expect(maskPhoneForReport(null)).toBe("<empty>");
    expect(maskPhoneForReport(undefined)).toBe("<empty>");
    expect(maskPhoneForReport("")).toBe("<empty>");
    expect(maskPhoneForReport("12345")).toBe("***");
  });
});
