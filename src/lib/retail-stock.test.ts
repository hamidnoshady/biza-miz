import { describe, expect, it } from "vitest";
import { classifyStockLevel, isDeadStock, validateItemQuantity, validateItemUnitCost } from "./retail-stock";

describe("classifyStockLevel", () => {
  it("is ok above the reorder point", () => {
    expect(classifyStockLevel("10", "5")).toBe("ok");
  });

  it("is low at or below the reorder point", () => {
    expect(classifyStockLevel("5", "5")).toBe("low");
    expect(classifyStockLevel("1", "5")).toBe("low");
  });

  it("is out at zero", () => {
    expect(classifyStockLevel("0", "5")).toBe("out");
  });

  it("never flags an item with no reorder point", () => {
    expect(classifyStockLevel("0", null)).toBe("ok");
    expect(classifyStockLevel("0", "0")).toBe("ok");
    expect(classifyStockLevel("3", undefined)).toBe("ok");
  });
});

describe("isDeadStock", () => {
  const today = "2026-08-16";

  it("treats never-sold as dead", () => {
    expect(isDeadStock(null, today, 90)).toBe(true);
  });

  it("is dead past the threshold", () => {
    expect(isDeadStock("2026-05-01", today, 90)).toBe(true);
  });

  it("accepts stored timestamps and includes exactly the UTC cutoff", () => {
    expect(isDeadStock("2026-05-18 00:00:00+00", today, 90)).toBe(true);
    expect(isDeadStock("2026-05-18T00:00:00.001Z", today, 90)).toBe(false);
    expect(isDeadStock("2026-05-17T23:59:59Z", today, 90)).toBe(true);
    expect(isDeadStock("bad-timestamp", today, 90)).toBe(false);
    expect(isDeadStock(null, today, Number.MAX_VALUE)).toBe(false);
  });

  it("is alive within the threshold", () => {
    expect(isDeadStock("2026-08-01", today, 90)).toBe(false);
  });

  it("is never dead when the window is zero or negative", () => {
    expect(isDeadStock(null, today, 0)).toBe(false);
    expect(isDeadStock(null, today, -1)).toBe(false);
  });
});

describe("validators", () => {
  it("accepts positive quantities and rejects the rest", () => {
    expect(validateItemQuantity("2.5")).toBeNull();
    expect(validateItemQuantity(1)).toBeNull();
    expect(validateItemQuantity("0")).not.toBeNull();
    expect(validateItemQuantity("-1")).not.toBeNull();
    expect(validateItemQuantity("x")).not.toBeNull();
  });

  it("accepts whole non-negative Rial costs only", () => {
    expect(validateItemUnitCost(1000)).toBeNull();
    expect(validateItemUnitCost(0)).toBeNull();
    expect(validateItemUnitCost(-1)).not.toBeNull();
    expect(validateItemUnitCost(1.5)).not.toBeNull();
  });
});
