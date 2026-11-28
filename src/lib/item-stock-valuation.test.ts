import { describe, expect, it } from "vitest";
import {
  ItemStockValuationError,
  carryingBasis,
  carryingDrift,
  planFungibleRelief,
  planFungibleRestore,
  type FungibleStockState,
} from "./item-stock-valuation";

const row = (quantity: string, unitCost: string | null, totalValue: string | null): FungibleStockState => ({
  quantity,
  unitCost,
  totalValue,
});

describe("item stock valuation (F1, GH #1567)", () => {
  it("owner repro: buy 10 @ 50,000, sell 4, write off 1 relieves 50,000 — not 83,333", () => {
    let state = row("10", "50000", "500000");
    const sale = planFungibleRelief(state, "4");
    expect(sale.value).toBe("200000");
    state = row(sale.nextQuantity, "50000", sale.nextTotal);
    expect(state.totalValue).toBe("300000");
    const writeOff = planFungibleRelief(state, "1");
    expect(writeOff.value).toBe("50000");
    expect(writeOff.nextTotal).toBe("250000");
  });

  it("legacy stale row: basis falls back to quantity × average, drift is carried untouched", () => {
    // The pre-fix state: sale moved quantity, total stayed 500,000.
    const stale = row("6", "50000", "500000");
    expect(carryingDrift(stale)).toBe(200000n);
    expect(carryingBasis(stale)).toBe("300000");
    const writeOff = planFungibleRelief(stale, "1");
    expect(writeOff.value).toBe("50000");
    // Not silently repaired: 500,000 − 50,000.
    expect(writeOff.nextTotal).toBe("450000");
  });

  it("keeps exact rounding pennies of a non-integer average", () => {
    // 1 @ 100 + 1 @ 101: average rounds to 101 but the carrying value is 201.
    const state = row("2", "101", "201");
    expect(carryingDrift(state)).toBe(0n);
    const first = planFungibleRelief(state, "1");
    const second = planFungibleRelief(row(first.nextQuantity, "101", first.nextTotal), "1");
    expect(BigInt(first.value) + BigInt(second.value)).toBe(201n);
    expect(second.nextTotal).toBe("0");
  });

  it("the last unit out takes the remainder so depletion leaves zero", () => {
    let state = row("3", "33", "100");
    let relieved = 0n;
    for (let i = 0; i < 3; i++) {
      const plan = planFungibleRelief(state, "1");
      relieved += BigInt(plan.value);
      state = row(plan.nextQuantity, "33", plan.nextTotal);
    }
    expect(relieved).toBe(100n);
    expect(state.totalValue).toBe("0");
  });

  it("refuses overselling and uncosted relief", () => {
    expect(() => planFungibleRelief(row("2", "10", "20"), "3")).toThrow(ItemStockValuationError);
    expect(() => planFungibleRelief(row("2", null, null), "1")).toThrow("cost_missing");
    expect(planFungibleRelief(row("2", null, null), "1", { requireCost: false }).value).toBe("0");
  });

  it("forced relief undoes an exact value but never below zero carried", () => {
    expect(planFungibleRelief(row("5", "100", "500"), "2", { forcedValue: "230" }).value).toBe("230");
    expect(planFungibleRelief(row("1", "100", "100"), "1", { forcedValue: "999" }).value).toBe("100");
  });

  it("restore re-enters the exact original value and re-averages", () => {
    // 6 left at 50,000; a return of 1 that originally relieved 40,000.
    const plan = planFungibleRestore(row("6", "50000", "300000"), "1", "40000");
    expect(plan.nextQuantity).toBe("7");
    expect(plan.nextTotal).toBe("340000");
    expect(plan.nextUnitCost).toBe("48571");
  });

  it("receipt: multi-cost purchases average on the exact total", () => {
    const first = planFungibleRestore(row("0", null, "0"), "10", "500000");
    expect(first.nextUnitCost).toBe("50000");
    const second = planFungibleRestore(row(first.nextQuantity, first.nextUnitCost, first.nextTotal), "5", "350000");
    expect(second.nextTotal).toBe("850000");
    expect(second.nextUnitCost).toBe("56667");
  });

  it("an uncosted row on hand takes the incoming cost, not a diluted one", () => {
    const plan = planFungibleRestore(row("4", null, null), "2", "200");
    expect(plan.nextUnitCost).toBe("100");
  });

  it("value-only restore (quantity 0) keeps the average", () => {
    const plan = planFungibleRestore(row("3", "100", "300"), "0", "100");
    expect(plan.nextQuantity).toBe("3");
    expect(plan.nextTotal).toBe("400");
    expect(plan.nextUnitCost).toBe("100");
  });
});
