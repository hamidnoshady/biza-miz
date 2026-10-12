/**
 * Server-side table-session operations (DB-touching; not unit-tested directly,
 * per the repo convention). Pure calculations live in ./table-sessions and
 * ./orders — this module only orchestrates DB writes around them.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { computeOrderTotals, type CartLine, type DiscountInput } from "./orders";
import type { Rial } from "./money";

export interface OpenSessionInput {
  locationId: string;
  tableIds: string[];
  partySize?: number | null;
  guestName?: string | null;
  guestPhone?: string | null;
  reservationId?: string | null;
  openedBy: string | null;
}

/** Find the open session currently holding a table, if any. */
export async function getOpenSessionIdForTable(
  client: PoolClient,
  locationId: string,
  tableId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ts.id
       FROM table_sessions ts
       JOIN table_session_tables tst ON tst.session_id = ts.id AND tst.released_at IS NULL
      WHERE ts.location_id = $1 AND ts.status = 'open' AND tst.table_id = $2
      LIMIT 1`,
    [locationId, tableId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Open a session on one or more free tables (seating a walk-in or reservation).
 * Locks the table rows, verifies each is seatable, creates the session +
 * memberships, and flips the tables to 'seated'. Throws {code} on conflict.
 */
export async function openSession(client: PoolClient, input: OpenSessionInput): Promise<{ id: string }> {
  const { locationId, tableIds, openedBy } = input;
  if (tableIds.length === 0) throw Object.assign(new Error("no_tables"), { code: "no_tables" });

  const { rows: tables } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM dining_tables
      WHERE location_id = $1 AND id = ANY($2::uuid[]) AND is_active
      FOR UPDATE`,
    [locationId, tableIds],
  );
  if (tables.length !== tableIds.length) {
    throw Object.assign(new Error("table_not_found"), { code: "table_not_found", status: 404 });
  }
  for (const t of tables) {
    if (t.status === "cleaning" || t.status === "out_of_service") {
      throw Object.assign(new Error("table_unavailable"), { code: "table_unavailable", status: 409 });
    }
    const existing = await getOpenSessionIdForTable(client, locationId, t.id);
    if (existing) throw Object.assign(new Error("table_occupied"), { code: "table_occupied", status: 409 });
  }

  const { rows: sessionRows } = await client.query<{ id: string }>(
    `INSERT INTO table_sessions
        (location_id, primary_table_id, party_size, guest_name, guest_phone, reservation_id, opened_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      locationId,
      tableIds[0],
      input.partySize ?? null,
      input.guestName ?? null,
      input.guestPhone ?? null,
      input.reservationId ?? null,
      openedBy,
    ],
  );
  const sessionId = sessionRows[0].id;

  for (const id of tableIds) {
    await client.query(
      "INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2)",
      [sessionId, id],
    );
  }
  await client.query(
    "UPDATE dining_tables SET status = 'seated' WHERE id = ANY($1::uuid[])",
    [tableIds],
  );
  return { id: sessionId };
}

/**
 * Ensure a dine-in order has a session: reuse the table's open session or open
 * a fresh one. Returns the session id. Runs inside the caller's transaction.
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
  });
  return id;
}

/** Add a free table to an open session (merge for a larger group). */
export async function mergeTableIntoSession(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  tableId: string,
): Promise<void> {
  const { rows: sess } = await client.query<{ id: string }>(
    "SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE",
    [sessionId, locationId],
  );
  if (sess.length === 0) throw Object.assign(new Error("session_not_found"), { code: "session_not_found", status: 404 });

  const { rows: tbl } = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE",
    [tableId, locationId],
  );
  if (tbl.length === 0) throw Object.assign(new Error("table_not_found"), { code: "table_not_found", status: 404 });
  if (tbl[0].status === "cleaning" || tbl[0].status === "out_of_service") {
    throw Object.assign(new Error("table_unavailable"), { code: "table_unavailable", status: 409 });
  }
  const occupied = await getOpenSessionIdForTable(client, locationId, tableId);
  if (occupied) throw Object.assign(new Error("table_occupied"), { code: "table_occupied", status: 409 });

  // A previously-released membership row may exist (same PK) — revive it.
  await client.query(
    `INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2)
     ON CONFLICT (session_id, table_id) DO UPDATE SET released_at = NULL, joined_at = now()`,
    [sessionId, tableId],
  );
  await client.query("UPDATE dining_tables SET status = 'seated' WHERE id = $1", [tableId]);
}

/**
 * Release a session that has nothing left to settle. Marks the session closed,
 * releases its table memberships, and returns every table it held to 'free'.
 *
 * Deliberately NOT 'cleaning': a table sat in 'cleaning' until somebody walked
 * over and tapped it clean, which meant a paid table stayed unsellable for as
 * long as the busiest moment of service lasted. Freeing on settlement is the
 * default; a floor that wants a cleaning beat still has the manual
 * seated/bill_requested → cleaning transition on the table itself.
 *
 * 'out_of_service' tables are left exactly as they are — a broken table does
 * not become sellable because somebody paid a bill on the table beside it.
 */
async function releaseSessionTables(
  client: PoolClient,
  sessionId: string,
  closedBy: string | null,
): Promise<void> {
  await client.query(
    "UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1 AND status = 'open'",
    [sessionId, closedBy],
  );
  const { rows: freed } = await client.query<{ table_id: string }>(
    "UPDATE table_session_tables SET released_at = now() WHERE session_id = $1 AND released_at IS NULL RETURNING table_id",
    [sessionId],
  );
  const tableIds = freed.map((r) => r.table_id);
  if (tableIds.length > 0) {
    await client.query(
      "UPDATE dining_tables SET status = 'free' WHERE id = ANY($1::uuid[]) AND status <> 'out_of_service'",
      [tableIds],
    );
  }
}

/**
 * Free a table once its last active order is finalized — the automatic
 * end-of-visit that replaced the cashier's manual «بستن میز».
 *
 * Call this inside the checkout transaction, AFTER the order's own status has
 * been written. It asks the only question that actually decides occupancy:
 * does this session still have an order somebody could add to or pay? An
 * 'open' or 'held' order means the party is still being served — a second
 * round on the same table is a separate order and settles separately, so one
 * paid bill must not evict a table that is still eating. Only when the last
 * one is finalized does the table go back to the floor.
 *
 * What it deliberately does not look at is money. Comparing cash taken against
 * the bill total re-derives occupancy from a number that legitimately differs
 * from the total (نسیه leaves a balance, an overpayment leaves credit, a
 * voided round is worth nothing) and would strand exactly the tables whose
 * checkout was unusual. Order status is the canonical finalization state, and
 * it is the same state the orders list, the floor plan and the KDS already
 * read.
 *
 * Idempotent (a session already closed is simply not re-closed), and
 * concurrency-safe: the session row is locked before the surviving orders are
 * counted, so two cashiers settling the last two orders at the same moment
 * serialize, and exactly the later one sees a zero count and frees the table.
 *
 * @returns the session that was released, or null if there was nothing to do.
 */
export async function releaseTableAfterOrderSettled(
  client: PoolClient,
  locationId: string,
  orderId: string,
  closedBy: string | null,
): Promise<{ sessionId: string } | null> {
  const { rows: orderRows } = await client.query<{ table_session_id: string | null }>(
    "SELECT table_session_id FROM orders WHERE id = $1 AND location_id = $2",
    [orderId, locationId],
  );
  const sessionId = orderRows[0]?.table_session_id ?? null;
  if (!sessionId) return null;

  // Lock first, count second: this is what makes the "last order wins" check
  // safe when two checkouts race on the same table.
  const { rows: sessionRows } = await client.query<{ id: string }>(
    "SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE",
    [sessionId, locationId],
  );
  if (sessionRows.length === 0) return null;

  const { rows: active } = await client.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE table_session_id = $1 AND status IN ('open', 'held')
      LIMIT 1`,
    [sessionId],
  );
  if (active.length > 0) return null;

  await releaseSessionTables(client, sessionId, closedBy);
  return { sessionId };
}

/**
 * Free a table that is seated but has nothing to settle — the walk-away case
 * (a party seated by mistake, or one that left without ordering). Refuses when
 * the session still holds an active order, because that table's exit is the
 * checkout's job, not a manual override.
 */
/**
 * Replace the guest list on an open session — extracted verbatim from
 * `PATCH /api/table-sessions/[id]` (batch AF #883) so the route and the
 * cockpit executor call the same rules: ≤50 unique ids, all owned parties,
 * guest numbers rebuild from 1, and party size never shrinks below the
 * guest count.
 */
export async function setSessionGuests(
  client: PoolClient,
  input: { businessId: string; locationId: string; sessionId: string; customerIds: (string | null | undefined)[] },
): Promise<void> {
  const customerIds = input.customerIds;
  if (customerIds.length > 50 || new Set(customerIds.filter(Boolean)).size !== customerIds.filter(Boolean).length) {
    throw Object.assign(new Error("invalid_guests"), { code: "invalid_guests", status: 400 });
  }
  const { rows: sessionRows } = await client.query<{ party_size: number | null }>(
    `SELECT party_size FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE`,
    [input.sessionId, input.locationId],
  );
  if (sessionRows.length === 0) {
    throw Object.assign(new Error("session_not_found"), { code: "session_not_found", status: 404 });
  }
  const partySize = Math.max(1, customerIds.length, Number(sessionRows[0].party_size ?? 0));
  const selectedCustomerIds = customerIds.filter((value): value is string => Boolean(value));
  if (selectedCustomerIds.length > 0) {
    const { rows: ownedCustomers } = await client.query<{ id: string }>(
      `SELECT id FROM parties WHERE business_id = $1 AND is_active AND id = ANY($2::uuid[])`,
      [input.businessId, selectedCustomerIds],
    );
    if (ownedCustomers.length !== selectedCustomerIds.length) {
      throw Object.assign(new Error("customer_not_found"), { code: "customer_not_found", status: 404 });
    }
  }
  await client.query(`DELETE FROM table_session_customers WHERE session_id = $1`, [input.sessionId]);
  for (const [index, customerId] of customerIds.entries()) {
    if (!customerId) continue;
    await client.query(
      `INSERT INTO table_session_customers (business_id, location_id, session_id, guest_number, customer_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.businessId, input.locationId, input.sessionId, index + 1, customerId],
    );
  }
  await client.query(`UPDATE table_sessions SET party_size = $2 WHERE id = $1`, [input.sessionId, partySize]);
}

export async function releaseSessionWithoutOrders(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  closedBy: string | null,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE",
    [sessionId, locationId],
  );
  if (rows.length === 0) {
    throw Object.assign(new Error("session_not_found"), { code: "session_not_found", status: 404 });
  }
  const { rows: active } = await client.query<{ id: string }>(
    `SELECT id FROM orders WHERE table_session_id = $1 AND status IN ('open', 'held') LIMIT 1`,
    [sessionId],
  );
  if (active.length > 0) {
    throw Object.assign(new Error("session_has_active_orders"), {
      code: "session_has_active_orders",
      status: 409,
    });
  }
  await releaseSessionTables(client, sessionId, closedBy);
}

export interface SessionBill {
  total: Rial;
  lines: { orderItemId: string; orderId: string; name: string; amount: Rial }[];
}

/**
 * Build the billable lines for a session across all its non-voided orders.
 * Each line's amount is that order line's post-discount, tax-inclusive total
 * (computed with the same {@link computeOrderTotals} used everywhere else), so
 * summed line amounts equal the session bill exactly.
 */
export async function computeSessionBill(sessionId: string): Promise<SessionBill> {
  const { rows: orders } = await query<{ id: string; discount_type: string | null; discount_value: string | null }>(
    "SELECT id, discount_type, discount_value FROM orders WHERE table_session_id = $1 AND status != 'voided' ORDER BY opened_at",
    [sessionId],
  );

  const lines: SessionBill["lines"] = [];
  let total = 0;
  if (orders.length === 0) return { total, lines };

  // One query for every order's items instead of one round trip per order —
  // a session with several rounds otherwise multiplies DB round trips by
  // its order count on every bill view and every table payment.
  type ItemRow = {
    order_id: string;
    id: string;
    name_snapshot: string;
    unit_price: string;
    quantity: number;
    tax_rate: string;
    mod_deltas: string[] | null;
  };
  const { rows: allItems } = await query<ItemRow>(
    `SELECT oi.order_id, oi.id, oi.name_snapshot, oi.unit_price, oi.quantity,
            COALESCE(mc.tax_rate, 0) AS tax_rate,
            ARRAY(SELECT price_delta * quantity FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id) AS mod_deltas
       FROM order_items oi
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = ANY($1::uuid[]) AND oi.status != 'voided'
      ORDER BY oi.order_id, oi.created_at`,
    [orders.map((o) => o.id)],
  );
  const itemsByOrder = new Map<string, ItemRow[]>();
  for (const it of allItems) {
    const bucket = itemsByOrder.get(it.order_id);
    if (bucket) bucket.push(it);
    else itemsByOrder.set(it.order_id, [it]);
  }

  for (const order of orders) {
    const items = itemsByOrder.get(order.id) ?? [];
    if (items.length === 0) continue;

    const cartLines: CartLine[] = items.map((it) => ({
      unitPrice: Number(it.unit_price),
      quantity: it.quantity,
      modifierDeltas: (it.mod_deltas ?? []).map(Number),
      taxRatePercent: Number(it.tax_rate),
    }));
    const discount: DiscountInput =
      order.discount_type === "percent" || order.discount_type === "amount"
        ? { type: order.discount_type, value: Number(order.discount_value ?? 0) }
        : { type: null };
    const totals = computeOrderTotals(cartLines, discount);
    totals.lines.forEach((lt, i) => {
      lines.push({ orderItemId: items[i].id, orderId: order.id, name: items[i].name_snapshot, amount: lt.lineTotal });
      total += lt.lineTotal;
    });
  }
  return { total, lines };
}
