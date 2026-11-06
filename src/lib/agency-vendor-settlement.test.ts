import { describe, expect, it } from "vitest";
import { isCostSettled, isVendorSettlementMethod, vendorSettlementAccounts } from "./agency-reimbursable-cost";

describe("vendor settlement vocabulary", () => {
  it("takes the liability out of 2140 rather than recording another expense", () => {
    expect(vendorSettlementAccounts("cash")).toEqual({ debitCode: "2140", creditCode: "1100" });
    expect(vendorSettlementAccounts("bank")).toEqual({ debitCode: "2140", creditCode: "1120" });
  });
  it("cannot pay a payable with another payable", () => {
    expect(isVendorSettlementMethod("payable")).toBe(false);
    expect(isVendorSettlementMethod(null)).toBe(false);
    expect(isVendorSettlementMethod("bank")).toBe(true);
  });
  it("derives the paid state and only a known reversal frees a paid row", () => {
    expect(isCostSettled({ settlementId: null })).toBe(false);
    expect(isCostSettled({ settlementId: "payment", reversedAt: null })).toBe(true);
    expect(isCostSettled({ settlementId: "payment" })).toBe(true);
    expect(isCostSettled({ settlementId: "payment", reversedAt: "" })).toBe(true);
    expect(isCostSettled({ settlementId: "payment", reversedAt: "2026-11-05T10:00:00Z" })).toBe(false);
  });
});
