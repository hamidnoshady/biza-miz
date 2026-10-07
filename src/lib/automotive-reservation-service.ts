/**
 * Issue #839 Wave 3 — vehicle reservations (§7) and their deposits.
 *
 * The hold itself is **not** a new table and not a new concept. Migration 0202
 * built `serial_reservations` for exactly this: one customer, one serialized
 * unit, an expiry, one active hold per unit enforced by a partial unique index,
 * and deliberately no accounting effect of its own. 0212 added the deposit
 * columns §7 asks for. This service is the automotive *policy* on top of that
 * shared shape:
 *
 *   - a reservation names a customer, an expiry date **and** an optional time
 *     of day («تا ساعت ۱۸»), a deposit, how it was paid, and whether it is
 *     refundable;
 *   - an **active** hold blocks a second reservation and a sale to anybody else
 *     — structurally for the reservation (the partial unique index), and by
 *     re-checking the live hold in the sale's own transaction for the sale
 *     (Wave 4);
 *   - a deposit is *money received against a future sale*: it posts Debit
 *     cash/bank · Credit the shared customer-advance liability 2430, never
 *     revenue, and it is **applied** to the invoice rather than re-earned;
 *   - releasing or expiring a hold returns the car to the shelf, and a
 *     non-refundable deposit stays where it is (that is what "non-refundable"
 *     means) while a refundable one is refunded with its own reversing entry.
 *
 * The vehicle's own `state` and the serial's `status` both move to `reserved`
 * here, in the same transaction, so the automotive board and the generic stock
 * paths agree about what is on the shelf.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { emitDomainEvent } from "./posting-engine";
import { rialText } from "./inventory-exact";
import type { VehicleSettlement } from "./automotive-posting-rules";
import { businessToday, ensureVehicleState, VehicleError } from "./automotive-service";
import { holdHasExpired, validateHoldStatusTransition, vehicleDisplayName, type VehicleHoldStatus } from "./automotive";
// Side-effect import: registers the automotive.* posting rules.
import "./automotive-posting-rules";

export { VehicleError };

export interface ReserveVehicleInput {
  businessId: string;
  locationId: string;
  serialId: string;
  customerId: string;
  /** Business-local ISO date (YYYY-MM-DD). */
  expiresAt?: string | null;
  /** Time of day the hold lapses («تا ساعت ۱۸»), with the date above. */
  expiresAtTime?: string | null;
  depositRial?: number;
  /** How the deposit was received — the repo's `payment_method` enum. */
  depositMethod?: "cash" | "card" | "card_to_card" | "online" | null;
  depositRefundable?: boolean;
  depositNote?: string | null;
  note?: string | null;
  actorId?: string | null;
}

export interface VehicleReservation {
  id: string;
  serialId: string;
  stockNumber: string;
  displayName: string;
  customerId: string;
  customerName: string | null;
  status: VehicleHoldStatus;
  expiresAt: string | null;
  expiresAtTime: string | null;
  depositRial: number;
  depositMethod: string | null;
  depositRefundable: boolean;
  depositNote: string | null;
  depositEntryId: string | null;
  note: string | null;
  releaseReason: string | null;
  createdAt: string;
  closedAt: string | null;
}

const RESERVATION_SELECT = `
  SELECT r.id, r.serial_id, v.stock_number, v.make, v.model, v.trim, v.model_year,
         r.customer_id, p.name AS customer_name, r.status, r.expires_at::text AS expires_at,
         r.expires_at_time::text AS expires_at_time, r.deposit_amount_rial::text AS deposit_amount_rial,
         r.deposit_method, r.deposit_refundable, r.deposit_note, r.deposit_ledger_entry_id,
         r.note, r.release_reason, r.created_at::text AS created_at, r.closed_at::text AS closed_at
    FROM serial_reservations r
    JOIN automotive_vehicle_attributes v ON v.serial_id = r.serial_id
    LEFT JOIN parties p ON p.id = r.customer_id`;

interface ReservationRow {
  [key: string]: unknown;
  id: string;
  serial_id: string;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  model_year: number | null;
  customer_id: string;
  customer_name: string | null;
  status: string;
  expires_at: string | null;
  expires_at_time: string | null;
  deposit_amount_rial: string;
  deposit_method: string | null;
  deposit_refundable: boolean;
  deposit_note: string | null;
  deposit_ledger_entry_id: string | null;
  note: string | null;
  release_reason: string | null;
  created_at: string;
  closed_at: string | null;
}

function mapReservation(row: ReservationRow): VehicleReservation {
  return {
    id: row.id,
    serialId: row.serial_id,
    stockNumber: row.stock_number,
    displayName: vehicleDisplayName({
      make: row.make,
      model: row.model,
      trim: row.trim,
      modelYear: row.model_year,
    }),
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status as VehicleHoldStatus,
    expiresAt: row.expires_at,
    expiresAtTime: row.expires_at_time,
    depositRial: Number(row.deposit_amount_rial),
    depositMethod: row.deposit_method,
    depositRefundable: row.deposit_refundable,
    depositNote: row.deposit_note,
    depositEntryId: row.deposit_ledger_entry_id,
    note: row.note,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

/**
 * §7 — one customer, one car, until a date, with a deposit where one is taken.
 *
 * The unit is locked first, so a reservation racing a sale (or a second
 * reservation) serialises on the serial row exactly as two sales do; then the
 * live-hold check and the partial unique index make a second active hold
 * impossible rather than merely unlikely.
 */
export async function reserveVehicle(
  client: PoolClient,
  input: ReserveVehicleInput,
): Promise<{ id: string; depositEntryId: string | null }> {
  const deposit = input.depositRial ?? 0;
  if (!Number.isInteger(deposit) || deposit < 0) {
    throw new VehicleError("invalid_amount", "مبلغ ودیعه باید عددی صحیح و نامنفی باشد.");
  }
  if (deposit > 0 && !input.depositMethod) {
    throw new VehicleError("invalid_deposit_method", "روش دریافت ودیعه الزامی است.");
  }
  // `credit` is not in the union at all: a deposit is money *received*, so
  // "on account" is a contradiction in terms (0212 excludes it at the column).
  if (input.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) {
    throw new VehicleError("invalid_date", "تاریخ انقضای رزرو نامعتبر است.");
  }
  if (!input.customerId) {
    throw new VehicleError("customer_required", "رزرو بدون مشتری معنا ندارد؛ مشتری را انتخاب کنید.");
  }
  // The customer is looked up in *this* tenant's directory, and must actually be
  // a customer: a client-supplied id is a claim, not a fact, and a reservation
  // to a supplier (or to another business's person) is not a reservation.
  const { rows: customerRows } = await client.query<{ id: string }>(
    `SELECT id FROM parties
      WHERE id = $1 AND business_id = $2 AND is_active
        AND (role = 'customer' OR roles @> ARRAY['customer']::text[])`,
    [input.customerId, input.businessId],
  );
  if (!customerRows[0]) throw new VehicleError("customer_not_found", "مشتری یافت نشد.", 404);

  const { rows: vehicleRows } = await client.query<{
    serial_id: string;
    location_id: string;
    state: string;
    stock_number: string;
    serial_status: string;
  }>(
    `SELECT v.serial_id, v.location_id, v.state, v.stock_number, s.status AS serial_status
       FROM automotive_vehicle_attributes v
       JOIN item_serials s ON s.id = v.serial_id
      WHERE v.business_id = $1 AND v.serial_id = $2
      FOR UPDATE OF v`,
    [input.businessId, input.serialId],
  );
  const vehicle = vehicleRows[0];
  if (!vehicle) throw new VehicleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.location_id !== input.locationId) {
    throw new VehicleError("wrong_location", "این خودرو در شعبهٔ فعال نیست.", 409);
  }
  if (vehicle.state !== "in_stock" && vehicle.state !== "acquired") {
    throw new VehicleError(
      "vehicle_not_available",
      vehicle.state === "reserved"
        ? "این خودرو قبلاً رزرو شده است؛ ابتدا رزرو فعلی را تعیین تکلیف کنید."
        : "این خودرو در وضعیت قابل رزرو نیست.",
      409,
    );
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO serial_reservations
       (business_id, location_id, serial_id, customer_id, expires_at, expires_at_time,
        deposit_amount_rial, deposit_method, deposit_refundable, deposit_note, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      input.businessId,
      vehicle.location_id,
      input.serialId,
      input.customerId,
      input.expiresAt ?? null,
      input.expiresAtTime ?? null,
      deposit,
      deposit > 0 ? (input.depositMethod ?? null) : null,
      input.depositRefundable ?? true,
      input.depositNote?.trim() || null,
      input.note?.trim() || null,
      input.actorId ?? null,
    ],
  );
  const reservationId = rows[0].id;

  let depositEntryId: string | null = null;
  if (deposit > 0) {
    const { entryId } = await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: vehicle.location_id,
      eventType: "automotive.deposit_received",
      payload: {
        reservationId,
        serialId: input.serialId,
        amount: rialText(String(deposit)),
        method: input.depositMethod ?? "cash",
      },
      sourceType: "automotive_reservation_deposit",
      sourceId: reservationId,
      createdBy: input.actorId ?? null,
    });
    depositEntryId = entryId;
    if (entryId) {
      await client.query(`UPDATE serial_reservations SET deposit_ledger_entry_id = $2 WHERE id = $1`, [
        reservationId,
        entryId,
      ]);
    }
  }

  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: input.serialId,
    state: "reserved",
    actorId: input.actorId ?? null,
    eventType: "automotive.vehicle_reserved",
  });

  return { id: reservationId, depositEntryId };
}

/**
 * Frees the car. A **refundable** deposit goes back with its own reversing
 * entry; a **non-refundable** one stays on the customer-advance liability —
 * which is exactly what the checkbox the counter ticked promised.
 */
export async function releaseVehicleReservation(
  client: PoolClient,
  input: { businessId: string; reservationId: string; reason: string; actorId?: string | null; refund?: boolean },
): Promise<{ refundedEntryId: string | null }> {
  const reason = input.reason?.trim();
  if (!reason) throw new VehicleError("reason_required", "دلیل آزادسازی رزرو الزامی است.");

  const { rows } = await client.query<{
    id: string;
    serial_id: string;
    location_id: string;
    status: string;
    deposit_amount_rial: string;
    deposit_method: string | null;
    deposit_refundable: boolean;
    deposit_ledger_entry_id: string | null;
  }>(
    `SELECT id, serial_id, location_id, status, deposit_amount_rial::text AS deposit_amount_rial,
            deposit_method, deposit_refundable, deposit_ledger_entry_id
       FROM serial_reservations
      WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.reservationId, input.businessId],
  );
  const reservation = rows[0];
  if (!reservation) throw new VehicleError("reservation_not_found", "رزرو یافت نشد.", 404);
  if (reservation.status !== "active") {
    throw new VehicleError("reservation_closed", "این رزرو قبلاً بسته شده است.", 409);
  }

  await client.query(
    `UPDATE serial_reservations SET status = 'released', release_reason = $2, closed_at = now() WHERE id = $1`,
    [reservation.id, reason],
  );

  let refundedEntryId: string | null = null;
  const deposit = Number(reservation.deposit_amount_rial);
  const shouldRefund = input.refund ?? reservation.deposit_refundable;
  if (deposit > 0 && shouldRefund) {
    const { entryId } = await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: reservation.location_id,
      eventType: "automotive.deposit_refunded",
      payload: {
        reservationId: reservation.id,
        serialId: reservation.serial_id,
        amount: rialText(String(deposit)),
        method: reservation.deposit_method ?? "cash",
      },
      sourceType: "automotive_reservation_deposit_refund",
      sourceId: reservation.id,
      createdBy: input.actorId ?? null,
    });
    refundedEntryId = entryId;
    if (entryId) {
      await client.query(
        `UPDATE serial_reservations SET deposit_refund_entry_id = $2, deposit_refunded_at = now() WHERE id = $1`,
        [reservation.id, entryId],
      );
    }
  }

  // Only a still-reserved car snaps back to the shelf: a car that moved on
  // (into a sale, a repair, a transfer) must not be dragged back by a release.
  await ensureVehicleState(client, {
    businessId: input.businessId,
    serialId: reservation.serial_id,
    state: "in_stock",
    actorId: input.actorId ?? null,
    eventType: "automotive.vehicle_reservation_released",
    onlyIfState: "reserved",
  });

  return { refundedEntryId };
}

/**
 * §7's "expired" — evaluated on read, so no cron has to sweep. A hold whose
 * business-local expiry day has passed is closed as `expired` the first time
 * anybody looks at it, which is also the moment the car becomes sellable to
 * anyone again.
 */
export async function expireVehicleReservations(
  client: PoolClient,
  input: { businessId: string; locationId: string },
): Promise<number> {
  const today = await businessToday(client, input.locationId);
  const { rows } = await client.query<{ id: string; serial_id: string; expires_at: string }>(
    `SELECT id, serial_id, expires_at::text AS expires_at
       FROM serial_reservations
      WHERE business_id = $1 AND location_id = $2 AND status = 'active' AND expires_at IS NOT NULL
      FOR UPDATE`,
    [input.businessId, input.locationId],
  );
  let expired = 0;
  for (const reservation of rows) {
    if (!holdHasExpired({ status: "active", expiresAt: reservation.expires_at }, today)) continue;
    await client.query(
      `UPDATE serial_reservations SET status = 'expired', closed_at = now() WHERE id = $1`,
      [reservation.id],
    );
    await client.query(
      `UPDATE item_serials SET status = 'in_stock' WHERE id = $1 AND status = 'reserved'`,
      [reservation.serial_id],
    );
    await client.query(
      `UPDATE automotive_vehicle_attributes SET state = 'in_stock', updated_at = now()
        WHERE business_id = $1 AND serial_id = $2 AND state = 'reserved'`,
      [input.businessId, reservation.serial_id],
    );
    await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "automotive.vehicle_reservation_expired",
      payload: { reservationId: reservation.id, serialId: reservation.serial_id },
      sourceType: "automotive_vehicle",
      sourceId: reservation.serial_id,
      createdBy: null,
    });
    expired += 1;
  }
  return expired;
}

/** The board's hold list for one branch, live holds first. */
export async function listVehicleReservations(
  businessId: string,
  options: { locationId?: string | null; serialId?: string | null; status?: VehicleHoldStatus | null; limit?: number } = {},
  client?: PoolClient,
): Promise<VehicleReservation[]> {
  const params: unknown[] = [businessId];
  const where = ["r.business_id = $1"];
  if (options.locationId) where.push(`r.location_id = $${params.push(options.locationId)}`);
  if (options.serialId) where.push(`r.serial_id = $${params.push(options.serialId)}`);
  if (options.status) where.push(`r.status = $${params.push(options.status)}`);
  const sql = `${RESERVATION_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY (r.status = 'active') DESC, r.created_at DESC
      LIMIT ${Math.min(Math.max(options.limit ?? 100, 1), 500)}`;
  const { rows } = client
    ? await client.query<ReservationRow>(sql, params)
    : await query<ReservationRow>(sql, params);
  return rows.map(mapReservation);
}

/** One hold, tenant-checked — the detail panel's read. */
export async function getVehicleReservation(
  businessId: string,
  reservationId: string,
  client?: PoolClient,
): Promise<VehicleReservation | null> {
  const params = [businessId, reservationId];
  const sql = `${RESERVATION_SELECT} WHERE r.business_id = $1 AND r.id = $2`;
  const { rows } = client
    ? await client.query<ReservationRow>(sql, params)
    : await query<ReservationRow>(sql, params);
  return rows[0] ? mapReservation(rows[0]) : null;
}

/**
 * Closes a hold because the car is being **sold** — called by the sale path in
 * the sale's own transaction. Returns the deposit that may be applied to the
 * invoice, and refuses a sale to anybody but the customer the hold names (that
 * refusal is §7's "blocks a second sale", and it is the same rule
 * `resolveReservationForSale` applies to a watch).
 */
export async function resolveVehicleReservationForSale(
  client: PoolClient,
  input: { businessId: string; serialId: string; customerId: string | null; saleDate: string; override?: boolean },
): Promise<{ reservationId: string; holdCustomerId: string | null; depositRial: number; applied: boolean }> {
  const { rows } = await client.query<{
    id: string;
    customer_id: string;
    expires_at: string | null;
    deposit_amount_rial: string;
    status: string;
  }>(
    `SELECT id, customer_id, expires_at::text AS expires_at,
            deposit_amount_rial::text AS deposit_amount_rial, status
       FROM serial_reservations
      WHERE business_id = $1 AND serial_id = $2 AND status = 'active'
      FOR UPDATE`,
    [input.businessId, input.serialId],
  );
  const reservation = rows[0];
  if (!reservation) return { reservationId: "", holdCustomerId: null, depositRial: 0, applied: false };

  const expired = holdHasExpired(
    { status: "active", expiresAt: reservation.expires_at },
    input.saleDate,
  );
  if (expired) {
    await client.query(`UPDATE serial_reservations SET status = 'expired', closed_at = now() WHERE id = $1`, [
      reservation.id,
    ]);
    return { reservationId: reservation.id, holdCustomerId: reservation.customer_id, depositRial: 0, applied: false };
  }

  if (input.customerId !== reservation.customer_id && !input.override) {
    throw new VehicleError(
      "reservation_blocks_sale",
      "این خودرو برای مشتری دیگری رزرو شده است؛ فاکتور را به نام همان مشتری ثبت کنید یا رزرو را آزاد کنید.",
      409,
    );
  }

  const deposit = Number(reservation.deposit_amount_rial);
  return {
    reservationId: reservation.id,
    holdCustomerId: reservation.customer_id,
    depositRial: deposit,
    applied: true,
  };
}

/** Marks the hold as converted by the sale that closed it (§7's audit trail). */
export async function convertVehicleReservation(
  client: PoolClient,
  input: { reservationId: string; orderId: string },
): Promise<void> {
  if (!input.reservationId) return;
  await client.query(
    `UPDATE serial_reservations
        SET status = 'converted', closed_at = now(), converted_order_id = $2
      WHERE id = $1 AND status = 'active'`,
    [input.reservationId, input.orderId],
  );
}

/**
 * The hold's own state machine, in one place: only 0212's four statuses, and
 * only the transitions 0202's lifecycle describes.
 */
export function validateReservationTransition(from: VehicleHoldStatus, to: VehicleHoldStatus): string | null {
  return validateHoldStatusTransition(from, to);
}

/** Re-exported so callers can name an account without importing the rules module. */
export type { VehicleSettlement };
