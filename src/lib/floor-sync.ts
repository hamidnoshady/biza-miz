import type { PoolClient } from "pg";
import { getPool } from "./db";
import type { Role } from "./auth";
import { deploymentRole } from "./deployment-role";
import { encryptReservationPhone } from "./reservation-service";
import {
  SyncPayloadError,
  type SyncDomainEffect,
} from "./sync-domain-handlers";
import { appendSyncOutboxEvent } from "./sync-outbox";

export interface SyncActor {
  userId?: string | null;
  role?: Role | string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export interface TableSessionStateSyncPayload {
  sessionId: string;
  locationId: string;
  status: "open" | "closed";
  partySize: number | null;
  guestName: string | null;
  openedBy: string | null;
  openedAt: string;
  billRequestedAt: string | null;
  closedAt: string | null;
  note: string | null;
  tables: Array<{
    tableId: string;
    mergedAt: string;
    releasedAt: string | null;
  }>;
  customers: Array<{
    guestNumber: number;
    customerId: string;
  }>;
}

export interface ReservationStateSyncPayload {
  reservationId: string;
  locationId: string;
  tableId: string | null;
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  reservedAt: string;
  durationMinutes: number;
  status: "booked" | "seated" | "cancelled" | "no_show" | "completed";
  seatedSessionId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

async function shouldRecordFloorSync(
  client: PoolClient,
  locationId: string,
): Promise<boolean> {
  const { rows: gate } = await client.query<{ record: boolean }>(
    `SELECT coalesce(current_setting('app.sync_replay', true), '') <> 'on'
            AND ($2::boolean OR EXISTS (
                  SELECT 1 FROM site_devices d
                   WHERE d.location_id = $1 AND d.status = 'active' AND d.revoked_at IS NULL)) AS record`,
    [locationId, deploymentRole() === "site"],
  );
  return Boolean(gate[0]?.record);
}

/**
 * Emit `table_session.state.synced` inside an open transaction whenever a
 * `table_sessions` row (or its attached tables/customers) changes.
 */
export async function recordTableSessionState(
  client: PoolClient,
  params: {
    businessId?: string;
    locationId: string;
    sessionId: string;
    actor: SyncActor;
  },
): Promise<void> {
  if (!(await shouldRecordFloorSync(client, params.locationId))) return;

  const { rows: sessionRows } = await client.query<{
    id: string;
    location_id: string;
    status: "open" | "closed";
    party_size: number | null;
    guest_name: string | null;
    opened_by: string | null;
    opened_at: Date;
    bill_requested_at: Date | null;
    closed_at: Date | null;
    note: string | null;
    stamp: string;
  }>(
    `SELECT id, location_id, status::text AS status, party_size, guest_name,
            opened_by, opened_at, bill_requested_at, closed_at, note,
            app_sync_next_hlc() AS stamp
       FROM table_sessions
      WHERE id = $1 AND location_id = $2`,
    [params.sessionId, params.locationId],
  );
  const s = sessionRows[0];
  if (!s) return;

  const { rows: tableRows } = await client.query<{
    table_id: string;
    joined_at: Date;
    released_at: Date | null;
  }>(
    `SELECT table_id, joined_at, released_at
       FROM table_session_tables
      WHERE session_id = $1
      ORDER BY joined_at, table_id`,
    [params.sessionId],
  );

  const { rows: customerRows } = await client.query<{
    guest_number: number;
    customer_id: string;
  }>(
    `SELECT guest_number, customer_id
       FROM table_session_customers
      WHERE session_id = $1
      ORDER BY guest_number`,
    [params.sessionId],
  );

  const payload: TableSessionStateSyncPayload = {
    sessionId: s.id,
    locationId: s.location_id,
    status: s.status,
    partySize: s.party_size,
    guestName: s.guest_name,
    openedBy: s.opened_by,
    openedAt: new Date(s.opened_at).toISOString(),
    billRequestedAt: s.bill_requested_at
      ? new Date(s.bill_requested_at).toISOString()
      : null,
    closedAt: s.closed_at ? new Date(s.closed_at).toISOString() : null,
    note: s.note,
    tables: tableRows.map((t) => ({
      tableId: t.table_id,
      mergedAt: new Date(t.joined_at).toISOString(),
      releasedAt: t.released_at ? new Date(t.released_at).toISOString() : null,
    })),
    customers: customerRows.map((c) => ({
      guestNumber: Number(c.guest_number),
      customerId: c.customer_id,
    })),
  };

  await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: `table-session-state:${s.id}:${s.stamp}`,
    eventType: "table_session.state.synced",
    payload: payload as unknown as Record<string, unknown>,
    actorUserId: params.actor.userId ?? null,
    actorRole: (params.actor.role as Role | null | undefined) ?? "owner",
  });
}

/**
 * Emit `reservation.state.synced` inside an open transaction whenever a
 * `reservations` row is created or updated.
 */
export async function recordReservationState(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    reservationId: string;
    actor: SyncActor;
    plainCustomerName?: string;
    plainCustomerPhone?: string | null;
  },
): Promise<void> {
  if (!(await shouldRecordFloorSync(client, params.locationId))) return;

  const { rows } = await client.query<{
    id: string;
    location_id: string;
    table_id: string | null;
    customer_name: string;
    customer_phone: string | null;
    party_size: number;
    reserved_at: Date;
    duration_minutes: number;
    status: "booked" | "seated" | "cancelled" | "no_show" | "completed";
    seated_session_id: string | null;
    note: string | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
    stamp: string;
  }>(
    `SELECT id, location_id, table_id, customer_name, customer_phone,
            party_size, reserved_at, duration_minutes, status::text AS status,
            seated_session_id, note, created_by, created_at, updated_at,
            app_sync_next_hlc() AS stamp
       FROM reservations
      WHERE id = $1 AND location_id = $2`,
    [params.reservationId, params.locationId],
  );
  const r = rows[0];
  if (!r) return;

  const payload: ReservationStateSyncPayload = {
    reservationId: r.id,
    locationId: r.location_id,
    tableId: r.table_id,
    customerName: params.plainCustomerName ?? r.customer_name,
    customerPhone:
      params.plainCustomerPhone !== undefined
        ? params.plainCustomerPhone
        : r.customer_phone,
    partySize: Number(r.party_size),
    reservedAt: new Date(r.reserved_at).toISOString(),
    durationMinutes: Number(r.duration_minutes),
    status: r.status,
    seatedSessionId: r.seated_session_id,
    note: r.note,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };

  await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: `reservation-state:${r.id}:${r.stamp}`,
    eventType: "reservation.state.synced",
    payload: payload as unknown as Record<string, unknown>,
    actorUserId: params.actor.userId ?? null,
    actorRole: (params.actor.role as Role | null | undefined) ?? "owner",
  });
}

export async function recordTableSessionStateStandalone(params: {
  businessId?: string;
  locationId: string;
  sessionId: string;
  actor: SyncActor;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await recordTableSessionState(client, params);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
  }
}

export async function recordReservationStateStandalone(params: {
  businessId: string;
  locationId: string;
  reservationId: string;
  actor: SyncActor;
  plainCustomerName?: string;
  plainCustomerPhone?: string | null;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await recordReservationState(client, params);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
  }
}

/**
 * Apply an incoming `table_session.state.synced` event idempotently.
 */
export async function applyTableSessionState(
  client: PoolClient,
  context: {
    businessId: string;
    locationId: string;
    payload: Record<string, unknown>;
  },
): Promise<SyncDomainEffect> {
  const { locationId, payload } = context;
  const sessionId = payload.sessionId;
  if (!isUuid(sessionId)) {
    throw new SyncPayloadError("invalid_session_id");
  }
  const status = payload.status === "closed" ? "closed" : "open";
  const partySize =
    typeof payload.partySize === "number" && Number.isFinite(payload.partySize)
      ? Math.max(1, Math.trunc(payload.partySize))
      : null;
  const guestName =
    typeof payload.guestName === "string" ? payload.guestName : null;
  const openedBy = isUuid(payload.openedBy) ? payload.openedBy : null;
  const openedAt =
    typeof payload.openedAt === "string"
      ? payload.openedAt
      : new Date().toISOString();
  const billRequestedAt =
    typeof payload.billRequestedAt === "string" ? payload.billRequestedAt : null;
  const closedAt =
    typeof payload.closedAt === "string" ? payload.closedAt : null;
  const note = typeof payload.note === "string" ? payload.note : null;

  let validOpenedBy: string | null = null;
  if (openedBy) {
    const u = await client.query(`SELECT id FROM users WHERE id = $1`, [
      openedBy,
    ]);
    if (u.rows[0]) validOpenedBy = openedBy;
  }

  await client.query(
    `INSERT INTO table_sessions
       (id, location_id, status, party_size, guest_name, opened_by, opened_at, bill_requested_at, closed_at, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       party_size = EXCLUDED.party_size,
       guest_name = EXCLUDED.guest_name,
       bill_requested_at = EXCLUDED.bill_requested_at,
       closed_at = EXCLUDED.closed_at,
       note = EXCLUDED.note`,
    [
      sessionId,
      locationId,
      status,
      partySize,
      guestName,
      validOpenedBy,
      openedAt,
      billRequestedAt,
      closedAt,
      note,
    ],
  );

  const tables = Array.isArray(payload.tables) ? payload.tables : [];
  for (const raw of tables) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    if (!isUuid(t.tableId)) continue;
    const tableExists = await client.query(
      `SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2`,
      [t.tableId, locationId],
    );
    if (!tableExists.rows[0]) continue;

    const mergedAt =
      typeof t.mergedAt === "string" ? t.mergedAt : openedAt;
    const releasedAt =
      typeof t.releasedAt === "string"
        ? t.releasedAt
        : status === "closed"
          ? closedAt ?? new Date().toISOString()
          : null;

    if (releasedAt === null) {
      await client.query(
        `UPDATE table_session_tables
            SET released_at = now()
          WHERE table_id = $1 AND session_id <> $2 AND released_at IS NULL`,
        [t.tableId, sessionId],
      );
    }

    await client.query(
      `INSERT INTO table_session_tables (session_id, table_id, joined_at, released_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, table_id) DO UPDATE SET
         joined_at = EXCLUDED.joined_at,
         released_at = EXCLUDED.released_at`,
      [sessionId, t.tableId, mergedAt, releasedAt],
    );
  }

  const customers = Array.isArray(payload.customers) ? payload.customers : [];
  for (const raw of customers) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const guestNumber = Number(c.guestNumber);
    if (!Number.isInteger(guestNumber) || guestNumber < 1 || !isUuid(c.customerId)) {
      continue;
    }
    const partyExists = await client.query(
      `SELECT id FROM parties WHERE id = $1`,
      [c.customerId],
    );
    if (!partyExists.rows[0]) continue;

    await client.query(
      `INSERT INTO table_session_customers (session_id, guest_number, customer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, guest_number) DO UPDATE SET
         customer_id = EXCLUDED.customer_id`,
      [sessionId, guestNumber, c.customerId],
    );
  }

  return { effectType: "table_session", effectId: sessionId };
}

/**
 * Apply an incoming `reservation.state.synced` event idempotently.
 */
export async function applyReservationState(
  client: PoolClient,
  context: {
    businessId: string;
    locationId: string;
    payload: Record<string, unknown>;
  },
): Promise<SyncDomainEffect> {
  const { businessId, locationId, payload } = context;
  const reservationId = payload.reservationId;
  if (!isUuid(reservationId)) {
    throw new SyncPayloadError("invalid_reservation_id");
  }
  const customerName =
    typeof payload.customerName === "string" && payload.customerName.trim()
      ? payload.customerName.trim()
      : "مهمان";
  const customerPhone =
    typeof payload.customerPhone === "string" && payload.customerPhone.trim()
      ? payload.customerPhone.trim()
      : null;
  const partySize =
    typeof payload.partySize === "number" && Number.isFinite(payload.partySize)
      ? Math.max(1, Math.trunc(payload.partySize))
      : 2;
  const reservedAt =
    typeof payload.reservedAt === "string"
      ? payload.reservedAt
      : new Date().toISOString();
  const durationMinutes =
    typeof payload.durationMinutes === "number" &&
    Number.isFinite(payload.durationMinutes)
      ? Math.max(15, Math.trunc(payload.durationMinutes))
      : 90;
  const validStatuses = new Set([
    "booked",
    "seated",
    "cancelled",
    "no_show",
    "completed",
  ]);
  const status =
    typeof payload.status === "string" && validStatuses.has(payload.status)
      ? payload.status
      : "booked";
  const note = typeof payload.note === "string" ? payload.note : null;
  const createdAt =
    typeof payload.createdAt === "string"
      ? payload.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof payload.updatedAt === "string"
      ? payload.updatedAt
      : new Date().toISOString();

  let tableId: string | null = null;
  if (isUuid(payload.tableId)) {
    const t = await client.query(
      `SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2`,
      [payload.tableId, locationId],
    );
    if (t.rows[0]) tableId = payload.tableId;
  }

  let seatedSessionId: string | null = null;
  if (isUuid(payload.seatedSessionId)) {
    const s = await client.query(
      `SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2`,
      [payload.seatedSessionId, locationId],
    );
    if (s.rows[0]) seatedSessionId = payload.seatedSessionId;
  }

  let createdBy: string | null = null;
  if (isUuid(payload.createdBy)) {
    const u = await client.query(`SELECT id FROM users WHERE id = $1`, [
      payload.createdBy,
    ]);
    if (u.rows[0]) createdBy = payload.createdBy;
  }

  const encryptedPhone = await encryptReservationPhone(
    businessId,
    customerPhone,
  );

  await client.query(
    `INSERT INTO reservations
       (id, location_id, table_id, customer_name,
        customer_phone, customer_phone_enc, customer_phone_bidx,
        party_size, reserved_at, duration_minutes, status, seated_session_id,
        note, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO UPDATE SET
       table_id = EXCLUDED.table_id,
       customer_name = EXCLUDED.customer_name,
       customer_phone = NULL,
       customer_phone_enc = EXCLUDED.customer_phone_enc,
       customer_phone_bidx = EXCLUDED.customer_phone_bidx,
       party_size = EXCLUDED.party_size,
       reserved_at = EXCLUDED.reserved_at,
       duration_minutes = EXCLUDED.duration_minutes,
       status = EXCLUDED.status,
       seated_session_id = EXCLUDED.seated_session_id,
       note = EXCLUDED.note,
       updated_at = EXCLUDED.updated_at`,
    [
      reservationId,
      locationId,
      tableId,
      customerName,
      encryptedPhone.enc,
      encryptedPhone.bidx,
      partySize,
      reservedAt,
      durationMinutes,
      status,
      seatedSessionId,
      note,
      createdBy,
      createdAt,
      updatedAt,
    ],
  );

  return { effectType: "reservation", effectId: reservationId };
}
