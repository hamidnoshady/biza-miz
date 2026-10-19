import type { PoolClient } from "pg";
import { query } from "./db";
import type { Rial } from "./money";
import { evenSplit, isValidTableStatus, type TableStatus } from "./table-sessions";
import { recordReservationState, recordTableSessionState } from "./floor-sync";

export interface OpenSessionInput {
  locationId: string;
  tableIds: string[];
  partySize?: number | null;
  guestName?: string | null;
  guestPhone?: string | null;
  reservationId?: string | null;
  note?: string | null;
  openedBy: string | null;
  /**
   * When true, checks whether any requested table has an upcoming `booked`
   * reservation within `turnaroundMinutes` and throws `upcoming_reservation_conflict` (409).
   * Order creation (`ensureSessionForTable`) leaves this false so upcoming bookings
   * never block ringing up a new order.
   */
  checkUpcomingReservations?: boolean;
  turnaroundMinutes?: number;
}

export interface UpcomingReservationConflict {
  id: string;
  table_id: string;
  customer_name: string;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
}

export class TableSessionError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(code: string, status = 400, details?: unknown) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Look up the active open `table_sessions` row that currently holds `tableId`, if any.
 */
export async function getOpenSessionIdForTable(
  client: PoolClient,
  locationId: string,
  tableId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ts.id
       FROM table_sessions ts
       JOIN table_session_tables tst ON tst.session_id = ts.id AND tst.released_at IS NULL
      WHERE ts.location_id = $1
        AND ts.status = 'open'
        AND tst.table_id = $2
      LIMIT 1`,
    [locationId, tableId],
  );
  return rows[0]?.id ?? null;
}

export const findOpenSessionForTable = getOpenSessionIdForTable;

/**
 * Open a new `table_sessions` row inside an existing transaction and attach one or
 * more tables to it.
 */
export async function openSession(
  client: PoolClient,
  input: OpenSessionInput,
): Promise<{ id: string }> {
  if (!Array.isArray(input.tableIds) || input.tableIds.length === 0) {
    throw new TableSessionError("no_tables", 400);
  }
  const normalizedIds = input.tableIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (normalizedIds.length === 0) {
    throw new TableSessionError("no_tables", 400);
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new TableSessionError("duplicate_table_ids", 400);
  }

  if (input.partySize !== undefined && input.partySize !== null) {
    const ps = Number(input.partySize);
    if (!Number.isInteger(ps) || ps < 1 || ps > 500) {
      throw new TableSessionError("invalid_party_size", 400);
    }
  }

  const found = await client.query<{ id: string; status: TableStatus; is_active: boolean }>(
    `SELECT id, status, is_active
       FROM dining_tables
      WHERE location_id = $1 AND id = ANY($2::uuid[]) AND is_active
      FOR UPDATE`,
    [input.locationId, normalizedIds],
  );
  if (found.rows.length !== normalizedIds.length) {
    throw new TableSessionError("table_not_found", 404);
  }
  for (const row of found.rows) {
    if (row.status === "cleaning" || row.status === "out_of_service") {
      throw new TableSessionError("table_unavailable", 409);
    }
    const existing = await getOpenSessionIdForTable(client, input.locationId, row.id);
    if (existing) {
      throw new TableSessionError("table_occupied", 409);
    }
  }

  if (input.checkUpcomingReservations && !input.reservationId) {
    const turnaround = Math.max(15, Math.min(480, Math.round(input.turnaroundMinutes || 90)));
    const { rows: conflicts } = await client.query<{
      id: string;
      table_id: string;
      customer_name: string;
      party_size: number;
      reserved_at: Date;
      duration_minutes: number;
    }>(
      `SELECT id, table_id, customer_name, party_size, reserved_at, duration_minutes
         FROM reservations
        WHERE location_id = $1
          AND table_id = ANY($2::uuid[])
          AND status = 'booked'
          AND reserved_at < now() + ($3 || ' minutes')::interval
          AND reserved_at + (duration_minutes || ' minutes')::interval > now()
        ORDER BY reserved_at ASC`,
      [input.locationId, normalizedIds, String(turnaround)],
    );
    if (conflicts.length > 0) {
      throw new TableSessionError(
        "upcoming_reservation_conflict",
        409,
        conflicts.map((c) => ({
          id: c.id,
          table_id: c.table_id,
          customer_name: c.customer_name,
          party_size: c.party_size,
          reserved_at: c.reserved_at instanceof Date ? c.reserved_at.toISOString() : String(c.reserved_at),
          duration_minutes: c.duration_minutes,
        })),
      );
    }
  }

  const primary = normalizedIds[0];
  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO table_sessions
       (location_id, primary_table_id, party_size, guest_name, guest_phone,
        reservation_id, note, opened_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.locationId,
      primary,
      input.partySize ?? null,
      input.guestName ?? null,
      input.guestPhone ?? null,
      input.reservationId ?? null,
      input.note ?? null,
      input.openedBy,
    ],
  );
  const sessionId = inserted[0].id;

  for (const tid of normalizedIds) {
    await client.query(
      `INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2)`,
      [sessionId, tid],
    );
  }
  await client.query(
    `UPDATE dining_tables
        SET status = 'seated'
      WHERE location_id = $1
        AND id = ANY($2::uuid[])
        AND status IN ('free', 'reserved')`,
    [input.locationId, normalizedIds],
  );

  await recordTableSessionState(client, {
    locationId: input.locationId,
    sessionId,
    actor: { userId: input.openedBy },
  });

  return { id: sessionId };
}

/**
 * Find the open `table_sessions` row for `tableId`, or open a fresh one if the
 * table does not have an active session yet. Used by dine-in order creation so
 * multiple simultaneous orders can be created at the same table (each with its
 * own independent `orders` row, customer, items, and bill).
 */
export async function ensureSessionForTable(
  client: PoolClient,
  locationId: string,
  tableId: string,
  openedBy: string | null,
  partySize?: number | null,
): Promise<string> {
  const existing = await getOpenSessionIdForTable(client, locationId, tableId);
  if (existing) return existing;
  const { id } = await openSession(client, {
    locationId,
    tableIds: [tableId],
    partySize: partySize ?? null,
    openedBy,
    checkUpcomingReservations: false,
  });
  return id;
}

/**
 * Attach an additional table to an already-open session (multi-table merge).
 */
export async function mergeTableIntoSession(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  tableId: string,
): Promise<void> {
  const sess = await client.query<{ id: string }>(
    `SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE`,
    [sessionId, locationId],
  );
  if (!sess.rows[0]) {
    throw new TableSessionError("session_not_found", 404);
  }
  const tbl = await client.query<{ id: string; status: TableStatus }>(
    `SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE`,
    [tableId, locationId],
  );
  if (!tbl.rows[0]) {
    throw new TableSessionError("table_not_found", 404);
  }
  if (tbl.rows[0].status === "cleaning" || tbl.rows[0].status === "out_of_service") {
    throw new TableSessionError("table_unavailable", 409);
  }
  const existing = await getOpenSessionIdForTable(client, locationId, tableId);
  if (existing) {
    throw new TableSessionError("table_occupied", 409);
  }
  await client.query(
    `INSERT INTO table_session_tables (session_id, table_id)
     VALUES ($1, $2)
     ON CONFLICT (session_id, table_id) DO UPDATE SET released_at = NULL, joined_at = now()`,
    [sessionId, tableId],
  );
  await client.query(
    `UPDATE dining_tables SET status = 'seated' WHERE id = $1 AND status IN ('free', 'reserved')`,
    [tableId],
  );
  await recordTableSessionState(client, {
    locationId,
    sessionId,
    actor: { userId: null },
  });
}

/**
 * Reconcile any `seated` reservation linked to `sessionId` (or `reservationId`)
 * to `completed` when the guest visit ends.
 */
async function completeLinkedReservationsForSession(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  reservationId: string | null,
  actorUserId: string | null,
): Promise<string[]> {
  const { rows: completedRes } = await client.query<{ id: string; business_id: string }>(
    `UPDATE reservations r
        SET status = 'completed',
            updated_at = now()
       FROM locations l
      WHERE l.id = r.location_id
        AND r.location_id = $1
        AND r.status = 'seated'
        AND (r.seated_session_id = $2 OR ($3::uuid IS NOT NULL AND r.id = $3::uuid))
      RETURNING r.id, l.business_id`,
    [locationId, sessionId, reservationId],
  );
  for (const r of completedRes) {
    await recordReservationState(client, {
      businessId: r.business_id,
      locationId,
      reservationId: r.id,
      actor: { userId: actorUserId },
    });
  }
  return completedRes.map((r) => r.id);
}

/**
 * Close a visit session (`table_sessions`), stamp `released_at` on its
 * `table_session_tables` links, and complete any linked `seated` reservation.
 *
 * Manual physical table status (`dining_tables.status`) is decoupled from session
 * and order lifecycles: `dining_tables.status` is only updated when the caller
 * passes an explicit `options.nextTableStatus` (e.g. `"cleaning"` or `"free"`).
 */
export async function releaseSessionTables(
  client: PoolClient,
  sessionId: string,
  closedBy: string | null,
  options?: { nextTableStatus?: TableStatus | null },
): Promise<string[]> {
  const { rows: closedRows } = await client.query<{
    location_id: string;
    reservation_id: string | null;
  }>(
    `UPDATE table_sessions
        SET status = 'closed',
            closed_at = COALESCE(closed_at, now()),
            closed_by = COALESCE(closed_by, $2)
      WHERE id = $1
      RETURNING location_id, reservation_id`,
    [sessionId, closedBy],
  );
  const meta = closedRows[0];

  const { rows } = await client.query<{ table_id: string }>(
    `UPDATE table_session_tables
        SET released_at = now()
      WHERE session_id = $1 AND released_at IS NULL
      RETURNING table_id`,
    [sessionId],
  );
  const tableIds = rows.map((r) => r.table_id);

  if (options?.nextTableStatus && isValidTableStatus(options.nextTableStatus) && tableIds.length > 0) {
    await client.query(
      `UPDATE dining_tables
          SET status = $2::table_status
        WHERE id = ANY($1::uuid[]) AND status != 'out_of_service'`,
      [tableIds, options.nextTableStatus],
    );
  }

  if (meta) {
    await completeLinkedReservationsForSession(
      client,
      meta.location_id,
      sessionId,
      meta.reservation_id,
      closedBy,
    );
    await recordTableSessionState(client, {
      locationId: meta.location_id,
      sessionId,
      actor: { userId: closedBy },
    });
  }

  return tableIds;
}

/**
 * Reconcile active `table_session_tables` links when staff manually changes a
 * table's status to `free`, `cleaning`, or `out_of_service` via `PATCH /api/tables/[id]`.
 */
export async function reconcileTableSessionsOnManualStatusChange(
  client: PoolClient,
  locationId: string,
  tableId: string,
  nextStatus: TableStatus,
  actorUserId: string | null,
): Promise<{ closedSessionIds: string[]; completedReservationIds: string[] }> {
  if (nextStatus !== "free" && nextStatus !== "cleaning" && nextStatus !== "out_of_service") {
    return { closedSessionIds: [], completedReservationIds: [] };
  }

  const { rows: releasedLinks } = await client.query<{ session_id: string }>(
    `UPDATE table_session_tables tst
        SET released_at = now()
       FROM table_sessions ts
      WHERE tst.session_id = ts.id
        AND ts.location_id = $1
        AND tst.table_id = $2
        AND tst.released_at IS NULL
      RETURNING tst.session_id`,
    [locationId, tableId],
  );

  const closedSessionIds: string[] = [];
  const completedReservationIds: string[] = [];

  for (const link of releasedLinks) {
    const { rows: remaining } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM table_session_tables
        WHERE session_id = $1 AND released_at IS NULL`,
      [link.session_id],
    );
    if (Number(remaining[0]?.cnt ?? 0) === 0) {
      const { rows: closedSess } = await client.query<{ reservation_id: string | null }>(
        `UPDATE table_sessions
            SET status = 'closed',
                closed_at = COALESCE(closed_at, now()),
                closed_by = COALESCE(closed_by, $3)
          WHERE id = $1 AND location_id = $2 AND status = 'open'
          RETURNING reservation_id`,
        [link.session_id, locationId, actorUserId],
      );
      if (closedSess[0]) {
        closedSessionIds.push(link.session_id);
        const completed = await completeLinkedReservationsForSession(
          client,
          locationId,
          link.session_id,
          closedSess[0].reservation_id,
          actorUserId,
        );
        completedReservationIds.push(...completed);
      }
    }
    await recordTableSessionState(client, {
      locationId,
      sessionId: link.session_id,
      actor: { userId: actorUserId },
    });
  }

  return { closedSessionIds, completedReservationIds };
}

/**
 * Post-payment hook called when an order is settled in POS (`completeOrderPayment`).
 *
 * Issue #916 contract:
 * - Paying an order NEVER automatically frees `dining_tables.status`, NEVER closes
 *   `table_sessions`, and NEVER marks a `seated` reservation as `completed`.
 */
export async function releaseTableAfterOrderSettled(
  client: PoolClient,
  locationId: string,
  orderId: string,
  _closedBy: string | null,
): Promise<{ sessionId: string; tableIds: string[] } | null> {
  const { rows: ordRows } = await client.query<{ table_session_id: string | null }>(
    `SELECT table_session_id FROM orders WHERE id = $1 AND location_id = $2`,
    [orderId, locationId],
  );
  const sessionId = ordRows[0]?.table_session_id ?? null;
  if (!sessionId) return null;
  return { sessionId, tableIds: [] };
}

/**
 * Explicitly end a visit session (`PATCH /api/table-sessions/[id]` `action: "release"`).
 */
export async function releaseSessionWithoutOrders(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  closedBy: string | null,
  options?: { nextTableStatus?: TableStatus | null },
): Promise<string[]> {
  const { rows: sess } = await client.query<{ status: string }>(
    `SELECT status FROM table_sessions WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [sessionId, locationId],
  );
  if (!sess[0]) {
    throw new TableSessionError("session_not_found", 404);
  }
  if (sess[0].status !== "open") {
    throw new TableSessionError("session_already_closed", 409);
  }
  return releaseSessionTables(client, sessionId, closedBy, {
    nextTableStatus: options?.nextTableStatus ?? null,
  });
}

export interface SetSessionGuestsInput {
  businessId: string;
  locationId: string;
  sessionId: string;
  customerIds?: (string | null | undefined)[];
  partySize?: number | null;
}

/**
 * Replace the guest roster (and optional `partySize`) on an open session.
 */
export async function setSessionGuests(
  client: PoolClient,
  input: SetSessionGuestsInput,
): Promise<void> {
  const customerIds = Array.isArray(input.customerIds) ? input.customerIds : [];
  const filteredIds = customerIds
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean);
  if (customerIds.length > 50 || new Set(filteredIds).size !== filteredIds.length) {
    throw new TableSessionError("invalid_guests", 400);
  }
  if (input.partySize !== undefined && input.partySize !== null) {
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 500) {
      throw new TableSessionError("invalid_party_size", 400);
    }
  }

  const { rows: sessionRows } = await client.query<{ party_size: number | null; status: string }>(
    `SELECT party_size, status FROM table_sessions WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [input.sessionId, input.locationId],
  );
  if (sessionRows.length === 0) {
    throw new TableSessionError("session_not_found", 404);
  }
  if (sessionRows[0].status !== "open") {
    throw new TableSessionError("session_already_closed", 409);
  }

  const partySize =
    input.partySize !== undefined && input.partySize !== null
      ? Math.max(input.partySize, customerIds.length)
      : Math.max(1, customerIds.length, Number(sessionRows[0].party_size ?? 0));

  if (filteredIds.length > 0) {
    const { rows: ownedCustomers } = await client.query<{ id: string }>(
      `SELECT id FROM parties WHERE business_id = $1 AND is_active AND id = ANY($2::uuid[])`,
      [input.businessId, filteredIds],
    );
    if (ownedCustomers.length !== filteredIds.length) {
      throw new TableSessionError("customer_not_found", 404);
    }
  }

  await client.query(`DELETE FROM table_session_customers WHERE session_id = $1`, [input.sessionId]);
  for (const [index, rawId] of customerIds.entries()) {
    const customerId = typeof rawId === "string" ? rawId.trim() : "";
    if (!customerId) continue;
    await client.query(
      `INSERT INTO table_session_customers (business_id, location_id, session_id, guest_number, customer_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.businessId, input.locationId, input.sessionId, index + 1, customerId],
    );
  }
  await client.query(`UPDATE table_sessions SET party_size = $2 WHERE id = $1`, [
    input.sessionId,
    partySize,
  ]);

  await recordTableSessionState(client, {
    locationId: input.locationId,
    sessionId: input.sessionId,
    actor: { userId: null },
  });
}

export interface SessionBillLine {
  id: string;
  orderItemId: string;
  orderId: string;
  order_id: string;
  order_number: number;
  name: string;
  name_snapshot: string;
  quantity: number;
  unit_price: number;
  modifiers_total: number;
  line_total: number;
  amount: Rial;
  status: string;
}

export interface SessionOrderSummary {
  id: string;
  order_number: number;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  subtotal: number;
  discount: number;
  service_charge: number;
  tax: number;
  total: number;
  paid_amount: number;
  outstanding_amount: number;
  opened_at: string;
}

export interface SessionBill {
  sessionId: string;
  partySize: number;
  subtotal: Rial;
  discount: Rial;
  serviceCharge: Rial;
  tax: Rial;
  total: Rial;
  paidTotal: Rial;
  outstandingTotal: Rial;
  equalShares: number[];
  orders: SessionOrderSummary[];
  lines: SessionBillLine[];
}

/**
 * Summarize canonical persisted order totals for a `table_sessions` row.
 *
 * Issue #916 (Finding 16): Reads canonical persisted `subtotal`, `discount`,
 * `service_charge`, `tax`, `total`, and recorded `payments` directly from
 * `orders` and `payments`, keeping each order's financial identity distinct.
 */
export async function computeSessionBill(
  sessionIdOrLocationId: string,
  maybeSessionId?: string,
): Promise<SessionBill> {
  const sessionId = maybeSessionId ?? sessionIdOrLocationId;
  const locationFilter = maybeSessionId ? sessionIdOrLocationId : null;

  const sessRes = await query<{ id: string; location_id: string; party_size: number | null }>(
    locationFilter
      ? `SELECT id, location_id, party_size FROM table_sessions WHERE id = $1 AND location_id = $2`
      : `SELECT id, location_id, party_size FROM table_sessions WHERE id = $1`,
    locationFilter ? [sessionId, locationFilter] : [sessionId],
  );
  const sess = sessRes.rows[0];
  const partySize = Math.max(1, sess?.party_size ?? 1);
  if (!sess) {
    return {
      sessionId,
      partySize: 1,
      subtotal: 0,
      discount: 0,
      serviceCharge: 0,
      tax: 0,
      total: 0,
      paidTotal: 0,
      outstandingTotal: 0,
      equalShares: [0],
      orders: [],
      lines: [],
    };
  }

  const ordersRes = await query<{
    id: string;
    order_number: number;
    status: string;
    customer_id: string | null;
    customer_name: string | null;
    subtotal: string;
    discount: string;
    service_charge: string;
    tax: string;
    total: string;
    paid_amount: string;
    opened_at: Date;
  }>(
    `SELECT o.id, o.order_number, o.status::text AS status,
            o.customer_id, p.name AS customer_name,
            o.subtotal::text, o.discount::text, o.service_charge::text,
            o.tax::text, o.total::text,
            COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = o.id), 0)::text AS paid_amount,
            o.opened_at
       FROM orders o
       LEFT JOIN parties p ON p.id = o.customer_id
      WHERE o.location_id = $1
        AND o.table_session_id = $2
        AND o.status != 'voided'
      ORDER BY o.opened_at ASC, o.id ASC`,
    [sess.location_id, sessionId],
  );

  const linesRes = await query<{
    id: string;
    order_id: string;
    order_number: number;
    name_snapshot: string;
    quantity: number;
    unit_price: string;
    status: string;
    modifiers_total: string;
  }>(
    `SELECT oi.id, oi.order_id, o.order_number, oi.name_snapshot,
            oi.quantity, oi.unit_price::text, oi.status,
            COALESCE((
              SELECT SUM(oim.price_delta * oim.quantity)
                FROM order_item_modifiers oim
               WHERE oim.order_item_id = oi.id
            ), 0)::text AS modifiers_total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.location_id = $1
        AND o.table_session_id = $2
        AND o.status != 'voided'
        AND oi.status != 'voided'
      ORDER BY o.opened_at, oi.created_at`,
    [sess.location_id, sessionId],
  );

  const lines: SessionBillLine[] = linesRes.rows.map((r) => {
    const unit = Number(r.unit_price);
    const mods = Number(r.modifiers_total);
    const lineTotal = (unit + mods) * r.quantity;
    return {
      id: r.id,
      orderItemId: r.id,
      orderId: r.order_id,
      order_id: r.order_id,
      order_number: Number(r.order_number),
      name: r.name_snapshot,
      name_snapshot: r.name_snapshot,
      quantity: r.quantity,
      unit_price: unit,
      modifiers_total: mods,
      line_total: lineTotal,
      amount: lineTotal,
      status: r.status,
    };
  });

  let subtotal = 0;
  let discount = 0;
  let serviceCharge = 0;
  let tax = 0;
  let total = 0;
  let paidTotal = 0;
  let outstandingTotal = 0;

  const orders: SessionOrderSummary[] = ordersRes.rows.map((o) => {
    const oSub = Number(o.subtotal);
    const oDisc = Number(o.discount);
    const oSvc = Number(o.service_charge);
    const oTax = Number(o.tax);
    const oTot = Number(o.total);
    const oPaid = Number(o.paid_amount);
    const oOut = o.status === "completed" ? 0 : Math.max(0, oTot - oPaid);

    subtotal += oSub;
    discount += oDisc;
    serviceCharge += oSvc;
    tax += oTax;
    total += oTot;
    paidTotal += oPaid;
    outstandingTotal += oOut;

    return {
      id: o.id,
      order_number: Number(o.order_number),
      status: o.status,
      customer_id: o.customer_id,
      customer_name: o.customer_name,
      subtotal: oSub,
      discount: oDisc,
      service_charge: oSvc,
      tax: oTax,
      total: oTot,
      paid_amount: oPaid,
      outstanding_amount: oOut,
      opened_at: o.opened_at instanceof Date ? o.opened_at.toISOString() : String(o.opened_at),
    };
  });

  return {
    sessionId,
    partySize,
    subtotal,
    discount,
    serviceCharge,
    tax,
    total,
    paidTotal,
    outstandingTotal,
    equalShares: evenSplit(outstandingTotal > 0 ? outstandingTotal : total, partySize),
    orders,
    lines,
  };
}
