import { describe, expect, it } from "vitest";
import { giftCardExpiryDate, isGiftCardExpired } from "./gift-card-expiry";

describe("giftCardExpiryDate", () => {
  it("never expires a card when the business has not opted in", () => {
    expect(giftCardExpiryDate("2026-10-02", null)).toBeNull();
  });

  it("adds whole months, keeping the day", () => {
    expect(giftCardExpiryDate("2026-10-02", 12)).toBe("2027-10-02");
    expect(giftCardExpiryDate("2026-10-02", 3)).toBe("2027-01-02");
  });

  it("clamps to the end of a shorter month instead of spilling into the next", () => {
    expect(giftCardExpiryDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(giftCardExpiryDate("2028-01-31", 1)).toBe("2028-02-29");
    expect(giftCardExpiryDate("2026-08-31", 1)).toBe("2026-09-30");
  });

  it("refuses an invalid date or validity rather than storing nonsense", () => {
    expect(() => giftCardExpiryDate("2026-13-01", 1)).toThrow();
    expect(() => giftCardExpiryDate("2026-10-02", 0)).toThrow();
    expect(() => giftCardExpiryDate("2026-10-02", 121)).toThrow();
    expect(() => giftCardExpiryDate("2026-10-02", 1.5)).toThrow();
  });
});

describe("isGiftCardExpired", () => {
  it("keeps a card spendable through its last day and expires it the day after", () => {
    expect(isGiftCardExpired("2026-12-31", "2026-12-31")).toBe(false);
    expect(isGiftCardExpired("2026-12-31", "2027-01-01")).toBe(true);
  });

  it("never expires a card without an expiry date", () => {
    expect(isGiftCardExpired(null, "2099-01-01")).toBe(false);
  });
});
