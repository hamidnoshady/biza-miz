import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import {
  decryptReservationPhones,
  encryptReservationPhone,
  lockTableForReservationWrite,
  parseDate,
  tableConflicts,
} from "@/lib/reservation-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  getOpenSessionIdForTable,
  openSession,
  recordReservationState,
  recordReservationStateStandalone,
  recordTableSessionState,
} from "@/lib/table-session-service";
import { broadcast } from "@/lib/realtime";

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

type ReservationRow = {
  id: string;
  table_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
  status: string;
  seated_session_id: string | null;
  note?: string | null;
};

async function loadReservation(
  businessId: string,
  locationId: string,
  id: string,
): Promise<ReservationRow | null> {
  const { rows } = await query<ReservationRow & { customer_phone_enc?: unknown }>(
    `SELECT id, table_id, customer_name, customer_phone, customer_phone_enc, party_size, reserved_at,
            duration_minutes, status, seated_session_id, note
       FROM reservations WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
  if (!rows[0]) return null;
  const [reservation] = await decryptReservationPhones(businessId, rows);
  return reservation;
}

interface PatchBody {
  action?: "cancel" | "no_show" | "seat" | "complete" | "update";
  status?: "booked" | "seated" | "completed" | "cancelled" | "no_show";
  tableId?: string | null;
  customerName?: string;
  customerPhone?: string;
  partySize?: number;
  reservedAt?: string;
  durationMinutes?: number;
  note?: string;
  allowConflict?: boolean;
  tableIds?: string[];
}

/** Update reservation fields, change its status, or seat it (opens or links a session atomically). */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.reservationsManage);
    if (error) return error;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: PatchBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (body.action === "seat" || body.status === "seated") {
      return seatReservation(session.businessId, location.id, id, body, session.sub, session.role);
    }

    const reservation = await loadReservation(session.businessId, location.id, id);
    if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });

    if (body.action === "complete" || body.status === "completed") {
      if (reservation.status !== "seated") {
        return NextResponse.json(
          { error: "reservation_not_seated", currentStatus: reservation.status },
          { status: 409 },
        );
      }
      const { rowCount } = await query(
        "UPDATE reservations SET status = 'completed'::reservation_status, updated_at = now() WHERE id = $1 AND location_id = $2 AND status = 'seated'",
        [id, location.id],
      );
      if (!rowCount) {
        return NextResponse.json({ error: "reservation_not_seated" }, { status: 409 });
      }
      await recordReservationStateStandalone({
        businessId: session.businessId,
        locationId: location.id,
        reservationId: id,
        actor: { userId: session.sub, role: session.role },
      });
      broadcast(location.id, { type: "floor.updated", entity: "reservation", entityId: id });
      return NextResponse.json({
        ok: true,
        reservation: { ...reservation, status: "completed" },
      });
    }

    if (
      body.action === "cancel" ||
      body.action === "no_show" ||
      body.status === "cancelled" ||
      body.status === "no_show"
    ) {
      const to =
        body.action === "cancel" || body.status === "cancelled" ? "cancelled" : "no_show";
      // Atomic conditional update (`WHERE id = $1 AND status = 'booked'`) so a
      // cancel/no-show request racing against `seat` never overwrites an already-seated party.
      const { rowCount } = await query(
        "UPDATE reservations SET status = $2::reservation_status, updated_at = now() WHERE id = $1 AND location_id = $3 AND status = 'booked'",
        [id, to, location.id],
      );
      if (!rowCount) {
        return NextResponse.json({ error: "reservation_not_booked" }, { status: 409 });
      }
      await recordReservationStateStandalone({
        businessId: session.businessId,
        locationId: location.id,
        reservationId: id,
        actor: { userId: session.sub, role: session.role },
      });
      broadcast(location.id, { type: "floor.updated", entity: "reservation", entityId: id });
      return NextResponse.json({ ok: true });
    }

    if (reservation.status !== "booked") {
      return NextResponse.json({ error: "reservation_not_booked" }, { status: 409 });
    }
    return updateReservation(session.businessId, location.id, reservation, body, session.sub, session.role);
  },
);

/**
 * Atomically lock and claim a `booked` reservation inside the transaction:
 *   - `SELECT ... FOR UPDATE` on the reservation row prevents double-seating
 *     and cancel-vs-seat races.
 *   - If the target single table already has an active open `table_sessions` row
 *     (e.g., an order was already started on that table), attaches the reservation
 *     to that session (`seated_session_id`) so multiple orders on the table never
 *     block seating the reservation.
 */
async function seatReservation(
  businessId: string,
  locationId: string,
  reservationId: string,
  body: PatchBody,
  userId: string,
  userRole: string,
) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: lockedRows } = await client.query<
      ReservationRow & { customer_phone_enc?: unknown }
    >(
      `SELECT id, table_id, customer_name, customer_phone, customer_phone_enc,
              party_size, reserved_at, duration_minutes, status, seated_session_id, note
         FROM reservations
        WHERE id = $1 AND location_id = $2
        FOR UPDATE`,
      [reservationId, locationId],
    );
    if (!lockedRows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
    }
    const [reservation] = await decryptReservationPhones(businessId, lockedRows);

    if (reservation.status !== "booked") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "reservation_not_booked", currentStatus: reservation.status },
        { status: 409 },
      );
    }

    const rawIds = (body.tableIds?.filter(Boolean) ?? []).length
      ? body.tableIds!.filter(Boolean)
      : body.tableId
        ? [body.tableId]
        : reservation.table_id
          ? [reservation.table_id]
          : [];
    const tableIds = rawIds.map((t) => String(t).trim()).filter(Boolean);
    if (tableIds.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "table_required" }, { status: 400 });
    }
    if (new Set(tableIds).size !== tableIds.length) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "duplicate_table_ids" }, { status: 400 });
    }

    let sessionId: string;
    if (tableIds.length === 1) {
      const existingSessionId = await getOpenSessionIdForTable(client, locationId, tableIds[0]);
      if (existingSessionId) {
        sessionId = existingSessionId;
        await client.query(
          `UPDATE table_sessions
              SET reservation_id = COALESCE(reservation_id, $2),
                  party_size = COALESCE(party_size, $3),
                  guest_name = COALESCE(guest_name, $4),
                  guest_phone = COALESCE(guest_phone, $5)
            WHERE id = $1 AND location_id = $6`,
          [
            sessionId,
            reservation.id,
            reservation.party_size,
            reservation.customer_name,
            reservation.customer_phone,
            locationId,
          ],
        );
        await recordTableSessionState(client, {
          businessId,
          locationId,
          sessionId,
          actor: { userId, role: userRole },
        });
      } else {
        const opened = await openSession(client, {
          locationId,
          tableIds,
          partySize: reservation.party_size,
          guestName: reservation.customer_name,
          guestPhone: reservation.customer_phone,
          reservationId: reservation.id,
          note: reservation.note ?? null,
          openedBy: userId,
          checkUpcomingReservations: false,
        });
        sessionId = opened.id;
      }
    } else {
      const opened = await openSession(client, {
        locationId,
        tableIds,
        partySize: reservation.party_size,
        guestName: reservation.customer_name,
        guestPhone: reservation.customer_phone,
        reservationId: reservation.id,
        note: reservation.note ?? null,
        openedBy: userId,
        checkUpcomingReservations: false,
      });
      sessionId = opened.id;
    }

    const { rowCount: claimed } = await client.query(
      `UPDATE reservations
          SET status = 'seated',
              table_id = COALESCE(table_id, $3),
              seated_session_id = $2,
              updated_at = now()
        WHERE id = $1 AND status = 'booked'`,
      [reservation.id, sessionId, tableIds[0]],
    );
    if (!claimed) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "reservation_not_booked" }, { status: 409 });
    }

    await recordReservationState(client, {
      businessId,
      locationId,
      reservationId: reservation.id,
      actor: { userId, role: userRole },
    });

    await client.query("COMMIT");
    for (const tid of tableIds) {
      broadcast(locationId, { type: "table.status", tableId: tid, status: "seated" });
    }
    broadcast(locationId, { type: "table_session.updated", sessionId });
    broadcast(locationId, { type: "floor.updated", entity: "reservation", entityId: reservation.id });
    return NextResponse.json({ ok: true, sessionId });
  } catch (err) {
    await client.query("ROLLBACK");
    const code = (err as { code?: string }).code;
    const status = (err as { status?: number }).status;
    if (code) return NextResponse.json({ error: code }, { status: status ?? 409 });
    throw err;
  } finally {
    client.release();
  }
}

async function updateReservation(
  businessId: string,
  locationId: string,
  reservation: ReservationRow,
  body: PatchBody,
  userId: string,
  userRole: string,
) {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  let effectiveTableId = reservation.table_id;
  let effectiveReservedAt = new Date(reservation.reserved_at);
  let effectiveDuration = reservation.duration_minutes;

  if (body.tableId !== undefined) {
    if (body.tableId) {
      if (!isUuid(body.tableId)) {
        return NextResponse.json({ error: "table_not_found" }, { status: 404 });
      }
      const { rows } = await query(
        "SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
        [body.tableId, locationId],
      );
      if (rows.length === 0) return NextResponse.json({ error: "table_not_found" }, { status: 404 });
    }
    effectiveTableId = body.tableId || null;
    set("table_id", effectiveTableId);
  }
  if (body.reservedAt !== undefined) {
    const d = parseDate(body.reservedAt);
    if (!d) return NextResponse.json({ error: "invalid_time" }, { status: 400 });
    effectiveReservedAt = d;
    set("reserved_at", d.toISOString());
  }
  if (body.durationMinutes !== undefined) {
    if (!Number.isFinite(body.durationMinutes) || Number(body.durationMinutes) <= 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    effectiveDuration = Math.min(600, Math.max(15, Math.round(Number(body.durationMinutes))));
    set("duration_minutes", effectiveDuration);
  }
  if (body.customerName !== undefined) {
    const name = body.customerName.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("customer_name", name);
  }
  if (body.customerPhone !== undefined) {
    const phone = body.customerPhone?.trim() || null;
    const cipher = await encryptReservationPhone(businessId, phone);
    set("customer_phone", phone);
    set("customer_phone_enc", cipher.enc);
    set("customer_phone_bidx", cipher.bidx);
  }
  if (body.partySize !== undefined) {
    const n = Number(body.partySize);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "invalid_party_size" }, { status: 400 });
    }
    set("party_size", Math.round(n));
  }
  if (body.note !== undefined) set("note", body.note?.trim() || null);

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  set("updated_at", new Date().toISOString());
  const recheckOverlap =
    effectiveTableId &&
    (body.tableId !== undefined || body.reservedAt !== undefined || body.durationMinutes !== undefined);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (recheckOverlap) {
      await lockTableForReservationWrite(client, locationId, effectiveTableId!);
      const conflicts = await tableConflicts(
        locationId,
        effectiveTableId!,
        effectiveReservedAt,
        effectiveDuration,
        reservation.id,
        client,
      );
      if (conflicts.length > 0 && !body.allowConflict) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "reservation_conflict", conflicts }, { status: 409 });
      }
    }
    await client.query(`UPDATE reservations SET ${fields.join(", ")} WHERE id = $1`, [
      reservation.id,
      ...values,
    ]);
    await recordReservationState(client, {
      businessId,
      locationId,
      reservationId: reservation.id,
      actor: { userId, role: userRole },
    });
    await client.query("COMMIT");
    broadcast(locationId, { type: "floor.updated", entity: "reservation", entityId: reservation.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Delete a reservation outright (rarely needed; cancel is preferred). */
export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.reservationsManage);
    if (error) return error;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const reservation = await loadReservation(session.businessId, location.id, id);
    if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });

    await query("DELETE FROM reservations WHERE id = $1", [id]);
    broadcast(location.id, { type: "floor.updated", entity: "reservation", entityId: id });
    return NextResponse.json({ ok: true });
  },
);
