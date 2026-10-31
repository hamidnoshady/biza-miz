import { describe, expect, it } from "vitest";
import { refundRestockIntent } from "./woo-refund-policy";

describe("Woo refund restock evidence", () => {
  it("keeps a financial refund separate from a stock return", () => {
    expect(refundRestockIntent({ restock_items: false })).toBe(false);
    expect(refundRestockIntent({ restock_items: true })).toBe(true);
  });
  it("reads the persisted marker through REST and never guesses for old refunds", () => {
    expect(refundRestockIntent({ meta_data: [{ key: "_bizamiz_restock_items", value: "yes" }] })).toBe(true);
    expect(refundRestockIntent({ meta_data: [{ key: "_bizamiz_restock_items", value: "no" }] })).toBe(false);
    expect(refundRestockIntent({})).toBeNull();
    expect(refundRestockIntent({ meta_data: [{ key: "_bizamiz_restock_items", value: "unknown" }] })).toBeNull();
  });
});
