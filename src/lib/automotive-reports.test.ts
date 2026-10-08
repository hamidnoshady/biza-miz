/**
 * Issue #839 §14 — the automotive reports' arithmetic, as pure functions.
 *
 * The three claims worth a test rather than a comment:
 *
 *   - margin is measured against *net* revenue (VAT is the tax office's money
 *     and never a margin numerator) and against the **frozen** effective cost
 *     the rows carry;
 *   - a sale with no recorded salesperson shows up in its own bucket instead of
 *     vanishing from the breakdown;
 *   - a deposit is a liability: it is reported as money *held*, never as
 *     revenue — which is exactly why the reservation summary has no "sales"
 *     figure for a hold to be mistaken for.
 */
import { describe, expect, it } from "vitest";
import {
  vehicleInventorySummary,
  vehicleMarginPercent,
  vehicleReservationSummary,
  vehicleSalesSummary,
  type VehicleInventoryReportRow,
  type VehicleReservationReportRow,
  type VehicleSalesReportRow,
} from "./automotive-reports";

function stockRow(overrides: Partial<VehicleInventoryReportRow> = {}): VehicleInventoryReportRow {
  return {
    serialId: "s1",
    stockNumber: "1403-001",
    displayName: "پژو 207",
    make: "پژو",
    model: "207",
    modelYear: 1403,
    condition: "new",
    state: "in_stock",
    locationId: "loc-1",
    locationName: "شعبهٔ مرکزی",
    acquiredOn: "2026-01-01",
    daysInStock: 30,
    ageBucket: "fresh",
    acquisitionCostRial: 700_000_000,
    capitalizedCostRial: 30_000_000,
    periodExpenseRial: 5_000_000,
    effectiveCostRial: 730_000_000,
    askingPriceRial: 900_000_000,
    potentialMarginRial: 170_000_000,
    minimumPriceRial: 800_000_000,
    vin: null,
    plateNumber: null,
    ...overrides,
  };
}

describe("vehicleInventorySummary", () => {
  it("totals the lot, separating capitalized money from expensed money", () => {
    const summary = vehicleInventorySummary([
      stockRow(),
      stockRow({
        serialId: "s2",
        stockNumber: "1403-002",
        condition: "used",
        state: "reserved",
        daysInStock: 75,
        ageBucket: "slow",
        acquisitionCostRial: 400_000_000,
        capitalizedCostRial: 0,
        periodExpenseRial: 12_000_000,
        effectiveCostRial: 400_000_000,
        askingPriceRial: 500_000_000,
        potentialMarginRial: 100_000_000,
      }),
      stockRow({
        serialId: "s3",
        stockNumber: "1403-003",
        state: "in_stock",
        daysInStock: 140,
        ageBucket: "dead",
        locationId: "loc-2",
        locationName: "شعبهٔ دوم",
        acquisitionCostRial: 1_000_000_000,
        capitalizedCostRial: 50_000_000,
        periodExpenseRial: 0,
        effectiveCostRial: 1_050_000_000,
        askingPriceRial: 1_200_000_000,
        potentialMarginRial: 150_000_000,
      }),
    ]);

    expect(summary.count).toBe(3);
    expect(summary.newCount).toBe(2);
    expect(summary.usedCount).toBe(1);
    expect(summary.inStockCount).toBe(2);
    expect(summary.reservedCount).toBe(1);
    expect(summary.totalAcquisitionCostRial).toBe(2_100_000_000);
    expect(summary.totalCapitalizedCostRial).toBe(80_000_000);
    expect(summary.totalPeriodExpenseRial).toBe(17_000_000);
    expect(summary.totalEffectiveCostRial).toBe(2_180_000_000);
    expect(summary.totalAskingPriceRial).toBe(2_600_000_000);
    expect(summary.totalPotentialMarginRial).toBe(420_000_000);
    expect(summary.averageAgeDays).toBe(82); // (30 + 75 + 140) / 3
    expect(summary.slowCount).toBe(1);
    expect(summary.deadCount).toBe(1);
    expect(summary.ageBuckets.map((b) => b.count)).toEqual([1, 1, 1]);
    // Branch inventory: the biggest lot first.
    expect(summary.byBranch.map((b) => [b.locationId, b.count])).toEqual([
      ["loc-1", 2],
      ["loc-2", 1],
    ]);
  });

  it("answers an empty lot with zeros and a null average, never NaN", () => {
    const summary = vehicleInventorySummary([]);
    expect(summary.count).toBe(0);
    expect(summary.averageAgeDays).toBeNull();
    expect(summary.totalEffectiveCostRial).toBe(0);
    expect(summary.byBranch).toEqual([]);
  });
});

function saleRow(overrides: Partial<VehicleSalesReportRow> = {}): VehicleSalesReportRow {
  return {
    serialId: "s1",
    stockNumber: "1403-001",
    displayName: "پژو 207",
    make: "پژو",
    model: "207",
    modelYear: 1403,
    condition: "new",
    soldOn: "2026-02-01",
    daysToSale: 31,
    salePriceRial: 981_000_000,
    revenueRial: 900_000_000,
    effectiveCostRial: 730_000_000,
    grossProfitRial: 170_000_000,
    marginPercent: 18.9,
    salespersonId: "u1",
    salespersonName: "خانم فروشنده",
    locationId: "loc-1",
    locationName: "شعبهٔ مرکزی",
    reversed: false,
    ...overrides,
  };
}

describe("vehicleSalesSummary", () => {
  it("reports gross profit against net revenue and the frozen cost", () => {
    const summary = vehicleSalesSummary([saleRow(), saleRow({ serialId: "s2", revenueRial: 500_000_000, effectiveCostRial: 400_000_000, daysToSale: 61, salePriceRial: 545_000_000 })]);

    expect(summary.unitsSold).toBe(2);
    expect(summary.revenueRial).toBe(1_400_000_000);
    expect(summary.cogsRial).toBe(1_130_000_000);
    expect(summary.grossProfitRial).toBe(270_000_000);
    // 270 / 1,400 = 19.3%, not the VAT-inclusive 1,526 base.
    expect(summary.averageMarginPercent).toBe(19.3);
    expect(summary.averageDaysToSale).toBe(46);
    expect(summary.reversedCount).toBe(0);
  });

  it("keeps an unnamed salesperson's sale visible instead of dropping it", () => {
    const summary = vehicleSalesSummary([
      saleRow(),
      saleRow({ serialId: "s2", salespersonId: null, salespersonName: null }),
    ]);
    expect(summary.bySalesperson).toHaveLength(2);
    expect(summary.bySalesperson.map((g) => g.label).sort()).toEqual(["بدون فروشندهٔ ثبت‌شده", "خانم فروشنده"]);
    expect(summary.bySalesperson.reduce((total, g) => total + g.units, 0)).toBe(2);
  });

  it("breaks performance down by make and model, best profit first", () => {
    const summary = vehicleSalesSummary([
      saleRow(),
      saleRow({ serialId: "s2", make: "کیا", model: "سراتو", revenueRial: 2_000_000_000, effectiveCostRial: 1_000_000_000, marginPercent: 50 }),
    ]);
    expect(summary.byMakeModel.map((g) => g.label)).toEqual(["کیا سراتو", "پژو 207"]);
    expect(summary.byMakeModel[0].marginPercent).toBe(50);
  });

  it("counts the period's acquisitions beside its sales", () => {
    const summary = vehicleSalesSummary([saleRow()], { count: 3, costRial: 1_800_000_000 });
    expect(summary.acquisitions).toEqual({ count: 3, costRial: 1_800_000_000 });
  });

  it("answers a period with no sales with zeros, not a divide-by-zero margin", () => {
    const summary = vehicleSalesSummary([]);
    expect(summary.unitsSold).toBe(0);
    expect(summary.averageMarginPercent).toBeNull();
    expect(summary.averageDaysToSale).toBeNull();
    expect(summary.bySalesperson).toEqual([]);
  });
});

describe("vehicleMarginPercent", () => {
  it("measures margin against net revenue, and refuses to divide by zero", () => {
    expect(vehicleMarginPercent(900, 730)).toBe(18.9);
    expect(vehicleMarginPercent(1_000, 1_000)).toBe(0);
    expect(vehicleMarginPercent(1_000, 1_200)).toBe(-20);
    expect(vehicleMarginPercent(0, 500)).toBeNull();
  });
});

function holdRow(overrides: Partial<VehicleReservationReportRow> = {}): VehicleReservationReportRow {
  return {
    id: "r1",
    stockNumber: "1403-001",
    displayName: "پژو 207",
    customerName: "آقای رضایی",
    status: "active",
    expiresAt: "2026-03-05",
    expiresAtTime: null,
    depositRial: 50_000_000,
    depositMethod: "cash",
    depositRefundable: true,
    depositRefundedRial: 0,
    createdAt: "2026-02-20",
    closedAt: null,
    ageDays: 3,
    locationId: "loc-1",
    locationName: "شعبهٔ مرکزی",
    releaseReason: null,
    ...overrides,
  };
}

describe("vehicleReservationSummary", () => {
  it("reports a deposit as money held — a liability — never as revenue", () => {
    const summary = vehicleReservationSummary(
      [
        holdRow(),
        holdRow({
          id: "r2",
          status: "active",
          depositRial: 30_000_000,
          depositRefundable: false,
          expiresAt: null,
        }),
        holdRow({
          id: "r3",
          status: "released",
          depositRefundedRial: 20_000_000,
          releaseReason: "انصراف مشتری",
        }),
        holdRow({ id: "r4", status: "converted" }),
        holdRow({ id: "r5", status: "expired" }),
      ],
      "2026-03-01",
    );

    expect(summary.total).toBe(5);
    expect(summary.activeCount).toBe(2);
    expect(summary.convertedCount).toBe(1);
    expect(summary.releasedCount).toBe(1);
    expect(summary.expiredCount).toBe(1);
    expect(summary.depositHeldRial).toBe(80_000_000);
    expect(summary.nonRefundableHeldRial).toBe(30_000_000);
    expect(summary.depositRefundedRial).toBe(20_000_000);
    // 2026-03-05 is four days away from 2026-03-01, so only a wider window
    // counts it; the "until released" hold never appears.
    expect(summary.expiringSoonCount).toBe(0);
    expect(vehicleReservationSummary([holdRow()], "2026-03-01", 7).expiringSoonCount).toBe(1);
  });
});
