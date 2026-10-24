import { describe, expect, it } from "vitest";
import { classifyStockLevel, isDeadStock, isReorderTracked, stockNeedsAttentionSql, validateItemQuantity, validateItemUnitCost, validateDeadStockDays, deadStockCutoff } from "./retail-stock";

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

  it("never flags an in-stock item with no reorder point as low", () => {
    expect(classifyStockLevel("3", undefined)).toBe("ok");
    expect(classifyStockLevel("1", "0")).toBe("ok");
  });

  it("shows zero stock as out even when the reorder reminder is off", () => {
    expect(classifyStockLevel("0", null)).toBe("out");
    expect(classifyStockLevel("0", "0")).toBe("out");
    expect(classifyStockLevel("-2", undefined)).toBe("out");
  });
});

describe("isReorderTracked", () => {
  it("is a separate reminder state from availability", () => {
    expect(isReorderTracked(null)).toBe(false);
    expect(isReorderTracked("0")).toBe(false);
    expect(isReorderTracked("4")).toBe(true);
  });
});

describe("stockNeedsAttentionSql", () => {
  it("covers out-of-stock rows regardless of the reorder point", () => {
    expect(stockNeedsAttentionSql("q", "r")).toBe("(q <= 0 OR (r > 0 AND q <= r))");
  });
});

describe("isDeadStock", () => {
  const today = "2026-08-16";

  it("treats never-sold as dead ONLY when stock age is old enough", () => {
    // Newly received never-sold: stock age today -> not dead
    expect(isDeadStock(null, today, 90, today)).toBe(false);
    // Old never-sold: created 91 days ago -> dead
    expect(isDeadStock(null, today, 90, "2026-05-10")).toBe(true);
    // Never-sold without age provenance -> not dead (insufficient data)
    expect(isDeadStock(null, today, 90)).toBe(false);
    expect(isDeadStock(null, today, 90, null)).toBe(false);
  });

  it("is dead past the threshold via last sale", () => {
    expect(isDeadStock("2026-05-01", today, 90)).toBe(true);
  });

  it("accepts stored timestamps and includes exactly the UTC cutoff", () => {
    expect(isDeadStock("2026-05-18 00:00:00+00", today, 90)).toBe(true);
    expect(isDeadStock("2026-05-18T00:00:00.001Z", today, 90)).toBe(false);
    expect(isDeadStock("2026-05-17T23:59:59Z", today, 90)).toBe(true);
    expect(isDeadStock("bad-timestamp", today, 90)).toBe(false);
    expect(isDeadStock(null, today, Number.MAX_VALUE, "2000-01-01")).toBe(false);
  });

  it("is alive within the threshold", () => {
    expect(isDeadStock("2026-08-01", today, 90)).toBe(false);
  });

  it("is never dead when the window is zero or negative", () => {
    expect(isDeadStock(null, today, 0, "2026-01-01")).toBe(false);
    expect(isDeadStock(null, today, -1, "2026-01-01")).toBe(false);
    expect(isDeadStock("2026-01-01", today, 0)).toBe(false);
  });

  it("handles 89/90/91 day boundaries with stock age", () => {
    // Created 89 days ago: not dead at 90
    expect(isDeadStock(null, today, 90, "2026-05-19")).toBe(false);
    // Created 90 days ago: exactly dead
    expect(isDeadStock(null, today, 90, "2026-05-18")).toBe(true);
    // Created 91 days ago: dead
    expect(isDeadStock(null, today, 90, "2026-05-17")).toBe(true);
  });
});

describe("validateDeadStockDays", () => {
  it("defaults to 90 when absent", () => {
    expect(validateDeadStockDays(null).days).toBe(90);
    expect(validateDeadStockDays(undefined).days).toBe(90);
    expect(validateDeadStockDays("").days).toBe(90);
  });
  it("accepts valid integers", () => {
    expect(validateDeadStockDays("30").days).toBe(30);
    expect(validateDeadStockDays(90).days).toBe(90);
    expect(validateDeadStockDays("3650").days).toBe(3650);
  });
  it("rejects non-finite/invalid", () => {
    expect(validateDeadStockDays("abc").error).toBe("invalid_days");
    expect(validateDeadStockDays("NaN").error).toBe("invalid_days");
    expect(validateDeadStockDays("Infinity").error).toBe("invalid_days");
    expect(validateDeadStockDays("90.5").error).toBe("invalid_days");
  });
  it("rejects out of range", () => {
    expect(validateDeadStockDays("0").error).toBe("days_out_of_range");
    expect(validateDeadStockDays("-1").error).toBe("days_out_of_range");
    expect(validateDeadStockDays("4000").error).toBe("days_out_of_range");
  });
});

describe("deadStockCutoff", () => {
  it("computes UTC cutoff", () => {
    expect(deadStockCutoff("2026-08-16", 90)).toBe("2026-05-18T00:00:00.000Z");
  });
  it("returns null for invalid days", () => {
    expect(deadStockCutoff("2026-08-16", 0)).toBeNull();
    expect(deadStockCutoff("2026-08-16", -5)).toBeNull();
    expect(deadStockCutoff("2026-08-16", NaN)).toBeNull();
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
