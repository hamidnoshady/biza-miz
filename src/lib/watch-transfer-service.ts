/**
 * Issue #795 — the canonical branch-transfer operation for serialized
 * units ("move them between branches", definition-of-done step 3).
 *
 * The catalogue is branch-scoped (one `items` row per model per branch), so
 * physically moving a unit means re-pointing its serial at the destination
 * branch's row for the SAME model — matched by SKU when the model has one,
 * by exact name otherwise. The destination model must already exist: a
 * transfer moves a physical thing, it does not invent catalogue entries.
 *
 * Accounting: deliberately none. The chart of accounts is business-scoped
 * (migration 0001), so the unit's cost basis sits in the same inventory
 * account before and after the move — a journal entry here would be a
 * zero-line no-op. The auditable fact is the domain event this records
 * (`watch.serial_transfer`, with both endpoints and the serial), plus the
 * serial's own row now living under the destination branch.
 */
import type { PoolClient } from "pg";
import { recordDomainEvent } from "./posting-engine";

export class SerialTransferError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export async function transferSerialUnit(
  client: PoolClient,
  input: {
    businessId: string;
    fromLocationId: string;
    toLocationId: string;
    serialId: string;
    note?: string | null;
    createdBy?: string | null;
  },
): Promise<{ toItemId: string }> {
  if (input.fromLocationId === input.toLocationId) {
    throw new SerialTransferError("مبدأ و مقصد انتقال یکی است.", 400);
  }

  // Both endpoints must be branches of this business.
  const { rows: locRows } = await client.query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [input.businessId, [input.fromLocationId, input.toLocationId]],
  );
  if (locRows.length !== 2) throw new SerialTransferError("شعبهٔ مقصد یافت نشد.", 404);

  // Lock the unit: a transfer racing a sale/repair/reservation serializes
  // here exactly like two sales racing each other.
  const { rows: serialRows } = await client.query<{
    id: string;
    item_id: string;
    serial_number: string;
    status: string;
    location_id: string;
    name: string;
    sku: string | null;
  }>(
    `SELECT s.id, s.item_id, s.serial_number, s.status, i.location_id, i.name, i.sku
       FROM item_serials s JOIN items i ON i.id = s.item_id
      WHERE s.id = $1 FOR UPDATE OF s`,
    [input.serialId],
  );
  const serial = serialRows[0];
  if (!serial || serial.location_id !== input.fromLocationId) {
    throw new SerialTransferError("سریال یافت نشد.", 404);
  }
  if (serial.status !== "in_stock") {
    throw new SerialTransferError("فقط دستگاه موجود در انبار قابل انتقال است (نه رزرو، در تعمیر یا فروخته‌شده).");
  }

  // The same model at the destination: SKU is the stable identity when the
  // model has one; exact name otherwise.
  const { rows: destRows } = await client.query<{ id: string }>(
    serial.sku
      ? `SELECT id FROM items WHERE location_id = $1 AND tracking = 'serial' AND sku = $2`
      : `SELECT id FROM items WHERE location_id = $1 AND tracking = 'serial' AND name = $2`,
    [input.toLocationId, serial.sku ?? serial.name],
  );
  const destItem = destRows[0];
  if (!destItem) {
    throw new SerialTransferError(
      "این مدل در شعبهٔ مقصد تعریف نشده است؛ ابتدا مدل را در کاتالوگ آن شعبه بسازید.",
    );
  }

  const { rowCount } = await client.query(
    `UPDATE item_serials SET item_id = $2 WHERE id = $1 AND status = 'in_stock'`,
    [serial.id, destItem.id],
  );
  if (rowCount === 0) {
    throw new SerialTransferError("فقط دستگاه موجود در انبار قابل انتقال است (نه رزرو، در تعمیر یا فروخته‌شده).");
  }

  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.fromLocationId,
    eventType: "watch.serial_transfer",
    payload: {
      serialId: serial.id,
      serialNumber: serial.serial_number,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      fromItemId: serial.item_id,
      toItemId: destItem.id,
      note: input.note?.trim() || null,
    },
    sourceType: "serial_transfer",
    sourceId: serial.id,
    createdBy: input.createdBy ?? null,
  });

  return { toItemId: destItem.id };
}
