/**
 * Issue #795 item 20 — the reservation (hold / layaway-hold) workflow that
 * finally makes the `reserved` serial status real.
 *
 * A hold is an explicit promise of one exact physical unit to one exact
 * customer: the unit leaves the sellable pool (`in_stock → reserved`, the
 * same transition validateSerialStatusTransition always allowed but nothing
 * ever took) and a `serial_reservations` row records for whom, until when,
 * and by whose hand. Three ways out:
 *
 * - **converted** — the reserving customer buys the unit: the normal
 *   invoice engine sells a reserved unit if (and only if) the invoice's
 *   customer is the reservation's customer (watch-sales-service.ts), and
 *   the hold closes as converted in the same transaction as the sale.
 * - **released** — staff free the unit, with the reason recorded; the
 *   unit returns to `in_stock`.
 * - **expired** — the hold's business-local expiry date has passed. An
 *   expired hold no longer blocks anyone: the next sale (to whomever)
 *   closes it as expired and proceeds. Nothing has to sweep a cron.
 *
 * The hold itself has no accounting effect — nothing was bought or sold
 * yet. A deposit, where the shop takes one, is real money and settles
 * through the existing AR / store-credit flows against the same customer.
 */
import type { PoolClient } from "pg";
import { query } from "./db";

export class SerialReservationError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export interface SerialReservationSummary {
  id: string;
  serialId: string;
  serialNumber: string;
  itemName: string;
  customerId: string;
  customerName: string | null;
  status: string;
  expiresAt: string | null;
  note: string | null;
  releaseReason: string | null;
  createdAt: string;
}

export async function reserveSerialUnit(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    serialId: string;
    customerId: string;
    /** Business-local ISO date the hold lapses; null = until released. */
    expiresAt?: string | null;
    note?: string | null;
    createdBy?: string | null;
  },
): Promise<{ id: string }> {
  const { rows: serialRows } = await client.query<{ status: string; location_id: string }>(
    `SELECT s.status, i.location_id FROM item_serials s JOIN items i ON i.id = s.item_id
      WHERE s.id = $1 FOR UPDATE OF s`,
    [input.serialId],
  );
  const serial = serialRows[0];
  if (!serial) throw new SerialReservationError("سریال یافت نشد.", 404);
  if (serial.location_id !== input.locationId) {
    throw new SerialReservationError("این دستگاه متعلق به شعبهٔ فعال نیست.");
  }
  if (serial.status !== "in_stock") {
    throw new SerialReservationError("فقط دستگاه موجود در انبار قابل رزرو است.");
  }
  if (input.expiresAt != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) {
    throw new SerialReservationError("تاریخ انقضای رزرو نامعتبر است.", 400);
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO serial_reservations
       (business_id, location_id, serial_id, customer_id, expires_at, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.serialId,
      input.customerId,
      input.expiresAt ?? null,
      input.note?.trim() || null,
      input.createdBy ?? null,
    ],
  );
  await client.query(`UPDATE item_serials SET status = 'reserved' WHERE id = $1`, [input.serialId]);
  return { id: rows[0].id };
}

export async function releaseSerialReservation(
  client: PoolClient,
  input: { businessId: string; reservationId: string; reason: string; actorId?: string | null },
): Promise<void> {
  if (!input.reason.trim()) throw new SerialReservationError("دلیل آزادسازی رزرو الزامی است.", 400);
  const { rows } = await client.query<{ id: string; serial_id: string; status: string }>(
    `SELECT id, serial_id, status FROM serial_reservations WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.reservationId, input.businessId],
  );
  const reservation = rows[0];
  if (!reservation) throw new SerialReservationError("رزرو یافت نشد.", 404);
  if (reservation.status !== "active") {
    throw new SerialReservationError("این رزرو قبلاً بسته شده است.");
  }
  await client.query(
    `UPDATE serial_reservations SET status = 'released', release_reason = $2, closed_at = now() WHERE id = $1`,
    [reservation.id, input.reason.trim()],
  );
  // The unit may have moved on legitimately (e.g. into repair); only a
  // still-reserved unit snaps back to the shelf.
  await client.query(
    `UPDATE item_serials SET status = 'in_stock' WHERE id = $1 AND status = 'reserved'`,
    [reservation.serial_id],
  );
}

/**
 * Resolves whether a reserved unit may sell on this invoice, inside the
 * sale's own transaction — called by sellSerializedUnit when it finds the
 * unit `reserved`. Returns quietly when the sale may proceed (and closes
 * the hold as converted/expired in the same breath); throws when the unit
 * is promised to somebody else.
 */
export async function resolveReservationForSale(
  client: PoolClient,
  input: { serialId: string; customerId: string | null; saleDate: string },
): Promise<void> {
  const { rows } = await client.query<{
    id: string;
    customer_id: string;
    expires_at: string | null;
  }>(
    `SELECT id, customer_id, expires_at::text AS expires_at
       FROM serial_reservations WHERE serial_id = $1 AND status = 'active' FOR UPDATE`,
    [input.serialId],
  );
  const reservation = rows[0];
  // A reserved unit with no live hold is drift (e.g. a hold row removed by
  // hand); the sale heals it rather than wedging the unit forever.
  if (!reservation) return;

  if (reservation.expires_at && reservation.expires_at < input.saleDate) {
    await client.query(
      `UPDATE serial_reservations SET status = 'expired', closed_at = now() WHERE id = $1`,
      [reservation.id],
    );
    return;
  }
  if (input.customerId && input.customerId === reservation.customer_id) {
    await client.query(
      `UPDATE serial_reservations SET status = 'converted', closed_at = now() WHERE id = $1`,
      [reservation.id],
    );
    return;
  }
  throw new Error("این دستگاه برای مشتری دیگری رزرو شده است؛ ابتدا رزرو را آزاد کنید یا فاکتور را به نام همان مشتری ثبت کنید.");
}

export async function listSerialReservations(
  businessId: string,
  locationId: string,
): Promise<SerialReservationSummary[]> {
  const { rows } = await query<{
    id: string;
    serial_id: string;
    serial_number: string;
    item_name: string;
    customer_id: string;
    customer_name: string | null;
    status: string;
    expires_at: string | null;
    note: string | null;
    release_reason: string | null;
    created_at: string;
  }>(
    `SELECT r.id, r.serial_id, s.serial_number, i.name AS item_name,
            r.customer_id, p.name AS customer_name, r.status,
            r.expires_at::text AS expires_at, r.note, r.release_reason, r.created_at::text AS created_at
       FROM serial_reservations r
       JOIN item_serials s ON s.id = r.serial_id
       JOIN items i ON i.id = s.item_id
       LEFT JOIN parties p ON p.id = r.customer_id
      WHERE r.business_id = $1 AND r.location_id = $2
      ORDER BY (r.status = 'active') DESC, r.created_at DESC`,
    [businessId, locationId],
  );
  return rows.map((r) => ({
    id: r.id,
    serialId: r.serial_id,
    serialNumber: r.serial_number,
    itemName: r.item_name,
    customerId: r.customer_id,
    customerName: r.customer_name,
    status: r.status,
    expiresAt: r.expires_at,
    note: r.note,
    releaseReason: r.release_reason,
    createdAt: r.created_at,
  }));
}
