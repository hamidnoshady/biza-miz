import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/floor";
import { recordReservationState } from "@/lib/floor-sync";
import { broadcast } from "@/lib/realtime";
import { normalizeTimeZone, zonedDayBoundsIso } from "@/lib/reservations";
import {
  decryptReservationPhones,
  encryptReservationPhone,
  lockTableForReservationWrite,
  parseDate,
  tableConflicts,
} from "@/lib/reservation-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * List reservations in a time window (default: from 1h ago through 14 days
 * out). Supports both `from`/`to` ISO instants and `?date=YYYY-MM-DD`
 * interpreted in the active branch's configured `locations.timezone`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reservationsView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ timezone: "Asia/Tehran", reservations: [] });
  }
  const timezone = normalizeTimeZone(location.timezone);

  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  let from: Date;
  let to: Date;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const bounds = zonedDayBoundsIso(dateParam, timezone);
    from = new Date(bounds.startIso);
    to = new Date(bounds.endIso);
  } else {
    from = parseDate(url.searchParams.get("from")) ?? new Date(Date.now() - 60 * 60 * 1000);
    to = parseDate(url.searchParams.get("to")) ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  }

  const { rows: reservations } = await query<{
    customer_phone: string | null;
    customer_phone_enc?: unknown;
  }>(
    `SELECT r.id, r.table_id, dt.name AS table_name, r.customer_name, r.customer_phone, r.customer_phone_enc,
            r.party_size, r.reserved_at, r.duration_minutes, r.status, r.note, r.seated_session_id
       FROM reservations r
       LEFT JOIN dining_tables dt ON dt.id = r.table_id
      WHERE r.location_id = $1 AND r.reserved_at >= $2 AND r.reserved_at <= $3
      ORDER BY r.reserved_at`,
    [location.id, from.toISOString(), to.toISOString()],
  );
  return NextResponse.json({
    timezone,
    reservations: await decryptReservationPhones(session.businessId, reservations),
  });
});

interface CreateBody {
  tableId?: string | null;
  customerName?: string;
  customerPhone?: string;
  partySize?: number;
  reservedAt?: string;
  durationMinutes?: number;
  note?: string;
  allowConflict?: boolean;
}

/** Book a reservation. Overlaps on the same table are flagged (409) unless overridden. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reservationsManage);
  if (error) return error;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const customerName = body.customerName?.trim();
  if (!customerName) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const reservedAt = parseDate(body.reservedAt);
  if (!reservedAt) return NextResponse.json({ error: "invalid_time" }, { status: 400 });
  if (reservedAt.getTime() < Date.now() - 60 * 60 * 1000) {
    return NextResponse.json({ error: "time_in_past" }, { status: 400 });
  }

  const partySize =
    Number.isFinite(body.partySize) && Number(body.partySize) > 0
      ? Math.round(Number(body.partySize))
      : 0;
  if (partySize <= 0 || partySize > 500) {
    return NextResponse.json({ error: "invalid_party_size" }, { status: 400 });
  }

  const duration =
    Number.isFinite(body.durationMinutes) && Number(body.durationMinutes) > 0
      ? Math.min(600, Math.max(15, Math.round(Number(body.durationMinutes))))
      : 90;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const tableId: string | null = body.tableId ? String(body.tableId).trim() : null;
  if (tableId && !isUuid(tableId)) {
    return NextResponse.json({ error: "table_not_found" }, { status: 404 });
  }
  const customerPhone = body.customerPhone?.trim() || null;
  const phoneCipher = await encryptReservationPhone(session.businessId, customerPhone);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (tableId) {
      await lockTableForReservationWrite(client, location.id, tableId);

      const { rows: table } = await client.query(
        "SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
        [tableId, location.id],
      );
      if (table.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "table_not_found" }, { status: 404 });
      }

      const conflicts = await tableConflicts(
        location.id,
        tableId,
        reservedAt,
        duration,
        null,
        client,
      );
      if (conflicts.length > 0 && !body.allowConflict) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "reservation_conflict", conflicts }, { status: 409 });
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO reservations
          (location_id, table_id, customer_name, customer_phone, party_size, reserved_at, duration_minutes, note, created_by,
           customer_phone_enc, customer_phone_bidx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        location.id,
        tableId,
        customerName,
        customerPhone,
        partySize,
        reservedAt.toISOString(),
        duration,
        body.note?.trim() || null,
        session.sub,
        phoneCipher.enc,
        phoneCipher.bidx,
      ],
    );

    await recordReservationState(client, {
      businessId: session.businessId,
      locationId: location.id,
      reservationId: rows[0].id,
      actor: { userId: session.sub, role: session.role },
    });

    await client.query("COMMIT");
    broadcast(location.id, { type: "floor.updated", entity: "reservation", entityId: rows[0].id });
    return NextResponse.json({ ok: true, id: rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
