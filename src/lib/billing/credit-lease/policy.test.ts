import { describe, expect, it } from "vitest";
import {
  CREDIT_LEASE_SETTINGS_DEFAULT,
  DEBT_CEILING_RIAL_DEFAULT,
  NEVER_BLOCKED_ACTIONS,
  OFFLINE_WINDOW_DAYS_DEFAULT,
  debtPercent,
  decideAccess,
  meterState,
  overLeaseCostRial,
  payDownDebt,
  quotaThreshold,
  recordUsage,
  resolveCreditLeaseSettings,
  validateCreditLeaseSettings,
  type CreditLeaseSettings,
  type MeterPosition,
} from "./policy";

const settings: CreditLeaseSettings = { ...CREDIT_LEASE_SETTINGS_DEFAULT, debtCeilingRial: 1_000 };
const fresh: MeterPosition = { unitsGranted: 10, unitsUsed: 0, leaseExpired: false, debtRial: 0 };

describe("defaults", () => {
  it("match the owner decisions of 2026-10-18 and the approved ceiling", () => {
    expect(OFFLINE_WINDOW_DAYS_DEFAULT).toBe(7);
    expect(DEBT_CEILING_RIAL_DEFAULT).toBe(10_000_000);
    expect(CREDIT_LEASE_SETTINGS_DEFAULT.overLeasePriceBps).toBe(10_000);
    expect(validateCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT)).toBeNull();
  });
});

describe("resolveCreditLeaseSettings", () => {
  it("lets a plan override only the fields it sets", () => {
    const resolved = resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, { debtCeilingRial: 5_000_000 });
    expect(resolved.debtCeilingRial).toBe(5_000_000);
    expect(resolved.offlineWindowDays).toBe(7);
    expect(resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, null)).toEqual(CREDIT_LEASE_SETTINGS_DEFAULT);
  });

  it("rejects a bad stored value instead of granting unlimited debt", () => {
    expect(() => resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, { debtCeilingRial: -1 })).toThrow("bad_debt_ceiling_rial");
    expect(() => resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, { debtCeilingRial: 1.5 })).toThrow("bad_debt_ceiling_rial");
    expect(() => resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, { offlineWindowDays: 0 })).toThrow("bad_offline_window_days");
    expect(() => resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, { overLeasePriceBps: 0 })).toThrow("bad_over_lease_price_bps");
    expect(() => resolveCreditLeaseSettings(CREDIT_LEASE_SETTINGS_DEFAULT, { lockPolicy: "nope" as never })).toThrow("bad_lock_policy");
  });
});

describe("overLeaseCostRial", () => {
  it("is exact at 1.0x and rounds a fraction of a Rial up", () => {
    expect(overLeaseCostRial(3, 100, 10_000)).toBe(300);
    expect(overLeaseCostRial(3, 101, 15_000)).toBe(455); // 454.5 -> 455
    expect(overLeaseCostRial(0, 100, 10_000)).toBe(0);
  });

  it("does not lose precision above 2^53 before dividing", () => {
    // 1e6 units * 1e7 Rial * 10_000 bps = 1e17 > Number.MAX_SAFE_INTEGER
    expect(overLeaseCostRial(1_000_000, 10_000_000, 10_000)).toBe(10_000_000_000_000);
  });

  it("refuses non-integers and negatives", () => {
    expect(() => overLeaseCostRial(-1, 1, 1)).toThrow("bad_over_units");
    expect(() => overLeaseCostRial(1, 1.5, 1)).toThrow("bad_unit_price_rial");
  });
});

describe("meterState", () => {
  it("is lease while units remain and the lease is live", () => {
    expect(meterState(fresh, settings)).toBe("lease");
    expect(meterState({ ...fresh, unitsUsed: 9 }, settings)).toBe("lease");
  });

  it("is over_lease_debt once the lease is exhausted or expired and debt is under the ceiling", () => {
    expect(meterState({ ...fresh, unitsUsed: 10 }, settings)).toBe("over_lease_debt");
    expect(meterState({ ...fresh, leaseExpired: true }, settings)).toBe("over_lease_debt");
  });

  it("is locked at the ceiling, and at once when the ceiling is zero", () => {
    expect(meterState({ ...fresh, unitsUsed: 10, debtRial: 999 }, settings)).toBe("over_lease_debt");
    expect(meterState({ ...fresh, unitsUsed: 10, debtRial: 1_000 }, settings)).toBe("locked");
    expect(meterState({ ...fresh, unitsUsed: 10 }, { ...settings, debtCeilingRial: 0 })).toBe("locked");
  });

  it("never locks a live lease, whatever the stored debt", () => {
    expect(meterState({ ...fresh, debtRial: 5_000 }, settings)).toBe("lease");
  });
});

describe("recordUsage", () => {
  it("stays inside the lease and adds no debt", () => {
    const r = recordUsage(fresh, 4, 100, settings);
    expect(r).toMatchObject({ leaseUnits: 4, overLeaseUnits: 0, debtAddedRial: 0, state: "lease" });
    expect(r.next.unitsUsed).toBe(4);
  });

  it("splits a use that straddles the end of the lease", () => {
    const r = recordUsage({ ...fresh, unitsUsed: 8 }, 5, 100, settings);
    expect(r.leaseUnits).toBe(2);
    expect(r.overLeaseUnits).toBe(3);
    expect(r.debtAddedRial).toBe(300);
    expect(r.next.unitsUsed).toBe(10);
    expect(r.state).toBe("over_lease_debt");
  });

  it("treats an expired lease as fully over-lease even with units left", () => {
    const r = recordUsage({ ...fresh, leaseExpired: true }, 2, 100, settings);
    expect(r.leaseUnits).toBe(0);
    expect(r.overLeaseUnits).toBe(2);
    expect(r.next.unitsUsed).toBe(0);
  });

  it("accepts the unit that crosses the ceiling and locks the next one", () => {
    const start: MeterPosition = { ...fresh, unitsUsed: 10, debtRial: 900 };
    const crossing = recordUsage(start, 1, 500, settings);
    expect(crossing.debtAddedRial).toBe(500);
    expect(crossing.next.debtRial).toBe(1_400);
    expect(crossing.state).toBe("locked");
  });

  it("applies the over-lease price multiplier", () => {
    const r = recordUsage({ ...fresh, unitsUsed: 10 }, 2, 100, { ...settings, overLeasePriceBps: 20_000 });
    expect(r.debtAddedRial).toBe(400);
  });

  it("rejects a zero, negative or fractional quantity", () => {
    for (const q of [0, -1, 1.5]) expect(() => recordUsage(fresh, q, 100, settings)).toThrow("bad_quantity");
  });

  it("never lets integer rating drift: debt equals the sum of per-use ratings", () => {
    let position: MeterPosition = { ...fresh, unitsGranted: 0 };
    let expected = 0;
    for (let i = 1; i <= 25; i++) {
      const price = 37 * i;
      expected += overLeaseCostRial(1, price, 12_500);
      position = recordUsage(position, 1, price, { ...settings, debtCeilingRial: Number.MAX_SAFE_INTEGER, overLeasePriceBps: 12_500 }).next;
    }
    expect(position.debtRial).toBe(expected);
  });
});

describe("payDownDebt", () => {
  it("pays debt first and returns the rest", () => {
    expect(payDownDebt(700, 1_000)).toEqual({ paidRial: 700, remainingDebtRial: 0, leftoverRial: 300 });
    expect(payDownDebt(700, 200)).toEqual({ paidRial: 200, remainingDebtRial: 500, leftoverRial: 0 });
    expect(payDownDebt(0, 50)).toEqual({ paidRial: 0, remainingDebtRial: 0, leftoverRial: 50 });
  });
});

describe("debtPercent and quotaThreshold", () => {
  it("floors the percent and caps it at 100", () => {
    expect(debtPercent(799, 1_000)).toBe(79);
    expect(debtPercent(800, 1_000)).toBe(80);
    expect(debtPercent(5_000, 1_000)).toBe(100);
    expect(debtPercent(0, 0)).toBe(100);
  });

  it("reports the lowest of the 50 / 20 / 5 % thresholds crossed", () => {
    expect(quotaThreshold(100, 10)).toBeNull();
    expect(quotaThreshold(100, 50)).toBe(50);
    expect(quotaThreshold(100, 80)).toBe(20);
    expect(quotaThreshold(100, 95)).toBe(5);
    expect(quotaThreshold(100, 100)).toBe(5);
    expect(quotaThreshold(0, 0)).toBeNull();
  });
});

describe("decideAccess", () => {
  it("allows everything until the meter locks, debt included", () => {
    for (const state of ["lease", "over_lease_debt"] as const) {
      for (const intent of ["start_metered", "other_write", "read"] as const) {
        expect(decideAccess(state, "read_only", intent).allowed).toBe(true);
      }
    }
  });

  it("keeps every never-blocked action open when locked, under either policy", () => {
    for (const policy of ["block", "read_only"] as const) {
      for (const action of NEVER_BLOCKED_ACTIONS) {
        expect(decideAccess("locked", policy, action).allowed).toBe(true);
      }
      expect(decideAccess("locked", policy, "read").allowed).toBe(true);
    }
  });

  it("block refuses new metered work only; read_only also refuses other writes", () => {
    expect(decideAccess("locked", "block", "start_metered")).toEqual({ allowed: false, reason: "locked_block" });
    expect(decideAccess("locked", "block", "other_write").allowed).toBe(true);
    expect(decideAccess("locked", "read_only", "start_metered")).toEqual({ allowed: false, reason: "locked_read_only" });
    expect(decideAccess("locked", "read_only", "other_write")).toEqual({ allowed: false, reason: "locked_read_only" });
  });

  it("lists the six actions the owner named", () => {
    expect([...NEVER_BLOCKED_ACTIONS]).toEqual(["close_open_order", "close_shift", "print_receipt", "export_data", "backup", "login"]);
  });
});
