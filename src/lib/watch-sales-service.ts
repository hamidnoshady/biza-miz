/**
 * Phase 21 Wave 5 — selling one serialized unit (a watch), and the warranty
 * window that starts when it sells.
 *
 * The serial counterpart of `gold-sales-service.ts`: same discipline (all
 * work happens in the caller's own transaction, so a sale is atomic with
 * its postings, its status change, and its warranty row), same two-event
 * split (revenue, then COGS), and the same refusal to sell a unit with no
 * cost basis recorded.
 *
 * DB-touching, so per repo convention (see watch-pricing.ts/watch.ts for
 * the pure rules this leans on) it has no direct unit test; covered instead
 * by integration/watch-sales.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { computeWatchSalePrice, type WatchSalePriceBreakdown } from "./watch-pricing";
import { addMonthsToIsoDate, validateWarrantyMonths } from "./watch";
import { getItem } from "./items-service";
import { emitDomainEvent } from "./posting-engine";
import { rialText, type RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
import { resolveLineTenders, type RetailTenderQueueEntry } from "./retail-tenders";
// Side-effect import: registers the watch.* posting rules with the engine.
import "./watch-posting-rules";

export interface SellSerializedUnitInput {
  businessId: string;
  locationId: string;
  serialId: string;
  /** Agreed pre-VAT price of this unit (Rial, whole). */
  price: number;
  discount?: number;
  vatPercent: number;
  /** The whole unit paid one way — every pre-split caller (the watch quick-sell panel). */
  paymentMethod?: SettlementMethod;
  /** A retail invoice's shared tender queue (retail-tenders.ts) — mutually exclusive with `paymentMethod`. */
  tenders?: RetailTenderQueueEntry[];
  /** Overrides the unit's standard term recorded at intake; omit to use that. */
  warrantyMonths?: number;
  /** ISO date (YYYY-MM-DD); defaults to today. The warranty window starts here. */
  saleDate?: string;
  createdBy?: string | null;
}

export interface SerialWarranty {
  serialId: string;
  months: number;
  startDate: string;
  endDate: string;
}

export interface SellSerializedUnitResult {
  breakdown: WatchSalePriceBreakdown;
  revenueEntryId: string | null;
  cogsEntryId: string | null;
  warranty: SerialWarranty | null;
  /** The COGS this sale posted, Rial — the unit's recorded cost basis. */
  cost: RialText;
}

interface SerialLookupRow {
  id: string;
  item_id: string;
  serial_number: string;
  status: string;
  unit_cost: string | null;
  warranty_months: number;
  location_id: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function sellSerializedUnit(
  client: PoolClient,
  input: SellSerializedUnitInput,
): Promise<SellSerializedUnitResult> {
  const { rows } = await client.query<SerialLookupRow>(
    `SELECT s.id, s.item_id, s.serial_number, s.status, s.unit_cost, s.warranty_months, i.location_id
       FROM item_serials s JOIN items i ON i.id = s.item_id
      WHERE s.id = $1`,
    [input.serialId],
  );
  const serial = rows[0];
  if (!serial) throw new Error("سریال یافت نشد.");
  if (serial.status !== "in_stock") {
    throw new Error("این دستگاه در انبار موجود نیست (رزرو، در تعمیر یا فروخته‌شده است).");
  }
  if (!serial.unit_cost) {
    throw new Error("بهای تمام‌شده این دستگاه ثبت نشده است؛ ابتدا آن را ثبت کنید.");
  }

  const warrantyMonths = input.warrantyMonths ?? serial.warranty_months;
  const warrantyError = validateWarrantyMonths(warrantyMonths);
  if (warrantyError) throw new Error(warrantyError);

  const breakdown = computeWatchSalePrice({
    price: input.price,
    discount: input.discount ?? 0,
    vatPercent: input.vatPercent,
  });

  const saleDate = input.saleDate ?? todayIso();
  const lineTenders = resolveLineTenders(input, breakdown.total);

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "watch.sale_revenue",
    payload: {
      serialId: serial.id,
      itemId: serial.item_id,
      price: breakdown.price,
      discount: breakdown.discount,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
      tenders: lineTenders,
    },
    sourceType: "watch_sale",
    sourceId: serial.id,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: cogsEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "watch.sale_cogs",
    payload: {
      serialId: serial.id,
      itemId: serial.item_id,
      unitCost: rialText(serial.unit_cost),
    },
    sourceType: "watch_sale",
    sourceId: serial.id,
    createdBy: input.createdBy ?? null,
  });

  await client.query(
    `UPDATE item_serials SET status = 'sold', sold_at = $2, warranty_months = $3 WHERE id = $1`,
    [serial.id, saleDate, warrantyMonths],
  );

  // A zero-month term is a real answer ("sold with no warranty"), so it
  // records no window rather than a zero-length one the reports would then
  // have to filter out everywhere.
  let warranty: SerialWarranty | null = null;
  if (warrantyMonths > 0) {
    const endDate = addMonthsToIsoDate(saleDate, warrantyMonths);
    await client.query(
      `INSERT INTO serial_warranties (serial_id, months, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (serial_id) DO UPDATE
         SET months = EXCLUDED.months, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date`,
      [serial.id, warrantyMonths, saleDate, endDate],
    );
    warranty = { serialId: serial.id, months: warrantyMonths, startDate: saleDate, endDate };
  }

  return { breakdown, revenueEntryId, cogsEntryId, warranty, cost: rialText(serial.unit_cost) };
}

export interface SerialUnitSummary {
  id: string;
  itemId: string;
  itemName: string;
  serialNumber: string;
  status: string;
  unitCost: number | null;
  warrantyMonths: number;
  soldAt: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
}

/** The watch dashboard's unit board: every serialized unit at this branch with its model, cost basis, and live warranty window, in one round trip. */
export async function listSerialUnits(locationId: string): Promise<SerialUnitSummary[]> {
  const { rows } = await query<{
    id: string;
    item_id: string;
    item_name: string;
    serial_number: string;
    status: string;
    unit_cost: string | null;
    warranty_months: number;
    sold_at: string | null;
    warranty_start: string | null;
    warranty_end: string | null;
  }>(
    `SELECT s.id, s.item_id, i.name AS item_name, s.serial_number, s.status, s.unit_cost,
            s.warranty_months, s.sold_at::text AS sold_at,
            w.start_date::text AS warranty_start, w.end_date::text AS warranty_end
       FROM item_serials s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN serial_warranties w ON w.serial_id = s.id
      WHERE i.location_id = $1 AND i.tracking = 'serial'
      ORDER BY i.name, s.serial_number`,
    [locationId],
  );
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    serialNumber: r.serial_number,
    status: r.status,
    unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    warrantyMonths: r.warranty_months,
    soldAt: r.sold_at,
    warrantyStart: r.warranty_start,
    warrantyEnd: r.warranty_end,
  }));
}

/** The warranty window running on a unit, if any — what a repair intake checks to decide whether the job is billable. */
export async function getSerialWarranty(serialId: string): Promise<SerialWarranty | null> {
  const { rows } = await query<{ serial_id: string; months: number; start_date: string; end_date: string }>(
    `SELECT serial_id, months, start_date::text AS start_date, end_date::text AS end_date
       FROM serial_warranties WHERE serial_id = $1`,
    [serialId],
  );
  const row = rows[0];
  return row
    ? { serialId: row.serial_id, months: row.months, startDate: row.start_date, endDate: row.end_date }
    : null;
}
