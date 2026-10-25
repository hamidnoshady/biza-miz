/**
 * Phase 38 Wave 3 (issue #381) — product, stock and price push through
 * `website_outbox`. DB-touching; the decisions it applies are in `sync.ts`.
 *
 * Shape, deliberately the WooCommerce outbox's (`integrations/outbox-service.ts`):
 *
 *   1. **Fill.** For every in-scope product, read what the site *should* show
 *      (price from `menu_items`/`item_stock`, stock from the recipe or the
 *      `item_stock` row), diff against what was last pushed, and re-arm the
 *      matching outbox rows. The UNIQUE on (kind, product) is the coalescing
 *      rule: a hundred sales re-arm one `stock.set`.
 *   2. **Drain.** Take due rows, and for each one read the value **from the
 *      database at send time** — never from the row's payload, which only
 *      names the product. Success records the pushed value on the map; a
 *      failure backs off or dead-letters (`afterFailure`).
 *
 * `runWebsiteSyncTick` is `server.ts`'s entry: enumerate connected businesses
 * under the documented platform bypass, re-enter each with `withTenant`, and
 * swallow its own errors so one site's outage never stops the next business's
 * tick. A business whose site is down simply grows its queue; nothing is lost.
 */
import { query, withoutTenantScope, withTenant } from "../db";
import { isAppServiceOperational } from "../service-activation/app-gate-service";
import { writeIntegrationAudit } from "../integrations/audit";
import { WebsiteAdapterError, isRetryableWebsiteError, type WebsiteAdapter } from "./adapter";
import { adapterFromRow, getWebsiteConnectionRow, recordWebsiteError, type WebsiteConnectionRow } from "./connection-service";
import {
  afterFailure,
  planProductEvents,
  sellableFromIngredients,
  type DesiredProductState,
  type LocalProductKind,
  type ProductMapState,
  type WebsiteOutboxKind,
} from "./sync";

export const WEBSITE_SYNC_TICK_INTERVAL_MS = 60 * 1000;
const DRAIN_BATCH = 25;

// ---------------------------------------------------------------------------
// Local product reads — "what should the site show right now"
// ---------------------------------------------------------------------------

interface LocalProduct {
  name: string;
  sku: string | null;
  description: string | null;
}

async function resolveLocationId(row: WebsiteConnectionRow): Promise<string | null> {
  if (row.sync_location_id) return row.sync_location_id;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [row.business_id],
  );
  return rows[0]?.id ?? null;
}

async function menuItemSellable(locationId: string, menuItemId: string): Promise<number | null> {
  const { rows } = await query<{ quantity: string; stock: string }>(
    `SELECT mii.quantity::text, COALESCE(SUM(sm.quantity), 0)::text AS stock
       FROM menu_item_ingredients mii
       LEFT JOIN stock_movements sm
         ON sm.inventory_item_id = mii.inventory_item_id AND sm.location_id = $1
      WHERE mii.menu_item_id = $2
      GROUP BY mii.inventory_item_id, mii.quantity`,
    [locationId, menuItemId],
  );
  return sellableFromIngredients(rows.map((r) => ({ onHand: Number(r.stock), perUnit: Number(r.quantity) })));
}

/** Read the local product and its desired state; `null` when it no longer exists. */
export async function readLocalProduct(
  locationId: string,
  kind: LocalProductKind,
  localId: string,
): Promise<{ product: LocalProduct; desired: DesiredProductState } | null> {
  if (kind === "menu_item") {
    const { rows } = await query<{ name: string; sku: string | null; description: string | null; price: string }>(
      `SELECT name, sku, description, price::text FROM menu_items WHERE id = $1 AND location_id = $2`,
      [localId, locationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      product: { name: row.name, sku: row.sku, description: row.description },
      desired: { priceRial: Number(row.price), stock: await menuItemSellable(locationId, localId) },
    };
  }
  const { rows } = await query<{ name: string; sku: string | null; quantity: string; unit_price: string | null }>(
    `SELECT i.name, i.sku, s.quantity::text, s.unit_price::text
       FROM items i
       JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = $1 AND i.location_id = $2 AND i.kind <> 'variant_parent'`,
    [localId, locationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    product: { name: row.name, sku: row.sku, description: null },
    desired: { priceRial: row.unit_price === null ? null : Number(row.unit_price), stock: Math.floor(Number(row.quantity)) },
  };
}

// ---------------------------------------------------------------------------
// Product map
// ---------------------------------------------------------------------------

interface MapRow extends Record<string, unknown> {
  id: string;
  local_kind: LocalProductKind;
  local_id: string;
  remote_id: string | null;
  sync_enabled: boolean;
  last_pushed_at: string | null;
  last_pushed_price_rial: string | null;
  last_pushed_stock: string | null;
}

function mapState(row: MapRow): ProductMapState {
  return {
    remoteId: row.remote_id,
    syncEnabled: row.sync_enabled,
    lastPushedPriceRial: row.last_pushed_price_rial === null ? null : Number(row.last_pushed_price_rial),
    lastPushedStock: row.last_pushed_stock === null ? null : Number(row.last_pushed_stock),
  };
}

async function listMapRows(businessId: string): Promise<MapRow[]> {
  const { rows } = await query<MapRow>(
    `SELECT id, local_kind, local_id, remote_id, sync_enabled, last_pushed_at,
            last_pushed_price_rial::text, last_pushed_stock::text
       FROM website_product_map WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows;
}

/** The owner's mark: create the map row if needed and set `sync_enabled`. */
export async function setProductSync(
  businessId: string,
  kind: LocalProductKind,
  localId: string,
  enabled: boolean,
): Promise<void> {
  await query(
    `INSERT INTO website_product_map (business_id, local_kind, local_id, sync_enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, local_kind, local_id)
     DO UPDATE SET sync_enabled = EXCLUDED.sync_enabled, updated_at = now()`,
    [businessId, kind, localId, enabled],
  );
}

// ---------------------------------------------------------------------------
// Outbox: fill
// ---------------------------------------------------------------------------

export async function enqueueWebsiteEvent(
  businessId: string,
  kind: WebsiteOutboxKind,
  localKind: LocalProductKind,
  localId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  // One row per (kind, product). On conflict:
  //   - a `sent` row is re-armed (pending, attempts 0, due now);
  //   - a `pending`/`processing` row is already queued — leave it;
  //   - a `failed` row keeps its backoff schedule — re-arming it every tick
  //     would defeat the backoff and hammer a site that is down;
  //   - a `dead` row stays dead until a person retries it (`force`, which the
  //     owner's explicit mark also uses).
  // The payload names the product and nothing else — the number is read at send.
  const force = opts.force === true;
  await query(
    `INSERT INTO website_outbox (business_id, kind, local_kind, local_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (business_id, kind, local_kind, local_id)
     DO UPDATE SET
       status = CASE WHEN website_outbox.status = 'sent' OR $6 THEN 'pending' ELSE website_outbox.status END,
       attempts = CASE WHEN website_outbox.status = 'sent' OR $6 THEN 0 ELSE website_outbox.attempts END,
       next_attempt_at = CASE WHEN website_outbox.status = 'sent' OR $6 THEN now() ELSE website_outbox.next_attempt_at END,
       error = CASE WHEN website_outbox.status = 'sent' OR $6 THEN NULL ELSE website_outbox.error END,
       updated_at = now()`,
    [businessId, kind, localKind, localId, JSON.stringify({ localKind, localId }), force],
  );
}

/**
 * Called by the tick, and — cheaply — by anything that knows a product just
 * changed (a sale, a price edit) to bring the next push forward. Diffing here
 * against the last pushed value means calling it too often costs nothing.
 */
export async function refreshWebsiteOutbox(row: WebsiteConnectionRow): Promise<number> {
  const locationId = await resolveLocationId(row);
  if (!locationId) return 0;
  const switches = { pushPrices: row.push_prices, pushStock: row.push_stock, productScope: row.product_scope };
  let queued = 0;
  for (const map of await listMapRows(row.business_id)) {
    const local = await readLocalProduct(locationId, map.local_kind, map.local_id);
    if (!local) continue;
    for (const kind of planProductEvents(mapState(map), local.desired, switches)) {
      await enqueueWebsiteEvent(row.business_id, kind, map.local_kind, map.local_id);
      queued += 1;
    }
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Outbox: drain
// ---------------------------------------------------------------------------

interface OutboxRow extends Record<string, unknown> {
  id: string;
  kind: WebsiteOutboxKind;
  local_kind: LocalProductKind;
  local_id: string;
  attempts: number;
}

async function applyEvent(adapter: WebsiteAdapter, row: WebsiteConnectionRow, event: OutboxRow, locationId: string): Promise<void> {
  const local = await readLocalProduct(locationId, event.local_kind, event.local_id);
  if (!local) throw new WebsiteAdapterError("not_found", "local product no longer exists");

  const { rows: maps } = await query<MapRow>(
    `SELECT id, local_kind, local_id, remote_id, sync_enabled, last_pushed_at,
            last_pushed_price_rial::text, last_pushed_stock::text
       FROM website_product_map WHERE business_id = $1 AND local_kind = $2 AND local_id = $3`,
    [row.business_id, event.local_kind, event.local_id],
  );
  const map = maps[0];
  if (!map) throw new WebsiteAdapterError("not_found", "product map row missing");

  // The value at THIS moment — the Phase 32 rule: the event says which, the
  // database says how much.
  const price = local.desired.priceRial;
  const stock = local.desired.stock;

  switch (event.kind) {
    case "product.upsert": {
      if (price === null) throw new WebsiteAdapterError("rejected", "local product has no price");
      const remote = await adapter.upsertProduct({
        remoteId: map.remote_id ?? undefined,
        title: local.product.name,
        sku: local.product.sku ?? undefined,
        summary: local.product.description ?? undefined,
        priceRial: price,
        ...(row.push_stock && stock !== null ? { stock } : {}),
      });
      await query(
        `UPDATE website_product_map
            SET remote_id = $2, last_pushed_at = now(), last_pushed_price_rial = $3,
                last_pushed_stock = CASE WHEN $5 THEN $4 ELSE last_pushed_stock END, updated_at = now()
          WHERE id = $1`,
        [map.id, remote.id, price, stock, row.push_stock && stock !== null],
      );
      return;
    }
    case "price.set": {
      if (!map.remote_id) throw new WebsiteAdapterError("not_found", "no remote id yet");
      if (price === null) throw new WebsiteAdapterError("rejected", "local product has no price");
      await adapter.setProductPrice(map.remote_id, price);
      await query(
        `UPDATE website_product_map SET last_pushed_at = now(), last_pushed_price_rial = $2, updated_at = now() WHERE id = $1`,
        [map.id, price],
      );
      return;
    }
    case "stock.set": {
      if (!map.remote_id) throw new WebsiteAdapterError("not_found", "no remote id yet");
      if (stock === null) throw new WebsiteAdapterError("rejected", "stock unknown for this product");
      await adapter.setProductStock(map.remote_id, stock);
      await query(
        `UPDATE website_product_map SET last_pushed_at = now(), last_pushed_stock = $2, updated_at = now() WHERE id = $1`,
        [map.id, stock],
      );
      return;
    }
  }
}

export async function drainWebsiteOutbox(row: WebsiteConnectionRow, adapter = adapterFromRow(row)): Promise<{ sent: number; failed: number }> {
  const businessId = row.business_id;
  const locationId = await resolveLocationId(row);
  if (!locationId) return { sent: 0, failed: 0 };

  const { rows } = await query<OutboxRow>(
    `SELECT id, kind, local_kind, local_id, attempts
       FROM website_outbox
      WHERE business_id = $1 AND status IN ('pending', 'failed') AND next_attempt_at <= now()
      ORDER BY
        CASE kind WHEN 'product.upsert' THEN 0 ELSE 1 END, -- an upsert must land before its follow-ups
        next_attempt_at
      LIMIT $2`,
    [businessId, DRAIN_BATCH],
  );

  let sent = 0;
  let failed = 0;
  for (const event of rows) {
    await query(`UPDATE website_outbox SET status = 'processing', updated_at = now() WHERE id = $1`, [event.id]);
    try {
      await applyEvent(adapter, row, event, locationId);
      await query(
        `UPDATE website_outbox SET status = 'sent', sent_at = now(), error = NULL, updated_at = now() WHERE id = $1`,
        [event.id],
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      const outcome = afterFailure(event.attempts, isRetryableWebsiteError(err));
      await query(
        `UPDATE website_outbox
            SET status = $2, attempts = $3, error = $4,
                next_attempt_at = now() + ($5 || ' milliseconds')::interval, updated_at = now()
          WHERE id = $1`,
        [event.id, outcome.status, outcome.attempts, message, outcome.delayMs],
      );
      if (outcome.status === "dead") {
        await writeIntegrationAudit({
          businessId,
          action: "website.outbox.dead_lettered",
          entityType: event.kind,
          localId: event.local_id,
          error: message,
        });
      }
      // The site going away is the whole tick's problem, not this row's:
      // stop the batch and let the backoff do its work. A credential refusal
      // is recorded on the connection so the owner sees it on the page.
      if (err instanceof WebsiteAdapterError && err.code === "unreachable") break;
      if (err instanceof WebsiteAdapterError && err.code === "unauthorized") {
        await recordWebsiteError(businessId, "unauthorized");
        break;
      }
    }
  }
  return { sent, failed };
}

/** Owner action: put a dead or failed row back in the queue, due now. */
export async function retryWebsiteOutboxRow(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE website_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2 AND status IN ('failed', 'dead')`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// One business, one tick
// ---------------------------------------------------------------------------

/** Fill then drain for one business. Exported so tests and the queue page's «همگام‌سازی اکنون» can call it. */
export async function syncWebsiteForBusiness(businessId: string, adapter?: WebsiteAdapter): Promise<{ queued: number; sent: number; failed: number }> {
  if (!(await isAppServiceOperational(businessId, "website"))) {
    return { queued: 0, sent: 0, failed: 0 };
  }
  const row = await getWebsiteConnectionRow(businessId);
  if (!row || row.status !== "active") return { queued: 0, sent: 0, failed: 0 };
  const queued = await refreshWebsiteOutbox(row);
  const drained = await drainWebsiteOutbox(row, adapter ?? adapterFromRow(row));
  return { queued, ...drained };
}

/**
 * The background tick — same shape as `runWooCommerceSyncTick`: enumerate
 * with the platform bypass, `withTenant` per business, swallow each
 * business's own error so the loop continues.
 */
export async function runWebsiteSyncTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string }>(`SELECT business_id FROM eshobe_cms_connections WHERE status = 'active'`),
  );
  for (const { business_id } of rows) {
    try {
      await withTenant(business_id, () => syncWebsiteForBusiness(business_id));
    } catch (err) {
      console.error("website sync tick: business failed", { businessId: business_id, error: (err as Error).message });
    }
  }
}
