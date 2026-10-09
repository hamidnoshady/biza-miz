/**
 * Issue #839 — the automotive trade's pure rules, tested without a database.
 *
 * Three kinds of assertion live here, the same three `industry-coverage.test.ts`
 * names for the cross-cutting registries:
 *
 *   1. **behaviour** — the lifecycle, the identity rules, the cost/margin
 *      arithmetic, ageing, holds and the KPI summary;
 *   2. **the SQL mirror** — every enum in this module is a CHECK constraint in
 *      `migrations/0212_automotive_vehicle_stock.sql`, and the two must list the
 *      same values. The module's own doc comment promises this and nothing else
 *      enforces it: a value added in TypeScript but not in SQL fails at the
 *      counter, in production, on the write that carries it;
 *   3. **the tenant shape** — the four new tables are tenant-scoped and
 *      RLS-enabled in the same migration that creates them (CLAUDE.md's rule).
 *
 * The real isolation proof is
 * `integration/tenant-isolation.integration.test.ts` against the live schema;
 * what this file checks is that the migration *text* declares the shape, so a
 * missing policy fails here in plain `npm test` rather than only in CI's
 * database job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkMinimumPrice,
  computeEffectiveCost,
  daysBetweenIso,
  daysInStock,
  depositAppliedToSale,
  holdHasExpired,
  holdIsBlocking,
  isVehicleAvailable,
  jalaliMonthRange,
  isVehicleCondition,
  isVehicleYearCalendar,
  minimumPriceFloor,
  nextStockNumber,
  normalizeVehicleSearch,
  normalizeVin,
  summarizeVehicleStock,
  validateChassisNumber,
  validateHoldStatusTransition,
  validateMileage,
  validatePlateNumber,
  validatePriorOwners,
  validateStockNumber,
  validateVehicleStateTransition,
  validateVehicleYears,
  validateVin,
  vehicleAgeBucket,
  vehicleDisplayName,
  vehicleMargin,
  VEHICLE_ACQUISITION_SOURCES,
  VEHICLE_ACQUISITION_SOURCE_LABELS,
  VEHICLE_AGE_BUCKET_LABELS,
  VEHICLE_BODY_TYPE_LABELS,
  VEHICLE_BODY_TYPES,
  VEHICLE_CONDITION_LABELS,
  VEHICLE_CONDITIONS,
  VEHICLE_DRIVETRAIN_LABELS,
  VEHICLE_DRIVETRAINS,
  VEHICLE_EXPENSE_CATEGORIES,
  VEHICLE_EXPENSE_CATEGORY_LABELS,
  VEHICLE_EXPENSE_POSTING_LABELS,
  VEHICLE_EXPENSE_POSTINGS,
  VEHICLE_FUEL_TYPE_LABELS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_HOLD_STATUS_LABELS,
  VEHICLE_HOLD_STATUSES,
  VEHICLE_SELLABLE_STATES,
  VEHICLE_STATE_LABELS,
  VEHICLE_STATES,
  VEHICLE_TRANSMISSION_LABELS,
  VEHICLE_TRANSMISSIONS,
  VEHICLE_YEAR_CALENDARS,
  VEHICLE_YEAR_CALENDAR_LABELS,
  VEHICLE_YEAR_RANGES,
  isVehicleCondition as isCondition,
  SALE_REVERSAL_STATE,
} from "./automotive";

const MIGRATION = "0212_automotive_vehicle_stock.sql";
const migrationSql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");

/**
 * The value list inside a column's `IN ( … )` CHECK, or null when the migration
 * does not carry one. Both spellings the migration uses are accepted — a bare
 * `CHECK (col IN (…))` and the nullable `CHECK (col IS NULL OR col IN (…))`.
 */
function sqlCheckList(column: string): string[] | null {
  const patterns = [
    new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([\\s\\S]*?)\\)\\s*\\)`),
    new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IS\\s+NULL\\s+OR\\s+${column}\\s+IN\\s*\\(([\\s\\S]*?)\\)\\s*\\)`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(migrationSql);
    if (match) return [...match[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  }
  return null;
}

describe("the enums and the migration's CHECK constraints agree", () => {
  it("lists the same lifecycle states", () => {
    expect(sqlCheckList("state")).toEqual([...VEHICLE_STATES]);
  });

  it("lists the same conditions", () => {
    expect(sqlCheckList("condition")).toEqual([...VEHICLE_CONDITIONS]);
  });

  it("lists the same lot vocabulary", () => {
    expect(sqlCheckList("body_type")).toEqual([...VEHICLE_BODY_TYPES]);
    expect(sqlCheckList("transmission")).toEqual([...VEHICLE_TRANSMISSIONS]);
    expect(sqlCheckList("fuel_type")).toEqual([...VEHICLE_FUEL_TYPES]);
    expect(sqlCheckList("drivetrain")).toEqual([...VEHICLE_DRIVETRAINS]);
  });

  it("lists the same acquisition sources and year calendars", () => {
    expect(sqlCheckList("acquisition_source")).toEqual([...VEHICLE_ACQUISITION_SOURCES]);
    expect(sqlCheckList("vehicle_year_calendar")).toEqual([...VEHICLE_YEAR_CALENDARS]);
  });

  it("lists the same cost categories and posting decisions", () => {
    expect(sqlCheckList("category")).toEqual([...VEHICLE_EXPENSE_CATEGORIES]);
    expect(sqlCheckList("posting")).toEqual([...VEHICLE_EXPENSE_POSTINGS]);
  });

  it("mirrors the hold statuses on serial_reservations", () => {
    // The hold table predates this issue (migration 0202); its status CHECK is
    // what VEHICLE_HOLD_STATUSES has to mean, so the two are pinned together.
    const holdSql = readFileSync(join(process.cwd(), "migrations", "0202_serial_reservations.sql"), "utf8");
    const clause = /status\s+text[\s\S]*?CHECK\s*\(\s*status\s+IN\s*\(([\s\S]*?)\)\s*\)/.exec(holdSql);
    expect(clause).not.toBeNull();
    expect([...clause![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...VEHICLE_HOLD_STATUSES]);
  });

  it("excludes credit as a deposit method — a deposit is money received", () => {
    expect(migrationSql).toMatch(/deposit_method\s+payment_method[\s\S]{0,200}?<>\s*'credit'/);
  });

  it("gives every enum value a label, with no label reused inside one enum", () => {
    const maps: [readonly string[], Record<string, string>][] = [
      [VEHICLE_CONDITIONS, VEHICLE_CONDITION_LABELS],
      [VEHICLE_STATES, VEHICLE_STATE_LABELS],
      [VEHICLE_HOLD_STATUSES, VEHICLE_HOLD_STATUS_LABELS],
      [VEHICLE_BODY_TYPES, VEHICLE_BODY_TYPE_LABELS],
      [VEHICLE_TRANSMISSIONS, VEHICLE_TRANSMISSION_LABELS],
      [VEHICLE_FUEL_TYPES, VEHICLE_FUEL_TYPE_LABELS],
      [VEHICLE_DRIVETRAINS, VEHICLE_DRIVETRAIN_LABELS],
      [VEHICLE_ACQUISITION_SOURCES, VEHICLE_ACQUISITION_SOURCE_LABELS],
      [VEHICLE_EXPENSE_CATEGORIES, VEHICLE_EXPENSE_CATEGORY_LABELS],
      [VEHICLE_EXPENSE_POSTINGS, VEHICLE_EXPENSE_POSTING_LABELS],
      [VEHICLE_YEAR_CALENDARS, VEHICLE_YEAR_CALENDAR_LABELS],
      [["fresh", "slow", "dead"], VEHICLE_AGE_BUCKET_LABELS],
    ];
    for (const [values, labels] of maps) {
      const translated = values.map((value) => labels[value]);
      expect(translated.every((label) => typeof label === "string" && label.length > 0), values.join(",")).toBe(true);
      expect(new Set(translated).size, values.join(",")).toBe(translated.length);
    }
  });
});

describe("the tenant shape the migration must declare", () => {
  const tables = [
    "automotive_vehicle_attributes",
    "automotive_vehicle_costs",
    "automotive_vehicle_price_history",
    "automotive_vehicle_transfers",
  ];

  it("creates four tenant-scoped tables", () => {
    for (const table of tables) {
      const create = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migrationSql);
      expect(create, `${table}: no CREATE TABLE`).not.toBeNull();
      expect(create![1], `${table}: business_id must be NOT NULL`).toMatch(/business_id\s+uuid NOT NULL/);
      expect(create![1], `${table}: location_id must be NOT NULL`).toMatch(/location_id\s+uuid NOT NULL/);
    }
  });

  it("enables and forces RLS on each of them, in the same migration", () => {
    for (const table of tables) {
      expect(migrationSql, `${table}: ENABLE ROW LEVEL SECURITY`).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
      expect(migrationSql, `${table}: FORCE ROW LEVEL SECURITY`).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
      );
      expect(
        migrationSql.includes(`CREATE POLICY tenant_isolation ON ${table} FOR ALL`),
        `${table}: tenant_isolation policy`,
      ).toBe(true);
    }
  });

  it("makes uniqueness structural rather than a service convention", () => {
    // The identity rules §3 states, as indexes: per tenant, case-insensitively,
    // and only where the identifier exists at all.
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX uq_automotive_vehicle_vin\s+ON automotive_vehicle_attributes \(business_id, upper\(vin\)\) WHERE vin IS NOT NULL/);
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX uq_automotive_vehicle_chassis\s+ON[\s\S]{0,80}upper\(chassis_number\)\) WHERE chassis_number IS NOT NULL/);
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX uq_automotive_vehicle_stock_number\s+ON[\s\S]{0,80}upper\(stock_number\)\)/);
    // "Sold once": one sale line per physical car, whatever two concurrent sales believe.
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX uq_automotive_vehicle_sold_order_item/);
    // One live hold per unit stays 0202's index; one open transfer per car is 0212's.
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX uq_automotive_vehicle_transfer_open[\s\S]{0,80}WHERE status = 'in_transit'/);
  });
});

describe("lifecycle", () => {
  it("allows the moves the trade actually makes", () => {
    for (const [from, to] of [
      ["draft", "acquired"],
      ["acquired", "in_stock"],
      ["in_stock", "reserved"],
      ["reserved", "sold"],
      ["in_stock", "sold"],
      ["in_stock", "transferred"],
      ["transferred", "in_stock"],
      ["returned", "in_stock"],
    ] as const) {
      expect(validateVehicleStateTransition(from, to), `${from} → ${to}`).toBeNull();
    }
  });

  it("refuses a sale out of every state that is not sellable", () => {
    for (const state of VEHICLE_STATES) {
      const refused = !VEHICLE_SELLABLE_STATES.includes(state) && state !== "sold";
      if (refused) {
        expect(validateVehicleStateTransition(state, "sold"), `${state} → sold`).not.toBeNull();
      }
    }
  });

  it("lets only the sale reversal move a car out of `sold`, and only into `returned`", () => {
    expect(SALE_REVERSAL_STATE).toBe("returned");
    expect(validateVehicleStateTransition("sold", "returned")).toBeNull();
    for (const target of ["in_stock", "reserved", "archived", "draft"] as const) {
      expect(validateVehicleStateTransition("sold", target), `sold → ${target}`).not.toBeNull();
    }
  });

  it("treats archived as a tombstone", () => {
    for (const target of VEHICLE_STATES) {
      if (target === "archived") continue;
      expect(validateVehicleStateTransition("archived", target), `archived → ${target}`).not.toBeNull();
    }
  });

  it("is idempotent for an unchanged save and rejects unknown states", () => {
    for (const state of VEHICLE_STATES) expect(validateVehicleStateTransition(state, state)).toBeNull();
    expect(validateVehicleStateTransition("in_stock", "nonsense" as never)).not.toBeNull();
  });

  it("does not call a car in transit, or a sold one, available", () => {
    expect(isVehicleAvailable("in_stock")).toBe(true);
    expect(isVehicleAvailable("reserved")).toBe(true);
    expect(isVehicleAvailable("draft")).toBe(true);
    for (const state of ["sold", "archived"] as const) expect(isVehicleAvailable(state), state).toBe(false);
  });
});

describe("identity", () => {
  it("normalises a VIN before it is stored, so two spellings are one car", () => {
    expect(normalizeVin(" wc-12345 6789012345 ")).toBe("WC123456789012345");
    expect(validateVin("wc123456789012345")).toBeNull();
    expect(validateVin("WC123456789012345")).toBeNull();
  });

  it("accepts an absent VIN and rejects a malformed one", () => {
    for (const value of [null, undefined, "", "   "]) expect(validateVin(value)).toBeNull();
    expect(validateVin("WC12345678901234")).not.toBeNull(); // 16 characters
    expect(validateVin("WC1234567890123456")).not.toBeNull(); // 18
    expect(validateVin("WI123456789012345")).not.toBeNull(); // I is excluded
    expect(validateVin("WO123456789012345")).not.toBeNull(); // O is excluded
    expect(validateVin("WQ123456789012345")).not.toBeNull(); // Q is excluded
  });

  it("accepts an Iranian-market chassis number where a VIN would not fit", () => {
    expect(validateChassisNumber("IR-ABC 12345")).toBeNull();
    expect(validateChassisNumber("AB1")).not.toBeNull(); // too short
    expect(validateChassisNumber("شاسی۱۲۳۴")).not.toBeNull(); // not Latin alphanumerics
    expect(validateChassisNumber(null)).toBeNull();
  });

  it("requires a stock number but not a plate", () => {
    expect(validateStockNumber(" ۱۴۰۳-007 ")).toBeNull();
    expect(validateStockNumber("S 1001")).toBeNull();
    expect(validateStockNumber("")).not.toBeNull();
    expect(validateStockNumber(null)).not.toBeNull();
    expect(validateStockNumber("A".repeat(33))).not.toBeNull();
    expect(validatePlateNumber("۱۲ ب ۳۴۵ ایران ۱۱")).toBeNull();
    expect(validatePlateNumber(null)).toBeNull();
    expect(validatePlateNumber("X".repeat(33))).not.toBeNull();
  });

  it("validates a year inside the calendar it is stated in", () => {
    // The market's own words: «مدل ۱۴۰۲» for a domestic car, «مدل ۲۰۲۳» for an import.
    expect(validateVehicleYears({ modelYear: 1402, productionYear: 1401 })).toBeNull();
    expect(validateVehicleYears({ modelYear: 2023, productionYear: 2022, calendar: "gregorian" })).toBeNull();
    // A Gregorian year is out of range under the Jalali calendar and vice versa.
    expect(validateVehicleYears({ modelYear: 2023 })).not.toBeNull();
    expect(validateVehicleYears({ calendar: "gregorian", modelYear: 1402 })).not.toBeNull();
    // The build can never post-date the model.
    expect(validateVehicleYears({ modelYear: 1401, productionYear: 1402 })).not.toBeNull();
    // Optional on both sides: a used car's production year is often unknown.
    expect(validateVehicleYears({})).toBeNull();
    expect(validateVehicleYears({ productionYear: 1401 })).toBeNull();
    expect(VEHICLE_YEAR_RANGES.jalali).toEqual({ min: 1300, max: 1500 });
    expect(isVehicleYearCalendar("jalali")).toBe(true);
    expect(isVehicleYearCalendar("lunar")).toBe(false);
  });

  it("keeps condition and its dependent facts consistent", () => {
    expect(isVehicleCondition("used")).toBe(true);
    expect(isCondition("brand_new")).toBe(false);
    expect(validateMileage(120_000, "used")).toBeNull();
    expect(validateMileage(0, "new")).toBeNull();
    expect(validateMileage(12_000, "new")).not.toBeNull();
    expect(validateMileage(-1, "used")).not.toBeNull();
    expect(validateMileage(2_000_001, "used")).not.toBeNull();
    expect(validatePriorOwners(2, "used")).toBeNull();
    expect(validatePriorOwners(1, "new")).not.toBeNull();
    expect(validatePriorOwners(-1, "used")).not.toBeNull();
    // Optional is not the same as required-to-be-zero.
    expect(validateMileage(null, "used")).toBeNull();
    expect(validateMileage(undefined, "new")).toBeNull();
    expect(validatePriorOwners(null, "new")).toBeNull();
  });
});

describe("cost, pricing and margin", () => {
  it("adds only the capitalized costs into the effective cost", () => {
    const cost = computeEffectiveCost({ acquisitionCostRial: 5_000_000_000, capitalizedCostRial: 300_000_000, periodExpenseRial: 120_000_000 });
    expect(cost.effectiveCostRial).toBe(5_300_000_000);
    // The period expense is reported beside the effective cost, never inside it.
    expect(cost.periodExpenseRial).toBe(120_000_000);
  });

  it("refuses a fractional or negative Rial amount", () => {
    expect(() => computeEffectiveCost({ acquisitionCostRial: 1.5, capitalizedCostRial: 0, periodExpenseRial: 0 })).toThrow();
    expect(() => computeEffectiveCost({ acquisitionCostRial: -1, capitalizedCostRial: 0, periodExpenseRial: 0 })).toThrow();
  });

  it("computes a margin the owner can reconcile", () => {
    expect(vehicleMargin({ priceRial: 700_000_000, effectiveCostRial: 530_000_000 })).toEqual({
      marginRial: 170_000_000,
      marginPercent: 24.29,
    });
    // A loss is reported as one, not hidden by an absolute value.
    expect(vehicleMargin({ priceRial: 100, effectiveCostRial: 200 }).marginRial).toBe(-100);
    // A gift has no percentage margin to state.
    expect(vehicleMargin({ priceRial: 0, effectiveCostRial: 0 }).marginPercent).toBeNull();
  });

  it("treats no floor as no constraint, and a floor as a real one", () => {
    expect(minimumPriceFloor(null)).toBeNull();
    expect(minimumPriceFloor(6_500_000_000)).toBe(6_500_000_000);
    expect(checkMinimumPrice({ priceRial: 100, minimumPriceRial: null, overrideAllowed: false })).toEqual({
      allowed: true,
      shortfallRial: 0,
    });
    expect(checkMinimumPrice({ priceRial: 100, minimumPriceRial: 120, overrideAllowed: false })).toEqual({
      allowed: false,
      shortfallRial: 20,
    });
    // With the permission the sale proceeds, and the shortfall is still reported
    // so the sale can be flagged rather than silently accepted.
    expect(checkMinimumPrice({ priceRial: 100, minimumPriceRial: 120, overrideAllowed: true })).toEqual({
      allowed: true,
      shortfallRial: 20,
    });
    expect(checkMinimumPrice({ priceRial: 120, minimumPriceRial: 120, overrideAllowed: false }).allowed).toBe(true);
    // A floor of zero is a floor, not an absence.
    expect(checkMinimumPrice({ priceRial: 0, minimumPriceRial: 0, overrideAllowed: false }).allowed).toBe(true);
  });
});

describe("stock ageing", () => {
  it("counts whole days between ISO dates", () => {
    expect(daysBetweenIso("2025-04-01", "2025-05-01")).toBe(30);
    expect(daysBetweenIso("2025-05-01", "2025-04-01")).toBe(0); // never negative
    expect(() => daysBetweenIso("not-a-date", "2025-04-01")).toThrow();
  });

  it("measures a sold car to its sale date, not to today", () => {
    expect(daysInStock({ acquiredOn: "2025-01-01", soldOn: "2025-02-01" }, "2025-09-01")).toBe(31);
    expect(daysInStock({ acquiredOn: "2025-01-01" }, "2025-02-01")).toBe(31);
  });

  it("buckets at the thresholds the table, report and dashboard share", () => {
    expect(vehicleAgeBucket(0)).toBe("fresh");
    expect(vehicleAgeBucket(60)).toBe("fresh");
    expect(vehicleAgeBucket(61)).toBe("slow");
    expect(vehicleAgeBucket(90)).toBe("slow");
    expect(vehicleAgeBucket(91)).toBe("dead");
  });
});

describe("holds and deposits", () => {
  it("has exactly one blocking status", () => {
    expect(holdIsBlocking("active")).toBe(true);
    for (const status of ["converted", "released", "expired"] as const) {
      expect(holdIsBlocking(status), status).toBe(false);
    }
  });

  it("closes a hold once and never reopens it", () => {
    expect(validateHoldStatusTransition("active", "converted")).toBeNull();
    expect(validateHoldStatusTransition("active", "released")).toBeNull();
    expect(validateHoldStatusTransition("active", "expired")).toBeNull();
    for (const from of ["converted", "released", "expired"] as const) {
      expect(validateHoldStatusTransition(from, "active"), from).not.toBeNull();
    }
    expect(validateHoldStatusTransition("released", "released")).toBeNull();
  });

  it("expires on the business day after its expiry date, and never without one", () => {
    expect(holdHasExpired({ status: "active", expiresAt: "2025-04-01" }, "2025-04-02")).toBe(true);
    expect(holdHasExpired({ status: "active", expiresAt: "2025-04-01" }, "2025-04-01")).toBe(false);
    expect(holdHasExpired({ status: "active", expiresAt: null }, "2030-01-01")).toBe(false);
    // A closed hold is history; expiry is not an event that can happen to it.
    expect(holdHasExpired({ status: "converted", expiresAt: "2020-01-01" }, "2030-01-01")).toBe(false);
  });

  it("applies at most the invoice total, leaving the rest on the customer's advance", () => {
    expect(depositAppliedToSale(50_000_000, 700_000_000)).toBe(50_000_000);
    expect(depositAppliedToSale(700_000_000, 700_000_000)).toBe(700_000_000);
    expect(depositAppliedToSale(800_000_000, 700_000_000)).toBe(700_000_000);
    expect(depositAppliedToSale(0, 700_000_000)).toBe(0);
  });
});

describe("display, search and numbering", () => {
  it("assembles the display name once", () => {
    expect(vehicleDisplayName({ make: "پژو", model: "۲۰۷", trim: "پانوراما", modelYear: 1403 })).toBe(
      "پژو ۲۰۷ پانوراما 1403",
    );
    expect(vehicleDisplayName({ make: "کیا", model: "سراتو", trim: null, modelYear: null })).toBe("کیا سراتو");
  });

  it("folds Persian/Arabic digits and case for search", () => {
    expect(normalizeVehicleSearch(" ۱۴۰۳-007 ")).toBe("1403-007");
    expect(normalizeVehicleSearch("۱۲۳٤")).toBe("1234");
    expect(normalizeVehicleSearch("wc-123")).toBe("WC-123");
  });

  it("suggests the next stock number without insisting on it", () => {
    expect(nextStockNumber("1403-007")).toBe("1403-008");
    expect(nextStockNumber("999")).toBe("1000");
    expect(nextStockNumber("A-09")).toBe("A-10");
    expect(nextStockNumber("بدون شماره")).toBeNull();
    expect(nextStockNumber(null)).toBeNull();
  });
});

describe("the dashboard summary", () => {
  const lot = [
    { state: "in_stock", condition: "new", effectiveCostRial: 5_000_000_000, askingPriceRial: 5_800_000_000, acquiredOn: "2025-09-01" },
    { state: "reserved", condition: "used", effectiveCostRial: 3_000_000_000, askingPriceRial: 3_400_000_000, acquiredOn: "2025-07-18" },
    { state: "in_stock", condition: "used", effectiveCostRial: 1_000_000_000, askingPriceRial: 1_500_000_000, acquiredOn: "2025-01-01" },
    { state: "sold", condition: "used", effectiveCostRial: 2_000_000_000, askingPriceRial: 2_400_000_000, acquiredOn: "2025-02-01", soldOn: "2025-03-01", salePriceRial: 2_300_000_000 },
    { state: "archived", condition: "used", effectiveCostRial: 0, askingPriceRial: 0, acquiredOn: "2020-01-01" },
  ] as const;

  const summary = summarizeVehicleStock(lot, "2025-10-01");

  it("counts what is on the lot, ignoring sold and archived units", () => {
    expect(summary.inStock).toBe(2);
    expect(summary.reserved).toBe(1);
    expect(summary.sold).toBe(1);
  });

  it("values the stock at effective cost and prices at asking", () => {
    expect(summary.stockValueRial).toBe(9_000_000_000);
    expect(summary.askingValueRial).toBe(10_700_000_000);
    expect(summary.potentialMarginRial).toBe(1_700_000_000);
  });

  it("ages the lot to the report date and counts the slow and dead", () => {
    // 30, 75 and 273 days at the report date: fresh, slow, dead.
    expect(summary.averageAgeDays).toBe(Math.round((30 + 75 + 273) / 3));
    expect(summary.slowCount).toBe(1);
    expect(summary.deadCount).toBe(1);
  });

  it("has no average age for an empty lot rather than dividing by zero", () => {
    expect(summarizeVehicleStock([], "2025-10-01").averageAgeDays).toBeNull();
  });
});

describe("jalaliMonthRange", () => {
  it("returns the first and last day of the Jalali month a date falls in", () => {
    // 2026-01-10 is 20 Dey 1404; Dey has 30 days.
    expect(jalaliMonthRange("2026-01-10")).toEqual(["2025-12-22", "2026-01-20"]);
    // 2026-04-05 is 16 Farvardin 1405 (Nowruz 1405 = 2026-03-21), 31 days long.
    expect(jalaliMonthRange("2026-04-05")).toEqual(["2026-03-21", "2026-04-20"]);
  });

  it("handles Esfand of a leap year without inventing a day", () => {
    const [start, end] = jalaliMonthRange("2026-03-15"); // 24 Esfand 1404
    expect(start).toBe("2026-02-20");
    expect(end).toBe("2026-03-20");
  });
});

describe("summarizeVehicleStock month figures", () => {
  const onDate = "2026-01-15"; // 25 Dey 1404

  it("counts this Jalali month's sales, at net revenue and the frozen cost", () => {
    const summary = summarizeVehicleStock(
      [
        // Sold inside Dey 1404 (2025-12-22 … 2026-01-20).
        {
          state: "sold",
          condition: "new",
          effectiveCostRial: 700_000_000,
          askingPriceRial: 900_000_000,
          acquiredOn: "2025-12-01",
          soldOn: "2026-01-05",
          salePriceRial: 981_000_000,
          saleNetRial: 900_000_000,
          soldCostRial: 700_000_000,
        },
        // Sold in the PREVIOUS Gregorian month, in the same Jalali month —
        // both must count, which is the whole point of a Jalali range.
        {
          state: "sold",
          condition: "used",
          effectiveCostRial: 400_000_000,
          askingPriceRial: 500_000_000,
          acquiredOn: "2025-11-01",
          soldOn: "2025-12-28",
          salePriceRial: 545_000_000,
          saleNetRial: 500_000_000,
          soldCostRial: 400_000_000,
        },
        // Sold *after* the month: a lifetime sale, but not this month's.
        {
          state: "sold",
          condition: "new",
          effectiveCostRial: 1_000_000_000,
          askingPriceRial: 1_200_000_000,
          acquiredOn: "2025-10-01",
          soldOn: "2026-01-25",
          salePriceRial: 1_308_000_000,
          saleNetRial: 1_200_000_000,
          soldCostRial: 1_000_000_000,
        },
        {
          state: "in_stock",
          condition: "new",
          effectiveCostRial: 600_000_000,
          askingPriceRial: 750_000_000,
          acquiredOn: "2026-01-02",
        },
      ],
      onDate,
    );

    expect(summary.sold).toBe(3);
    expect(summary.soldThisMonth).toBe(2);
    // VAT is never margin: 981m invoice and 545m invoice both come in net.
    expect(summary.revenueThisMonthRial).toBe(1_400_000_000);
    expect(summary.grossProfitThisMonthRial).toBe(300_000_000);
    expect(summary.averageMarginThisMonth).toBe(21.4);
    // The stock side is untouched by any of it.
    expect(summary.inStock).toBe(1);
    expect(summary.stockValueRial).toBe(600_000_000);
  });

  it("answers a month with no sales with zeros rather than a NaN margin", () => {
    const summary = summarizeVehicleStock(
      [
        {
          state: "in_stock",
          condition: "new",
          effectiveCostRial: 600_000_000,
          askingPriceRial: 750_000_000,
          acquiredOn: "2026-01-02",
        },
      ],
      onDate,
    );
    expect(summary.soldThisMonth).toBe(0);
    expect(summary.revenueThisMonthRial).toBe(0);
    expect(summary.grossProfitThisMonthRial).toBe(0);
    expect(summary.averageMarginThisMonth).toBeNull();
  });
});

