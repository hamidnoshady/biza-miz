import type { PoolClient } from "pg";
import type { Role } from "./auth";
import { getPool, query } from "./db";
import { deploymentRole } from "./deployment-role";
import type { Rial } from "./money";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { TableStatus } from "./table-sessions";

export interface SyncActor {
  userId?: string | null;
  role?: Role | string | null;
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
  tables: Array<{ tableId: string; mergedAt: string; releasedAt: string | null }>;
  customers: Array<{ guestNumber: number; customerId: string }>;
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

const VALID_STATUSES = new Set(["free", "seated", "reserved", "bill_requested", "cleaning", "out_of_service"]);
const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);

async function shouldSync(client: PoolClient, locationId: string): Promise<boolean> {
  const { rows } = await client.query<{ record: boolean }>(
    `SELECT coalesce(current_setting('app.sync_replay', true), '') <> 'on' AND ($2::boolean OR EXISTS (SELECT 1 FROM site_devices d WHERE d.location_id = $1 AND d.status = 'active' AND d.revoked_at IS NULL)) AS record`,
    [locationId, deploymentRole() === "site"],
  );
  return Boolean(rows[0]?.record);
}

export async function recordTableSessionState(
  client: PoolClient,
  p: { businessId?: string; locationId: string; sessionId: string; actor: SyncActor },
): Promise<void> {
  if (!(await shouldSync(client, p.locationId))) return;
  const { rows } = await client.query(
    `SELECT id, location_id, status::text AS status, party_size, guest_name, opened_by, opened_at, bill_requested_at, closed_at, note, app_sync_next_hlc() AS stamp FROM table_sessions WHERE id = $1 AND location_id = $2`,
    [p.sessionId, p.locationId],
  );
  const s = rows[0];
  if (!s) return;
  const { rows: tRows } = await client.query(
    `SELECT table_id, joined_at, released_at FROM table_session_tables WHERE session_id = $1 ORDER BY joined_at, table_id`,
    [p.sessionId],
  );
  const { rows: cRows } = await client.query(
    `SELECT guest_number, customer_id FROM table_session_customers WHERE session_id = $1 ORDER BY guest_number`,
    [p.sessionId],
  );
  await appendSyncOutboxEvent(client, {
    locationId: p.locationId,
    clientEventId: `table-session-state:${s.id}:${s.stamp}`,
    eventType: "table_session.state.synced",
    payload: {
      sessionId: s.id, locationId: s.location_id, status: s.status, partySize: s.party_size,
      guestName: s.guest_name, openedBy: s.opened_by, openedAt: iso(s.opened_at)!,
      billRequestedAt: iso(s.bill_requested_at), closedAt: iso(s.closed_at), note: s.note,
      tables: tRows.map((t) => ({ tableId: t.table_id, mergedAt: iso(t.joined_at)!, releasedAt: iso(t.released_at) })),
      customers: cRows.map((c) => ({ guestNumber: Number(c.guest_number), customerId: c.customer_id })),
    },
    actorUserId: p.actor.userId ?? null,
    actorRole: (p.actor.role as Role | null | undefined) ?? "owner",
  });
}

export async function recordReservationState(
  client: PoolClient,
  p: { businessId: string; locationId: string; reservationId: string; actor: SyncActor; plainCustomerName?: string; plainCustomerPhone?: string | null },
): Promise<void> {
  if (!(await shouldSync(client, p.locationId))) return;
  const { rows } = await client.query(
    `SELECT id, location_id, table_id, customer_name, customer_phone, party_size, reserved_at, duration_minutes, status::text AS status, seated_session_id, note, created_by, created_at, updated_at, app_sync_next_hlc() AS stamp FROM reservations WHERE id = $1 AND location_id = $2`,
    [p.reservationId, p.locationId],
  );
  const r = rows[0];
  if (!r) return;
  await appendSyncOutboxEvent(client, {
    locationId: p.locationId,
    clientEventId: `reservation-state:${r.id}:${r.stamp}`,
    eventType: "reservation.state.synced",
    payload: {
      reservationId: r.id, locationId: r.location_id, tableId: r.table_id,
      customerName: p.plainCustomerName ?? r.customer_name,
      customerPhone: p.plainCustomerPhone !== undefined ? p.plainCustomerPhone : r.customer_phone,
      partySize: Number(r.party_size), reservedAt: iso(r.reserved_at)!, durationMinutes: Number(r.duration_minutes),
      status: r.status, seatedSessionId: r.seated_session_id, note: r.note,
      createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    },
    actorUserId: p.actor.userId ?? null,
    actorRole: (p.actor.role as Role | null | undefined) ?? "owner",
  });
}

export async function recordTableSessionStateStandalone(p: { businessId?: string; locationId: string; sessionId: string; actor: SyncActor }): Promise<void> {
  const c = await getPool().connect();
  try { await c.query("BEGIN"); await recordTableSessionState(c, p); await c.query("COMMIT"); }
  catch { await c.query("ROLLBACK").catch(() => {}); }
  finally { c.release(); }
}

export async function recordReservationStateStandalone(p: { businessId: string; locationId: string; reservationId: string; actor: SyncActor; plainCustomerName?: string; plainCustomerPhone?: string | null }): Promise<void> {
  const c = await getPool().connect();
  try { await c.query("BEGIN"); await recordReservationState(c, p); await c.query("COMMIT"); }
  catch { await c.query("ROLLBACK").catch(() => {}); }
  finally { c.release(); }
}

export interface OpenSessionInput {
  locationId: string;
  tableIds: string[];
  partySize?: number | null;
  guestName?: string | null;
  guestPhone?: string | null;
  reservationId?: string | null;
  note?: string | null;
  openedBy: string | null;
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

export async function getOpenSessionIdForTable(client: PoolClient, locationId: string, tableId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ts.id FROM table_sessions ts JOIN table_session_tables tst ON tst.session_id = ts.id AND tst.released_at IS NULL WHERE ts.location_id = $1 AND ts.status = 'open' AND tst.table_id = $2 LIMIT 1`,
    [locationId, tableId],
  );
  return rows[0]?.id ?? null;
}

export const findOpenSessionForTable = getOpenSessionIdForTable;

export async function openSession(client: PoolClient, input: OpenSessionInput): Promise<{ id: string }> {
  if (!Array.isArray(input.tableIds) || input.tableIds.length === 0) throw new TableSessionError("no_tables", 400);
  const ids = input.tableIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (ids.length === 0) throw new TableSessionError("no_tables", 400);
  if (new Set(ids).size !== ids.length) throw new TableSessionError("duplicate_table_ids", 400);
  if (input.partySize != null) {
    const ps = Number(input.partySize);
    if (!Number.isInteger(ps) || ps < 1 || ps > 500) throw new TableSessionError("invalid_party_size", 400);
  }
  const found = await client.query<{ id: string; status: TableStatus }>(
    `SELECT id, status FROM dining_tables WHERE location_id = $1 AND id = ANY($2::uuid[]) AND is_active FOR UPDATE`,
    [input.locationId, ids],
  );
  if (found.rows.length !== ids.length) throw new TableSessionError("table_not_found", 404);
  for (const row of found.rows) {
    if (row.status === "cleaning" || row.status === "out_of_service") throw new TableSessionError("table_unavailable", 409);
    if (await getOpenSessionIdForTable(client, input.locationId, row.id)) throw new TableSessionError("table_occupied", 409);
  }
  if (input.checkUpcomingReservations && !input.reservationId) {
    const mins = String(Math.max(15, Math.min(480, Math.round(input.turnaroundMinutes || 90))));
    const { rows: c } = await client.query<{
      id: string;
      table_id: string;
      customer_name: string;
      party_size: number;
      reserved_at: Date | string;
      duration_minutes: number;
    }>(
      `SELECT id, table_id, customer_name, party_size, reserved_at, duration_minutes FROM reservations WHERE location_id = $1 AND table_id = ANY($2::uuid[]) AND status = 'booked' AND reserved_at < now() + ($3 || ' minutes')::interval AND reserved_at + (duration_minutes || ' minutes')::interval > now() ORDER BY reserved_at ASC`,
      [input.locationId, ids, mins],
    );
    if (c.length > 0) {
      throw new TableSessionError(
        "upcoming_reservation_conflict",
        409,
        c.map((r) => {
          const reservedAtIso = iso(r.reserved_at)!;
          return {
            ...r,
            reserved_at: reservedAtIso,
            tableId: r.table_id,
            customerName: r.customer_name,
            partySize: r.party_size,
            reservedAt: reservedAtIso,
            durationMinutes: r.duration_minutes,
          };
        }),
      );
    }
  }
  const { rows: ins } = await client.query<{ id: string }>(
    `INSERT INTO table_sessions (location_id, primary_table_id, party_size, guest_name, guest_phone, reservation_id, note, opened_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.locationId, ids[0], input.partySize ?? null, input.guestName ?? null, input.guestPhone ?? null, input.reservationId ?? null, input.note ?? null, input.openedBy],
  );
  const sessionId = ins[0].id;
  for (const tid of ids) await client.query(`INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2)`, [sessionId, tid]);
  await client.query(`UPDATE dining_tables SET status = 'seated' WHERE location_id = $1 AND id = ANY($2::uuid[]) AND status IN ('free', 'reserved')`, [input.locationId, ids]);
  await recordTableSessionState(client, { locationId: input.locationId, sessionId, actor: { userId: input.openedBy } });
  return { id: sessionId };
}

export async function ensureSessionForTable(client: PoolClient, locationId: string, tableId: string, openedBy: string | null, partySize?: number | null): Promise<string> {
  return (await getOpenSessionIdForTable(client, locationId, tableId)) ?? (await openSession(client, { locationId, tableIds: [tableId], partySize: partySize ?? null, openedBy })).id;
}

export async function mergeTableIntoSession(client: PoolClient, locationId: string, sessionId: string, tableId: string): Promise<void> {
  const sess = await client.query(`SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE`, [sessionId, locationId]);
  if (!sess.rows[0]) throw new TableSessionError("session_not_found", 404);
  const tbl = await client.query<{ id: string; status: TableStatus }>(`SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE`, [tableId, locationId]);
  if (!tbl.rows[0]) throw new TableSessionError("table_not_found", 404);
  if (tbl.rows[0].status === "cleaning" || tbl.rows[0].status === "out_of_service") throw new TableSessionError("table_unavailable", 409);
  if (await getOpenSessionIdForTable(client, locationId, tableId)) throw new TableSessionError("table_occupied", 409);
  await client.query(`INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2) ON CONFLICT (session_id, table_id) DO UPDATE SET released_at = NULL, joined_at = now()`, [sessionId, tableId]);
  await client.query(`UPDATE dining_tables SET status = 'seated' WHERE id = $1 AND status IN ('free', 'reserved')`, [tableId]);
  await recordTableSessionState(client, { locationId, sessionId, actor: { userId: null } });
}

async function completeLinkedReservations(client: PoolClient, locationId: string, sessionId: string, reservationId: string | null, actorUserId: string | null): Promise<string[]> {
  const { rows } = await client.query<{ id: string; business_id: string }>(
    `UPDATE reservations r SET status = 'completed', updated_at = now() FROM locations l WHERE l.id = r.location_id AND r.location_id = $1 AND r.status = 'seated' AND (r.seated_session_id = $2 OR ($3::uuid IS NOT NULL AND r.id = $3::uuid)) RETURNING r.id, l.business_id`,
    [locationId, sessionId, reservationId],
  );
  for (const r of rows) await recordReservationState(client, { businessId: r.business_id, locationId, reservationId: r.id, actor: { userId: actorUserId } });
  return rows.map((r) => r.id);
}

export async function releaseSessionTables(client: PoolClient, sessionId: string, closedBy: string | null, options?: { nextTableStatus?: TableStatus | null }): Promise<string[]> {
  const { rows: closedRows } = await client.query<{ location_id: string; reservation_id: string | null }>(
    `UPDATE table_sessions SET status = 'closed', closed_at = COALESCE(closed_at, now()), closed_by = COALESCE(closed_by, $2) WHERE id = $1 RETURNING location_id, reservation_id`,
    [sessionId, closedBy],
  );
  const meta = closedRows[0];
  const { rows } = await client.query<{ table_id: string }>(`UPDATE table_session_tables SET released_at = now() WHERE session_id = $1 AND released_at IS NULL RETURNING table_id`, [sessionId]);
  const tableIds = rows.map((r) => r.table_id);
  if (options?.nextTableStatus && VALID_STATUSES.has(options.nextTableStatus) && tableIds.length > 0) {
    await client.query(`UPDATE dining_tables SET status = $2::table_status WHERE id = ANY($1::uuid[]) AND status != 'out_of_service'`, [tableIds, options.nextTableStatus]);
  }
  if (meta) {
    await completeLinkedReservations(client, meta.location_id, sessionId, meta.reservation_id, closedBy);
    await recordTableSessionState(client, { locationId: meta.location_id, sessionId, actor: { userId: closedBy } });
  }
  return tableIds;
}

export async function reconcileTableSessionsOnManualStatusChange(client: PoolClient, locationId: string, tableId: string, nextStatus: TableStatus, actorUserId: string | null): Promise<{ closedSessionIds: string[]; completedReservationIds: string[] }> {
  if (nextStatus !== "free" && nextStatus !== "cleaning" && nextStatus !== "out_of_service") return { closedSessionIds: [], completedReservationIds: [] };
  const { rows: activeOrders } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM orders o WHERE o.location_id = $1 AND o.status IN ('open', 'held') AND (o.table_id = $2 OR o.table_session_id IN (SELECT tst.session_id FROM table_session_tables tst JOIN table_sessions ts ON ts.id = tst.session_id WHERE tst.table_id = $2 AND ts.location_id = $1 AND tst.released_at IS NULL AND ts.status = 'open'))`,
    [locationId, tableId],
  );
  if (Number(activeOrders[0]?.cnt ?? 0) > 0) return { closedSessionIds: [], completedReservationIds: [] };
  const { rows: links } = await client.query<{ session_id: string }>(
    `UPDATE table_session_tables tst SET released_at = now() FROM table_sessions ts WHERE tst.session_id = ts.id AND ts.location_id = $1 AND tst.table_id = $2 AND tst.released_at IS NULL RETURNING tst.session_id`,
    [locationId, tableId],
  );
  const closedSessionIds: string[] = [], completedReservationIds: string[] = [];
  for (const link of links) {
    const { rows: rem } = await client.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM table_session_tables WHERE session_id = $1 AND released_at IS NULL`, [link.session_id]);
    if (Number(rem[0]?.cnt ?? 0) === 0) {
      const { rows: cs } = await client.query<{ reservation_id: string | null }>(
        `UPDATE table_sessions SET status = 'closed', closed_at = COALESCE(closed_at, now()), closed_by = COALESCE(closed_by, $3) WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING reservation_id`,
        [link.session_id, locationId, actorUserId],
      );
      if (cs[0]) {
        closedSessionIds.push(link.session_id);
        completedReservationIds.push(...(await completeLinkedReservations(client, locationId, link.session_id, cs[0].reservation_id, actorUserId)));
      }
    }
    await recordTableSessionState(client, { locationId, sessionId: link.session_id, actor: { userId: actorUserId } });
  }
  return { closedSessionIds, completedReservationIds };
}

export async function releaseTableAfterOrderSettled(client: PoolClient, locationId: string, orderId: string, _closedBy: string | null): Promise<{ sessionId: string; tableIds: string[] } | null> {
  const { rows } = await client.query<{ table_session_id: string | null }>(`SELECT table_session_id FROM orders WHERE id = $1 AND location_id = $2`, [orderId, locationId]);
  return rows[0]?.table_session_id ? { sessionId: rows[0].table_session_id, tableIds: [] } : null;
}

export async function releaseSessionWithoutOrders(client: PoolClient, locationId: string, sessionId: string, closedBy: string | null, options?: { nextTableStatus?: TableStatus | null }): Promise<string[]> {
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM table_sessions WHERE id = $1 AND location_id = $2 FOR UPDATE`, [sessionId, locationId]);
  if (!rows[0]) throw new TableSessionError("session_not_found", 404);
  if (rows[0].status !== "open") throw new TableSessionError("session_already_closed", 409);
  return releaseSessionTables(client, sessionId, closedBy, { nextTableStatus: options?.nextTableStatus ?? null });
}

export interface SetSessionGuestsInput {
  businessId: string;
  locationId: string;
  sessionId: string;
  customerIds?: (string | null | undefined)[];
  partySize?: number | null;
}

export async function setSessionGuests(client: PoolClient, input: SetSessionGuestsInput): Promise<void> {
  const customerIds = Array.isArray(input.customerIds) ? input.customerIds : [];
  const filteredIds = customerIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);
  if (customerIds.length > 50 || new Set(filteredIds).size !== filteredIds.length) throw new TableSessionError("invalid_guests", 400);
  if (input.partySize != null && (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 500)) throw new TableSessionError("invalid_party_size", 400);
  const { rows: sRows } = await client.query<{ party_size: number | null; status: string }>(`SELECT party_size, status FROM table_sessions WHERE id = $1 AND location_id = $2 FOR UPDATE`, [input.sessionId, input.locationId]);
  if (sRows.length === 0) throw new TableSessionError("session_not_found", 404);
  if (sRows[0].status !== "open") throw new TableSessionError("session_already_closed", 409);
  const partySize = input.partySize != null ? Math.max(input.partySize, customerIds.length) : Math.max(1, customerIds.length, Number(sRows[0].party_size ?? 0));
  if (filteredIds.length > 0) {
    const { rows: owned } = await client.query<{ id: string }>(`SELECT id FROM parties WHERE business_id = $1 AND is_active AND id = ANY($2::uuid[])`, [input.businessId, filteredIds]);
    if (owned.length !== filteredIds.length) throw new TableSessionError("customer_not_found", 404);
  }
  await client.query(`DELETE FROM table_session_customers WHERE session_id = $1`, [input.sessionId]);
  for (const [index, rawId] of customerIds.entries()) {
    const customerId = typeof rawId === "string" ? rawId.trim() : "";
    if (customerId) await client.query(`INSERT INTO table_session_customers (business_id, location_id, session_id, guest_number, customer_id) VALUES ($1, $2, $3, $4, $5)`, [input.businessId, input.locationId, input.sessionId, index + 1, customerId]);
  }
  await client.query(`UPDATE table_sessions SET party_size = $2 WHERE id = $1`, [input.sessionId, partySize]);
  await recordTableSessionState(client, { locationId: input.locationId, sessionId: input.sessionId, actor: { userId: null } });
}

export interface SessionBillLine {
  id: string; orderItemId: string; orderId: string; order_id: string; order_number: number;
  name: string; name_snapshot: string; quantity: number; unit_price: number;
  modifiers_total: number; line_total: number; amount: Rial; status: string;
}

export interface SessionOrderSummary {
  id: string; order_number: number; status: string; customer_id: string | null; customer_name: string | null;
  subtotal: number; discount: number; service_charge: number; tax: number; total: number;
  paid_amount: number; outstanding_amount: number; opened_at: string;
}

export interface SessionBill {
  sessionId: string; partySize: number; subtotal: Rial; discount: Rial; serviceCharge: Rial;
  tax: Rial; total: Rial; paidTotal: Rial; outstandingTotal: Rial; equalShares: number[];
  orders: SessionOrderSummary[]; lines: SessionBillLine[];
}

export async function computeSessionBill(sessionIdOrLocationId: string, maybeSessionId?: string): Promise<SessionBill> {
  const sessionId = maybeSessionId ?? sessionIdOrLocationId;
  const loc = maybeSessionId ? sessionIdOrLocationId : null;
  const sessRes = await query<{ id: string; location_id: string; party_size: number | null }>(
    loc ? `SELECT id, location_id, party_size FROM table_sessions WHERE id = $1 AND location_id = $2` : `SELECT id, location_id, party_size FROM table_sessions WHERE id = $1`,
    loc ? [sessionId, loc] : [sessionId],
  );
  const sess = sessRes.rows[0];
  const partySize = Math.max(1, sess?.party_size ?? 1);
  if (!sess) return { sessionId, partySize: 1, subtotal: 0, discount: 0, serviceCharge: 0, tax: 0, total: 0, paidTotal: 0, outstandingTotal: 0, equalShares: [0], orders: [], lines: [] };
  const ordersRes = await query<{
    id: string; order_number: number; status: string; customer_id: string | null; customer_name: string | null;
    subtotal: string; discount: string; service_charge: string; tax: string; total: string; paid_amount: string; opened_at: Date;
  }>(
    `SELECT o.id, o.order_number, o.status::text AS status, o.customer_id, p.name AS customer_name, o.subtotal::text, o.discount::text, o.service_charge::text, o.tax::text, o.total::text, COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = o.id), 0)::text AS paid_amount, o.opened_at FROM orders o LEFT JOIN parties p ON p.id = o.customer_id WHERE o.location_id = $1 AND o.table_session_id = $2 AND o.status != 'voided' ORDER BY o.opened_at ASC, o.id ASC`,
    [sess.location_id, sessionId],
  );
  const linesRes = await query<{
    id: string; order_id: string; order_number: number; name_snapshot: string; quantity: number; unit_price: string; status: string; modifiers_total: string;
  }>(
    `SELECT oi.id, oi.order_id, o.order_number, oi.name_snapshot, oi.quantity, oi.unit_price::text, oi.status, COALESCE((SELECT SUM(oim.price_delta * oim.quantity) FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id), 0)::text AS modifiers_total FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.location_id = $1 AND o.table_session_id = $2 AND o.status != 'voided' AND oi.status != 'voided' ORDER BY o.opened_at, oi.created_at`,
    [sess.location_id, sessionId],
  );
  const lines: SessionBillLine[] = linesRes.rows.map((r) => {
    const unit = Number(r.unit_price), mods = Number(r.modifiers_total), lineTotal = (unit + mods) * r.quantity;
    return { id: r.id, orderItemId: r.id, orderId: r.order_id, order_id: r.order_id, order_number: Number(r.order_number), name: r.name_snapshot, name_snapshot: r.name_snapshot, quantity: r.quantity, unit_price: unit, modifiers_total: mods, line_total: lineTotal, amount: lineTotal, status: r.status };
  });
  let subtotal = 0, discount = 0, serviceCharge = 0, tax = 0, total = 0, paidTotal = 0, outstandingTotal = 0;
  const orders: SessionOrderSummary[] = ordersRes.rows.map((o) => {
    const oSub = Number(o.subtotal), oDisc = Number(o.discount), oSvc = Number(o.service_charge), oTax = Number(o.tax), oTot = Number(o.total), oPaid = Number(o.paid_amount);
    const oOut = o.status === "completed" ? 0 : Math.max(0, oTot - oPaid);
    subtotal += oSub; discount += oDisc; serviceCharge += oSvc; tax += oTax; total += oTot; paidTotal += oPaid; outstandingTotal += oOut;
    return { id: o.id, order_number: Number(o.order_number), status: o.status, customer_id: o.customer_id, customer_name: o.customer_name, subtotal: oSub, discount: oDisc, service_charge: oSvc, tax: oTax, total: oTot, paid_amount: oPaid, outstanding_amount: oOut, opened_at: iso(o.opened_at)! };
  });
  const splitTarget = Math.max(0, Math.round(outstandingTotal > 0 ? outstandingTotal : total));
  const base = Math.floor(splitTarget / partySize), rem = splitTarget - base * partySize;
  const equalShares = Array.from({ length: partySize }, (_, i) => base + (i < rem ? 1 : 0));
  return { sessionId, partySize, subtotal, discount, serviceCharge, tax, total, paidTotal, outstandingTotal, equalShares, orders, lines };
}
