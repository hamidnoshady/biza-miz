import { describe, expect, it } from "vitest";
import {
  calculateRefundCapacity,
  isCustomerReturnRefundMethod,
  normalizeCustomerReturnLines,
  sameNormalizedReturnLines,
  validateCustomerReturnReason,
} from "./customer-return-domain";

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";

const line = (orderItemId: string, quantity: string, disposition = "restockable") => ({
  orderItemId,
  quantity,
  disposition,
});

describe("customer return domain", () => {
  it("aggregates repeated item ids exactly before persistence and canonicalizes UUID case", () => {
    expect(normalizeCustomerReturnLines([
      line(ITEM_A.toUpperCase(), "1"),
    ])).toEqual([{ orderItemId: ITEM_A, quantity: "1", disposition: "restockable" }]);
    expect(normalizeCustomerReturnLines([
      line(ITEM_B, "0.125"),
      line(ITEM_A, "1.2"),
      line(ITEM_A, "0.3"),
    ])).toEqual([
      { orderItemId: ITEM_A, quantity: "1.5", disposition: "restockable" },
      { orderItemId: ITEM_B, quantity: "0.125", disposition: "restockable" },
    ]);
  });

  it("rejects contradictory duplicate dispositions and malformed line payloads", () => {
    expect(() => normalizeCustomerReturnLines([
      line(ITEM_A, "1", "restockable"),
      line(ITEM_A, "1", "discarded"),
    ])).toThrowError("duplicate_return_line_conflict");
    expect(() => normalizeCustomerReturnLines(null)).toThrowError("invalid_return_lines");
    expect(() => normalizeCustomerReturnLines([{ ...line(ITEM_A, "1"), priceRial: "100" }])).toThrowError("invalid_return_line");
    expect(() => normalizeCustomerReturnLines([line("not-a-uuid", "1")])).toThrowError("invalid_return_line");
    expect(() => normalizeCustomerReturnLines([line(ITEM_A, "0")])).toThrowError("invalid_return_quantity");
  });

  it("compares idempotent line payloads after normalization", () => {
    const original = normalizeCustomerReturnLines([line(ITEM_A, "1"), line(ITEM_A, "2")]);
    const retry = normalizeCustomerReturnLines([line(ITEM_A, "3")]);
    const changed = normalizeCustomerReturnLines([line(ITEM_A, "2.9")]);
    expect(sameNormalizedReturnLines(original, retry)).toBe(true);
    expect(sameNormalizedReturnLines(original, changed)).toBe(false);
  });

  it("requires a trimmed reason and caps its length", () => {
    expect(validateCustomerReturnReason("  ایراد سفارش  ")).toBe("ایراد سفارش");
    expect(() => validateCustomerReturnReason("  ")).toThrowError("return_reason_required");
    expect(() => validateCustomerReturnReason("x".repeat(501))).toThrowError("return_reason_too_long");
  });

  it("refuses A/R credit refunds while retaining supported cash and bank methods", () => {
    expect(isCustomerReturnRefundMethod("cash")).toBe(true);
    expect(isCustomerReturnRefundMethod("card_to_card")).toBe(true);
    expect(isCustomerReturnRefundMethod("online")).toBe(true);
    expect(isCustomerReturnRefundMethod("credit")).toBe(false);
    expect(isCustomerReturnRefundMethod("snappfood")).toBe(false);
  });

  it("uses the lower exact-Rial sale/tender ceiling, excluding credit and tips", () => {
    // 20,000 Rial face value, 2,000 previously returned, and 16,000 of
    // active non-credit tender after prior negative refund rows. A/R credit
    // and tip are intentionally absent from these inputs.
    expect(calculateRefundCapacity({
      orderTotalRial: "20000",
      previouslyRefundedRial: "2000",
      netNonCreditTenderRial: "16000",
    })).toEqual({
      saleRemainingRial: "18000",
      tenderRemainingRial: "16000",
      remainingRefundRial: "16000",
    });
  });

  it("caps overpayments at sale consideration and prevents repeated over-refunds", () => {
    expect(calculateRefundCapacity({
      orderTotalRial: "10000",
      previouslyRefundedRial: "2500",
      netNonCreditTenderRial: "12500",
    })).toEqual({
      saleRemainingRial: "7500",
      tenderRemainingRial: "12500",
      remainingRefundRial: "7500",
    });
  });

  it("keeps credit, tips, and mixed tenders out of the wrong refund ceiling", () => {
    // A 1,000-Rial bill settled with 200 cash, 300 card, and 500 credit can
    // refund only the 500 Rial actually collected through non-credit tenders.
    expect(calculateRefundCapacity({
      orderTotalRial: "1000",
      previouslyRefundedRial: "0",
      netNonCreditTenderRial: "500",
    }).remainingRefundRial).toBe("500");

    // A mixed cash/card tender may be refunded up to its active 700 Rial after
    // a prior 200 Rial refund; the order's remaining sale value is the same.
    expect(calculateRefundCapacity({
      orderTotalRial: "1000",
      previouslyRefundedRial: "200",
      netNonCreditTenderRial: "700",
    }).remainingRefundRial).toBe("700");

    // The stored order total is the bill without its 250-Rial tip. Even though
    // the tender includes the bill in full, the tip never enlarges the refund.
    expect(calculateRefundCapacity({
      orderTotalRial: "1000",
      previouslyRefundedRial: "0",
      netNonCreditTenderRial: "1000",
    }).remainingRefundRial).toBe("1000");
  });

  it("handles repeated refunds and negative/legacy over-refund rows without floating point", () => {
    expect(calculateRefundCapacity({
      orderTotalRial: "1000",
      previouslyRefundedRial: "750",
      netNonCreditTenderRial: "250",
    }).remainingRefundRial).toBe("250");
    expect(calculateRefundCapacity({
      orderTotalRial: "100000000000000000",
      previouslyRefundedRial: "90000000000000000",
      netNonCreditTenderRial: "5000000000000000",
    }).remainingRefundRial).toBe("5000000000000000");
    expect(calculateRefundCapacity({
      orderTotalRial: "10000",
      previouslyRefundedRial: "12000",
      netNonCreditTenderRial: "-2000",
    })).toEqual({
      saleRemainingRial: "0",
      tenderRemainingRial: "0",
      remainingRefundRial: "0",
    });
  });
});
