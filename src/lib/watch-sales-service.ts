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
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "./db";
import { computeWatchSalePrice, type WatchSalePriceBreakdown } from "./watch-pricing";
import { addMonthsToIsoDate, validateWarrantyMonths } from "./watch";
import { getItem } from "./items-service";
import { emitDomainEvent } from "./posting-engine";
import { rialText, type RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
import { resolveLineTenders, type RetailTenderQueueEntry } from "./retail-tenders";
import { resolveReservationForSale } from "./watch-reservation-service";
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
  /**
   * The invoice's customer — what lets a RESERVED unit sell: only to the
   * customer the hold names (issue #795 item 20), closing the hold as
   * converted in the same transaction.
   */
  customerId?: string | null;
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
  if (serial.status !== "in_stock" && serial.status !== "reserved") {
    throw new Error("این دستگاه در انبار موجود نیست (در تعمیر یا فروخته‌شده است).");
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

  // Issue #795 (item 21) — an omitted sale date defaults to the branch's own
  // business-local day, not the UTC calendar day: around local midnight the
  // two disagree, and the warranty window (which starts here) would otherwise
  // open on the wrong business day.
  let saleDate = input.saleDate ?? null;
  if (!saleDate) {
    const { rows: dayRows } = await client.query<{ today: string }>(
      `SELECT app_business_date(now(), coalesce(timezone, 'Asia/Tehran'), business_day_start_minutes)::text AS today
         FROM locations WHERE id = $1`,
      [input.locationId],
    );
    saleDate = dayRows[0]?.today ?? todayIso();
  }

  // Issue #795 item 20 — a reserved unit sells only to the customer its
  // hold names (converting the hold), or to anyone once the hold has
  // expired; otherwise the sale refuses here, before anything posts.
  if (serial.status === "reserved") {
    await resolveReservationForSale(client, {
      serialId: serial.id,
      customerId: input.customerId ?? null,
      saleDate,
    });
  }

  const lineTenders = resolveLineTenders(input, breakdown.total);

  // Each sale OCCURRENCE is its own posting identity. The serial id alone
  // used to be the source id, on the assumption a unit sells exactly once —
  // issue #795's return workflow made that false by design (a
  // returned-sellable unit legitimately sells again), and a second sale
  // with the same (source_type, source_id, posting_kind) would trip
  // uq_journal_business_source_posting. The serial stays queryable through
  // the payload's serialId.
  const saleId = randomUUID();

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
    sourceId: saleId,
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
    sourceId: saleId,
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
  /** Issue #795 item 19 — recorded at pre-owned intake, surfaced on the board. */
  preOwned: boolean;
  conditionGrade: string | null;
  boxAndPapers: boolean;
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
    pre_owned: boolean;
    condition_grade: string | null;
    box_and_papers: boolean;
  }>(
    `SELECT s.id, s.item_id, i.name AS item_name, s.serial_number, s.status, s.unit_cost,
            s.warranty_months, s.sold_at::text AS sold_at,
            w.start_date::text AS warranty_start, w.end_date::text AS warranty_end,
            s.pre_owned, s.condition_grade, s.box_and_papers
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
    preOwned: r.pre_owned,
    conditionGrade: r.condition_grade,
    boxAndPapers: r.box_and_papers,
  }));
}

/** The warranty window running on a unit, if any — what a repair intake checks to decide whether the job is billable. */
export async function getSerialWarranty(serialId: string, client?: PoolClient): Promise<SerialWarranty | null> {
  const sql = `SELECT serial_id, months, start_date::text AS start_date, end_date::text AS end_date
       FROM serial_warranties WHERE serial_id = $1`;
  const { rows } = client
    ? await client.query<{ serial_id: string; months: number; start_date: string; end_date: string }>(sql, [serialId])
    : await query<{ serial_id: string; months: number; start_date: string; end_date: string }>(sql, [serialId]);
  const row = rows[0];
  return row
    ? { serialId: row.serial_id, months: row.months, startDate: row.start_date, endDate: row.end_date }
    : null;
}
