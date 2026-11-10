/**
 * Accounting → website projection through the existing website_outbox.
 *
 * The queue names a local product and connection; every price, stock count,
 * category, modifier and image is read from Accounting at send time. Remote
 * creates carry stable source identities so a lost response can be recovered
 * without matching a display name or SKU. All auxiliary identities are scoped
 * to one existing CMS connection, and every database read/write stays inside
 * the caller's tenant scope (the background tick enters one per business).
 */
import { createHash } from "node:crypto";
import { query, withoutTenantScope, withTenant, withTenantTransaction } from "../db";
import { isAppServiceOperational } from "../service-activation/app-gate-service";
import { writeIntegrationAudit } from "../integrations/audit";
import { connectionFetch, connectionUrl } from "../integrations/outbound-http";
import { getMediaConfig, getActiveMediaAssetWithStorageKey, readMediaObject } from "../media-service";
import { catalogueImage } from "../restaurant-menu";
import {
  WebsiteAdapterError,
  isRetryableWebsiteError,
  WEBSITE_MENU_TAXONOMY_KEY,
  type MenuModifierGroup,
  type RemoteProductInput,
  type WebsiteAdapter,
} from "./adapter";
import {
  adapterFromRow,
  getWebsiteConnectionRow,
  listWebsiteConnectionRows,
  recordWebsiteError,
  WebsiteNotConnectedError,
  type WebsiteConnectionRow,
} from "./connection-service";
import { menuProjectionKey, projectMenuItem } from "./menu-projection";
import {
  afterFailure,
  planProductEvents,
  productInScope,
  sellableFromIngredients,
  type DesiredProductState,
  type LocalProductKind,
  type ProductMapState,
  type SyncSwitches,
  type WebsiteLocalProduct,
  type WebsiteOutboxKind,
} from "./sync";

export const WEBSITE_SYNC_TICK_INTERVAL_MS = 60 * 1000;
const DRAIN_BATCH = 25;
const MAX_LEGACY_IMAGE_BYTES = 10 * 1024 * 1024;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Local reads — what Accounting says the site should show right now
// ---------------------------------------------------------------------------

export interface LocalProductSnapshot {
  product: WebsiteLocalProduct;
  desired: DesiredProductState;
}

async function resolveLocationId(row: WebsiteConnectionRow): Promise<string | null> {
  if (row.sync_location_id) {
    const owned = await query(
      `SELECT 1 FROM locations WHERE id = $1 AND business_id = $2 AND is_active`,
      [row.sync_location_id, row.business_id],
    );
    return owned.rowCount ? row.sync_location_id : null;
  }
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at, id LIMIT 1`,
    [row.business_id],
  );
  return rows[0]?.id ?? null;
}

async function menuItemSellable(locationId: string, menuItemId: string): Promise<number | null> {
  const { rows } = await query<{ quantity: string; stock: string }>(
    `SELECT mii.quantity::text, COALESCE(SUM(sm.quantity), 0)::text AS stock
       FROM menu_item_ingredients mii
       JOIN inventory_items ii ON ii.id = mii.inventory_item_id AND ii.location_id = $1
       LEFT JOIN stock_movements sm
         ON sm.inventory_item_id = mii.inventory_item_id AND sm.location_id = $1
      WHERE mii.menu_item_id = $2
      GROUP BY mii.inventory_item_id, mii.quantity`,
    [locationId, menuItemId],
  );
  return sellableFromIngredients(rows.map((r) => ({ onHand: Number(r.stock), perUnit: Number(r.quantity) })));
}

interface MenuProjectionRow extends Record<string, unknown> {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  price: string;
  image_url: string | null;
  image_media_id: string | null;
  sort_order: number;
  is_active: boolean;
  category_name: string | null;
  category_description: string | null;
  category_sort_order: number | null;
  category_active: boolean | null;
}

/** Read one product, including its complete category/add-on projection. */
export async function readLocalProduct(
  locationId: string,
  kind: LocalProductKind,
  localId: string,
  businessId?: string,
): Promise<LocalProductSnapshot | null> {
  if (businessId) {
    const owned = await query(`SELECT 1 FROM locations WHERE id = $1 AND business_id = $2`, [locationId, businessId]);
    if (!owned.rowCount) return null;
  }
  if (kind === "menu_item") {
    const { rows } = await query<MenuProjectionRow>(
      `SELECT m.id, m.category_id, m.name, m.description, m.sku, m.price::text,
              m.image_url, m.image_media_id, m.sort_order, m.is_active,
              c.name AS category_name, c.description AS category_description,
              c.sort_order AS category_sort_order, c.is_active AS category_active
         FROM menu_items m
         LEFT JOIN menu_categories c ON c.id = m.category_id AND c.location_id = m.location_id
        WHERE m.id = $1 AND m.location_id = $2`,
      [localId, locationId],
    );
    const row = rows[0];
    if (!row) return null;
    const [groups, links, modifiers] = await Promise.all([
      query<{ id: string; name: string; min_select: number; max_select: number; is_active: boolean; sort_order: number }>(
        `SELECT g.id, g.name, g.min_select, g.max_select, g.is_active, g.sort_order
           FROM menu_item_modifier_groups l
           JOIN modifier_groups g ON g.id = l.modifier_group_id AND g.location_id = $2
          WHERE l.menu_item_id = $1 ORDER BY l.sort_order, g.sort_order, g.name`,
        [localId, locationId],
      ),
      query<{ menu_item_id: string; modifier_group_id: string; min_select_override: number | null; max_select_override: number | null; sort_order: number; is_active: boolean }>(
        `SELECT l.menu_item_id, l.modifier_group_id, l.min_select_override, l.max_select_override, l.sort_order, l.is_active
           FROM menu_item_modifier_groups l
           JOIN modifier_groups g ON g.id = l.modifier_group_id AND g.location_id = $2
          WHERE l.menu_item_id = $1 ORDER BY l.sort_order, g.id`,
        [localId, locationId],
      ),
      query<{ id: string; group_id: string; name: string; price_delta: string; is_active: boolean; sort_order: number }>(
        `SELECT o.id, o.group_id, o.name, o.price_delta::text, o.is_active, o.sort_order
           FROM modifiers o
           JOIN modifier_groups g ON g.id = o.group_id AND g.location_id = $2
           JOIN menu_item_modifier_groups l ON l.modifier_group_id = g.id AND l.menu_item_id = $1
          WHERE o.location_id = $2 ORDER BY o.sort_order, o.name`,
        [localId, locationId],
      ),
    ]);
    const projected = projectMenuItem({
      item: {
        id: row.id, categoryId: row.category_id, name: row.name, description: row.description,
        sku: row.sku, price: Number(row.price), imageUrl: row.image_url, imageMediaId: row.image_media_id,
        isActive: row.is_active, sortOrder: row.sort_order, targetMarginPercent: null,
      },
      category: row.category_id && row.category_name !== null ? {
        id: row.category_id, name: row.category_name, description: row.category_description,
        taxRate: 0, isActive: row.category_active === true, sortOrder: row.category_sort_order ?? 0,
      } : null,
      groups: groups.rows.map((g) => ({ id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, isActive: g.is_active, sortOrder: g.sort_order })),
      links: links.rows.map((l) => ({
        menuItemId: l.menu_item_id, modifierGroupId: l.modifier_group_id,
        minSelectOverride: l.min_select_override, maxSelectOverride: l.max_select_override,
        sortOrder: l.sort_order, isActive: l.is_active,
      })),
      modifiers: modifiers.rows.map((o) => ({ id: o.id, groupId: o.group_id, name: o.name, priceDelta: Number(o.price_delta), isActive: o.is_active, sortOrder: o.sort_order })),
    });
    if (!projected) return null;
    projected.desired.stock = await menuItemSellable(locationId, localId);
    return projected;
  }

  const { rows } = await query<{ name: string; sku: string | null; quantity: string; unit_price: string | null; is_active: boolean }>(
    `SELECT i.name, i.sku, s.quantity::text, s.unit_price::text, i.is_active
       FROM items i JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = $1 AND i.location_id = $2 AND i.kind <> 'variant_parent'`,
    [localId, locationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    product: { name: row.name, sku: row.sku, description: null },
    desired: {
      priceRial: row.unit_price === null ? null : Number(row.unit_price),
      stock: Math.max(0, Math.floor(Number(row.quantity))),
      published: true,
      available: row.is_active,
    },
  };
}

function switchesFor(row: WebsiteConnectionRow): SyncSwitches {
  return { pushPrices: row.push_prices, pushStock: row.push_stock, productScope: row.product_scope };
}

function desiredFor(map: ProductMapState, local: LocalProductSnapshot, switches: SyncSwitches): DesiredProductState {
  const published = productInScope(map, switches);
  const available = (local.desired.available ?? true) && published && !(switches.pushStock && local.desired.stock === 0);
  const desired = { ...local.desired, published, available };
  return { ...desired, contentHash: sha256(menuProjectionKey(local.product, desired)) };
}

// ---------------------------------------------------------------------------
// Existing product map, now explicitly per connection/site
// ---------------------------------------------------------------------------

interface MapRow extends Record<string, unknown> {
  id: string;
  connection_id: string;
  local_kind: LocalProductKind;
  local_id: string;
  remote_id: string | null;
  sync_enabled: boolean;
  last_pushed_at: string | null;
  last_pushed_price_rial: string | null;
  last_pushed_stock: string | null;
  last_pushed_content_hash: string | null;
  last_pushed_published: boolean | null;
  last_pushed_available: boolean | null;
}

const MAP_COLUMNS = `id, connection_id, local_kind, local_id, remote_id, sync_enabled, last_pushed_at,
  last_pushed_price_rial::text, last_pushed_stock::text, last_pushed_content_hash,
  last_pushed_published, last_pushed_available`;

function mapState(row: MapRow): ProductMapState {
  return {
    remoteId: row.remote_id,
    syncEnabled: row.sync_enabled,
    lastPushedPriceRial: row.last_pushed_price_rial === null ? null : Number(row.last_pushed_price_rial),
    lastPushedStock: row.last_pushed_stock === null ? null : Number(row.last_pushed_stock),
    lastPushedContentHash: row.last_pushed_content_hash,
    lastPushedPublished: row.last_pushed_published,
  };
}

async function listMapRows(businessId: string, connectionId: string): Promise<MapRow[]> {
  const { rows } = await query<MapRow>(
    `SELECT ${MAP_COLUMNS} FROM website_product_map
      WHERE business_id = $1 AND connection_id = $2 ORDER BY created_at, id`,
    [businessId, connectionId],
  );
  return rows;
}

async function productBelongsToLocation(businessId: string, kind: LocalProductKind, localId: string, locationId: string): Promise<boolean> {
  const table = kind === "menu_item" ? "menu_items" : "items";
  const { rowCount } = await query(
    `SELECT 1 FROM ${table} p JOIN locations l ON l.id = p.location_id
      WHERE p.id = $1 AND p.location_id = $2 AND l.business_id = $3`,
    [localId, locationId, businessId],
  );
  return (rowCount ?? 0) > 0;
}

/** The owner's per-site mark. Opting out queues a withdrawal, not a deletion. */
export async function setProductSync(
  businessId: string,
  kind: LocalProductKind,
  localId: string,
  enabled: boolean,
  connectionId?: string,
): Promise<void> {
  const connection = await getWebsiteConnectionRow(businessId, connectionId);
  if (!connection || connection.status !== "active") throw new WebsiteNotConnectedError();
  const locationId = await resolveLocationId(connection);
  if (!locationId || !(await productBelongsToLocation(businessId, kind, localId, locationId))) {
    throw new WebsiteAdapterError("not_found", "local product is not in this connection's branch");
  }
  await query(
    `INSERT INTO website_product_map (business_id, connection_id, local_kind, local_id, sync_enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, connection_id, local_kind, local_id)
     DO UPDATE SET sync_enabled = EXCLUDED.sync_enabled, updated_at = now()`,
    [businessId, connection.id, kind, localId, enabled],
  );
  await enqueueWebsiteEvent(businessId, "product.upsert", kind, localId, { force: true, connectionId: connection.id });
}

// ---------------------------------------------------------------------------
// Outbox fill/coalescing
// ---------------------------------------------------------------------------

export async function enqueueWebsiteEvent(
  businessId: string,
  kind: WebsiteOutboxKind,
  localKind: LocalProductKind,
  localId: string,
  opts: { force?: boolean; connectionId?: string } = {},
): Promise<void> {
  const connection = await getWebsiteConnectionRow(businessId, opts.connectionId);
  if (!connection || connection.status !== "active") throw new WebsiteNotConnectedError();
  const force = opts.force === true;
  await query(
    `INSERT INTO website_outbox (business_id, connection_id, kind, local_kind, local_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (business_id, connection_id, kind, local_kind, local_id)
     DO UPDATE SET
       status = CASE WHEN website_outbox.status = 'sent' OR $7 THEN 'pending' ELSE website_outbox.status END,
       attempts = CASE WHEN website_outbox.status = 'sent' OR $7 THEN 0 ELSE website_outbox.attempts END,
       next_attempt_at = CASE WHEN website_outbox.status = 'sent' OR $7 THEN now() ELSE website_outbox.next_attempt_at END,
       error = CASE WHEN website_outbox.status = 'sent' OR $7 THEN NULL ELSE website_outbox.error END,
       desired_at = CASE WHEN website_outbox.status = 'sent' OR $7 THEN now() ELSE website_outbox.desired_at END,
       updated_at = CASE WHEN website_outbox.status = 'sent' OR $7 THEN now() ELSE website_outbox.updated_at END`,
    [businessId, connection.id, kind, localKind, localId, JSON.stringify({ localKind, localId }), force],
  );
}

/** Diff every mapped product of one site. Calling it repeatedly is cheap. */
export async function refreshWebsiteOutbox(row: WebsiteConnectionRow): Promise<number> {
  const locationId = await resolveLocationId(row);
  if (!locationId) return 0;
  const switches = switchesFor(row);
  let queued = 0;
  for (const map of await listMapRows(row.business_id, row.id)) {
    const local = await readLocalProduct(locationId, map.local_kind, map.local_id, row.business_id);
    if (!local) {
      // A hard-deleted local row still owes a withdrawal if it was published.
      if (map.remote_id && map.last_pushed_published !== false) {
        await enqueueWebsiteEvent(row.business_id, "product.upsert", map.local_kind, map.local_id, { connectionId: row.id });
        queued += 1;
      }
      continue;
    }
    const desired = desiredFor(mapState(map), local, switches);
    for (const kind of planProductEvents(mapState(map), desired, switches)) {
      await enqueueWebsiteEvent(row.business_id, kind, map.local_kind, map.local_id, { connectionId: row.id });
      queued += 1;
    }
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Connection-scoped auxiliary identities (taxonomy/category/media/add-ons)
// ---------------------------------------------------------------------------

type ObjectKind = "taxonomy" | "category" | "modifier_group" | "modifier" | "media";
interface ObjectMapRow extends Record<string, unknown> {
  source_key: string;
  remote_id: string;
  content_hash: string | null;
}

async function objectMaps(businessId: string, connectionId: string, kind: ObjectKind, keys?: string[]): Promise<Map<string, ObjectMapRow>> {
  const { rows } = await query<ObjectMapRow>(
    `SELECT source_key, remote_id, content_hash FROM website_menu_object_map
      WHERE business_id = $1 AND connection_id = $2 AND kind = $3
        AND ($4::text[] IS NULL OR source_key = ANY($4::text[]))`,
    [businessId, connectionId, kind, keys ?? null],
  );
  return new Map(rows.map((row) => [row.source_key, row]));
}

async function saveObjectMap(businessId: string, connectionId: string, kind: ObjectKind, sourceKey: string, remoteId: string, contentHash: string | null = null): Promise<void> {
  await query(
    `INSERT INTO website_menu_object_map (business_id, connection_id, kind, source_key, remote_id, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (business_id, connection_id, kind, source_key)
     DO UPDATE SET remote_id = EXCLUDED.remote_id, content_hash = EXCLUDED.content_hash, updated_at = now()`,
    [businessId, connectionId, kind, sourceKey, remoteId, contentHash],
  );
}

async function ensureCategory(adapter: WebsiteAdapter, row: WebsiteConnectionRow, category: WebsiteLocalProduct["category"]): Promise<string | null> {
  if (!category) return null;
  const taxonomies = await objectMaps(row.business_id, row.id, "taxonomy", [WEBSITE_MENU_TAXONOMY_KEY]);
  const taxonomy = await adapter.upsertMenuTaxonomy({ remoteId: taxonomies.get(WEBSITE_MENU_TAXONOMY_KEY)?.remote_id });
  await saveObjectMap(row.business_id, row.id, "taxonomy", WEBSITE_MENU_TAXONOMY_KEY, taxonomy.id);
  const categories = await objectMaps(row.business_id, row.id, "category", [category.sourceId]);
  const remote = await adapter.upsertMenuCategory({
    ...category,
    remoteId: categories.get(category.sourceId)?.remote_id,
    taxonomyId: taxonomy.id,
  });
  await saveObjectMap(row.business_id, row.id, "category", category.sourceId, remote.id);
  return remote.id;
}

async function fetchLegacyImage(url: string): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new WebsiteAdapterError("rejected", "unsafe legacy image URL"); }
  let response: Response;
  try {
    response = await connectionFetch(parsed.toString(), { method: "GET", redirect: "error" });
  } catch {
    throw new WebsiteAdapterError("unreachable", "legacy image could not be fetched");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new WebsiteAdapterError("rejected", `legacy image returned ${response.status}`);
  }
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") {
    await response.body?.cancel().catch(() => {});
    throw new WebsiteAdapterError("rejected", "legacy image is not a raster image");
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_LEGACY_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new WebsiteAdapterError("rejected", "legacy image is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WebsiteAdapterError("rejected", "legacy image has no bytes");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LEGACY_IMAGE_BYTES) {
        await reader.cancel();
        throw new WebsiteAdapterError("rejected", "legacy image is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebsiteAdapterError) throw error;
    throw new WebsiteAdapterError("unreachable", "legacy image download interrupted");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const filename = parsed.pathname.split("/").filter(Boolean).pop() || "menu-image";
  return { bytes, mimeType, filename: filename.slice(0, 200) };
}

/** Upload only changed bytes; the map and adapter source identity cover retries. */
async function ensureMedia(adapter: WebsiteAdapter, row: WebsiteConnectionRow, product: WebsiteLocalProduct): Promise<string | null> {
  const image = catalogueImage({ imageMediaId: product.imageMediaId ?? null, imageUrl: product.imageUrl ?? null });
  if (image.mediaId) {
    const asset = await getActiveMediaAssetWithStorageKey(row.business_id, image.mediaId);
    if (!asset || asset.asset.kind !== "image") return null;
    const sourceKey = `media:${image.mediaId}`;
    const existing = (await objectMaps(row.business_id, row.id, "media", [sourceKey])).get(sourceKey);
    if (existing && existing.content_hash === asset.sha256) return existing.remote_id;
    let stored: Awaited<ReturnType<typeof readMediaObject>>;
    try {
      stored = await readMediaObject(row.business_id, image.mediaId, await getMediaConfig());
    } catch {
      throw new WebsiteAdapterError("unreachable", "menu image storage is unavailable");
    }
    if (!stored) return null;
    if (sha256(stored.bytes) !== asset.sha256) throw new WebsiteAdapterError("rejected", "menu image integrity check failed");
    const remote = await adapter.uploadMedia({
      sourceId: `${sourceKey}:${asset.sha256}`,
      filename: stored.asset.fileName,
      mimeType: stored.asset.mimeType,
      bytes: stored.bytes,
      alt: product.name,
    });
    await saveObjectMap(row.business_id, row.id, "media", sourceKey, remote.id, asset.sha256);
    return remote.id;
  }
  if (!image.url) return null;
  const sourceKey = `url:${sha256(image.url)}`;
  const legacy = await fetchLegacyImage(image.url);
  const hash = sha256(legacy.bytes);
  const existing = (await objectMaps(row.business_id, row.id, "media", [sourceKey])).get(sourceKey);
  if (existing && existing.content_hash === hash) return existing.remote_id;
  const remote = await adapter.uploadMedia({
    sourceId: `${sourceKey}:${hash}`,
    filename: legacy.filename,
    mimeType: legacy.mimeType,
    bytes: legacy.bytes,
    alt: product.name,
  });
  await saveObjectMap(row.business_id, row.id, "media", sourceKey, remote.id, hash);
  return remote.id;
}

async function withRemoteModifierIds(row: WebsiteConnectionRow, groups: MenuModifierGroup[]): Promise<MenuModifierGroup[]> {
  const groupMaps = await objectMaps(row.business_id, row.id, "modifier_group", groups.map((g) => g.sourceId));
  const optionIds = groups.flatMap((g) => g.options.map((o) => o.sourceId));
  const optionMaps = await objectMaps(row.business_id, row.id, "modifier", optionIds);
  return groups.map((group) => ({
    ...group,
    remoteId: groupMaps.get(group.sourceId)?.remote_id,
    options: group.options.map((option) => ({ ...option, remoteId: optionMaps.get(option.sourceId)?.remote_id })),
  }));
}

async function saveRemoteModifiers(row: WebsiteConnectionRow, groups: MenuModifierGroup[]): Promise<void> {
  for (const group of groups) {
    if (group.remoteId) await saveObjectMap(row.business_id, row.id, "modifier_group", group.sourceId, group.remoteId);
    for (const option of group.options) {
      if (option.remoteId) await saveObjectMap(row.business_id, row.id, "modifier", option.sourceId, option.remoteId);
    }
  }
}

// ---------------------------------------------------------------------------
// Outbox drain
// ---------------------------------------------------------------------------

interface OutboxRow extends Record<string, unknown> {
  id: string;
  kind: WebsiteOutboxKind;
  local_kind: LocalProductKind;
  local_id: string;
  attempts: number;
  updated_at: string;
}

async function applyEvent(adapter: WebsiteAdapter, connection: WebsiteConnectionRow, event: OutboxRow, locationId: string): Promise<void> {
  // Serialize remote identity recovery for one site across worker processes.
  // The transaction holds no Accounting row lock while waiting on the network.
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`website-menu:${connection.id}`]);
  const current = await getWebsiteConnectionRow(connection.business_id, connection.id);
  if (!current || current.status !== "active") throw new WebsiteAdapterError("unreachable", "connection is not active");
  const { rows: maps } = await query<MapRow>(
    `SELECT ${MAP_COLUMNS} FROM website_product_map
      WHERE business_id = $1 AND connection_id = $2 AND local_kind = $3 AND local_id = $4 FOR UPDATE`,
    [current.business_id, current.id, event.local_kind, event.local_id],
  );
  const map = maps[0];
  if (!map) throw new WebsiteAdapterError("not_found", "product map row missing");
  const local = await readLocalProduct(locationId, event.local_kind, event.local_id, current.business_id);
  const switches = switchesFor(current);
  const published = local !== null && productInScope(mapState(map), switches);
  const desired = local ? desiredFor(mapState(map), local, switches) : null;

  if (event.kind === "price.set") {
    if (!switches.pushPrices) return;
    if (!map.remote_id) throw new WebsiteAdapterError("not_found", "no remote id yet");
    if (!local || local.desired.priceRial === null) throw new WebsiteAdapterError("rejected", "local product has no price");
    await adapter.setProductPrice(map.remote_id, local.desired.priceRial);
    await query(`UPDATE website_product_map SET last_pushed_at = now(), last_pushed_price_rial = $2, updated_at = now()
                  WHERE business_id = $1 AND id = $3`, [current.business_id, local.desired.priceRial, map.id]);
    return;
  }
  if (event.kind === "stock.set") {
    if (!switches.pushStock) return;
    if (!map.remote_id) throw new WebsiteAdapterError("not_found", "no remote id yet");
    if (!local) throw new WebsiteAdapterError("not_found", "local product no longer exists");
    await adapter.setProductStock(map.remote_id, local.desired.stock);
    await query(`UPDATE website_product_map SET last_pushed_at = now(), last_pushed_stock = $2, updated_at = now()
                  WHERE business_id = $1 AND id = $3`, [current.business_id, local.desired.stock, map.id]);
    return;
  }

  if (!map.remote_id && !published) return;
  if (!local || !desired) {
    if (map.remote_id) {
      await adapter.setProductAvailability(map.remote_id, { published: false, available: false });
      await query(
        `UPDATE website_product_map SET last_pushed_at = now(), last_pushed_published = false,
            last_pushed_available = false, last_pushed_content_hash = NULL, updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [current.business_id, map.id],
      );
    }
    return;
  }

  // A content upsert must not sneak a price change past the independent price
  // switch. The first create necessarily carries Accounting's current price.
  const price = map.remote_id && !switches.pushPrices && map.last_pushed_price_rial !== null
    ? Number(map.last_pushed_price_rial)
    : local.desired.priceRial;
  if (price === null) throw new WebsiteAdapterError("rejected", "local product has no price");
  const categoryTermId = await ensureCategory(adapter, current, local.product.category);
  const imageId = await ensureMedia(adapter, current, local.product);
  const modifierGroups = await withRemoteModifierIds(current, local.product.modifierGroups ?? []);
  const input: RemoteProductInput = {
    remoteId: map.remote_id ?? undefined,
    sourceId: `${event.local_kind}:${event.local_id}`,
    title: local.product.name,
    sku: local.product.sku ?? "",
    summary: local.product.description ?? "",
    priceRial: price,
    imageId,
    categoryTermId,
    menuOrder: local.product.sortOrder ?? 0,
    published: desired.published,
    available: desired.available,
    inventoryManagedExternally: event.local_kind === "menu_item",
    modifierGroups,
    ...(switches.pushStock ? { stock: local.desired.stock } : {}),
  };
  const remote = await adapter.upsertProduct(input);
  await saveRemoteModifiers(current, remote.modifierGroups ?? []);
  await query(
    `UPDATE website_product_map
        SET remote_id = $2, last_pushed_at = now(), last_pushed_price_rial = $3,
            last_pushed_stock = CASE WHEN $5 THEN $4 ELSE last_pushed_stock END,
            last_pushed_content_hash = $6, last_pushed_published = $7, last_pushed_available = $8,
            updated_at = now()
      WHERE business_id = $1 AND id = $9`,
    [current.business_id, remote.id, price, local.desired.stock, switches.pushStock,
     desired.contentHash ?? null, desired.published ?? false, desired.available ?? false, map.id],
  );
}

export async function drainWebsiteOutbox(row: WebsiteConnectionRow, adapter = adapterFromRow(row)): Promise<{ sent: number; failed: number }> {
  const businessId = row.business_id;
  const locationId = await resolveLocationId(row);
  if (!locationId) return { sent: 0, failed: 0 };

  // SKIP LOCKED plus a stale-processing lease makes concurrent ticks safe. A
  // crashed worker's row becomes due again; stable source ids prevent a second
  // remote product/media object when that happens after a lost response.
  const { rows } = await query<OutboxRow>(
    `WITH due AS (
       SELECT id FROM website_outbox
        WHERE business_id = $1 AND connection_id = $2
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= now())
            OR (status = 'processing' AND updated_at < now() - interval '5 minutes'))
        ORDER BY CASE kind WHEN 'product.upsert' THEN 0 ELSE 1 END, next_attempt_at, id
        LIMIT $3 FOR UPDATE SKIP LOCKED
     )
     UPDATE website_outbox o SET status = 'processing', updated_at = now()
       FROM due WHERE o.id = due.id
     RETURNING o.id, o.kind, o.local_kind, o.local_id, o.attempts, o.updated_at::text AS updated_at`,
    [businessId, row.id, DRAIN_BATCH],
  );

  rows.sort((a, b) => (a.kind === "product.upsert" ? 0 : 1) - (b.kind === "product.upsert" ? 0 : 1));
  let sent = 0;
  let failed = 0;
  for (const event of rows) {
    try {
      await withTenantTransaction(businessId, () => applyEvent(adapter, row, event, locationId));
      const finished = await query(
        `UPDATE website_outbox SET status = 'sent', sent_at = now(), error = NULL, updated_at = now()
          WHERE business_id = $1 AND id = $2 AND status = 'processing' AND updated_at::text = $3`,
        [businessId, event.id, event.updated_at],
      );
      if (finished.rowCount) sent += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      const outcome = afterFailure(event.attempts, isRetryableWebsiteError(err));
      const recorded = await query(
        `UPDATE website_outbox
            SET status = $2, attempts = $3, error = $4,
                next_attempt_at = now() + ($5 || ' milliseconds')::interval, updated_at = now()
          WHERE business_id = $1 AND id = $6 AND updated_at::text = $7`,
        [businessId, outcome.status, outcome.attempts, message, outcome.delayMs, event.id, event.updated_at],
      );
      if (recorded.rowCount && outcome.status === "dead") {
        await writeIntegrationAudit({
          businessId,
          action: "website.outbox.dead_lettered",
          entityType: event.kind,
          localId: event.local_id,
          payload: { connectionId: row.id, siteId: row.site_id },
          error: message,
        });
      }
      if (err instanceof WebsiteAdapterError && err.code === "unreachable") break;
      if (err instanceof WebsiteAdapterError && err.code === "unauthorized") {
        await recordWebsiteError(businessId, "unauthorized", row.id);
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
// One business, every connected site
// ---------------------------------------------------------------------------

export async function syncWebsiteForBusiness(
  businessId: string,
  adapter?: WebsiteAdapter,
  connectionId?: string,
): Promise<{ queued: number; sent: number; failed: number }> {
  const empty = { queued: 0, sent: 0, failed: 0 };
  if (!(await isAppServiceOperational(businessId, "website"))) return empty;
  const connections = connectionId
    ? [await getWebsiteConnectionRow(businessId, connectionId)].filter((row): row is WebsiteConnectionRow => row !== null && row.status === "active")
    : await listWebsiteConnectionRows(businessId, true);
  if (adapter && connections.length > 1 && !connectionId) {
    throw new Error("adapter_override_requires_connection");
  }
  const total = { ...empty };
  for (const row of connections) {
    const queued = await refreshWebsiteOutbox(row);
    const drained = await drainWebsiteOutbox(row, adapter ?? adapterFromRow(row));
    total.queued += queued;
    total.sent += drained.sent;
    total.failed += drained.failed;
  }
  return total;
}

/** Enumerate businesses under the documented platform bypass, then scope each. */
export async function runWebsiteSyncTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string }>(`SELECT DISTINCT business_id FROM eshobe_cms_connections WHERE status = 'active'`),
  );
  for (const { business_id } of rows) {
    try {
      await withTenant(business_id, () => syncWebsiteForBusiness(business_id));
    } catch (err) {
      console.error("website sync tick: business failed", { businessId: business_id, error: (err as Error).message });
    }
  }
}
