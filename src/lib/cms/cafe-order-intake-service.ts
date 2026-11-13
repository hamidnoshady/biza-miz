/**
 * ESH-146 (biza-miz#1304) — a submitted Eshobe CMS café order becomes one real
 * POS order, before anybody has paid for it and before the kitchen sees it.
 *
 * The Phase G path next to this file imports a *paid* single-product storefront
 * order as a completed sale. A café order is a different animal:
 *
 *   - it arrives on `order.submitted` (and again, later, on `order.paid`),
 *   - it has several lines and modifier selections,
 *   - a dine-in order names its table only through the opaque token printed on
 *     it (`table-qr-service.ts`), never through an id,
 *   - and it is a *proposal*: the kitchen must not start cooking until a staff
 *     member accepts it.
 *
 * So this module writes through the shared `createOrder()` (pricing, stock
 * snapshots, visit session, sync outbox all come from there) with kitchen
 * dispatch held, and records the CMS identity + `pending` approval on the row.
 * `cafe-order-approval-service.ts` owns the accept/reject decision.
 *
 * Idempotency is layered on purpose: the CMS identity is stamped on the order
 * (`uq_orders_cms_order`), and the create itself carries
 * `clientRequestId = cms-cafe:<connection>:<order>`, which is the same
 * exactly-once contract the till uses for a lost HTTP response. A replayed
 * webhook, a poll re-reading the same event and a paid-before-submitted race
 * therefore all converge on one order.
 *
 * Every function here must run inside the tenant scope of the signed CMS
 * connection (`withTenant(connection.business_id, …)`) — the site id chose the
 * business long before this module is reached.
 */
import { getPool, query } from "../db";
import { createOrder } from "../order-mutations";
import type { CartItemInput } from "../order-cart";
import { MAX_ORDER_LINE_QUANTITY } from "../order-quantity";
import { completeOrderPayment } from "../payment-service";
import { parseRemoteInstant } from "../online-sale-policy";
import { reconcileExternalIdentity } from "../crm-external-identity";
import { getPrimaryLocation } from "../setup-state";
import type { WebsiteConnectionRow } from "../website/connection-service";
import {
  createDineInOrderFromTableQr,
  resolveTableQrTokenForOrder,
  type ResolvedTableQrIntake,
} from "../table-qr-service";
import type { CmsOrder } from "./types";

/** A refusal the inbox records verbatim — the operator sees the code. */
export class CafeOrderIntakeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
  ) {
    super(code);
    this.name = "CafeOrderIntakeError";
  }
}

export interface CafeOrderIntakeResult {
  /** The one POS order this CMS order resolves to. */
  orderId: string;
  /** True when this call created it; false when it already existed. */
  created: boolean;
  /** Null for takeaway, and for a replay of an order that already exists. */
  resolved: ResolvedTableQrIntake | null;
}

/**
 * Is this a café/table-service order rather than the legacy one-product
 * storefront shape? A multi-line basket, a service mode or a table token each
 * mark it; anything else keeps going through the Phase G paid import untouched.
 */
export function isCafeCmsOrder(order: CmsOrder): boolean {
  return (
    (Array.isArray(order.items) && order.items.length > 0) ||
    order.serviceMode === "dine_in" ||
    order.serviceMode === "takeaway" ||
    typeof order.tableToken === "string"
  );
}

/** The CMS order's own checkout instant, so the sale lands on its business day. */
function openedAtFor(order: CmsOrder): string | null {
  // Already an ISO instant (or null) — `parseRemoteInstant` is the one policy
  // for reading a remote timestamp, including "no offset means unknown".
  return parseRemoteInstant(order.createdAt, { assumeUtc: false });
}

function buyerNote(order: CmsOrder): string {
  const name = order.buyer?.name?.trim() || "مشتری سایت";
  const phone = order.buyer?.phone?.trim();
  const parts = [`سفارش سایت ${order.reference || order.id} — ${name}`];
  if (phone) parts.push(phone);
  if (order.buyer?.note?.trim()) parts.push(order.buyer.note.trim());
  return parts.join(" · ");
}

interface MappedLine {
  menuItemId: string;
  quantity: number;
  modifierIds: string[];
  note: string | null;
  remoteProductId: string;
}

/**
 * Maps every CMS line onto a local menu item (and every CMS modifier id onto a
 * local modifier) *before* any write. A basket with one unmappable line fails
 * whole: importing the mapped half would bill a customer for a meal they did
 * not order, which is worse than a visible inbox failure.
 */
async function mapCafeLines(
  businessId: string,
  connectionId: string,
  order: CmsOrder,
): Promise<MappedLine[]> {
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) throw new CafeOrderIntakeError("items_required", 400);
  if (items.length > 100) throw new CafeOrderIntakeError("too_many_items", 400);

  const remoteIds = [...new Set(items.map((line) => String(line.productId ?? "").trim()))];
  if (remoteIds.some((id) => !id)) throw new CafeOrderIntakeError("product_id_required", 400);

  const { rows: mappedRows } = await query<{ remote_id: string; local_id: string }>(
    `SELECT remote_id, local_id
       FROM website_product_map
      WHERE business_id = $1 AND connection_id = $2 AND local_kind = 'menu_item'
        AND sync_enabled = true AND remote_id = ANY($3::text[])`,
    [businessId, connectionId, remoteIds],
  );
  const localByRemote = new Map(mappedRows.map((row) => [row.remote_id, row.local_id]));

  const remoteModifierIds = [
    ...new Set(
      items.flatMap((line) =>
        (Array.isArray(line.modifierIds) ? line.modifierIds : [])
          .map((id) => String(id).trim())
          .filter(Boolean),
      ),
    ),
  ];
  const localModifierByRemote = new Map<string, string>();
  if (remoteModifierIds.length > 0) {
    const { rows: modifierRows } = await query<{ source_key: string; remote_id: string }>(
      `SELECT source_key, remote_id
         FROM website_menu_object_map
        WHERE business_id = $1 AND connection_id = $2 AND kind = 'modifier'
          AND remote_id = ANY($3::text[])`,
      [businessId, connectionId, remoteModifierIds],
    );
    for (const row of modifierRows) localModifierByRemote.set(row.remote_id, row.source_key);
  }

  return items.map((line) => {
    const remoteId = String(line.productId).trim();
    const menuItemId = localByRemote.get(remoteId);
    if (!menuItemId) throw new CafeOrderIntakeError(`product_not_mapped:${remoteId}`);

    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_LINE_QUANTITY) {
      throw new CafeOrderIntakeError("invalid_quantity", 400);
    }

    const modifierIds: string[] = [];
    for (const raw of Array.isArray(line.modifierIds) ? line.modifierIds : []) {
      const remoteModifierId = String(raw).trim();
      if (!remoteModifierId) continue;
      const local = localModifierByRemote.get(remoteModifierId);
      if (!local) throw new CafeOrderIntakeError(`modifier_not_mapped:${remoteModifierId}`);
      modifierIds.push(local);
    }

    return {
      menuItemId,
      quantity,
      modifierIds,
      note: line.note?.trim() || null,
      remoteProductId: remoteId,
    };
  });
}

/**
 * Stamp the CMS identity and the pending decision on the row.
 *
 * Runs after `createOrder()` has committed (it owns its transaction), which is
 * why the create carries a `clientRequestId`: if this stamp were lost, the next
 * delivery of the same event finds the order again and simply stamps it.
 */
async function stampOrderOrigin(
  connection: WebsiteConnectionRow,
  order: CmsOrder,
  orderId: string,
): Promise<void> {
  await query(
    `UPDATE orders
        SET origin = 'website',
            cms_connection_id = $2,
            cms_order_id = $3,
            website_approval_state = COALESCE(website_approval_state, 'pending')
      WHERE id = $1`,
    [orderId, connection.id, order.id],
  );
}

/**
 * Create (or return) the POS order a submitted CMS café order describes.
 */
export async function intakeSubmittedCafeOrder(
  connection: WebsiteConnectionRow,
  order: CmsOrder,
): Promise<CafeOrderIntakeResult> {
  const businessId = connection.business_id;
  if (!isCafeCmsOrder(order)) throw new CafeOrderIntakeError("not_cafe_order", 400);

  // A replay of the same CMS order must not re-price or re-open anything.
  const prior = await query<{ id: string; table_id: string | null }>(
    `SELECT id, table_id FROM orders
      WHERE cms_connection_id = $1 AND cms_order_id = $2
      LIMIT 1`,
    [connection.id, order.id],
  );
  if (prior.rows[0]) {
    return { orderId: prior.rows[0].id, created: false, resolved: null };
  }

  const serviceMode = order.serviceMode ?? (order.tableToken ? "dine_in" : "takeaway");
  if (serviceMode !== "dine_in" && serviceMode !== "takeaway") {
    throw new CafeOrderIntakeError("invalid_service_mode", 400);
  }

  let resolved: ResolvedTableQrIntake | null = null;
  if (serviceMode === "dine_in") {
    if (!order.tableToken) throw new CafeOrderIntakeError("table_token_required", 422);
    const resolution = await resolveTableQrTokenForOrder({
      token: order.tableToken,
      businessId,
      siteId: connection.site_id,
    });
    if (!resolution.ok) throw new CafeOrderIntakeError(resolution.reason, resolution.status);
    // A token is printed for one branch; a connection that syncs to another
    // branch must not accept it, even inside the same business.
    if (connection.sync_location_id && resolution.resolved.locationId !== connection.sync_location_id) {
      throw new CafeOrderIntakeError("location_mismatch", 422);
    }
    resolved = resolution.resolved;
  } else if (order.tableToken) {
    // Takeaway names no table; a token here is a client that mixed the two
    // flows up. Refusing beats silently seating a takeaway order.
    throw new CafeOrderIntakeError("table_token_not_allowed", 400);
  }

  const lines = await mapCafeLines(businessId, connection.id, order);
  const items: CartItemInput[] = lines.map((line) => ({
    menuItemId: line.menuItemId,
    quantity: line.quantity,
    modifierIds: line.modifierIds,
    note: line.note ?? undefined,
  }));

  const customer = await reconcileExternalIdentity(
    {
      businessId,
      connectionId: connection.id,
      provider: "eshobe_cms",
      remoteId: order.buyer?.phone?.trim() || order.id,
      name: order.buyer?.name?.trim() || "مشتری سایت",
      email: order.buyer?.email ?? null,
      phone: order.buyer?.phone ?? null,
      payload: { orderId: order.id, reference: order.reference },
    },
    // A checkout does not create a CRM customer on its own; the name and phone
    // ride on the order note so the till can see them.
    { allowCreate: false },
  );

  const clientRequestId = `cms-cafe:${connection.id}:${order.id}`;
  const note = buyerNote(order);

  if (resolved) {
    const created = await createDineInOrderFromTableQr({
      token: order.tableToken,
      businessId,
      siteId: connection.site_id,
      items,
      note,
      openedBy: null,
      clientRequestId,
      customerId: customer.partyId,
      holdKitchenDispatch: true,
      openedAt: openedAtFor(order),
      actorRole: "cashier",
    });
    if (!created.ok) {
      const code = "reason" in created ? created.reason : created.error;
      const status = "status" in created ? created.status : 422;
      throw new CafeOrderIntakeError(code, status);
    }
    await stampOrderOrigin(connection, order, created.order.id);
    return { orderId: created.order.id, created: true, resolved: created.resolved };
  }

  const location = connection.sync_location_id
    ? { id: connection.sync_location_id }
    : await getPrimaryLocation(businessId);
  if (!location) throw new CafeOrderIntakeError("no_location", 409);

  const result = await createOrder({
    locationId: location.id,
    type: "takeaway",
    tableId: null,
    tableQrTokenId: null,
    customerId: customer.partyId,
    guestCount: null,
    note,
    discount: { type: null },
    items,
    openedBy: null,
    clientRequestId,
    openedAt: openedAtFor(order),
    actorRole: "cashier",
    holdKitchenDispatch: true,
  });
  if (!result.ok) throw new CafeOrderIntakeError(result.error, result.status);
  await stampOrderOrigin(connection, order, result.data.id);
  return { orderId: result.data.id, created: true, resolved: null };
}

/**
 * Record an online payment for an already-imported café order.
 *
 * The money is real the moment the CMS verifies it, so it goes through the
 * canonical settlement service (payment row, inventory event, ledger, loyalty)
 * exactly like a counter payment would — with the CMS order id as the
 * idempotency key, so `order.paid` replayed by the webhook *and* re-read by the
 * poll attaches one payment, not two. Settling does not free the table: visit
 * lifecycle belongs to staff (ESH-147 / #916).
 */
export async function attachCafeOrderPayment(
  connection: WebsiteConnectionRow,
  order: CmsOrder,
  orderId: string,
): Promise<{ duplicate: boolean }> {
  const businessId = connection.business_id;
  const { rows } = await query<{ location_id: string }>(
    `SELECT location_id FROM orders WHERE id = $1`,
    [orderId],
  );
  const locationId = rows[0]?.location_id;
  if (!locationId) throw new CafeOrderIntakeError("order_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const settled = await completeOrderPayment({
      client,
      businessId,
      locationId,
      orderId,
      method: "online",
      reference: order.reference || order.id,
      receivedBy: null,
      idempotencyKey: `cms-paid:${connection.id}:${order.id}`,
    });
    await client.query("COMMIT");
    return { duplicate: settled.duplicate === true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
