import { describe, expect, it } from "vitest";
import { assertOrderControl, discountPercentForControl, normalizeOrderControlPolicy, normalizeVoidReason, type OrderControlPolicy } from "./order-controls";

const policy: OrderControlPolicy = {
  cashierDiscountLimitPercent: 10,
  wholeOrderVoidRequiresManager: true,
  postKitchenChangeRequiresManager: true,
};

describe("order controls", () => {
  it("requires a meaningful reason for order and item voids", () => {
    expect(() => normalizeVoidReason(" \t ")).toThrowError("void_reason_required");
    expect(normalizeVoidReason("  اشتباه ثبت شد  ")).toBe("اشتباه ثبت شد");
    expect(() => normalizeVoidReason("x".repeat(501))).toThrowError("void_reason_too_long");
  });

  it("enforces cashier discount thresholds", () => {
    expect(() =>
      assertOrderControl({
        policy,
        actorRole: "cashier",
        action: "discount",
        discountPercent: 11,
        kitchenStarted: false,
      }),
    ).toThrowError("manager_approval_required");

    expect(() =>
      assertOrderControl({
        policy,
        actorRole: "cashier",
        action: "discount",
        discountPercent: 10,
        kitchenStarted: false,
      }),
    ).not.toThrow();
  });

  it("counts sent-to-kitchen item changes and recognizes an administrator as managerial", () => {
    for (const action of ["add_items", "item_quantity", "item_change", "item_void"] as const) {
      expect(() => assertOrderControl({
        policy,
        actorRole: "cashier",
        action,
        kitchenStarted: true,
      })).toThrowError("manager_approval_required");
    }
    expect(() => assertOrderControl({
      policy,
      actorRole: "admin",
      action: "order_void",
      kitchenStarted: true,
    })).not.toThrow();
  });

  it("converts percent and amount discounts to the configured threshold", () => {
    expect(discountPercentForControl({ type: "percent", value: 10, subtotal: "1000" })).toBe(10);
    expect(discountPercentForControl({ type: "amount", value: 100, subtotal: "1000" })).toBe(10);
    expect(discountPercentForControl({ type: "amount", value: 200, subtotal: "1000" })).toBe(20);
    expect(discountPercentForControl({ type: "amount", value: 100, subtotal: "0" })).toBe(0);
  });

  it("validates configurable policy values instead of silently coercing malformed settings", () => {
    expect(normalizeOrderControlPolicy(policy)).toEqual(policy);
    expect(normalizeOrderControlPolicy({ ...policy, cashierDiscountLimitPercent: 101 })).toBeNull();
    expect(normalizeOrderControlPolicy({ ...policy, wholeOrderVoidRequiresManager: "yes" })).toBeNull();
    expect(normalizeOrderControlPolicy(null)).toBeNull();
  });

  it("requires manager authority for whole-order void and post-kitchen changes", () => {
    for (const action of ["order_void", "item_quantity", "item_void"] as const) {
      expect(() =>
        assertOrderControl({
          policy,
          actorRole: "cashier",
          action,
          kitchenStarted: action !== "order_void",
        }),
      ).toThrowError("manager_approval_required");
      expect(() =>
        assertOrderControl({
          policy,
          actorRole: "manager",
          action,
          kitchenStarted: true,
        }),
      ).not.toThrow();
    }
  });
});