import { describe, expect, it } from "vitest";
import { canTransitionTable, evenSplit, isValidTableStatus } from "./table-sessions";

describe("canTransitionTable", () => {
  it("allows identity transitions", () => {
    expect(canTransitionTable("free", "free")).toBe(true);
    expect(canTransitionTable("seated", "seated")).toBe(true);
    expect(canTransitionTable("cleaning", "cleaning")).toBe(true);
  });

  it("permits the standard dining cycle and direct manual status transitions", () => {
    expect(canTransitionTable("free", "seated")).toBe(true);
    expect(canTransitionTable("seated", "bill_requested")).toBe(true);
    expect(canTransitionTable("bill_requested", "cleaning")).toBe(true);
    expect(canTransitionTable("cleaning", "free")).toBe(true);
    expect(canTransitionTable("seated", "free")).toBe(true);
  });

  it("permits real-world cleaning and out-of-service transitions from any operational state", () => {
    expect(canTransitionTable("free", "cleaning")).toBe(true);
    expect(canTransitionTable("free", "out_of_service")).toBe(true);
    expect(canTransitionTable("seated", "cleaning")).toBe(true);
    expect(canTransitionTable("seated", "out_of_service")).toBe(true);
    expect(canTransitionTable("cleaning", "out_of_service")).toBe(true);
    expect(canTransitionTable("out_of_service", "cleaning")).toBe(true);
    expect(canTransitionTable("out_of_service", "free")).toBe(true);
    expect(canTransitionTable("reserved", "seated")).toBe(true);
    expect(canTransitionTable("reserved", "free")).toBe(true);
    expect(canTransitionTable("reserved", "cleaning")).toBe(true);
  });

  it("rejects unknown status strings", () => {
    expect(isValidTableStatus("free")).toBe(true);
    expect(isValidTableStatus("reserved")).toBe(true);
    expect(isValidTableStatus("invalid_status")).toBe(false);
    expect(canTransitionTable("free", "unknown" as never)).toBe(false);
  });
});

describe("evenSplit", () => {
  it("splits divisible totals evenly", () => {
    expect(evenSplit(300_000, 3)).toEqual([100_000, 100_000, 100_000]);
  });

  it("distributes the remainder Rials across the earliest shares so the sum matches", () => {
    const shares = evenSplit(100_000, 3);
    expect(shares).toEqual([33_334, 33_333, 33_333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100_000);
  });

  it("clamps parts to at least 1 and totals to at least 0", () => {
    expect(evenSplit(50_000, 0)).toEqual([50_000]);
    expect(evenSplit(-100, 2)).toEqual([0, 0]);
  });
});
