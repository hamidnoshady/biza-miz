import { createHash } from "node:crypto";
import { query, withTenantTransaction } from "../db";
import { getConnection, type ConnectionRow } from "./connections-service";
import { isWooCommerce } from "./provider-registry";
import { pluginSupportsJobType } from "./plugin-capabilities";
import { publicationRemoteId, publicationRetryTarget, PUBLICATION_META_KEY } from "./product-publication";
import type { WooCommerceClient, WooProduct } from "./woocommerce-client";
import { rialToWooAmount } from "./woo-money";
import { resolveMappedWooPrice } from "./woo-price-source-service";
import { buildMappedWooAttributes } from "./product-attribute-mappings-service";

interface PublicationItem extends Record<string, unknown> {
  id: string; name: string; sku: string | null; kind: string; parent_item_id: string | null;
  short_description: string | null; long_description: string | null; publish_status: string;
  is_sellable: boolean; is_active: boolean;
}
export interface PublicationEvent { entity_type?: string; remote_id: string; payload: unknown }
export interface PublicationPreview { connectionId: string; storeName: string; localId: string; name: string; action: string; reviewToken: string; payload: Record<string, unknown> }

export async function publicationStores(businessId: string, locationId: string) {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM integration_connections WHERE business_id=$1 AND provider='woocommerce'
       AND status='active' AND deleted_at IS NULL AND (location_id=$2 OR (location_id IS NULL AND $2::uuid =
         (SELECT id FROM locations WHERE business_id=$1 AND is_active ORDER BY created_at LIMIT 1))) ORDER BY name`, [businessId, locationId]);
  return rows;
}

export async function previewProductPublication(businessId: string, locationId: string, connectionId: string, localId: string, linkRemoteId?: string): Promise<PublicationPreview> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection || !isWooCommerce(connection) || connection.status !== "active" || (connection.location_id && connection.location_id !== locationId)) throw new Error("publication_connection_unavailable");
  if (!connection.location_id) {
    const { rows: primary } = await query<{ id: string }>(`SELECT id FROM locations WHERE business_id=$1 AND is_active ORDER BY created_at LIMIT 1`, [businessId]);
    if (primary[0]?.id !== locationId) throw new Error("publication_connection_unavailable");
  }
  if (connection.link_mode === "plugin" && !pluginSupportsJobType(connection.plugin_capabilities, "product_publish")) throw new Error("publication_plugin_update_required");
  const { rows } = await query<PublicationItem>(`SELECT id, name, sku, kind, parent_item_id, short_description, long_description, publish_status, is_sellable, is_active
    FROM items WHERE location_id=$1 AND (id=$2 OR (parent_item_id=$2 AND is_active)) ORDER BY (parent_item_id IS NOT NULL), id`, [locationId, localId]);
  const item = rows.find((r) => r.id === localId);
  if (!item) throw new Error("publication_product_not_found");
  if (item.parent_item_id) throw new Error("publication_select_parent_family");
  if (!item.is_active || (item.kind !== "variant_parent" && !item.is_sellable)) throw new Error("publication_product_not_sellable");
  const mappings = await query<{ local_id: string; remote_id: string }>(`SELECT local_id, remote_id FROM integration_mappings WHERE business_id=$1 AND connection_id=$2 AND entity_type='product' AND local_id=ANY($3::uuid[])`, [businessId, connectionId, rows.map((r) => r.id)]);
  const byLocal = new Map(mappings.rows.map((r) => [r.local_id, r.remote_id]));
  if (linkRemoteId && byLocal.has(localId) && byLocal.get(localId) !== linkRemoteId) throw new Error("publication_already_linked");
  const makePayload = async (row: PublicationItem): Promise<Record<string, unknown>> => {
    const price = row.kind === "variant_parent" ? null : await resolveMappedWooPrice(businessId, connection, row.id);
    if (row.kind !== "variant_parent" && price === null) throw new Error("publication_sale_price_missing");
    const type = row.parent_item_id ? "variation" : row.kind === "variant_parent" ? "variable" : "simple";
    const target = byLocal.get(row.id) ?? (row.id === localId ? linkRemoteId : undefined);
    const body: Record<string, unknown> = {
      name: row.name, sku: row.sku || `bizamiz-${row.id}`, status: row.publish_status === "published" ? "publish" : row.publish_status === "private" ? "private" : "draft",
      description: row.long_description ?? "", short_description: row.short_description ?? "",
      attributes: await buildMappedWooAttributes(businessId, connection, row.id),
      ...(type !== "variation" ? { type } : {}),
      ...(price !== null ? { regular_price: rialToWooAmount(price, connection.currency_unit) } : {}),
      ...(price !== null ? { __priceRial: price.toString() } : {}),
      __localId: row.id, __wooType: type, ...(target ? { __targetRemoteId: publicationRemoteId(target) } : {}),
      ...(row.id === localId && linkRemoteId && !byLocal.has(row.id) ? { __linkOnly: true } : {}),
    };
    return body;
  };
  const payload = await makePayload(item);
  const children = await Promise.all(rows.filter((r) => r.parent_item_id === item.id).map(makePayload));
  if (children.length && payload.__linkOnly) throw new Error("publication_family_link_requires_individual_review");
  if (children.length) payload.__children = children;
  const reviewToken = createHash("sha256").update(JSON.stringify({ businessId, locationId, connectionId, payload })).digest("hex");
  return { connectionId, storeName: connection.name, localId, name: item.name, action: payload.__linkOnly ? "link" : payload.__targetRemoteId ? "update" : "create", reviewToken, payload };
}

export async function queueProductPublication(businessId: string, preview: PublicationPreview): Promise<void> {
  const operationId = `publication:${preview.connectionId}:${preview.localId}:${preview.reviewToken}`;
  await query(`INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, local_id, payload, operation_id)
    VALUES ($1,$2,'product_publish',$3,$4,$5,$6) ON CONFLICT (connection_id,entity_type,remote_id) DO NOTHING`,
  [businessId, preview.connectionId, operationId, preview.localId, JSON.stringify({ ...preview.payload, __operationId: operationId }), operationId]);
}

export async function applyProductPublication(connection: ConnectionRow, client: WooCommerceClient, event: PublicationEvent): Promise<void> {
  const payload = event.payload as Record<string, unknown>;
  const parent = payload.__parentRemoteId ? Number(publicationRemoteId(payload.__parentRemoteId)) : null;
  const target = payload.__targetRemoteId ? Number(publicationRemoteId(payload.__targetRemoteId)) : null;
  const operationId = String(payload.__operationId ?? "");
  if (!operationId) throw new Error("publication_review:operation_id_missing");
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith("__")));
  let remote: WooProduct;
  if (target) {
    remote = parent ? await client.getVariation(parent, target) : await client.getProduct(target);
    if ((parent && remote.parent_id !== parent) || (!parent && remote.type !== payload.__wooType)) throw new Error("publication_review:remote_type_mismatch");
    if (payload.__linkOnly && remote.sku !== body.sku) throw new Error("publication_review:link_sku_mismatch");
    if (!payload.__linkOnly) remote = parent ? await client.updateVariation(parent, target, body) : await client.updateProduct(target, body);
  } else {
    const existing = parent ? await client.listVariations(parent, { sku: String(body.sku) }) : await client.listProducts({ sku: String(body.sku) });
    const recovered = publicationRetryTarget(existing, operationId);
    body.meta_data = [{ key: PUBLICATION_META_KEY, value: operationId }];
    if (recovered && ((parent && recovered.parent_id !== parent) || (!parent && recovered.type !== payload.__wooType))) throw new Error("publication_review:remote_type_mismatch");
    remote = recovered ?? (parent ? await client.createVariation(parent, body) : await client.createProduct(body));
  }
  payload.__ackRemoteId = publicationRemoteId(remote.id);
  await query(`UPDATE integration_outbox_events SET payload=jsonb_set(payload,'{__ackRemoteId}',to_jsonb($3::text))
    WHERE connection_id=$1 AND entity_type='product_publish' AND remote_id=$2 AND payload->>'__operationId'=$4`,
  [connection.id, event.remote_id, payload.__ackRemoteId, operationId]);
}

/** Called only for a successful, lease-fenced delivery; never maps a queued intention. */
export async function acknowledgeProductPublication(connection: ConnectionRow, event: PublicationEvent): Promise<void> {
  const original = event.payload as Record<string, unknown>;
  const { rows } = await query<{ payload: Record<string, unknown> }>(`SELECT payload FROM integration_outbox_events WHERE connection_id=$1 AND entity_type='product_publish' AND remote_id=$2`, [connection.id, event.remote_id]);
  const payload = rows[0]?.payload ?? original;
  const remoteId = publicationRemoteId(payload.__ackRemoteId);
  const localId = String(payload.__localId);
  return withTenantTransaction(connection.business_id, async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`woo-publication:${connection.id}:${localId}`]);
    const { rows: localMappings } = await query<{ remote_id: string }>(`SELECT remote_id FROM integration_mappings WHERE business_id=$1 AND connection_id=$2 AND entity_type='product' AND local_id=$3`, [connection.business_id, connection.id, localId]);
    if (localMappings.some(m => m.remote_id !== remoteId)) throw new Error("publication_review:local_already_linked");
    const existing = await query<{ local_id: string }>(`SELECT local_id FROM integration_mappings WHERE business_id=$1 AND connection_id=$2 AND entity_type='product' AND remote_id=$3 FOR UPDATE`, [connection.business_id, connection.id, remoteId]);
    if (existing.rows.some((r) => r.local_id !== localId)) throw new Error("publication_review:remote_already_linked");
    await query(`INSERT INTO integration_mappings (business_id,connection_id,entity_type,remote_id,local_id,last_pushed_payload)
      VALUES ($1,$2,'product',$3,$4,$5) ON CONFLICT (connection_id,entity_type,remote_id) DO UPDATE SET last_pushed_payload=integration_mappings.last_pushed_payload || EXCLUDED.last_pushed_payload, updated_at=now() WHERE integration_mappings.local_id=EXCLUDED.local_id`,
    [connection.business_id, connection.id, remoteId, localId, JSON.stringify({ wooType: payload.__wooType,
      ...(payload.__priceRial ? { priceRial: payload.__priceRial } : {}),
      ...(payload.__parentRemoteId ? { remoteParentId: payload.__parentRemoteId } : {}) })]);
    for (const child of (payload.__children ?? []) as Record<string, unknown>[]) {
      const operationId = `${payload.__operationId}:${child.__localId}`;
      await query(`INSERT INTO integration_outbox_events (business_id,connection_id,entity_type,remote_id,local_id,payload,operation_id)
        VALUES ($1,$2,'product_publish',$3,$4,$5,$3) ON CONFLICT (connection_id,entity_type,remote_id) DO NOTHING`,
      [connection.business_id, connection.id, operationId, child.__localId, JSON.stringify({ ...child, __parentRemoteId: remoteId, __operationId: operationId })]);
    }
  });
}
