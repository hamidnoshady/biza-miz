import { describe, expect, it } from "vitest";
import {
  effectivePushSwitches,
  isNoopPush,
  isSourceOfTruth,
  isStalePushJob,
  STALE_PUSH_JOB_HOURS,
  stockPushPayload,
} from "./outbox-policy";

describe("source of truth (issue #1149, C1)", () => {
  it("accepts only the three values", () => {
    expect(["store", "pos", "two_way"].every(isSourceOfTruth)).toBe(true);
    expect(isSourceOfTruth("both")).toBe(false);
    expect(isSourceOfTruth(null)).toBe(false);
  });

  it("a store-owned connection pushes nothing, whatever the switches say", () => {
    expect(effectivePushSwitches({ source_of_truth: "store", push_stock: true, push_prices: true })).toEqual({
      pushStock: false,
      pushPrices: false,
    });
  });

  it("pos and two_way leave the switches in charge, and a legacy row (no value) behaves as before", () => {
    for (const source_of_truth of ["pos", "two_way", undefined, null]) {
      expect(effectivePushSwitches({ source_of_truth, push_stock: true, push_prices: false })).toEqual({
        pushStock: true,
        pushPrices: false,
      });
    }
  });
});

describe("stockPushPayload (C3)", () => {
  it("sends the bare quantity where the store already tracks stock", () => {
    expect(stockPushPayload({ quantity: 7, remoteManageStock: true, manageStockOptIn: false })).toEqual({ stock_quantity: 7 });
  });

  it("never turns tracking on without the owner's opt-in — quantity 0 included", () => {
    expect(stockPushPayload({ quantity: 0, remoteManageStock: false, manageStockOptIn: false })).toBeNull();
    // A mapping synced before the shape was recorded is "unknown", not "tracked".
    expect(stockPushPayload({ quantity: 0, remoteManageStock: undefined, manageStockOptIn: false })).toBeNull();
  });

  it("with the opt-in it sends manage_stock alongside, because a quantity on an untracked product is ignored", () => {
    expect(stockPushPayload({ quantity: 3, remoteManageStock: false, manageStockOptIn: true })).toEqual({
      stock_quantity: 3,
      manage_stock: true,
    });
  });
});

describe("isNoopPush (C2)", () => {
  const remote = { remoteManageStock: true, remoteStockQuantity: 5, remoteRegularPriceRial: "1000" };

  it("drops a stock push equal to what the store reports", () => {
    expect(isNoopPush("stock", { stock_quantity: 5 }, remote, "toman")).toBe(true);
    expect(isNoopPush("stock", { stock_quantity: 6 }, remote, "toman")).toBe(false);
  });

  it("keeps a push that would switch tracking on, even at the same number", () => {
    expect(isNoopPush("stock", { stock_quantity: 5, manage_stock: true }, { ...remote, remoteManageStock: false }, "toman")).toBe(false);
    expect(isNoopPush("stock", { stock_quantity: 5, manage_stock: true }, remote, "toman")).toBe(true);
  });

  it("compares prices in Rial, in the connection's unit", () => {
    expect(isNoopPush("price", { regular_price: "100" }, remote, "toman")).toBe(true);
    expect(isNoopPush("price", { regular_price: "1000" }, remote, "rial")).toBe(true);
    expect(isNoopPush("price", { regular_price: "101" }, remote, "toman")).toBe(false);
  });

  it("treats an unrecorded or malformed value as unknown, never as equal", () => {
    expect(isNoopPush("stock", { stock_quantity: 5 }, {}, "toman")).toBe(false);
    expect(isNoopPush("stock", { stock_quantity: 5 }, { remoteStockQuantity: null }, "toman")).toBe(false);
    expect(isNoopPush("price", { regular_price: "abc" }, remote, "toman")).toBe(false);
    expect(isNoopPush("price", { regular_price: "100" }, {}, "toman")).toBe(false);
    expect(isNoopPush("product_update", { stock_quantity: 5 }, remote, "toman")).toBe(false);
  });
});

describe("isStalePushJob (C2)", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  it("is stale only past the window", () => {
    const just = new Date(now.getTime() - (STALE_PUSH_JOB_HOURS * 3600 - 60) * 1000).toISOString();
    const old = new Date(now.getTime() - (STALE_PUSH_JOB_HOURS * 3600 + 60) * 1000).toISOString();
    expect(isStalePushJob(just, now)).toBe(false);
    expect(isStalePushJob(old, now)).toBe(true);
    expect(isStalePushJob(null, now)).toBe(false);
    expect(isStalePushJob("not a date", now)).toBe(false);
  });
});
