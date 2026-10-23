/**
 * Issue #963 (#839 §9) — the trade-in deal's pure rules: the consideration
 * arithmetic, the deal validation, and the two registries that keep the
 * deal cloud-only and cost-gated. The DB halves (one transaction, the
 * reversal rules, tenant isolation, the round trip) live in
 * `integration/automotive-trade-in.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  computeEffectiveCost,
  computeTradeInConsideration,
  redactVehicleCostSensitive,
  validateTradeInDeal,
  vehicleMargin,
} from "./automotive";
import {
  AUTOMOTIVE_OFFLINE_REQUEST_TYPES,
  resolveAutomotiveOfflineCapability,
} from "./automotive-offline";
import { automotiveCloudOnlyTables } from "./automotive-sync-classification";
import { PERMISSIONS, effectivePermissions, hasPermission } from "./permissions";
import { permissionMetadata } from "./permission-registry";

describe("computeTradeInConsideration", () => {
  it("applies the allowance against the invoice and leaves the difference due", () => {
    const deal = computeTradeInConsideration({
      saleTotalRial: 1_090_000_000,
      allowanceRial: 400_000_000,
      expectedRetailRial: 520_000_000,
    });
    expect(deal).toEqual({
      allowanceRial: 400_000_000,
      expectedRetailRial: 520_000_000,
      saleTotalRial: 1_090_000_000,
      depositAppliedRial: 0,
      tradeInAppliedRial: 400_000_000,
      remainderPayableRial: 0,
      differenceDueRial: 690_000_000,
    });
  });

  it("applies the reservation deposit first, then the allowance — never refunded-re-taken", () => {
    const deal = computeTradeInConsideration({
      saleTotalRial: 1_090_000_000,
      depositAppliedRial: 90_000_000,
      allowanceRial: 400_000_000,
    });
    expect(deal.depositAppliedRial).toBe(90_000_000);
    expect(deal.tradeInAppliedRial).toBe(400_000_000);
    expect(deal.differenceDueRial).toBe(600_000_000);
  });

  it("keeps every Rial accounted for when the allowance exceeds the invoice", () => {
    const deal = computeTradeInConsideration({
      saleTotalRial: 500_000_000,
      depositAppliedRial: 50_000_000,
      allowanceRial: 600_000_000,
    });
    // The invoice can absorb 450M after the deposit; the other 150M is
    // still owed to the customer — it does not vanish into the deal.
    expect(deal.tradeInAppliedRial).toBe(450_000_000);
    expect(deal.remainderPayableRial).toBe(150_000_000);
    expect(deal.differenceDueRial).toBe(0);
    expect(deal.tradeInAppliedRial + deal.remainderPayableRial).toBe(deal.allowanceRial);
    expect(deal.depositAppliedRial + deal.tradeInAppliedRial + deal.differenceDueRial).toBe(deal.saleTotalRial);
  });

  it("caps an oversized deposit at the invoice before the allowance is considered", () => {
    const deal = computeTradeInConsideration({
      saleTotalRial: 300_000_000,
      depositAppliedRial: 400_000_000,
      allowanceRial: 100_000_000,
    });
    expect(deal.depositAppliedRial).toBe(300_000_000);
    expect(deal.tradeInAppliedRial).toBe(0);
    expect(deal.remainderPayableRial).toBe(100_000_000);
    expect(deal.differenceDueRial).toBe(0);
  });

  it("refuses a zero or negative allowance: a worthless hand-in is not consideration", () => {
    expect(() => computeTradeInConsideration({ saleTotalRial: 100, allowanceRial: 0 })).toThrow("ارزش معاوضه");
    expect(() => computeTradeInConsideration({ saleTotalRial: 100, allowanceRial: -1 })).toThrow();
  });

  it("refuses fractional Rial anywhere in the deal", () => {
    expect(() => computeTradeInConsideration({ saleTotalRial: 100.5, allowanceRial: 10 })).toThrow();
    expect(() => computeTradeInConsideration({ saleTotalRial: 100, allowanceRial: 10.5 })).toThrow();
    expect(() =>
      computeTradeInConsideration({ saleTotalRial: 100, allowanceRial: 10, expectedRetailRial: -1 }),
    ).toThrow();
  });

  it("values B honestly: margin is computed from the allowance, retail is a separate number", () => {
    // B's basis after hand-in: allowance + capitalized reconditioning —
    // the expected retail never enters the cost.
    const basis = computeEffectiveCost({
      acquisitionCostRial: 400_000_000,
      capitalizedCostRial: 25_000_000,
      periodExpenseRial: 8_000_000,
    });
    expect(basis.effectiveCostRial).toBe(425_000_000);
    const atRetail = vehicleMargin({ priceRial: 520_000_000, effectiveCostRial: basis.effectiveCostRial });
    expect(atRetail.marginRial).toBe(95_000_000);
  });
});

describe("validateTradeInDeal", () => {
  const valid = {
    customerId: "customer-1",
    soldSerialId: "serial-a",
    allowanceRial: 400_000_000,
    expectedRetailRial: 520_000_000,
    tradeInCondition: "used" as const,
    differenceSettlement: "credit",
  };

  it("accepts the ordinary one-car deal", () => {
    expect(validateTradeInDeal(valid)).toBeNull();
  });

  it("refuses more than one handed-in vehicle, loudly", () => {
    expect(validateTradeInDeal({ ...valid, tradeInVehicleCount: 2 })).toContain("فقط یک خودرو");
  });

  it("requires the customer both sides of the deal name", () => {
    expect(validateTradeInDeal({ ...valid, customerId: null })).toContain("مشتری");
    expect(validateTradeInDeal({ ...valid, soldSerialId: "" })).toContain("خودروی فروخته‌شده");
  });

  it("requires the handed-in car to be declared used", () => {
    expect(validateTradeInDeal({ ...valid, tradeInCondition: "new" })).toContain("کارکرده");
  });

  it("requires a positive whole-Rial allowance and a valid settlement", () => {
    expect(validateTradeInDeal({ ...valid, allowanceRial: 0 })).toContain("ارزش معاوضه");
    expect(validateTradeInDeal({ ...valid, allowanceRial: 1.5 })).toContain("ارزش معاوضه");
    expect(validateTradeInDeal({ ...valid, differenceSettlement: "barter" })).toContain("تسویه");
  });
});

describe("trade-ins stay cloud-only and cost-gated", () => {
  it("never offers a trade-in offline in any deployment shape, and never queues one", () => {
    for (const capability of [
      resolveAutomotiveOfflineCapability({ profile: "local", runtimeRole: "site" }),
      resolveAutomotiveOfflineCapability({ profile: "cloud", runtimeRole: "central" }),
      resolveAutomotiveOfflineCapability({ profile: "hybrid", runtimeRole: "site" }),
    ]) {
      expect(capability.offlineTradeIn).toBe(false);
    }
    expect(AUTOMOTIVE_OFFLINE_REQUEST_TYPES).toEqual(["reserve", "release"]);
  });

  it("classes the link table cloud-only beside the sale it belongs to", () => {
    expect(automotiveCloudOnlyTables()).toContain("automotive_vehicle_trade_ins");
  });

  it("redacts the allowance (B's cost) without cost view, but not the asking price", () => {
    const visible = redactVehicleCostSensitive({
      status: "active",
      allowanceRial: 400_000_000,
      tradeInAppliedRial: 400_000_000,
      tradeInAllowanceTotalRial: 400_000_000,
      remainderPayableRial: 0,
      expectedRetailRial: 520_000_000,
    }) as Record<string, unknown>;
    expect(visible.allowanceRial).toBeUndefined();
    expect(visible.tradeInAppliedRial).toBeUndefined();
    expect(visible.tradeInAllowanceTotalRial).toBeUndefined();
    expect(visible.remainderPayableRial).toBeUndefined();
    expect(visible.expectedRetailRial).toBe(520_000_000);
    expect(visible.status).toBe("active");
  });
});

describe("vehicles.trade_in — the dedicated permission (issue #963 item 9)", () => {
  it("is registered as a high-risk, audited automotive act", () => {
    const meta = permissionMetadata(PERMISSIONS.vehiclesTradeIn);
    expect(meta.group).toBe("automotive");
    expect(meta.risk).toBe("high");
    expect(meta.audit).toBe(true);
    expect(meta.label).toBe("معاوضه خودرو");
  });

  it("is the manager's (and owner's) by default, and neither the till's nor the books'", () => {
    expect(hasPermission("manager", null, PERMISSIONS.vehiclesTradeIn)).toBe(true);
    expect(hasPermission("owner", null, PERMISSIONS.vehiclesTradeIn)).toBe(true);
    // A cashier may sell a priced car; striking a two-sided deal that
    // prices the customer's car is not a till act.
    expect(hasPermission("cashier", null, PERMISSIONS.vehiclesSell)).toBe(true);
    expect(hasPermission("cashier", null, PERMISSIONS.vehiclesTradeIn)).toBe(false);
    expect(hasPermission("accountant", null, PERMISSIONS.vehiclesTradeIn)).toBe(false);
  });

  it("implies reading cost, and dies without it — like every cost write", () => {
    const granted = effectivePermissions("cashier", { granted: [PERMISSIONS.vehiclesTradeIn] });
    expect(granted.has(PERMISSIONS.vehiclesTradeIn)).toBe(true);
    expect(granted.has(PERMISSIONS.vehiclesCostView)).toBe(true);
    expect(granted.has(PERMISSIONS.vehiclesView)).toBe(true);
    const blind = effectivePermissions("cashier", {
      granted: [PERMISSIONS.vehiclesTradeIn],
      revoked: [PERMISSIONS.vehiclesCostView],
    });
    expect(blind.has(PERMISSIONS.vehiclesTradeIn)).toBe(false);
  });

  it("is not implied by selling alone", () => {
    const seller = effectivePermissions("waiter", { granted: [PERMISSIONS.vehiclesSell] });
    expect(seller.has(PERMISSIONS.vehiclesTradeIn)).toBe(false);
  });
});
