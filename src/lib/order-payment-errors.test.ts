import { describe, expect, it } from "vitest";
import { paymentFailureFor } from "./order-payment-errors";

/** node-postgres shape: a check violation carries code 23514 and the constraint name. */
function pgCheckViolation(constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error("new row violates check constraint"), {
    code: "23514",
    constraint,
  });
}

describe("paymentFailureFor", () => {
  it("names a locked fiscal period rather than letting it 500", () => {
    expect(paymentFailureFor(new Error("fiscal_period_locked"))).toEqual({
      error: "fiscal_period_locked",
      status: 409,
    });
  });

  it("names a soft-closed period the cashier may not post into", () => {
    expect(paymentFailureFor(new Error("fiscal_period_soft_closed"))).toEqual({
      error: "fiscal_period_soft_closed",
      status: 409,
    });
  });

  it("names an uncovered date after fiscal controls are adopted", () => {
    expect(paymentFailureFor(new Error("fiscal_period_not_defined"))).toEqual({
      error: "fiscal_period_not_defined",
      status: 409,
    });
  });

  it("names an ingredient requirement driven negative by an addon", () => {
    expect(paymentFailureFor(new Error("negative_ingredient_requirement"))).toEqual({
      error: "negative_ingredient_requirement",
      status: 409,
    });
  });

  it("reports a negative-layer costing violation as a costing conflict", () => {
    expect(paymentFailureFor(pgCheckViolation("negative_layer_exact_value_bounds"))).toEqual({
      error: "inventory_costing_conflict",
      status: 409,
    });
  });

  it("reports the lot-value twin the same way", () => {
    expect(paymentFailureFor(pgCheckViolation("inventory_lot_exact_value_bounds"))).toEqual({
      error: "inventory_costing_conflict",
      status: 409,
    });
  });

  it("leaves an unrelated check violation alone", () => {
    expect(paymentFailureFor(pgCheckViolation("orders_total_check"))).toBeNull();
  });

  it("leaves a violation of another error class alone even with a known name", () => {
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "negative_layer_exact_value_bounds",
    });
    expect(paymentFailureFor(uniqueViolation)).toBeNull();
  });

  it("keeps a genuinely unexpected error a 500 so the next bug is still visible", () => {
    expect(paymentFailureFor(new Error("connection terminated"))).toBeNull();
    expect(paymentFailureFor("not even an error")).toBeNull();
    expect(paymentFailureFor(null)).toBeNull();
  });
});
