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
 *   - and it is a *proposal*: lines land as `'pending'` (`sent_to_kitchen_at`
 *     is NULL) with kitchen dispatch held until a staff member accepts it.
 *
 * Idempotency is layered on purpose: the CMS identity is stamped atomically on
 * the order inside `createOrder()` (`uq_orders_cms_order`), and the create
 * carries `clientRequestId = cms-cafe:<connection>:<order>`, which is the same
 * exactly-once contract the till uses for a lost HTTP response.
 */
import { getPool, query } from "../db";
import { createOrder } from "../order-mutations";
import type { CartItemInput } from "../order-cart";
import { MAX_ORDER_LINE_QUANTITY } from "../order-quantity";
import { completeOrderPayment } from "../payment-service";
import { parseRemoteInstant } from "../online-sale-policy";
import { reconcileExternalIdentity } from "../crm-external-identity";
import { broadcast } from "../realtime";
import { getPrimaryLocation } from "../setup-state";
import type { WebsiteConnectionRow } from "../website/connection-service";
import {
  createDineInOrderFromTableQr,
  resolveTableQrTokenForOrder,
  type ResolvedTableQrIntake,
} from "../table-qr-service";
import { cmsMinorToRial } from "./order-money";
import type { CmsOrder, CmsOrderItem } from "./types";

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

export function cmsOrderServiceMode(
  order: CmsOrder,
): "dine_in" | "takeaway" | null | undefined {
  return order.serviceMode !== undefined
    ? order.serviceMode
    : order.cafe?.serviceMode;
}

export function cmsOrderTableToken(order: CmsOrder): string | null | undefined {
  return order.tableToken !== undefined
    ? order.tableToken
    : order.cafe?.tableToken;
}

export function cmsOrderItemProductId(line: CmsOrderItem): string {
  if (typeof line.productId === "string" && line.productId.trim()) {
    return line.productId.trim();
  }
  if (typeof line.product === "string" && line.product.trim()) {
    return line.product.trim();
  }
  if (line.product && typeof line.product === "object" && line.product.id) {
    return String(line.product.id).trim();
  }
  return "";
}

function cmsOrderItemModifierIds(line: CmsOrderItem): string[] {
  if (Array.isArray(line.modifierIds) && line.modifierIds.length > 0) {
    return line.modifierIds
      .map((id) => String(id).trim())
      .filter(Boolean);
  }
  if (Array.isArray(line.modifiers) && line.modifiers.length > 0) {
    const out: string[] = [];
    for (const mod of line.modifiers) {
      const optionId = String(mod.optionSourceId ?? "").trim();
      if (!optionId) continue;
      const repeat = Math.max(1, Math.min(20, Math.round(Number(mod.quantity ?? 1))));
      for (let i = 0; i < repeat; i++) out.push(optionId);
    }
    return out;
  }
  return [];
}

/**
 * Is this a café/table-service order rather than the legacy one-product
 * storefront shape? Accepts both normalized (`serviceMode`, `tableToken`,
 * `items[].productId`) and Payload persisted (`cafe.serviceMode`,
 * `cafe.tableToken`, `items[].product`) wire formats.
 */
export function isCafeCmsOrder(order: CmsOrder): boolean {
  const mode = cmsOrderServiceMode(order);
  const token = cmsOrderTableToken(order);
  return (
    (Array.isArray(order.items) && order.items.length > 0) ||
    mode === "dine_in" ||
    mode === "takeaway" ||
    (typeof token === "string" && token.length > 0)
  );
}

/** The CMS order's own checkout instant, so the sale lands on its business day. */
function openedAtFor(order: CmsOrder): string | null {
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

  const lineEntries = items.map((line) => ({
    line,
    remoteProductId: cmsOrderItemProductId(line),
    rawModifierIds: cmsOrderItemModifierIds(line),
  }));

  const remoteIds = [...new Set(lineEntries.map((e) => e.remoteProductId))];
  if (remoteIds.some((id) => !id)) {
    throw new CafeOrderIntakeError("product_id_required", 400);
  }

  const { rows: mappedRows } = await query<{ remote_id: string; local_id: string }>(
    `SELECT remote_id, local_id
       FROM website_product_map
      WHERE business_id = $1 AND connection_id = $2 AND local_kind = 'menu_item'
        AND sync_enabled = true AND remote_id = ANY($3::text[])`,
    [businessId, connectionId, remoteIds],
  );
  const localByRemote = new Map(mappedRows.map((row) => [row.remote_id, row.local_id]));

  const remoteModifierIds = [
    ...new Set(lineEntries.flatMap((entry) => entry.rawModifierIds)),
  ];
  const localModifierByRemote = new Map<string, string>();
  if (remoteModifierIds.length > 0) {
    // Support either CMS-assigned modifier `remote_id` OR synced local UUID
    // `source_key` (when `eshobe-cms` echoes `optionSourceId`).
    const { rows: modifierRows } = await query<{ source_key: string; remote_id: string }>(
      `SELECT source_key, remote_id
         FROM website_menu_object_map
        WHERE business_id = $1 AND connection_id = $2 AND kind = 'modifier'
          AND (remote_id = ANY($3::text[]) OR source_key = ANY($3::text[]))`,
      [businessId, connectionId, remoteModifierIds],
    );
    for (const row of modifierRows) {
      localModifierByRemote.set(row.remote_id, row.source_key);
      localModifierByRemote.set(row.source_key, row.source_key);
    }
  }

  return lineEntries.map(({ line, remoteProductId, rawModifierIds }) => {
    const menuItemId = localByRemote.get(remoteProductId);
    if (!menuItemId) throw new CafeOrderIntakeError(`product_not_mapped:${remoteProductId}`);

    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_LINE_QUANTITY) {
      throw new CafeOrderIntakeError("invalid_quantity", 400);
    }

    const modifierIds: string[] = [];
    for (const remoteModifierId of rawModifierIds) {
      const local = localModifierByRemote.get(remoteModifierId);
      if (!local) throw new CafeOrderIntakeError(`modifier_not_mapped:${remoteModifierId}`);
      modifierIds.push(local);
    }

    return {
      menuItemId,
      quantity,
      modifierIds,
      note: line.note?.trim() || null,
      remoteProductId,
    };
  });
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
  const prior = await query<{ id: string }>(
    `SELECT id FROM orders
      WHERE cms_connection_id = $1 AND cms_order_id = $2
      LIMIT 1`,
    [connection.id, order.id],
  );
  if (prior.rows[0]) {
    return { orderId: prior.rows[0].id, created: false, resolved: null };
  }

  const rawMode = cmsOrderServiceMode(order);
  const rawToken = cmsOrderTableToken(order);
  const serviceMode = rawMode ?? (rawToken ? "dine_in" : "takeaway");
  if (serviceMode !== "dine_in" && serviceMode !== "takeaway") {
    throw new CafeOrderIntakeError("invalid_service_mode", 400);
  }

  let resolved: ResolvedTableQrIntake | null = null;
  if (serviceMode === "dine_in") {
    if (!rawToken) throw new CafeOrderIntakeError("table_token_required", 422);
    const resolution = await resolveTableQrTokenForOrder({
      token: rawToken,
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
  } else if (rawToken) {
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
  const websiteOrigin = {
    cmsConnectionId: connection.id,
    cmsOrderId: order.id,
    websiteApprovalState: "pending" as const,
  };

  if (resolved) {
    const created = await createDineInOrderFromTableQr({
      token: rawToken,
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
      websiteOrigin,
    });
    if (!created.ok) {
      const code = "reason" in created ? created.reason : created.error;
      const status = "status" in created ? created.status : 422;
      throw new CafeOrderIntakeError(code, status);
    }
    // Defensive backfill only if `clientRequestId` replayed a pre-stamped row.
    await ensureWebsiteOriginStamped(connection, order.id, created.order.id);
    broadcast(resolved.locationId, { type: "order.created", orderId: created.order.id });
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
    websiteOrigin,
  });
  if (!result.ok) throw new CafeOrderIntakeError(result.error, result.status);
  await ensureWebsiteOriginStamped(connection, order.id, result.data.id);
  broadcast(location.id, { type: "order.created", orderId: result.data.id });
  return { orderId: result.data.id, created: true, resolved: null };
}

async function ensureWebsiteOriginStamped(
  connection: WebsiteConnectionRow,
  cmsOrderId: string,
  posOrderId: string,
): Promise<void> {
  await query(
    `UPDATE orders
        SET origin = 'website',
            cms_connection_id = COALESCE(cms_connection_id, $2),
            cms_order_id = COALESCE(cms_order_id, $3),
            website_approval_state = COALESCE(website_approval_state, 'pending')
      WHERE id = $1 AND (origin <> 'website' OR cms_connection_id IS NULL OR cms_order_id IS NULL)`,
    [posOrderId, connection.id, cmsOrderId],
  );
}

/**
 * Record an online payment for an already-imported café order.
 *
 * Verifies that the CMS paid total matches POS's locally-priced order total
 * (`cms_payment_amount_mismatch` otherwise), skips idempotently if POS already
 * completed the order (e.g., counter payment echo or replayed webhook/poll),
 * and suppresses outbound `paid` sync back to CMS so webhook settlement never
 * echoes.
 */
export async function attachCafeOrderPayment(
  connection: WebsiteConnectionRow,
  order: CmsOrder,
  orderId: string,
): Promise<{ duplicate: boolean }> {
  const businessId = connection.business_id;
  const expectedRial = cmsMinorToRial(order.total, order.currency);

  const client = await getPool().connect();
  let locationId = "";
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      location_id: string;
      total: string;
      status: string;
    }>(
      `SELECT location_id, total::text, status::text AS status
         FROM orders
        WHERE id = $1
        FOR UPDATE`,
      [orderId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new CafeOrderIntakeError("order_not_found", 404);
    }
    locationId = row.location_id;

    if (row.status === "completed") {
      // Already paid (either replayed webhook/poll or POS counter payment).
      await client.query("COMMIT");
      return { duplicate: true };
    }
    if (row.status === "voided") {
      await client.query("ROLLBACK");
      throw new CafeOrderIntakeError("order_voided_cannot_pay", 422);
    }

    if (expectedRial !== BigInt(row.total)) {
      await client.query("ROLLBACK");
      throw new CafeOrderIntakeError("cms_payment_amount_mismatch", 422);
    }

    const settled = await completeOrderPayment({
      client,
      businessId,
      locationId,
      orderId,
      method: "online",
      reference: order.reference || order.id,
      receivedBy: null,
      idempotencyKey: `cms-paid:${connection.id}:${order.id}`,
      skipCmsOrderStateSync: true,
    });
    await client.query("COMMIT");
    if (!settled.duplicate) {
      broadcast(locationId, { type: "order.updated", orderId });
    }
    return { duplicate: settled.duplicate === true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
