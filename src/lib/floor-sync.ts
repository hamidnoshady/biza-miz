import type { PoolClient } from "pg";
import { getBusinessDek } from "./business-keys";
import { encryptOptional, phoneBlindIndex } from "./field-crypto";
import type { SyncDomainEffect } from "./sync-domain-handlers";

class SyncPayloadError extends Error {
  constructor(readonly code = "invalid_payload") {
    super(code);
    this.name = "SyncPayloadError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export async function applyTableSessionState(
  client: PoolClient,
  context: { businessId: string; locationId: string; payload: Record<string, unknown> },
): Promise<SyncDomainEffect> {
  const { locationId, payload } = context;
  const sessionId = payload.sessionId;
  if (!isUuid(sessionId)) throw new SyncPayloadError("invalid_session_id");
  const status = payload.status === "closed" ? "closed" : "open";
  const partySize = typeof payload.partySize === "number" && Number.isFinite(payload.partySize) ? Math.max(1, Math.trunc(payload.partySize)) : null;
  const guestName = typeof payload.guestName === "string" ? payload.guestName : null;
  const openedBy = isUuid(payload.openedBy) ? payload.openedBy : null;
  const openedAt = typeof payload.openedAt === "string" ? payload.openedAt : new Date().toISOString();
  const billRequestedAt = typeof payload.billRequestedAt === "string" ? payload.billRequestedAt : null;
  const closedAt = typeof payload.closedAt === "string" ? payload.closedAt : null;
  const note = typeof payload.note === "string" ? payload.note : null;

  let validOpenedBy: string | null = null;
  if (openedBy) {
    const u = await client.query(`SELECT id FROM users WHERE id = $1`, [openedBy]);
    if (u.rows[0]) validOpenedBy = openedBy;
  }

  await client.query(
    `INSERT INTO table_sessions (id, location_id, status, party_size, guest_name, opened_by, opened_at, bill_requested_at, closed_at, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, party_size = EXCLUDED.party_size, guest_name = EXCLUDED.guest_name, bill_requested_at = EXCLUDED.bill_requested_at, closed_at = EXCLUDED.closed_at, note = EXCLUDED.note`,
    [sessionId, locationId, status, partySize, guestName, validOpenedBy, openedAt, billRequestedAt, closedAt, note],
  );

  const tables = Array.isArray(payload.tables) ? payload.tables : [];
  for (const raw of tables) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    if (!isUuid(t.tableId)) continue;
    const tableExists = await client.query(`SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2`, [t.tableId, locationId]);
    if (!tableExists.rows[0]) continue;
    const mergedAt = typeof t.mergedAt === "string" ? t.mergedAt : openedAt;
    const releasedAt = typeof t.releasedAt === "string" ? t.releasedAt : status === "closed" ? closedAt ?? new Date().toISOString() : null;
    if (releasedAt === null) {
      await client.query(`UPDATE table_session_tables SET released_at = now() WHERE table_id = $1 AND session_id <> $2 AND released_at IS NULL`, [t.tableId, sessionId]);
    }
    await client.query(
      `INSERT INTO table_session_tables (session_id, table_id, joined_at, released_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, table_id) DO UPDATE SET joined_at = EXCLUDED.joined_at, released_at = EXCLUDED.released_at`,
      [sessionId, t.tableId, mergedAt, releasedAt],
    );
  }

  const customers = Array.isArray(payload.customers) ? payload.customers : [];
  for (const raw of customers) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const guestNumber = Number(c.guestNumber);
    if (!Number.isInteger(guestNumber) || guestNumber < 1 || !isUuid(c.customerId)) continue;
    const partyExists = await client.query(`SELECT id FROM parties WHERE id = $1`, [c.customerId]);
    if (!partyExists.rows[0]) continue;
    await client.query(
      `INSERT INTO table_session_customers (session_id, guest_number, customer_id) VALUES ($1, $2, $3)
       ON CONFLICT (session_id, guest_number) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
      [sessionId, guestNumber, c.customerId],
    );
  }

  return { effectType: "table_session", effectId: sessionId };
}

export async function applyReservationState(
  client: PoolClient,
  context: { businessId: string; locationId: string; payload: Record<string, unknown> },
): Promise<SyncDomainEffect> {
  const { businessId, locationId, payload } = context;
  const reservationId = payload.reservationId;
  if (!isUuid(reservationId)) throw new SyncPayloadError("invalid_reservation_id");
  const customerName = typeof payload.customerName === "string" && payload.customerName.trim() ? payload.customerName.trim() : "مهمان";
  const customerPhone = typeof payload.customerPhone === "string" && payload.customerPhone.trim() ? payload.customerPhone.trim() : null;
  const partySize = typeof payload.partySize === "number" && Number.isFinite(payload.partySize) ? Math.max(1, Math.trunc(payload.partySize)) : 2;
  const reservedAt = typeof payload.reservedAt === "string" ? payload.reservedAt : new Date().toISOString();
  const durationMinutes = typeof payload.durationMinutes === "number" && Number.isFinite(payload.durationMinutes) ? Math.max(15, Math.trunc(payload.durationMinutes)) : 90;
  const validStatuses = new Set(["booked", "seated", "cancelled", "no_show", "completed"]);
  const status = typeof payload.status === "string" && validStatuses.has(payload.status) ? payload.status : "booked";
  const note = typeof payload.note === "string" ? payload.note : null;
  const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString();
  const updatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString();

  let tableId: string | null = null;
  if (isUuid(payload.tableId)) {
    const t = await client.query(`SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2`, [payload.tableId, locationId]);
    if (t.rows[0]) tableId = payload.tableId;
  }
  let seatedSessionId: string | null = null;
  if (isUuid(payload.seatedSessionId)) {
    const s = await client.query(`SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2`, [payload.seatedSessionId, locationId]);
    if (s.rows[0]) seatedSessionId = payload.seatedSessionId;
  }
  let createdBy: string | null = null;
  if (isUuid(payload.createdBy)) {
    const u = await client.query(`SELECT id FROM users WHERE id = $1`, [payload.createdBy]);
    if (u.rows[0]) createdBy = payload.createdBy;
  }

  const dek = await getBusinessDek(businessId);
  const enc = dek ? encryptOptional(customerPhone, dek) : null;
  const bidx = dek && customerPhone ? phoneBlindIndex(customerPhone, dek) : null;

  await client.query(
    `INSERT INTO reservations (id, location_id, table_id, customer_name, customer_phone, customer_phone_enc, customer_phone_bidx, party_size, reserved_at, duration_minutes, status, seated_session_id, note, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO UPDATE SET table_id = EXCLUDED.table_id, customer_name = EXCLUDED.customer_name, customer_phone = NULL, customer_phone_enc = EXCLUDED.customer_phone_enc, customer_phone_bidx = EXCLUDED.customer_phone_bidx, party_size = EXCLUDED.party_size, reserved_at = EXCLUDED.reserved_at, duration_minutes = EXCLUDED.duration_minutes, status = EXCLUDED.status, seated_session_id = EXCLUDED.seated_session_id, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
    [reservationId, locationId, tableId, customerName, enc, bidx, partySize, reservedAt, durationMinutes, status, seatedSessionId, note, createdBy, createdAt, updatedAt],
  );

  return { effectType: "reservation", effectId: reservationId };
}
