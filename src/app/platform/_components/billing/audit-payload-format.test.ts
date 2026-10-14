import { describe, expect, it } from "vitest";
import { formatPayloadValue, payloadValueKind, summarizePayload } from "./audit-payload-format";

describe("billing audit payload formatting (audit F21)", () => {
  it("never treats a large quantity as money", () => {
    // The audit's example: a 5,000-order limit must not read as 500 Toman.
    expect(payloadValueKind("orderLimit", 5000)).toBe("quantity");
    expect(formatPayloadValue("orderLimit", 5000)).not.toMatch(/تومان/);
    expect(formatPayloadValue("orderLimit", 5000)).toMatch(/۵٬۰۰۰/);
  });

  it("formats keys named as Rial amounts as Toman", () => {
    expect(payloadValueKind("amountRial", 5_000_000)).toBe("money");
    expect(formatPayloadValue("amountRial", 5_000_000)).toMatch(/تومان$/);
  });

  it("leaves an unknown integer as a plain value rather than guessing its unit", () => {
    expect(payloadValueKind("widgets", 12000)).toBe("unknown");
    expect(formatPayloadValue("widgets", 12000)).not.toMatch(/تومان/);
  });

  it("shows percent and basis-point values with a percent sign", () => {
    expect(formatPayloadValue("taxPercent", 9)).toBe("۹٪");
    expect(formatPayloadValue("taxBps", 900)).toBe("۹٪");
  });

  it("renders ISO timestamps as Jalali and booleans as words", () => {
    expect(payloadValueKind("expiresAt", "2026-10-13T00:00:00.000Z")).toBe("time");
    expect(formatPayloadValue("expiresAt", "2026-10-13T00:00:00.000Z")).toMatch(/[۰-۹]{4}/);
    expect(formatPayloadValue("active", true)).toBe("بله");
    expect(formatPayloadValue("active", false)).toBe("خیر");
  });

  it("summarises before/after diffs field by field with the right unit per key", () => {
    const summary = summarizePayload({
      before: { orderLimit: 1000, amountRial: 10_000_000 },
      after: { orderLimit: 5000, amountRial: 20_000_000 },
    });
    expect(summary).toContain("پیش:");
    expect(summary).toContain("پس:");
    expect(summary).toMatch(/سفارش: ۵٬۰۰۰/);
    expect(summary).toMatch(/مبلغ: .*تومان/);
    expect(summary).not.toMatch(/سقف سفارش: [^،•]*تومان/);
  });

  it("returns null for an empty or non-object payload", () => {
    expect(summarizePayload(null)).toBeNull();
    expect(summarizePayload({ unrelated: 1 })).toBeNull();
  });
});
