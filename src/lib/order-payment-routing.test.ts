import { describe, expect, it } from "vitest";
import { paymentSourceKindForSettlement } from "./order-payment-routing";

describe("financial accounts for checkout", () => {
  it("keeps terminal clearing separate from direct bank receipts", () => {
    expect(paymentSourceKindForSettlement("card")).toBe("pos_psp");
    expect(paymentSourceKindForSettlement("online")).toBe("pos_psp");
    expect(paymentSourceKindForSettlement("card_to_card")).toBe("bank");
    expect(paymentSourceKindForSettlement("cash")).toBe("cash");
  });

  it("leaves receivables and cheques to their existing ledger controls", () => {
    expect(paymentSourceKindForSettlement("credit")).toBeNull();
    expect(paymentSourceKindForSettlement("cheque")).toBeNull();
    expect(paymentSourceKindForSettlement("snappfood")).toBeNull();
  });
});
