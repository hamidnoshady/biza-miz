import { createHash } from "node:crypto";
import { query, withTenantTransaction } from "../db";
import { getItem } from "../items-service";
import { normalizeNameKey, normalizeSkuKey } from "../import-reconciliation/normalize";
import { canPublishOutbound } from "../import-reconciliation/lifecycle";
import { listItems, ReconciliationError } from "../import-reconciliation/service";
import type { IncomingProduct } from "../import-reconciliation/types";
import { wooClientFor, type ConnectionRow } from "../integrations/connections-service";
import { pluginSupportsJobType } from "../integrations/plugin-capabilities";
import { publicationRemoteId } from "../integrations/product-publication";
import {
  publicationOperationId, publicationStores, queueProductPublication, type PublicationPreview,
} from "../integrations/product-publication-service";
import { buildMappedWooAttributes } from "../integrations/product-attribute-mappings-service";
import { listTerms } from "../integrations/woo-taxonomy-service";
import type { WooProduct } from "../integrations/woocommerce-client";
import { catalogueTermSlug, type CatalogueTaxonomyPlan } from "../integrations/catalogue-publication-taxonomy";
import { getCatalogueRun, type CatalogueScope } from "./catalogue-import-service";

type ReviewOptions = {
  itemId: number;
  action?: "link" | "link_parent" | "create" | "create_parent";
  remoteId?: string;
  includeTaxonomy?: boolean;
  createTaxonomy?: boolean;
  reviewToken?: string;
};

type MappingRow = { local_id: string; remote_id: string; last_pushed_payload: { wooType?: string; remoteParentId?: string } };

export function catalogueTaxonomyCandidates<T extends { taxonomy: string; remoteId: string; slug: string; name: string }>(
  terms: readonly T[],
  taxonomy: string,
  value: string,
) {
  const key = normalizeNameKey(value);
  if (!key) return [];
  return terms.filter((term) => term.taxonomy === taxonomy &&
    (normalizeNameKey(term.name) === key || normalizeNameKey(term.slug) === key));
}

export async function catalogueWooReview(
  scope: CatalogueScope,
  runId: string,
  connection: ConnectionRow,
  options: ReviewOptions,
) {
  const { businessId, locationId } = scope;
  const { run } = await getCatalogueRun(scope, runId);
  if (connection.business_id !== businessId || !(await publicationStores(businessId, locationId)).some((store) => store.id === connection.id)) {
    throw new ReconciliationError("publication_connection_unavailable");
  }
  const [staged] = await listItems(businessId, runId, { afterId: options.itemId - 1, limit: 1 });
  if (!staged || staged.id !== options.itemId) throw new ReconciliationError("item_not_found");
  const record = staged.snapshot as IncomingProduct;
  if (!record.sku) throw new ReconciliationError("catalogue_invalid_identity");
  const localId = staged.resolvedCanonicalId ?? staged.canonicalId;
  const item = localId ? await getItem(localId) : null;
  if (item && item.locationId !== locationId) throw new ReconciliationError("publication_product_not_found");
  const parentSku = record.parentExternalId;
  const variant = record.kind === "variant_child";
  const parent = item?.parentItemId ? await getItem(item.parentItemId) : null;
  const parentOnly = options.action === "create_parent" || options.action === "link_parent";
  const type = parentOnly ? "variable" : variant ? "variation" : "simple";
  const sku = parentOnly ? parent?.sku : item?.sku ?? record.sku;
  if (!sku) throw new ReconciliationError("catalogue_invalid_identity");

  const { rows: mappings } = await query<MappingRow>(`SELECT local_id, remote_id, last_pushed_payload
    FROM integration_mappings WHERE business_id=$1 AND connection_id=$2 AND entity_type='product'
    AND local_id=ANY($3::uuid[]) ORDER BY remote_id`, [businessId, connection.id, [item?.id, parent?.id].filter(Boolean)]);
  const target = parentOnly ? parent : item;
  const mapped = mappings.filter((mapping) => mapping.local_id === target?.id);
  const parentMappings = mappings.filter((mapping) => mapping.local_id === parent?.id);
  if (mapped.length > 1 || parentMappings.length > 1) throw new ReconciliationError("publication_review_mapping_conflict");
  const remoteParent = !parentOnly && variant ? parentMappings[0]?.remote_id : null;
  const client = connection.link_mode === "rest_api" ? wooClientFor(connection) : null;
  const readable = client !== null;
  const mirror = await listTerms(businessId, connection.id);
  const categories = catalogueTaxonomyCandidates(mirror, "product_cat", String(record.fields?.collection ?? ""));
  const brands = catalogueTaxonomyCandidates(mirror, "product_brand", String(record.fields?.brand ?? ""));
  const specs = Object.entries((record.fields?.specs ?? {}) as Record<string, string>).filter(([field]) =>
    field !== "drive" || Boolean((record.fields?.watch as { movement?: string } | undefined)?.movement));
  const attributeTerms = specs.map(([field, value]) => {
    const taxonomy = `pa_${field.replaceAll("_", "-")}`;
    return { field, value, taxonomy, matches: catalogueTaxonomyCandidates(mirror, taxonomy, value) };
  });

  let products: WooProduct[] = [];
  if (client && (!variant || parentOnly || remoteParent)) {
    const soughtId = options.remoteId ?? mapped[0]?.remote_id;
    products = soughtId ? [remoteParent
      ? await client.getVariation(Number(publicationRemoteId(remoteParent)), Number(publicationRemoteId(soughtId)))
      : await client.getProduct(Number(publicationRemoteId(soughtId)))]
      : remoteParent ? await client.listVariations(Number(publicationRemoteId(remoteParent)), { sku })
        : await client.listProducts({ sku, per_page: 100 });
  }
  const candidates = products.map((product) => ({
    id: String(product.id), name: product.name, sku: product.sku, type: product.type, parentId: product.parent_id ?? null,
    price: product.regular_price, stock: product.stock_quantity,
  }));
  const discovery = {
    readable, candidates, mapped, parentSku, remoteParent, categories, brands, attributeTerms,
    awaitingLocalApply: staged.status !== "applied",
  };
  if (!options.action) return discovery;
  if (!target?.isActive || !run.crossChecked || !canPublishOutbound({
    runStatus: run.status, itemStatus: staged.status,
    mappingCommitted: Boolean(staged.resolvedCanonicalId), ownershipConfirmed: true,
  })) {
    throw new ReconciliationError("publication_local_review_incomplete");
  }
  if (connection.link_mode === "plugin" && !pluginSupportsJobType(connection.plugin_capabilities, "product_publish")) {
    throw new ReconciliationError("publication_plugin_update_required");
  }
  if (variant && !parentOnly && !remoteParent) throw new ReconciliationError("publication_parent_ack_required");

  const link = options.action === "link" || options.action === "link_parent";
  if (mapped.length) throw new ReconciliationError("publication_already_linked");
  const remoteId = link ? publicationRemoteId(options.remoteId) : undefined;
  const linkedVariantAttributes = link && variant && !parentOnly
    ? await buildMappedWooAttributes(businessId, connection, target.id)
    : [];
  if (link) {
    if (linkedVariantAttributes.length && !client && connection.plugin_capabilities?.publicationLinkAttributes !== true) {
      throw new ReconciliationError("publication_plugin_update_required");
    }
    if (client && (products.length !== 1 || products[0].type !== type ||
      normalizeSkuKey(products[0].sku) !== normalizeSkuKey(sku) ||
      (remoteParent && String(products[0].parent_id) !== remoteParent) ||
      linkedVariantAttributes.some((wanted) => !products[0].attributes?.some((entry) => entry.id === wanted.id &&
        "option" in wanted && entry.option === wanted.option)))) {
      throw new ReconciliationError("publication_review_incompatible_remote");
    }
    const { rows: existing } = await query<{ local_id: string }>(`SELECT local_id FROM integration_mappings
      WHERE business_id=$1 AND connection_id=$2 AND entity_type='product' AND remote_id=$3`, [businessId, connection.id, remoteId]);
    if (existing.some((mapping) => mapping.local_id !== target.id)) throw new ReconciliationError("publication_review_remote_already_linked");
  } else if (products.length) {
    throw new ReconciliationError("publication_review_sku_already_exists");
  }

  const attributes = !link && (variant || parentOnly)
    ? await buildMappedWooAttributes(businessId, connection, target.id) : [];
  let taxonomy: CatalogueTaxonomyPlan | undefined;
  if (options.includeTaxonomy && !link && !variant && !parentOnly) {
    if (!client) throw new ReconciliationError("publication_taxonomy_rest_required");
    if (categories.length > 1 || attributeTerms.some((attribute) => attribute.matches.length > 1)) {
      throw new ReconciliationError("publication_taxonomy_ambiguous");
    }
    taxonomy = { attributes: [] };
    const liveAttributes = await client.listAttributes();
    for (const attribute of attributeTerms) {
      const slug = attribute.taxonomy.replace(/^pa_/, "");
      const existing = liveAttributes.filter((entry) => entry.slug.replace(/^pa_/, "") === slug);
      if (existing.length > 1) throw new ReconciliationError("publication_taxonomy_ambiguous");
      const remote = existing[0];
      const terms = remote ? await client.listAttributeTerms(remote.id) : [];
      const matches = catalogueTaxonomyCandidates(terms.map((term) => ({
        ...term, remoteId: String(term.id), taxonomy: attribute.taxonomy,
      })), attribute.taxonomy, attribute.value);
      if (matches.length > 1) throw new ReconciliationError("publication_taxonomy_ambiguous");
      if (matches[0] || (options.createTaxonomy && attribute.value.length <= 100)) {
        taxonomy.attributes.push({
          name: remote?.name ?? attribute.field.replaceAll("_", " "),
          slug, id: remote?.id,
          term: matches[0] ?? { name: attribute.value, slug: catalogueTermSlug(attribute.value) },
        });
      }
    }
    const collection = String(record.fields?.collection ?? "");
    if (collection && collection.length <= 100) {
      const matches = catalogueTaxonomyCandidates((await client.listCategories()).map((term) => ({
        ...term, remoteId: String(term.id), taxonomy: "product_cat",
      })), "product_cat", collection);
      if (matches.length > 1) throw new ReconciliationError("publication_taxonomy_ambiguous");
      taxonomy.category = matches[0] ?? (options.createTaxonomy ? { name: collection, slug: catalogueTermSlug(collection) } : undefined);
    }
  }

  const payload = {
    sku: products[0]?.sku ?? sku,
    __localId: target.id,
    __catalogueRunId: run.id,
    __wooType: type,
    ...(remoteId ? { __targetRemoteId: remoteId, __linkOnly: true } : {}),
    ...(linkedVariantAttributes.length ? { __expectedLinkAttributes: linkedVariantAttributes } : {}),
    ...(remoteParent ? { __parentRemoteId: remoteParent } : {}),
    ...(!link ? {
      name: target.name, status: "draft", attributes,
      ...(taxonomy ? { __catalogueTaxonomy: taxonomy } : {}),
      ...(type !== "variation" ? { type } : {}),
    } : {}),
  };
  const reviewToken = createHash("sha256").update(JSON.stringify({ runId, itemId: staged.id, connectionId: connection.id, payload, candidates })).digest("hex");
  const preview: PublicationPreview = { connectionId: connection.id, storeName: connection.name, localId: target.id,
    name: target.name, action: options.action, reviewToken, payload };
  if (options.reviewToken) {
    if (reviewToken !== options.reviewToken) throw new ReconciliationError("publication_preview_changed");
    await withTenantTransaction(businessId, async () => {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`woo-publication:${connection.id}:${target.id}`]);
      const { rows } = await query(`SELECT 1 FROM integration_outbox_events
        WHERE business_id=$1 AND connection_id=$2 AND entity_type='product_publish' AND local_id=$3
          AND status IN ('pending','processing','failed','deferred') AND remote_id<>$4 LIMIT 1`,
      [businessId, connection.id, target.id, publicationOperationId(preview)]);
      if (rows.length) throw new ReconciliationError("publication_already_pending");
      const current = await query(`SELECT 1 FROM integration_mappings
        WHERE business_id=$1 AND connection_id=$2 AND entity_type='product' AND local_id=$3 LIMIT 1`,
      [businessId, connection.id, target.id]);
      if (current.rows.length) throw new ReconciliationError("publication_already_linked");
      await queueProductPublication(businessId, preview);
    });
  }
  return { ...discovery, preview, operationId: publicationOperationId(preview), queued: Boolean(options.reviewToken) };
}

export async function catalogueWooStatus(scope: CatalogueScope, runId: string, connectionId: string) {
  await getCatalogueRun(scope, runId);
  const { rows } = await query<{ id: string; remote_id: string; status: string; last_error: string | null; ack: string | null }>(
    `SELECT e.id, e.remote_id, e.status, e.last_error, e.payload->>'__ackRemoteId' AS ack
       FROM integration_outbox_events e
      WHERE e.business_id=$1 AND e.connection_id=$2 AND e.entity_type='product_publish'
        AND e.payload->>'__catalogueRunId'=$3 ORDER BY e.created_at DESC LIMIT 500`,
    [scope.businessId, connectionId, runId]);
  return rows;
}
