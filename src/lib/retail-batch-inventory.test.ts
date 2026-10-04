/**
 * Issue #770 — the pure rules of the canonical batch inventory engine:
 * FEFO allocation with expired-stock exclusion, exact cost valuation, and
 * restoration planning (what a return puts back, and where).
 */
import { describe, expect, it } from "vitest";
import {
  allocateBatchLots,
  allocationBatchNumbers,
  allocationCostValue,
  allocationExpiryDate,
  isBatchDisposition,
  isRestockDisposition,
  planBatchRestoration,
  RetailBatchError,
  type BatchLot,
  type RestorableAllocation,
} from "./retail-batch-inventory";

const TODAY = "2026-10-04";

function lot(id: string, expiryDate: string | null, quantity: string, unitCost: number | null): BatchLot {
  return { id, batchNumber: id.toUpperCase(), expiryDate, quantity, unitCost };
}

const restorable = (
  id: string,
  expiryDate: string | null,
  quantity: string,
  unitCost: number | null,
  restored = "0",
  disposed = "0",
): RestorableAllocation => ({
  id,
  batchId: `batch-${id}`,
  batchNumber: id.toUpperCase(),
  expiryDate,
  quantity,
  unitCost,
  restoredQuantity: restored,
  disposedQuantity: disposed,
});

describe("allocateBatchLots", () => {
  it("takes the earliest-expiring lot first and values each slice at its own cost", () => {
    const allocations = allocateBatchLots(
      [lot("late", "2031-01-01", "10", 20_000), lot("early", "2030-01-01", "3", 10_000)],
      "5",
      TODAY,
    );
    expect(allocations.map((a) => [a.batchNumber, a.quantity, a.costValue])).toEqual([
      ["EARLY", "3", "30000"],
      ["LATE", "2", "40000"],
    ]);
    expect(allocationCostValue(allocations)).toBe("70000");
    expect(allocationBatchNumbers(allocations)).toEqual(["EARLY", "LATE"]);
    expect(allocationExpiryDate(allocations)).toBe("2030-01-01");
  });

  it("consumes undated lots only after every dated one", () => {
    const allocations = allocateBatchLots(
      [lot("undated", null, "5", 10_000), lot("dated", "2035-01-01", "1", 10_000)],
      "2",
      TODAY,
    );
    expect(allocations.map((a) => a.batchNumber)).toEqual(["DATED", "UNDATED"]);
  });

  it("excludes expired lots entirely", () => {
    const allocations = allocateBatchLots(
      [lot("expired", "2020-01-01", "100", 10_000), lot("fresh", "2035-01-01", "2", 10_000)],
      "2",
      TODAY,
    );
    expect(allocations.map((a) => a.batchNumber)).toEqual(["FRESH"]);
  });

  it("treats the expiry date itself as still sellable", () => {
    const allocations = allocateBatchLots([lot("today", TODAY, "1", 10_000)], "1", TODAY);
    expect(allocations).toHaveLength(1);
  });

  it("refuses when only expired stock is left, with the expiry-specific message", () => {
    expect(() => allocateBatchLots([lot("expired", "2020-01-01", "5", 10_000)], "1", TODAY)).toThrow(
      /بخشی از این کالا منقضی شده است/,
    );
  });

  it("refuses a plain shortage with the shortage message", () => {
    expect(() => allocateBatchLots([lot("fresh", "2035-01-01", "1", 10_000)], "2", TODAY)).toThrow(
      "موجودی کافی نیست.",
    );
  });

  it("refuses a non-positive request", () => {
    expect(() => allocateBatchLots([lot("fresh", "2035-01-01", "5", 10_000)], "0", TODAY)).toThrow(
      RetailBatchError,
    );
  });

  it("carries a lot with no cost at zero value rather than failing the sale", () => {
    const allocations = allocateBatchLots([lot("nocost", "2035-01-01", "2", null)], "2", TODAY);
    expect(allocations[0].costValue).toBe("0");
  });
});

describe("planBatchRestoration", () => {
  it("takes from the earliest-expiring open allocation first", () => {
    const takes = planBatchRestoration(
      [restorable("late", "2031-01-01", "5", 20_000), restorable("early", "2030-01-01", "2", 10_000)],
      "3",
    );
    expect(takes.map((t) => [t.batchNumber, t.quantity, t.value])).toEqual([
      ["EARLY", "2", "20000"],
      ["LATE", "1", "20000"],
    ]);
  });

  it("ignores quantity already restored or disposed of", () => {
    const takes = planBatchRestoration(
      [restorable("early", "2030-01-01", "3", 10_000, "2", "0"), restorable("late", "2031-01-01", "3", 10_000, "0", "3")],
      "1",
    );
    expect(takes.map((t) => [t.batchNumber, t.quantity])).toEqual([["EARLY", "1"]]);
  });

  it("refuses a return larger than the line has open", () => {
    expect(() => planBatchRestoration([restorable("early", "2030-01-01", "2", 10_000, "1", "0")], "2")).toThrow(
      /بیشتر است/,
    );
  });

  it("refuses a non-positive return", () => {
    expect(() => planBatchRestoration([restorable("early", "2030-01-01", "2", 10_000)], "0")).toThrow(
      RetailBatchError,
    );
  });
});

describe("dispositions", () => {
  it("accepts exactly the documented dispositions", () => {
    for (const value of ["restockable", "damaged", "expired", "quarantine", "tester", "no_restock"]) {
      expect(isBatchDisposition(value)).toBe(true);
    }
    expect(isBatchDisposition("sold")).toBe(false);
    expect(isBatchDisposition(null)).toBe(false);
  });

  it("only restockable puts sellable stock back", () => {
    expect(isRestockDisposition("restockable")).toBe(true);
    expect(isRestockDisposition("damaged")).toBe(false);
    expect(isRestockDisposition("quarantine")).toBe(false);
  });
});
