/**
 * Phase 23 (issue #118) — Wave 4: push stock & price from the POS to
 * WooCommerce through the outbox. DB-touching (not unit-tested directly; the
 * backoff/dead-letter and money conversion logic it leans on are pure).
 *
 * The background tick (wired in server.ts) enumerates active connections under
 * the documented platform bypass, then re-enters each business with
 * withTenant() before touching tenant data — the same shape as every other
 * server.ts tick. For each connection it (1) diffs local price/stock against
 * the mapping's last-pushed value and upserts due outbox events, then (2)
 * drains due events to the store with retry/backoff/dead-lettering.
 */
import { query, withoutTenantScope, withTenant } from "../db";
import { getBusinessIndustry } from "../industry-guard";
import { hasSellableCatalogue } from "../industries";
import { getConnection, wooClientFor } from "./connections-service";
import { isWooCommerce } from "./provider-registry";
import { listMappings, setLastPushedPayload } from "./mapping-service";
import { rialToWooAmount } from "./woo-money";
import { backoffDelayMs, isDeadAfterAttempts, OUTBOX_MAX_ATTEMPTS } from "./retry";
import { writeIntegrationAudit } from "./audit";
import { wooUpdatePath } from "./woo-catalogue";
import type { ConnectionRow } from "./connections-service";

export const WOO_SYNC_TICK_INTERVAL_MS = 60 * 1000;
const DRAIN_BATCH = 25;

class NeedsReviewError extends Error {}

async function resolveLocationId(connection: ConnectionRow): Promise<string> {
  if (connection.location_id) return connection.location_id;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [connection.business_id],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

/**
 * The sellable quantity of a menu item, from its recipe: the minimum over its
 * ingredients of floor(on-hand / required-per-unit). NULL when the item has no
 * recipe — without one, the POS itself can't know how many it can sell.
 */
async function sellableStock(locationId: string, menuItemId: string): Promise<number | null> {
  const { rows } = await query<{ quantity: string; stock: string }>(
    `SELECT mii.quantity,
            COALESCE(SUM(sm.quantity), 0)::text AS stock
       FROM menu_item_ingredients mii
       LEFT JOIN stock_movements sm
         ON sm.inventory_item_id = mii.inventory_item_id AND sm.location_id = $1
      WHERE mii.menu_item_id = $2
      GROUP BY mii.inventory_item_id, mii.quantity`,
    [locationId, menuItemId],
  );
  if (rows.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const sellable = Math.floor(Number(row.stock) / Number(row.quantity));
    if (sellable < min) min = sellable;
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}

interface DesiredState {
  stock: number | null;
  priceRial: bigint | null;
}

/** What should currently be pushed for one mapped product. */
async function desiredState(connection: ConnectionRow, locationId: string, localId: string): Promise<DesiredState> {
  const industry = await getBusinessIndustry(connection.business_id);

  // A trade with no sellable catalogue has no local state to push: the mapping
  // cannot exist in the first place (product sync skips), so this is the safe
  // answer rather than a query against a table the business does not fill.
  if (!hasSellableCatalogue(industry)) return { stock: null, priceRial: null };

  if (industry === "food_service") {
    const { rows } = await query<{ price: string }>(
      `SELECT price FROM menu_items WHERE id = $1 AND location_id = $2`,
      [localId, locationId],
    );
    if (!rows[0]) return { stock: null, priceRial: null };
    return {
      stock: connection.push_stock ? await sellableStock(locationId, localId) : null,
      priceRial: connection.push_prices ? BigInt(rows[0].price) : null,
    };
  }

  // Retail: read the item_stock row directly — no recipe-based sellable stock.
  const { rows } = await query<{ quantity: string; unit_price: string | null }>(
    `SELECT s.quantity::text, s.unit_price::text
       FROM items i
       JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = $1 AND i.location_id = $2
        AND i.kind <> 'variant_parent'`,
    [localId, locationId],
  );
  if (!rows[0]) return { stock: null, priceRial: null };
  return {
    stock: connection.push_stock ? Number(rows[0].quantity) : null,
    priceRial: connection.push_prices && rows[0].unit_price ? BigInt(rows[0].unit_price) : null,
  };
}

/** Diffs desired vs last-pushed and upserts outbox events for anything changed. */
export async function refreshOutboxForConnection(connection: ConnectionRow): Promise<void> {
  const businessId = connection.business_id;
  const locationId = await resolveLocationId(connection);
  const mappings = await listMappings(businessId, connection.id, "product");

  for (const mapping of mappings) {
    const desired = await desiredState(connection, locationId, mapping.localId);
    const previous = (mapping.lastPushedPayload ?? {}) as { stock?: number; priceRial?: string };
    if (desired.priceRial !== null) {
      const changed = previous.priceRial !== desired.priceRial.toString();
      if (changed) {
        await upsertOutbox(businessId, connection.id, "price", mapping.remoteId, mapping.localId, {
          regular_price: rialToWooAmount(desired.priceRial, connection.currency_unit),
        });
      }
    }
    if (desired.stock !== null) {
      const changed = previous.stock !== desired.stock;
      if (changed) {
        await upsertOutbox(businessId, connection.id, "stock", mapping.remoteId, mapping.localId, {
          stock_quantity: desired.stock,
          manage_stock: true,
        });
      }
    }
  }
}

async function upsertOutbox(
  businessId: string,
  connectionId: string,
  entityType: "stock" | "price",
  remoteId: string,
  localId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO integration_outbox_events
       (business_id, connection_id, entity_type, remote_id, local_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                   next_attempt_at = now(), last_error = NULL, updated_at = now()`,
    [businessId, connectionId, entityType, remoteId, localId, JSON.stringify(payload)],
  );
}

export type OutboxEntityType =
  | "stock"
  | "price"
  | "product_update"
  | "order_status"
  | "refund_create"
  | "catalogue_export"
  | "customer_export"
  | "orders_export";

/**
 * Apply one queued push to the store.
 *
 * The variation path is the Phase 38 fix. A variation is
 * `products/{parent}/variations/{id}` and not `products/{id}`; sending the
 * flat path with a variation id answers 404, and every push to a variation
 * duly walked itself into the dead-letter queue. The parent id is recorded
 * on the mapping when the product is synced (see sync-service's
 * `recordProductShape`) and carried on the row so the plugin — which leases
 * these rows and applies them itself — can make the same choice.
 */
async function applyOutboundEvent(
  connection: ConnectionRow,
  client: ReturnType<typeof wooClientFor>,
  event: { entity_type: string; remote_id: string; payload: unknown },
): Promise<void> {
  const patch = (event.payload ?? {}) as Record<string, unknown>;
  // Reserved keys never reach the store: `__parentRemoteId` is routing
  // metadata for this channel, not a WooCommerce field.
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith("__")) body[key] = value;
  }

  switch (event.entity_type) {
    case "stock":
    case "price":
    case "product_update": {
      const parent = (patch.__parentRemoteId as string | undefined) ?? null;
      await client.updateAt(wooUpdatePath(event.remote_id, parent), body);
      return;
    }
    case "order_status":
      await client.updateOrder(Number(event.remote_id), { status: body.status });
      return;
    case "refund_create": {
      // `api_refund` is forced false by woo-ops-service and re-forced here:
      // this channel records a refund, it does not move money through
      // someone's payment gateway. Non-idempotent: tag the remote refund with
      // a stable operation id and check for it before retrying after an
      // ambiguous ACK/network failure.
      const operationId = typeof patch.__operationId === "string" ? patch.__operationId : null;
      if (!operationId) {
        throw new NeedsReviewError("operation_id_missing_for_non_idempotent_refund");
      }
      const orderRemoteId = typeof patch.__orderRemoteId === "string" ? patch.__orderRemoteId : event.remote_id;
      if (operationId) {
        const existing = await client.listOrderRefunds(Number(orderRemoteId));
        if (
          existing.some((refund) =>
            (refund.meta_data ?? []).some((meta) => meta.key === "_pos_operation_id" && meta.value === operationId),
          )
        ) {
          return;
        }
      }
      await client.createRefund(Number(orderRemoteId), {
        amount: body.amount,
        reason: body.reason ?? "",
        api_refund: false,
        ...(operationId ? { meta_data: [{ key: "_pos_operation_id", value: operationId }] } : {}),
      });
      return;
    }
    case "catalogue_export":
    case "customer_export":
    case "orders_export":
    case "content_export":
      // Plugin-only: they ask the plugin to send what only it can see. In
      // REST mode there is nothing to apply (the app pulled the data
      // itself), and leaving them queued would dead-letter a job that was
      // never meant for this side.
      return;
    case "post_upsert":
    case "media_create":
      // Plugin-side jobs for WordPress content. REST mode writes content
      // directly through the manager's API route (wpUpsertPost), so nothing
      // is drained here; in plugin mode the plugin leases and applies these
      // rows itself.
      return;
    default:
      return;
  }
}

export async function drainOutbox(connection: ConnectionRow): Promise<void> {
  if (connection.status !== "active") return;
  const businessId = connection.business_id;
  const client = wooClientFor(connection);

  const { rows } = await query<{
    id: string;
    entity_type: OutboxEntityType;
    remote_id: string;
    payload: unknown;
    attempts: number;
  }>(
    `SELECT id, entity_type, remote_id, payload, attempts
       FROM integration_outbox_events
      WHERE connection_id = $1 AND status IN ('pending', 'failed') AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT $2`,
    [connection.id, DRAIN_BATCH],
  );

  for (const event of rows) {
    await query(`UPDATE integration_outbox_events SET status = 'processing' WHERE id = $1`, [event.id]);
    try {
      await applyOutboundEvent(connection, client, event);
      await query(
        `UPDATE integration_outbox_events SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [event.id],
      );
      // Preserve the other half so a stock push doesn't erase the last-pushed price (and vice versa).
      if (event.entity_type === "stock" || event.entity_type === "price" || event.entity_type === "product_update") {
        const patch = (event.payload ?? {}) as Record<string, unknown>;
        const previous = await previousPayload(businessId, connection.id, event.remote_id);
        await setLastPushedPayload(businessId, connection.id, "product", event.remote_id, {
          ...previous,
          ...(event.entity_type === "stock" ? { stock: patch.stock_quantity as number } : {}),
          ...(event.entity_type === "price" ? { priceRial: await localPriceRial(connection, event.remote_id) } : {}),
          ...(event.entity_type === "product_update"
            ? {
                ...("stock_quantity" in patch ? { stock: patch.stock_quantity as number } : {}),
                ...("regular_price" in patch ? { priceRial: await localPriceRial(connection, event.remote_id) } : {}),
              }
            : {}),
        });
      }
    } catch (err) {
      if (err instanceof NeedsReviewError) {
        await query(
          `UPDATE integration_outbox_events
              SET status = 'needs_review', last_error = $2, leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [event.id, err.message],
        );
        await writeIntegrationAudit({
          businessId,
          connectionId: connection.id,
          action: "outbox.needs_review",
          entityType: event.entity_type,
          remoteId: event.remote_id,
          error: err.message,
        });
        continue;
      }
      const attempts = event.attempts + 1;
      if (isDeadAfterAttempts(attempts, OUTBOX_MAX_ATTEMPTS)) {
        await query(
          `UPDATE integration_outbox_events SET status = 'dead', attempts = $2, last_error = $3, updated_at = now()
            WHERE id = $1`,
          [event.id, attempts, (err as Error).message],
        );
        await writeIntegrationAudit({
          businessId,
          connectionId: connection.id,
          action: "outbox.dead_lettered",
          entityType: event.entity_type,
          remoteId: event.remote_id,
          error: (err as Error).message,
        });
      } else {
        const delay = backoffDelayMs(attempts);
        await query(
          `UPDATE integration_outbox_events
              SET status = 'failed', attempts = $2, last_error = $3,
                  next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
            WHERE id = $1`,
          [event.id, attempts, (err as Error).message, delay],
        );
      }
    }
  }
}

async function previousPayload(businessId: string, connectionId: string, remoteId: string): Promise<Record<string, unknown>> {
  const { rows } = await query<{ last_pushed_payload: Record<string, unknown> }>(
    `SELECT last_pushed_payload FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product' AND remote_id = $3`,
    [businessId, connectionId, remoteId],
  );
  return rows[0]?.last_pushed_payload ?? {};
}

async function localPriceRial(connection: ConnectionRow, remoteId: string): Promise<string> {
  const { rows } = await query<{ local_id: string }>(
    `SELECT local_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product' AND remote_id = $3`,
    [connection.business_id, connection.id, remoteId],
  );
  const localId = rows[0]?.local_id;
  if (!localId) return "0";

  const industry = await getBusinessIndustry(connection.business_id);
  if (!hasSellableCatalogue(industry)) return "0";
  if (industry === "food_service") {
    const locationId = await resolveLocationId(connection);
    const { rows: item } = await query<{ price: string }>(
      `SELECT price FROM menu_items WHERE id = $1 AND location_id = $2`,
      [localId, locationId],
    );
    return item[0]?.price ?? "0";
  }

  const { rows: item } = await query<{ unit_price: string | null }>(
    `SELECT s.unit_price::text FROM item_stock s WHERE s.item_id = $1`,
    [localId],
  );
  return item[0]?.unit_price ?? "0";
}

/** The background tick: enumerate connections, then scope each business's work. */
export async function runWooCommerceSyncTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT id, business_id FROM integration_connections WHERE status = 'active' AND provider = 'woocommerce'`,
    ),
  );
  for (const { business_id, id } of rows) {
    await withTenant(business_id, async () => {
      const connection = await getConnection(business_id, id);
      if (!connection || connection.status !== "active") return;
      // Provider dispatch (Phase 26): the WooCommerce tick owns only
      // WooCommerce connections. Holoo's push path is a separate tick
      // (Wave 8). The guard is belt-and-braces with the SQL filter above.
      if (!isWooCommerce(connection)) return;
      if (connection.push_stock || connection.push_prices) {
        await refreshOutboxForConnection(connection);
      }
      // Phase 38 — a scheduled order pull, in REST mode only. The plugin
      // pushes its own orders, so pulling there would be a second path to the
      // same rows; but a REST connection whose webhook was never configured
      // (or whose webhook has been failing for a week) has no other way for a
      // sale to reach this app at all. The inbox's delivery-id dedup makes
      // re-reading the same orders free.
      if (connection.link_mode === "rest_api" && connection.auto_pull_orders && connection.sync_orders) {
        try {
          const { syncOrders } = await import("./sync-service");
          await syncOrders(connection.business_id, connection.id, { maxPages: 10 });
        } catch (err) {
          await writeIntegrationAudit({
            businessId: connection.business_id,
            connectionId: connection.id,
            action: "orders.pull_failed",
            error: (err as Error).message,
          });
        }
      }
      // Filling the queue is the same in both link modes — it only reads local
      // stock and prices. Draining is not: in plugin mode the WordPress plugin
      // pulls these rows and applies them itself (there are no REST credentials
      // here to call the store with), so this side must leave them alone or it
      // would immediately dead-letter every job the plugin was about to take.
      if (connection.link_mode === "rest_api") {
        await drainOutbox(connection);
      }
    });
  }
}
