import { describe, expect, it } from "vitest";
import { structuredValueText } from "./structured-health";

describe("structuredValueText (audit F18)", () => {
  it("renders booleans as بله/خیر and missing values as a dash", () => {
    expect(structuredValueText("ok", true)).toBe("بله");
    expect(structuredValueText("ok", false)).toBe("خیر");
    expect(structuredValueText("lastError", null)).toBe("—");
    expect(structuredValueText("lastError", "")).toBe("—");
  });

  it("formats numbers with Persian digits and labels rial amounts", () => {
    expect(structuredValueText("count", 1234)).toMatch(/^[۰-۹]/);
    expect(structuredValueText("revenueRial", 500000)).toMatch(/ریال$/);
  });

  it("formats ISO timestamps as Jalali instead of raw ISO text", () => {
    const text = structuredValueText("lastSuccessAt", "2026-10-12T10:30:00Z");
    expect(text).not.toContain("2026-10-12T");
    expect(text).toMatch(/[۰-۹]/);
  });

  it("passes plain strings through and summarises arrays by count", () => {
    expect(structuredValueText("status", "degraded")).toBe("degraded");
    expect(structuredValueText("items", [1, 2, 3])).toBe("۳ مورد");
  });
});
