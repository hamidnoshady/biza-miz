/**
 * Issue #839 §14 — running the dealership's reports against the database.
 *
 * Everything computed here is a *read*: the rows are the same
 * `automotive_vehicle_attributes` (plus their costs and their holds) the
 * manager works on, and every total comes from `automotive-reports.ts`, so the
 * report and the board cannot disagree about what «ارزش موجودی» means.
 *
 * Two deliberate choices:
 *
 *   * **The frozen cost is the sale's cost.** A sold car reports the
 *     `frozen_effective_cost_rial` the sale wrote — the number COGS posted —
 *     even if reconditioning was recorded afterwards. That is what makes a
 *     closed period's profit final.
 *   * **A reversal is visible, not erased.** A sale that was reversed is still
 *     a sale that happened: its row carries `reversed: true` and the summary
 *     counts it, so «۳ فروش و ۱ برگشت» never silently reads as «۲ فروش».
 *
 * DB-touching, so per repo convention (see automotive-reports.ts for the pure
 * rules) it has no unit test; the shapes it returns are covered by
 * integration/automotive-reports.integration.test.ts.
 */
import { query } from "./db";
import { daysInStock, vehicleAgeBucket, vehicleDisplayName } from "./automotive";
import {
  vehicleInventorySummary,
  vehicleReservationSummary,
  vehicleSalesSummary,
  type VehicleAcquisitionPeriodSummary,
  type VehicleInventoryReportRow,
  type VehicleInventorySummary,
  type VehicleReservationReportRow,
  type VehicleReservationSummary,
  type VehicleSalesReportRow,
  type VehicleSalesSummary,
} from "./automotive-reports";

/** §14's «موجودی خودرو» — the stock the dealership owns right now, sold and archived cars excluded. */
export interface VehicleInventoryReport {
  rows: VehicleInventoryReportRow[];
  summary: VehicleInventorySummary;
  today: string;
}

interface InventoryDbRow {
  serial_id: string;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  model_year: number | null;
  condition: "new" | "used";
  state: string;
  location_id: string;
  location_name: string | null;
  acquired_on: string;
  acquisition_source: string | null;
  acquisition_cost_rial: string;
  capitalized_cost_rial: string;
  period_expense_rial: string;
  asking_price_rial: string;
  minimum_price_rial: string | null;
  vin: string | null;
  plate_number: string | null;
}

export async function vehicleInventoryReport(
  businessId: string,
  options: { locationId?: string | null; today: string; includeArchived?: boolean },
): Promise<VehicleInventoryReport> {
  const params: unknown[] = [businessId];
  const where = ["v.business_id = $1"];
  if (options.locationId) where.push(`v.location_id = $${params.push(options.locationId)}`);
  // A car that is sold is not stock, and neither is one that was written off —
  // unless the caller explicitly asks for the archive, which is how a report
  // reconciles what left the lot.
  where.push(options.includeArchived ? "v.state <> 'sold'" : "v.state NOT IN ('sold', 'archived')");

  const { rows } = (await query(
    `SELECT v.serial_id, v.stock_number, v.make, v.model, v.trim, v.model_year, v.condition, v.state,
            v.location_id, l.name AS location_name,
            coalesce(v.acquisition_date, v.created_at::date)::text AS acquired_on,
            v.acquisition_source,
            v.purchase_cost_rial::text AS acquisition_cost_rial,
            coalesce(c.capitalized_cost_rial, 0)::text AS capitalized_cost_rial,
            coalesce(c.period_expense_rial, 0)::text AS period_expense_rial,
            v.asking_price_rial::text AS asking_price_rial,
            v.minimum_price_rial::text AS minimum_price_rial,
            v.vin, v.plate_number
       FROM automotive_vehicle_attributes v
       LEFT JOIN locations l ON l.id = v.location_id AND l.business_id = v.business_id
       LEFT JOIN (
         SELECT business_id, serial_id,
                sum(amount_rial) FILTER (WHERE posting = 'capitalized') AS capitalized_cost_rial,
                sum(amount_rial) FILTER (WHERE posting = 'period_expense') AS period_expense_rial
           FROM automotive_vehicle_costs WHERE status = 'active' GROUP BY business_id, serial_id
       ) c ON c.business_id = v.business_id AND c.serial_id = v.serial_id
      WHERE ${where.join(" AND ")}
      ORDER BY acquired_on, v.stock_number`,
    params,
  )) as unknown as { rows: InventoryDbRow[] };

  const reportRows: VehicleInventoryReportRow[] = rows.map((row) => {
    const acquisition = Number(row.acquisition_cost_rial);
    const capitalized = Number(row.capitalized_cost_rial);
    const asking = Number(row.asking_price_rial);
    const effective = acquisition + capitalized;
    const age = daysInStock({ acquiredOn: row.acquired_on }, options.today);
    return {
      serialId: row.serial_id,
      stockNumber: row.stock_number,
      displayName: vehicleDisplayName({
        make: row.make,
        model: row.model,
        trim: row.trim,
        modelYear: row.model_year,
      }),
      make: row.make,
      model: row.model,
      modelYear: row.model_year,
      condition: row.condition,
      state: row.state,
      locationId: row.location_id,
      locationName: row.location_name,
      acquiredOn: row.acquired_on,
      acquisitionSource: row.acquisition_source,
      daysInStock: age,
      ageBucket: vehicleAgeBucket(age),
      acquisitionCostRial: acquisition,
      capitalizedCostRial: capitalized,
      periodExpenseRial: Number(row.period_expense_rial),
      effectiveCostRial: effective,
      askingPriceRial: asking,
      potentialMarginRial: asking - effective,
      minimumPriceRial: row.minimum_price_rial == null ? null : Number(row.minimum_price_rial),
      vin: row.vin,
      plateNumber: row.plate_number,
    };
  });

  return { rows: reportRows, summary: vehicleInventorySummary(reportRows), today: options.today };
}

/** §14's «فروش و سودآوری خودرو» — what sold in the period, and what it earned. */
export interface VehicleSalesReport {
  rows: VehicleSalesReportRow[];
  summary: VehicleSalesSummary;
  dateFrom: string | null;
  dateTo: string | null;
}

interface SalesDbRow {
  serial_id: string;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  model_year: number | null;
  condition: "new" | "used";
  sale_status: "active" | "reversed";
  sold_on: string;
  acquired_on: string | null;
  sale_price_rial: string;
  frozen_effective_cost_rial: string;
  vat_rial: string;
  salesperson_id: string | null;
  salesperson_name: string | null;
  location_id: string;
  location_name: string | null;
  trade_in_id: string | null;
  trade_in_status: string | null;
  trade_in_acquired_stock_number: string | null;
  trade_in_allowance_rial: string | null;
  trade_in_applied_rial: string | null;
}

export async function vehicleSalesReport(
  businessId: string,
  options: { locationId?: string | null; dateFrom?: string | null; dateTo?: string | null },
): Promise<VehicleSalesReport> {
  const params: unknown[] = [businessId];
  const where = ["s.business_id = $1"];
  if (options.locationId) where.push(`s.location_id = $${params.push(options.locationId)}`);
  if (options.dateFrom) where.push(`s.sold_on >= $${params.push(options.dateFrom)}`);
  if (options.dateTo) where.push(`s.sold_on <= $${params.push(options.dateTo)}`);

  const { rows } = (await query(
    `SELECT s.serial_id, s.stock_number, s.make, s.model, s.trim, s.model_year,
            s.condition, s.status AS sale_status, s.sold_on::text AS sold_on,
            s.acquired_on::text AS acquired_on, s.sale_price_rial::text AS sale_price_rial,
            coalesce(s.frozen_effective_cost_rial, (
              SELECT sum(jl.debit) FROM journal_entries e
                JOIN journal_lines jl ON jl.entry_id = e.id
                JOIN accounts a ON a.id = jl.account_id
               WHERE e.business_id = s.business_id
                 AND (e.source_id = s.sale_id OR e.id = ANY(s.sale_entry_ids))
                 AND e.posting_kind = 'automotive_sale_cogs' AND a.code = '5194'
            ), 0)::text AS frozen_effective_cost_rial,
            s.location_id, l.name AS location_name,
            s.sold_by AS salesperson_id, u.full_name AS salesperson_name,
            -- The VAT the invoice charged: read by this occurrence's unique
            -- posting identity, with its canonical captured entry ids as the
            -- compatibility key for legacy rows lacking a recoverable source id.
            coalesce((
              SELECT sum(jl.credit) FROM journal_entries e
                JOIN journal_lines jl ON jl.entry_id = e.id
                JOIN accounts a ON a.id = jl.account_id
               WHERE e.business_id = s.business_id
                 AND (e.source_id = s.sale_id OR e.id = ANY(s.sale_entry_ids))
                 AND e.posting_kind = 'automotive_sale_revenue' AND a.code = '2200'
            ), 0)::text AS vat_rial,
            -- Issue #963 — the trade-in link of this occurrence, when the
            -- sale had one. One link per sale (migration 0239), so the join
            -- cannot fan a sale out into two report rows; the allowance is
            -- reported beside the sale, never inside its revenue.
            t.id AS trade_in_id, t.status AS trade_in_status,
            tb.stock_number AS trade_in_acquired_stock_number,
            t.allowance_rial::text AS trade_in_allowance_rial,
            t.trade_in_applied_rial::text AS trade_in_applied_rial
       FROM automotive_vehicle_sales s
       LEFT JOIN locations l ON l.id = s.location_id AND l.business_id = s.business_id
       LEFT JOIN users u ON u.id = s.sold_by AND u.business_id = s.business_id
       LEFT JOIN automotive_vehicle_trade_ins t
              ON t.sale_id = s.sale_id AND t.business_id = s.business_id
       LEFT JOIN automotive_vehicle_attributes tb
              ON tb.serial_id = t.acquired_serial_id AND tb.business_id = s.business_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.sold_on, s.stock_number, s.created_at`,
    params,
  )) as unknown as { rows: SalesDbRow[] };

  const reportRows: VehicleSalesReportRow[] = rows.map((row) => {
    const gross = Number(row.sale_price_rial);
    const vat = Number(row.vat_rial);
    // The ledger's revenue is the net (invoice total less the VAT it posted);
    // taking it from the entry keeps the report tied to the books rather than
    // to a rate this file would have to guess.
    const revenue = Math.max(0, gross - vat);
    const cost = Number(row.frozen_effective_cost_rial);
    return {
      serialId: row.serial_id,
      stockNumber: row.stock_number,
      displayName: vehicleDisplayName({
        make: row.make,
        model: row.model,
        trim: row.trim,
        modelYear: row.model_year,
      }),
      make: row.make,
      model: row.model,
      modelYear: row.model_year,
      condition: row.condition,
      soldOn: row.sold_on,
      daysToSale: row.acquired_on ? daysInStock({ acquiredOn: row.acquired_on }, row.sold_on) : null,
      salePriceRial: gross,
      revenueRial: revenue,
      effectiveCostRial: cost,
      grossProfitRial: revenue - cost,
      marginPercent: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
      salespersonId: row.salesperson_id,
      salespersonName: row.salesperson_name,
      locationId: row.location_id,
      locationName: row.location_name,
      // A sold-then-returned car: still a sale in the period, visibly reversed.
      reversed: row.sale_status === "reversed",
      tradeInId: row.trade_in_id,
      tradeInAcquiredStockNumber: row.trade_in_acquired_stock_number,
      tradeInAllowanceRial: row.trade_in_allowance_rial == null ? null : Number(row.trade_in_allowance_rial),
      tradeInAppliedRial: row.trade_in_applied_rial == null ? null : Number(row.trade_in_applied_rial),
      tradeInReversed: row.trade_in_status === "reversed",
    };
  });

  const acquisitions = await acquisitionSummary(businessId, options);

  return {
    rows: reportRows,
    summary: vehicleSalesSummary(reportRows, acquisitions),
    dateFrom: options.dateFrom ?? null,
    dateTo: options.dateTo ?? null,
  };
}

async function acquisitionSummary(
  businessId: string,
  options: { locationId?: string | null; dateFrom?: string | null; dateTo?: string | null },
): Promise<VehicleAcquisitionPeriodSummary> {
  const params: unknown[] = [businessId];
  const where = ["business_id = $1", "acquisition_date IS NOT NULL", "purchase_cost_rial > 0"];
  if (options.locationId) where.push(`location_id = $${params.push(options.locationId)}`);
  if (options.dateFrom) where.push(`acquisition_date >= $${params.push(options.dateFrom)}`);
  if (options.dateTo) where.push(`acquisition_date <= $${params.push(options.dateTo)}`);
  // Issue #963 — a handed-in car whose deal was reversed went back to its
  // customer and its acquisition entry was mirrored: it is not a car the
  // period bought. A live trade-in *is* one (at its allowance), and the
  // FILTERed pair breaks it out as a subset rather than a second total.
  where.push(
    `NOT EXISTS (SELECT 1 FROM automotive_vehicle_trade_ins t
                  WHERE t.business_id = automotive_vehicle_attributes.business_id
                    AND t.acquired_serial_id = automotive_vehicle_attributes.serial_id
                    AND t.status = 'reversed')`,
  );
  const { rows } = await query<{
    count: string;
    cost_rial: string | null;
    trade_in_count: string;
    trade_in_cost_rial: string | null;
  }>(
    `SELECT count(*)::text AS count, coalesce(sum(purchase_cost_rial), 0)::text AS cost_rial,
            count(*) FILTER (WHERE acquisition_source = 'trade_in')::text AS trade_in_count,
            coalesce(sum(purchase_cost_rial) FILTER (WHERE acquisition_source = 'trade_in'), 0)::text AS trade_in_cost_rial
       FROM automotive_vehicle_attributes WHERE ${where.join(" AND ")}`,
    params,
  );
  return {
    count: Number(rows[0]?.count ?? 0),
    costRial: Number(rows[0]?.cost_rial ?? 0),
    tradeInCount: Number(rows[0]?.trade_in_count ?? 0),
    tradeInCostRial: Number(rows[0]?.trade_in_cost_rial ?? 0),
  };
}

/** §14's «رزروها و بیعانه‌ها» — the holds, and the money they are holding. */
export interface VehicleReservationReport {
  rows: VehicleReservationReportRow[];
  summary: VehicleReservationSummary;
  today: string;
}

interface ReservationDbRow {
  id: string;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  model_year: number | null;
  customer_name: string | null;
  status: "active" | "converted" | "released" | "expired";
  expires_at: string | null;
  expires_at_time: string | null;
  deposit_amount_rial: string;
  deposit_method: string | null;
  deposit_refundable: boolean;
  deposit_refund_entry_id: string | null;
  created_at: string;
  closed_at: string | null;
  location_id: string;
  location_name: string | null;
  release_reason: string | null;
}

export async function vehicleReservationReport(
  businessId: string,
  options: { locationId?: string | null; today: string },
): Promise<VehicleReservationReport> {
  const params: unknown[] = [businessId];
  const where = ["r.business_id = $1"];
  if (options.locationId) where.push(`r.location_id = $${params.push(options.locationId)}`);

  const { rows } = (await query(
    `SELECT r.id, v.stock_number, v.make, v.model, v.trim, v.model_year, p.name AS customer_name,
            r.status, r.expires_at::text AS expires_at, r.expires_at_time::text AS expires_at_time,
            r.deposit_amount_rial::text AS deposit_amount_rial, r.deposit_method, r.deposit_refundable,
            r.deposit_refund_entry_id, r.created_at::text AS created_at, r.closed_at::text AS closed_at,
            r.location_id, l.name AS location_name, r.release_reason
       FROM serial_reservations r
       JOIN automotive_vehicle_attributes v ON v.serial_id = r.serial_id AND v.business_id = r.business_id
       LEFT JOIN parties p ON p.id = r.customer_id AND p.business_id = r.business_id
       LEFT JOIN locations l ON l.id = r.location_id AND l.business_id = r.business_id
      WHERE ${where.join(" AND ")}
      ORDER BY (r.status = 'active') DESC, r.created_at DESC`,
    params,
  )) as unknown as { rows: ReservationDbRow[] };

  const reportRows: VehicleReservationReportRow[] = rows.map((row) => ({
    id: row.id,
    stockNumber: row.stock_number,
    displayName: vehicleDisplayName({
      make: row.make,
      model: row.model,
      trim: row.trim,
      modelYear: row.model_year,
    }),
    customerName: row.customer_name,
    status: row.status,
    expiresAt: row.expires_at,
    expiresAtTime: row.expires_at_time,
    depositRial: Number(row.deposit_amount_rial),
    depositMethod: row.deposit_method,
    depositRefundable: row.deposit_refundable,
    // The amount that actually went back is the deposit whose refund entry
    // exists — not the amount that merely *could* be refunded.
    depositRefundedRial: row.deposit_refund_entry_id ? Number(row.deposit_amount_rial) : 0,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    ageDays: daysInStock({ acquiredOn: row.created_at.slice(0, 10) }, options.today),
    locationId: row.location_id,
    locationName: row.location_name,
    releaseReason: row.release_reason,
  }));

  return { rows: reportRows, summary: vehicleReservationSummary(reportRows, options.today), today: options.today };
}
