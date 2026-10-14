/**
 * Issue #839 §14 — the dealership's reports, as arithmetic.
 *
 * Every number the automotive reports show is computed here, from rows the
 * service fetched, with no database and no clock of its own: the same shape
 * `industry-reports.ts` gives the trade reports next to it, and for the same
 * reason — the report, the dashboard and a test can all agree about what
 * «حاشیهٔ ناخالص» means because there is one function that decides.
 *
 * Two of these rules are worth stating out loud, because both are places a
 * dealership's books are commonly wrong:
 *
 *   * **Gross profit is revenue net of VAT and discount, minus the frozen
 *     effective cost** — the number COGS posted for that car, not today's
 *     estimate of what the car cost. The frozen cost is what makes a period's
 *     margin reproducible month after month: a reconditioning invoice entered
 *     later changes the *next* car's basis, never last month's profit.
 *   * **A deposit is not revenue.** The reservation summary reports deposits as
 *     money *held* (the customer-advance liability), separately from sales, so
 *     nobody adds «جمع بیعانه» to «فروش».
 */
import { VEHICLE_AGE_BUCKET_LABELS, daysInStock, vehicleAgeBucket, vehicleDisplayName } from "./automotive";

/* ---------------------------------------------------------------------------
 * Stock, valuation and aging
 * ------------------------------------------------------------------------- */

export interface VehicleInventoryReportRow {
  serialId: string;
  stockNumber: string;
  displayName: string;
  make: string;
  model: string;
  modelYear: number | null;
  condition: "new" | "used";
  state: string;
  locationId: string;
  locationName: string | null;
  acquiredOn: string;
  daysInStock: number;
  /** `fresh` / `slow` / `dead`, from the same thresholds `automotive.ts` owns. */
  ageBucket: "fresh" | "slow" | "dead";
  /** §4's original purchase price — the number that never changes. */
  acquisitionCostRial: number;
  /** Money added to the car's basis (freight, customs, repairs, preparation). */
  capitalizedCostRial: number;
  /** Money spent on the car that was *expensed* rather than capitalized. */
  periodExpenseRial: number;
  /** `acquisition + capitalized` — what the car stands at today. */
  effectiveCostRial: number;
  askingPriceRial: number;
  potentialMarginRial: number;
  /** The owner's floor, when one is recorded. */
  minimumPriceRial: number | null;
  vin: string | null;
  plateNumber: string | null;
}

export interface VehicleBranchStock {
  locationId: string;
  locationName: string | null;
  count: number;
  effectiveCostRial: number;
  askingPriceRial: number;
}

export interface VehicleInventorySummary {
  count: number;
  newCount: number;
  usedCount: number;
  inStockCount: number;
  reservedCount: number;
  totalAcquisitionCostRial: number;
  totalCapitalizedCostRial: number;
  totalPeriodExpenseRial: number;
  totalEffectiveCostRial: number;
  totalAskingPriceRial: number;
  totalPotentialMarginRial: number;
  averageAgeDays: number | null;
  slowCount: number;
  deadCount: number;
  ageBuckets: { bucket: "fresh" | "slow" | "dead"; label: string; count: number }[];
  byBranch: VehicleBranchStock[];
}

/**
 * The lot's own totals. `states` outside the sellable shelf (`sold`,
 * `archived`) are the caller's filter, not this function's: it reports what it
 * is given, so the service can ask for stock today and a past period later
 * without two code paths disagreeing.
 */
export function vehicleInventorySummary(rows: VehicleInventoryReportRow[]): VehicleInventorySummary {
  const byBranch = new Map<string, VehicleBranchStock>();
  let capitalized = 0;
  let periodExpense = 0;
  let acquisition = 0;
  let effective = 0;
  let asking = 0;
  let ageSum = 0;
  let slow = 0;
  let dead = 0;
  const buckets: Record<"fresh" | "slow" | "dead", number> = { fresh: 0, slow: 0, dead: 0 };

  for (const row of rows) {
    acquisition += row.acquisitionCostRial;
    capitalized += row.capitalizedCostRial;
    periodExpense += row.periodExpenseRial;
    effective += row.effectiveCostRial;
    asking += row.askingPriceRial;
    ageSum += row.daysInStock;
    buckets[row.ageBucket] += 1;
    if (row.ageBucket === "slow") slow += 1;
    if (row.ageBucket === "dead") dead += 1;

    const branch = byBranch.get(row.locationId) ?? {
      locationId: row.locationId,
      locationName: row.locationName,
      count: 0,
      effectiveCostRial: 0,
      askingPriceRial: 0,
    };
    branch.count += 1;
    branch.effectiveCostRial += row.effectiveCostRial;
    branch.askingPriceRial += row.askingPriceRial;
    byBranch.set(row.locationId, branch);
  }

  return {
    count: rows.length,
    newCount: rows.filter((row) => row.condition === "new").length,
    usedCount: rows.filter((row) => row.condition === "used").length,
    inStockCount: rows.filter((row) => row.state === "in_stock").length,
    reservedCount: rows.filter((row) => row.state === "reserved").length,
    totalAcquisitionCostRial: acquisition,
    totalCapitalizedCostRial: capitalized,
    totalPeriodExpenseRial: periodExpense,
    totalEffectiveCostRial: effective,
    totalAskingPriceRial: asking,
    totalPotentialMarginRial: asking - effective,
    averageAgeDays: rows.length === 0 ? null : Math.round(ageSum / rows.length),
    slowCount: slow,
    deadCount: dead,
    ageBuckets: (["fresh", "slow", "dead"] as const).map((bucket) => ({
      bucket,
      label: VEHICLE_AGE_BUCKET_LABELS[bucket],
      count: buckets[bucket],
    })),
    byBranch: [...byBranch.values()].sort((a, b) => b.count - a.count),
  };
}

/* ---------------------------------------------------------------------------
 * Sales, gross profit and days to sale
 * ------------------------------------------------------------------------- */

export interface VehicleSalesReportRow {
  serialId: string;
  stockNumber: string;
  displayName: string;
  make: string;
  model: string;
  modelYear: number | null;
  condition: "new" | "used";
  soldOn: string;
  /** Business days between acquisition and sale — the lot's own turnover number. */
  daysToSale: number | null;
  /** Invoice total, VAT included — what the customer paid. */
  salePriceRial: number;
  /** Net of VAT: the revenue the ledger credited. */
  revenueRial: number;
  /** The frozen effective cost COGS posted for this car. */
  effectiveCostRial: number;
  grossProfitRial: number;
  marginPercent: number | null;
  salespersonId: string | null;
  salespersonName: string | null;
  locationId: string;
  locationName: string | null;
  /** True when the sale was subsequently reversed (the car is `returned`). */
  reversed: boolean;
}

export interface VehicleProfitGroup {
  key: string;
  label: string;
  units: number;
  revenueRial: number;
  grossProfitRial: number;
  marginPercent: number | null;
  averageDaysToSale: number | null;
}

export interface VehicleAcquisitionPeriodSummary {
  count: number;
  costRial: number;
}

export interface VehicleSalesSummary {
  unitsSold: number;
  /** Invoice totals, VAT included. */
  revenueGrossRial: number;
  revenueRial: number;
  cogsRial: number;
  grossProfitRial: number;
  averageMarginPercent: number | null;
  averageDaysToSale: number | null;
  /** The period's cars bought in, beside the ones sold: §14's «خرید و فروش دوره». */
  acquisitions: VehicleAcquisitionPeriodSummary;
  bySalesperson: VehicleProfitGroup[];
  byMakeModel: VehicleProfitGroup[];
  reversedCount: number;
}

/** Gross margin as a percentage of net revenue; null when there is no revenue to divide by. */
export function vehicleMarginPercent(revenueRial: number, costRial: number): number | null {
  if (revenueRial <= 0) return null;
  return Math.round(((revenueRial - costRial) / revenueRial) * 1000) / 10;
}

function groupProfit(
  rows: VehicleSalesReportRow[],
  keyOf: (row: VehicleSalesReportRow) => { key: string; label: string } | null,
): VehicleProfitGroup[] {
  const groups = new Map<string, { label: string; rows: VehicleSalesReportRow[] }>();
  for (const row of rows) {
    const group = keyOf(row);
    if (!group) continue;
    const bucket = groups.get(group.key) ?? { label: group.label, rows: [] };
    bucket.rows.push(row);
    groups.set(group.key, bucket);
  }
  return [...groups.entries()]
    .map(([key, bucket]) => {
      const revenue = bucket.rows.reduce((total, row) => total + row.revenueRial, 0);
      const cost = bucket.rows.reduce((total, row) => total + row.effectiveCostRial, 0);
      const days = bucket.rows
        .map((row) => row.daysToSale)
        .filter((value): value is number => value != null);
      return {
        key,
        label: bucket.label,
        units: bucket.rows.length,
        revenueRial: revenue,
        grossProfitRial: revenue - cost,
        marginPercent: vehicleMarginPercent(revenue, cost),
        averageDaysToSale:
          days.length === 0 ? null : Math.round(days.reduce((total, value) => total + value, 0) / days.length),
      };
    })
    .sort((a, b) => b.grossProfitRial - a.grossProfitRial);
}

export function vehicleSalesSummary(
  rows: VehicleSalesReportRow[],
  acquisitions: VehicleAcquisitionPeriodSummary = { count: 0, costRial: 0 },
): VehicleSalesSummary {
  const revenue = rows.reduce((total, row) => total + row.revenueRial, 0);
  const gross = rows.reduce((total, row) => total + row.salePriceRial, 0);
  const cogs = rows.reduce((total, row) => total + row.effectiveCostRial, 0);
  const days = rows.map((row) => row.daysToSale).filter((value): value is number => value != null);

  return {
    unitsSold: rows.length,
    revenueGrossRial: gross,
    revenueRial: revenue,
    cogsRial: cogs,
    grossProfitRial: revenue - cogs,
    averageMarginPercent: vehicleMarginPercent(revenue, cogs),
    averageDaysToSale:
      days.length === 0 ? null : Math.round(days.reduce((total, value) => total + value, 0) / days.length),
    acquisitions,
    bySalesperson: groupProfit(rows, (row) =>
      row.salespersonId
        ? { key: row.salespersonId, label: row.salespersonName ?? "بدون نام" }
        : // A sale with no recorded salesperson is *not* silently dropped from
          // the breakdown: it is a bucket of its own, and seeing it is how an
          // owner notices the counter stopped stamping the seller.
          { key: "unassigned", label: "بدون فروشندهٔ ثبت‌شده" },
    ),
    byMakeModel: groupProfit(rows, (row) => ({
      key: `${row.make} ${row.model}`.trim(),
      label: vehicleDisplayName({ make: row.make, model: row.model }),
    })),
    reversedCount: rows.filter((row) => row.reversed).length,
  };
}

/* ---------------------------------------------------------------------------
 * Reservations and the money they hold
 * ------------------------------------------------------------------------- */

export interface VehicleReservationReportRow {
  id: string;
  stockNumber: string;
  displayName: string;
  customerName: string | null;
  status: "active" | "converted" | "released" | "expired";
  expiresAt: string | null;
  expiresAtTime: string | null;
  depositRial: number;
  depositMethod: string | null;
  depositRefundable: boolean;
  depositRefundedRial: number;
  createdAt: string;
  closedAt: string | null;
  ageDays: number;
  locationId: string;
  locationName: string | null;
  releaseReason: string | null;
}

export interface VehicleReservationSummary {
  total: number;
  activeCount: number;
  convertedCount: number;
  releasedCount: number;
  expiredCount: number;
  /** Money held against live holds — a liability, never revenue. */
  depositHeldRial: number;
  /** Deposits refunded in the period, for reconciling against 2430. */
  depositRefundedRial: number;
  /** Live holds whose deposit is not refundable — the part a cancel would keep. */
  nonRefundableHeldRial: number;
  expiringSoonCount: number;
}

/**
 * `expiringWithinDays` counts live holds that lapse within that many days of
 * `todayIso` — the list the counter rings the customer about. Holds with no
 * expiry are "until released" and never appear here.
 */
export function vehicleReservationSummary(
  rows: VehicleReservationReportRow[],
  todayIso: string,
  expiringWithinDays = 3,
): VehicleReservationSummary {
  let held = 0;
  let refunded = 0;
  let nonRefundableHeld = 0;
  let expiringSoon = 0;
  for (const row of rows) {
    if (row.status === "active") {
      held += row.depositRial;
      if (!row.depositRefundable) nonRefundableHeld += row.depositRial;
      if (row.expiresAt) {
        const daysLeft = daysInStock({ acquiredOn: todayIso }, row.expiresAt);
        if (daysLeft >= 0 && daysLeft <= expiringWithinDays) expiringSoon += 1;
      }
    }
    refunded += row.depositRefundedRial;
  }
  return {
    total: rows.length,
    activeCount: rows.filter((row) => row.status === "active").length,
    convertedCount: rows.filter((row) => row.status === "converted").length,
    releasedCount: rows.filter((row) => row.status === "released").length,
    expiredCount: rows.filter((row) => row.status === "expired").length,
    depositHeldRial: held,
    depositRefundedRial: refunded,
    nonRefundableHeldRial: nonRefundableHeld,
    expiringSoonCount: expiringSoon,
  };
}

/** The age bucket a stock row belongs to — re-exported so a caller names it once. */
export { vehicleAgeBucket };
