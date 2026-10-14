/**
 * Issue #795 Phase 6 — the serial detail view: everything the shop knows
 * about ONE physical unit, aggregated server-side in one request. This is
 * the "file" a staff member opens when the watch is on the counter:
 * identity + model attributes, lifecycle status, cost basis, warranty
 * window, who owns it (from the persisted invoice), its pre-owned
 * provenance document (with media), every repair it has been through,
 * the live reservation if any, and its branch-transfer history.
 */
import { query } from "./db";
import { getWatchAttributes, type WatchItemAttributes } from "./watch-attributes-service";
import { latestPreOwnedIntake, type PreOwnedIntakeRecord } from "./watch-crm-service";
import { listRepairsForSerial, type RepairTicket } from "./repairs-service";

export interface SerialOwner {
  customerId: string;
  name: string | null;
  phone: string | null;
  /** When the owning invoice closed (ISO timestamp) — the proof of ownership. */
  purchasedAt: string | null;
}

export interface SerialTransferEvent {
  fromLocationId: string;
  toLocationId: string;
  fromLocationName: string | null;
  toLocationName: string | null;
  note: string | null;
  createdAt: string;
}

export interface SerialUnitDetail {
  id: string;
  serialNumber: string;
  status: string;
  unitCost: number | null;
  warrantyMonths: number;
  soldAt: string | null;
  preOwned: boolean;
  conditionGrade: string | null;
  boxAndPapers: boolean;
  model: {
    itemId: string;
    name: string;
    sku: string | null;
    serviceIntervalMonths: number | null;
    attributes: WatchItemAttributes | null;
  };
  warranty: { startDate: string; endDate: string } | null;
  owner: SerialOwner | null;
  preOwnedIntake: PreOwnedIntakeRecord | null;
  repairs: RepairTicket[];
  activeReservation: {
    id: string;
    customerId: string;
    customerName: string | null;
    expiresAt: string | null;
    note: string | null;
  } | null;
  transfers: SerialTransferEvent[];
}

export async function serialUnitDetail(serialId: string): Promise<SerialUnitDetail | null> {
  const { rows } = await query<{
    id: string;
    serial_number: string;
    status: string;
    unit_cost: string | null;
    warranty_months: number;
    sold_at: string | null;
    pre_owned: boolean;
    condition_grade: string | null;
    box_and_papers: boolean;
    item_id: string;
    item_name: string;
    sku: string | null;
    service_interval_months: number | null;
    warranty_start: string | null;
    warranty_end: string | null;
    owner_customer_id: string | null;
    owner_name: string | null;
    owner_phone: string | null;
    owner_purchased_at: string | null;
    res_id: string | null;
    res_customer_id: string | null;
    res_customer_name: string | null;
    res_expires_at: string | null;
    res_note: string | null;
  }>(
    `SELECT s.id, s.serial_number, s.status, s.unit_cost, s.warranty_months,
            s.sold_at::text AS sold_at, s.pre_owned, s.condition_grade, s.box_and_papers,
            i.id AS item_id, i.name AS item_name, i.sku, i.service_interval_months,
            w.start_date::text AS warranty_start, w.end_date::text AS warranty_end,
            own.customer_id AS owner_customer_id, op.name AS owner_name, op.phone AS owner_phone,
            own.closed_at::text AS owner_purchased_at,
            r.id AS res_id, r.customer_id AS res_customer_id, rp.name AS res_customer_name,
            r.expires_at::text AS res_expires_at, r.note AS res_note
       FROM item_serials s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN serial_warranties w ON w.serial_id = s.id
       LEFT JOIN LATERAL (
         SELECT o.customer_id, o.closed_at
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          -- No location predicate: ownership follows the serial itself, so a
          -- unit transferred to another branch keeps its owner history.
          WHERE o.status = 'completed' AND oi.status <> 'voided'
            AND oi.retail_snapshot ->> 'kind' = 'watch'
            AND oi.retail_snapshot ->> 'serialId' = s.id::text
            AND o.customer_id IS NOT NULL
          ORDER BY o.closed_at DESC NULLS LAST
          LIMIT 1
       ) own ON true
       LEFT JOIN parties op ON op.id = own.customer_id
       LEFT JOIN serial_reservations r ON r.serial_id = s.id AND r.status = 'active'
       LEFT JOIN parties rp ON rp.id = r.customer_id
      WHERE s.id = $1`,
    [serialId],
  );
  const row = rows[0];
  if (!row) return null;

  const [attributes, preOwnedIntake, repairs, transfers] = await Promise.all([
    getWatchAttributes(row.item_id),
    latestPreOwnedIntake(serialId),
    listRepairsForSerial(serialId),
    listSerialTransfers(serialId),
  ]);

  return {
    id: row.id,
    serialNumber: row.serial_number,
    status: row.status,
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    warrantyMonths: row.warranty_months,
    soldAt: row.sold_at,
    preOwned: row.pre_owned,
    conditionGrade: row.condition_grade,
    boxAndPapers: row.box_and_papers,
    model: {
      itemId: row.item_id,
      name: row.item_name,
      sku: row.sku,
      serviceIntervalMonths: row.service_interval_months,
      attributes,
    },
    warranty:
      row.warranty_start && row.warranty_end
        ? { startDate: row.warranty_start, endDate: row.warranty_end }
        : null,
    owner: row.owner_customer_id
      ? {
          customerId: row.owner_customer_id,
          name: row.owner_name,
          phone: row.owner_phone,
          purchasedAt: row.owner_purchased_at,
        }
      : null,
    preOwnedIntake,
    repairs,
    activeReservation: row.res_id
      ? {
          id: row.res_id,
          customerId: row.res_customer_id!,
          customerName: row.res_customer_name,
          expiresAt: row.res_expires_at,
          note: row.res_note,
        }
      : null,
    transfers,
  };
}

async function listSerialTransfers(serialId: string): Promise<SerialTransferEvent[]> {
  const { rows } = await query<{
    payload: { fromLocationId?: string; toLocationId?: string; note?: string | null };
    created_at: string;
    from_name: string | null;
    to_name: string | null;
  }>(
    `SELECT e.payload, e.created_at::text AS created_at,
            lf.name AS from_name, lt.name AS to_name
       FROM domain_events e
       LEFT JOIN locations lf ON lf.id = (e.payload ->> 'fromLocationId')::uuid
       LEFT JOIN locations lt ON lt.id = (e.payload ->> 'toLocationId')::uuid
      WHERE e.event_type = 'watch.serial_transfer' AND e.payload ->> 'serialId' = $1
      ORDER BY e.created_at`,
    [serialId],
  );
  return rows.map((r) => ({
    fromLocationId: String(r.payload.fromLocationId ?? ""),
    toLocationId: String(r.payload.toLocationId ?? ""),
    fromLocationName: r.from_name,
    toLocationName: r.to_name,
    note: r.payload.note ?? null,
    createdAt: r.created_at,
  }));
}
