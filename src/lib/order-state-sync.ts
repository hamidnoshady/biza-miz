/**
 * Open-order convergence between a desktop and the central server
 * (`order.state.synced@1`, migration 0190).
 *
 * Before this, only an order's *creation* and its *payment* crossed. Items
 * added at the till afterwards, a line voided or re-quantified, a discount,
 * a customer attached, a table moved, a kitchen status — none of it did. The
 * other side then settled the payment against a bill it held a different
 * version of, and the payment was refused. That is the single largest reason
 * "some data syncs but not all".
 *
 * The fix is state transfer for the one aggregate that is still mutable: every
 * change to an open order emits the whole order (header, lines, add-ons),
 * stamped with a hybrid logical clock, inside the same transaction as the
 * change. The receiver makes its copy match and ignores any state older than
 * the one it holds, so a late retry can never roll a bill back. An open order
 * has posted nothing to the books yet — revenue, VAT, stock and COGS all post
 * at payment — so replacing its contents is safe; a settled order is never
 * touched by a state event.
 *
 * The payment route emits one final state in its own transaction, just before
 * the payment event, so even if every intermediate state were lost the other
 * side still settles the exact bill that was paid.
 */
import type { PoolClient } from "pg";
import { getPool } from "./db";
import type { Role } from "./auth";
import { deploymentRole } from "./deployment-role";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { ensureSessionForTable } from "./table-session-service";
import { isHlc } from "./sync-hlc";

export interface OrderStateActor {
  userId: string;
  role: Role;
}

interface OrderStateModifier {
  id: string;
  modifierId: string | null;
  nameSnapshot: string;
  priceDelta: string;
  quantity: number;
}

interface OrderStateItem {
  id: string;
  menuItemId: string | null;
  nameSnapshot: string;
  unitPrice: string;
  quantity: number;
  status: string;
  note: string | null;
  sentToKitchenAt: string | null;
  readyAt: string | null;
  createdAt: string;
  voidReason: string | null;
  modifiers: OrderStateModifier[];
}

export interface OrderStatePayload {
  orderId: string;
  stateHlc: string;
  order: {
    type: string;
    status: string;
    orderNumber: string;
    tableId: string | null;
    customerId: string | null;
    guestCount: number | null;
    note: string | null;
    discountType: "percent" | "amount" | null;
    discountValue: string | null;
    /**
     * The sender's own figures, carried verbatim rather than recomputed here:
     * promotions and category tax rates can differ between the two sides, and
     * the bill a guest paid is the one the sender computed.
     */
    subtotal: string;
    discount: string;
    serviceCharge: string;
    tax: string;
    total: string;
    openedAt: string;
    openedBy: string | null;
    voidedReason: string | null;
    closedBy: string | null;
    closedAt: string | null;
  };
  items: OrderStateItem[];
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

/**
 * Stamp the order and queue its full current state, inside the caller's
 * transaction. A no-op where nothing would be delivered: a replay (the peer
 * already has this state), a retail invoice (settled in one step, outside
 * hybrid sync), or a central-server branch with no paired desktop.
 */
export async function recordOrderState(
  client: PoolClient,
  params: { locationId: string; orderId: string; actor: OrderStateActor },
): Promise<void> {
  const { rows: gate } = await client.query<{ record: boolean }>(
    `SELECT coalesce(current_setting('app.sync_replay', true), '') <> 'on'
            AND ($2::boolean OR EXISTS (
                  SELECT 1 FROM site_devices d
                   WHERE d.location_id = $1 AND d.status = 'active' AND d.revoked_at IS NULL)) AS record`,
    [params.locationId, deploymentRole() === "site"],
  );
  if (!gate[0]?.record) return;

  const payload = await readOrderState(client, params.locationId, params.orderId);
  if (!payload || payload.order.type === "retail") return;
  await client.query("UPDATE orders SET sync_state_hlc = $2 WHERE id = $1", [params.orderId, payload.stateHlc]);
  await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: `order-state:${params.orderId}:${payload.stateHlc}`,
    eventType: "order.state.synced",
    payload: payload as unknown as Record<string, unknown>,
    actorUserId: params.actor.userId,
    actorRole: params.actor.role,
  });
}

/** For a change made outside a transaction (the kitchen bump): its own short one. */
export async function recordOrderStateStandalone(params: {
  locationId: string;
  orderId: string;
  actor: OrderStateActor;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [params.orderId]);
    await recordOrderState(client, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Best effort: the payment emits the final state atomically regardless.
    console.error("order state sync failed:", error);
  } finally {
    client.release();
  }
}

async function readOrderState(
  client: PoolClient,
  locationId: string,
  orderId: string,
): Promise<OrderStatePayload | null> {
  const { rows: orderRows } = await client.query<{
    type: string;
    status: string;
    order_number: string;
    table_id: string | null;
    customer_id: string | null;
    guest_count: number | null;
    note: string | null;
    discount_type: "percent" | "amount" | null;
    discount_value: string | null;
    subtotal: string;
    discount: string;
    service_charge: string;
    tax: string;
    total: string;
    opened_at: Date;
    opened_by: string | null;
    voided_reason: string | null;
    closed_by: string | null;
    closed_at: Date | null;
    stamp: string;
  }>(
    `SELECT type::text, status::text, order_number::text, table_id, customer_id, guest_count, note,
            discount_type, discount_value::text, subtotal::text, discount::text, service_charge::text,
            tax::text, total::text, opened_at, opened_by, voided_reason, closed_by, closed_at,
            app_sync_next_hlc() AS stamp
       FROM orders WHERE id = $1 AND location_id = $2`,
    [orderId, locationId],
  );
  const order = orderRows[0];
  if (!order) return null;
  const { rows: itemRows } = await client.query<{
    id: string;
    menu_item_id: string | null;
    name_snapshot: string;
    unit_price: string;
    quantity: number;
    status: string;
    note: string | null;
    sent_to_kitchen_at: Date | null;
    ready_at: Date | null;
    created_at: Date;
    void_reason: string | null;
  }>(
    `SELECT id, menu_item_id, name_snapshot, unit_price::text, quantity, status::text, note,
            sent_to_kitchen_at, ready_at, created_at, void_reason
       FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const { rows: modifierRows } = await client.query<{
    id: string;
    order_item_id: string;
    modifier_id: string | null;
    name_snapshot: string;
    price_delta: string;
    quantity: number;
  }>(
    `SELECT m.id, m.order_item_id, m.modifier_id, m.name_snapshot, m.price_delta::text, m.quantity
       FROM order_item_modifiers m JOIN order_items i ON i.id = m.order_item_id
      WHERE i.order_id = $1 ORDER BY m.id`,
    [orderId],
  );
  return {
    orderId,
    stateHlc: order.stamp,
    order: {
      type: order.type,
      status: order.status,
      orderNumber: order.order_number,
      tableId: order.table_id,
      customerId: order.customer_id,
      guestCount: order.guest_count,
      note: order.note,
      discountType: order.discount_type,
      discountValue: order.discount_value,
      subtotal: order.subtotal,
      discount: order.discount,
      serviceCharge: order.service_charge,
      tax: order.tax,
      total: order.total,
      openedAt: iso(order.opened_at)!,
      openedBy: order.opened_by,
      voidedReason: order.voided_reason,
      closedBy: order.closed_by,
      closedAt: iso(order.closed_at),
    },
    items: itemRows.map((item) => ({
      id: item.id,
      menuItemId: item.menu_item_id,
      nameSnapshot: item.name_snapshot,
      unitPrice: item.unit_price,
      quantity: item.quantity,
      status: item.status,
      note: item.note,
      sentToKitchenAt: iso(item.sent_to_kitchen_at),
      readyAt: iso(item.ready_at),
      createdAt: iso(item.created_at)!,
      voidReason: item.void_reason,
      modifiers: modifierRows
        .filter((modifier) => modifier.order_item_id === item.id)
        .map((modifier) => ({
          id: modifier.id,
          modifierId: modifier.modifier_id,
          nameSnapshot: modifier.name_snapshot,
          priceDelta: modifier.price_delta,
          quantity: modifier.quantity,
        })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Receiving side
// ---------------------------------------------------------------------------

/** Shown to staff on a line voided by reconciliation, so Persian like every other void reason. */
export const STRAY_LINE_REASON = "همگام‌سازی — این ردیف در صورت‌حساب دستگاه دیگر نبود";

/** Thrown for an order state that can never apply; the sync engine dead-letters it. */
export class OrderStateTerminal extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_TYPES = new Set(["dine_in", "takeaway", "delivery"]);
/** An order still being rung up; `held` is a parked one. */
const MUTABLE_STATUSES = new Set(["open", "held"]);
const MONEY = /^-?[0-9]{1,18}$/;
const ITEM_STATUSES = new Set(["pending", "sent", "preparing", "ready", "served", "voided"]);

function parseState(payload: Record<string, unknown>): OrderStatePayload {
  const state = payload as unknown as OrderStatePayload;
  if (
    typeof state.orderId !== "string" ||
    !UUID.test(state.orderId) ||
    !isHlc(state.stateHlc) ||
    !state.order ||
    typeof state.order !== "object" ||
    !ORDER_TYPES.has(state.order.type) ||
    (!MUTABLE_STATUSES.has(state.order.status) && state.order.status !== "voided") ||
    !/^[0-9]{1,18}$/.test(String(state.order.orderNumber)) ||
    typeof state.order.openedAt !== "string" ||
    !Number.isFinite(Date.parse(state.order.openedAt)) ||
    ![state.order.subtotal, state.order.discount, state.order.serviceCharge, state.order.tax, state.order.total].every(
      (value) => MONEY.test(String(value)),
    ) ||
    !Array.isArray(state.items) ||
    state.items.length > 500
  ) {
    throw new OrderStateTerminal("invalid_order_state");
  }
  for (const item of state.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !UUID.test(item.id) ||
      !ITEM_STATUSES.has(item.status) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      !/^-?[0-9]{1,18}$/.test(String(item.unitPrice)) ||
      !Array.isArray(item.modifiers)
    ) {
      throw new OrderStateTerminal("invalid_order_state");
    }
  }
  return state;
}

async function existingIds(client: PoolClient, table: string, ids: string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && UUID.test(id)))];
  if (wanted.length === 0) return new Set();
  const { rows } = await client.query<{ id: string }>(`SELECT id::text FROM ${table} WHERE id = ANY($1::uuid[])`, [wanted]);
  return new Set(rows.map((row) => row.id));
}

/**
 * Make this side's copy of an open order match the sender's state. Runs inside
 * applySyncEvent's transaction (so the replay flag is already set and nothing
 * is re-emitted). Throws `customer_not_found` / `menu_item_not_found` while a
 * master record has not arrived yet — dependency errors, so the event is held
 * and retried rather than applied with a hole in it.
 */
export async function applyOrderState(
  client: PoolClient,
  params: { locationId: string; actor: OrderStateActor; payload: Record<string, unknown> },
): Promise<{ orderId: string; outcome: "applied" | "stale" | "settled" }> {
  const state = parseState(params.payload);
  const { orderId, order } = state;

  const { rows: existing } = await client.query<{
    status: string;
    sync_state_hlc: string | null;
    location_id: string;
  }>(
    "SELECT status::text, sync_state_hlc, location_id FROM orders WHERE id = $1 FOR UPDATE",
    [orderId],
  );
  const local = existing[0];
  if (local && local.location_id !== params.locationId) throw new OrderStateTerminal("order_location_mismatch");
  // Already at this state or a newer one.
  if (local?.sync_state_hlc && local.sync_state_hlc >= state.stateHlc) return { orderId, outcome: "stale" };
  if (local && !MUTABLE_STATUSES.has(local.status)) {
    // Settled here already. The payment (or void) is the later, authoritative
    // fact; an open-order state from before it is simply history.
    if (MUTABLE_STATUSES.has(order.status) || local.status === order.status) return { orderId, outcome: "settled" };
    throw new OrderStateTerminal("order_already_settled");
  }
  // Items can only be written while the order is 'open' (migration 0014's
  // guard); a parked order is reopened for the write and parked again below.
  if (local?.status === "held") {
    await client.query("UPDATE orders SET status = 'open' WHERE id = $1", [orderId]);
  }

  // Master records the bill points at must already be here.
  if (order.customerId) {
    if ((await existingIds(client, "parties", [order.customerId])).size === 0) throw new Error("customer_not_found");
  }
  const menuIds = state.items.map((item) => item.menuItemId).filter((id): id is string => !!id);
  const knownMenu = await existingIds(client, "menu_items", menuIds);
  if (menuIds.some((id) => !knownMenu.has(id))) throw new Error("menu_item_not_found");

  const users = await existingIds(client, "users", [order.openedBy, order.closedBy].filter((id): id is string => !!id));
  const tables = order.tableId ? await existingIds(client, "dining_tables", [order.tableId]) : new Set<string>();
  const tableId = order.tableId && tables.has(order.tableId) ? order.tableId : null;
  const openedBy = order.openedBy && users.has(order.openedBy) ? order.openedBy : null;

  if (!local) {
    // Keep the sender's number when it is free here, so a receipt reads the
    // same on both sides; otherwise take this side's next one.
    const { rows: taken } = await client.query(
      "SELECT 1 FROM orders WHERE location_id = $1 AND order_number = $2::bigint",
      [params.locationId, order.orderNumber],
    );
    let orderNumber = order.orderNumber;
    if (taken.length > 0) {
      const { rows: counter } = await client.query<{ next_number: string }>(
        `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
         ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
         RETURNING (next_number - 1)::text AS next_number`,
        [params.locationId],
      );
      orderNumber = counter[0].next_number;
    } else {
      await client.query(
        `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, $2::bigint + 1)
         ON CONFLICT (location_id) DO UPDATE
           SET next_number = greatest(order_number_counters.next_number, EXCLUDED.next_number)`,
        [params.locationId, orderNumber],
      );
    }
    await client.query(
      `INSERT INTO orders (id, location_id, order_number, type, status, table_id, customer_id, guest_count,
                           note, discount_type, discount_value, opened_at, opened_by)
       VALUES ($1, $2, $3::bigint, $4::order_type, 'open', $5, $6, $7, $8, $9, $10::numeric, $11::timestamptz, $12)`,
      [
        orderId,
        params.locationId,
        orderNumber,
        order.type,
        tableId,
        order.customerId,
        order.guestCount,
        order.note,
        order.discountType,
        order.discountValue,
        order.openedAt,
        openedBy,
      ],
    );
  } else {
    // opened_at too: an order.create replayed before this fix, or by an older
    // peer, carries the replay's clock, and the bill belongs to the shift and
    // day it was really opened in.
    await client.query(
      `UPDATE orders SET table_id = $2, customer_id = $3, guest_count = $4, note = $5, opened_at = $6::timestamptz
        WHERE id = $1`,
      [orderId, tableId, order.customerId, order.guestCount, order.note, order.openedAt],
    );
  }
  if (tableId && MUTABLE_STATUSES.has(order.status)) {
    const sessionId = await ensureSessionForTable(client, params.locationId, tableId, openedBy, order.guestCount);
    await client.query("UPDATE orders SET table_session_id = $2 WHERE id = $1", [orderId, sessionId]);
  } else if (!tableId) {
    await client.query("UPDATE orders SET table_session_id = NULL WHERE id = $1", [orderId]);
  }

  // Lines: never deleted (a line is voided, not removed), so the incoming set
  // is upserted by id.
  const known = await existingIds(client, "order_items", state.items.map((item) => item.id));
  for (const item of state.items) {
    if (known.has(item.id)) {
      await client.query(
        `UPDATE order_items
            SET quantity = $2, status = $3::order_item_status, note = $4, void_reason = $5,
                sent_to_kitchen_at = $6::timestamptz, ready_at = $7::timestamptz
          WHERE id = $1 AND order_id = $8`,
        [item.id, item.quantity, item.status, item.note, item.voidReason, item.sentToKitchenAt, item.readyAt, orderId],
      );
      continue;
    }
    await client.query(
      `INSERT INTO order_items (id, location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity,
                                status, note, sent_to_kitchen_at, ready_at, created_at, void_reason)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8::order_item_status, $9, $10::timestamptz, $11::timestamptz,
               $12::timestamptz, $13)`,
      [
        item.id,
        params.locationId,
        orderId,
        item.menuItemId,
        item.nameSnapshot,
        item.unitPrice,
        item.quantity,
        item.status,
        item.note,
        item.sentToKitchenAt,
        item.readyAt,
        item.createdAt,
        item.voidReason,
      ],
    );
    const knownModifiers = await existingIds(
      client,
      "modifiers",
      item.modifiers.map((modifier) => modifier.modifierId).filter((id): id is string => !!id),
    );
    for (const modifier of item.modifiers) {
      await client.query(
        `INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, name_snapshot, price_delta, quantity)
         VALUES ($1, $2, $3, $4, $5::bigint, $6)
         ON CONFLICT DO NOTHING`,
        [
          modifier.id,
          item.id,
          modifier.modifierId && knownModifiers.has(modifier.modifierId) ? modifier.modifierId : null,
          modifier.nameSnapshot,
          modifier.priceDelta,
          Math.max(1, Math.round(modifier.quantity || 1)),
        ],
      );
    }
    // What the line will consume, captured here from this side's recipe the
    // same way an intake line is, so payment-time COGS has its snapshot.
    // (Loaded lazily: order-mutations emits order state, so a static import
    // would be a cycle.)
    if (item.menuItemId && item.status !== "voided") {
      const { captureInventorySnapshot } = await import("./order-mutations");
      await captureInventorySnapshot(
        client,
        item.id,
        item.menuItemId,
        item.modifiers
          .filter((modifier) => modifier.modifierId && knownModifiers.has(modifier.modifierId))
          .map((modifier) => ({ id: modifier.modifierId!, quantity: modifier.quantity })),
      );
    }
  }

  // A line this side holds but the sender does not was never on the sender's
  // bill: typically the copy an offline-queued phone's order.create made here
  // under different line ids. The sender's state is the bill; the stray line
  // is voided (never deleted — it keeps its audit trail and its immutable
  // inventory snapshot), so it neither prices nor consumes stock at payment.
  await client.query(
    `UPDATE order_items SET status = 'voided', void_reason = $3
      WHERE order_id = $1 AND status <> 'voided' AND NOT (id = ANY($2::uuid[]))`,
    [orderId, state.items.map((item) => item.id), STRAY_LINE_REASON],
  );

  await client.query(
    `UPDATE orders SET subtotal = $2::bigint, discount = $3::bigint, service_charge = $4::bigint, tax = $5::bigint,
            total = $6::bigint, discount_type = $7, discount_value = $8::numeric
      WHERE id = $1`,
    [
      orderId,
      order.subtotal,
      order.discount,
      order.serviceCharge,
      order.tax,
      order.total,
      order.discountType,
      order.discountType ? order.discountValue : null,
    ],
  );

  if (order.status === "held") {
    await client.query("UPDATE orders SET status = 'held' WHERE id = $1 AND status = 'open'", [orderId]);
  }
  if (order.status === "voided") {
    await client.query(
      `UPDATE orders SET status = 'voided', voided_reason = $2, closed_by = $3, closed_at = coalesce($4::timestamptz, now())
        WHERE id = $1 AND status = 'open'`,
      [orderId, order.voidedReason, order.closedBy && users.has(order.closedBy) ? order.closedBy : null, order.closedAt],
    );
  }
  await client.query("UPDATE orders SET sync_state_hlc = $2 WHERE id = $1", [orderId, state.stateHlc]);
  await client.query("SELECT app_sync_observe_hlc($1)", [state.stateHlc]);
  return { orderId, outcome: "applied" };
}
