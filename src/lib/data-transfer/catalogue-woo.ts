import { createHash } from "node:crypto";
import { query, withTenantTransaction } from "../db";
import { canPublishOutbound } from "../import-reconciliation/lifecycle";
import { normalizeSkuKey } from "../import-reconciliation/normalize";
import { listItems, ReconciliationError } from "../import-reconciliation/service";
import { wooClientFor, type ConnectionRow } from "../integrations/connections-service";
import { pluginSupportsJobType } from "../integrations/plugin-capabilities";
import { publicationRemoteId } from "../integrations/product-publication";
import { publicationStores, queueProductPublication, type PublicationPreview } from "../integrations/product-publication-service";
import { cataloguePluginReviewSchema } from "../integrations/catalogue-plugin-review";
import { catalogueTermSlug } from "../integrations/catalogue-publication-taxonomies";
import { listTerms } from "../integrations/woo-taxonomy-service";
import { buildMappedWooAttributes } from "../integrations/product-attribute-mappings-service";
import { inferWooProductType, wooVariationAttributes } from "../integrations/woo-catalogue";
import { attributeComparisonKey } from "../product-attributes";
import type { CatalogueRecord } from "./catalogue-plan";
import { catalogueSummary, type CatalogueOwner } from "./catalogue-service";

type Remote = {
  id: string; sku: string; name: string; type: string; parent: string | null;
  linkedTo?: string; categories?: { id: number; name: string; slug: string }[];
};

export function resolveWooCatalogueAction(
  sku: string, type: string, localId: string | null, matches: Remote[],
) {
  const mapped = localId ? matches.filter(m => m.linkedTo === localId) : [];
  if (mapped.length > 1) return { action: "conflict" as const, remote: null };
  const candidates = matches.filter(m => normalizeSkuKey(m.sku) === sku);
  const preferred = mapped[0];
  if (preferred && !candidates.some(m => m.id === preferred.id)) return { action: "conflict" as const, remote: null };
  if (candidates.length === 0) return { action: "draft" as const, remote: null };
  if (candidates.length !== 1 || candidates[0].type !== type || candidates[0].parent ||
      (candidates[0].linkedTo && candidates[0].linkedTo !== localId)) {
    return { action: "conflict" as const, remote: null };
  }
  return { action: preferred ? "linked" as const : "link" as const, remote: candidates[0] };
}

const specFields = {
  case_dimension: "case-dimension", case_material: "case-material", band_material: "band-material",
  band_color: "band-color", drive: "movement", face: "dial-color", lock_type: "clasp-type",
  case_color: "case-color", case_form: "case-shape",
} as const;

async function checkStore(owner: CatalogueOwner, connection: ConnectionRow) {
  if (!(await publicationStores(owner.businessId, owner.locationId)).some(store => store.id === connection.id)) {
    throw new ReconciliationError("catalogue_store_unavailable");
  }
  if (connection.link_mode === "plugin" && !pluginSupportsJobType(connection.plugin_capabilities, "product_publish")) {
    throw new ReconciliationError("catalogue_plugin_update_required");
  }
}

async function pluginDiscovery(owner: CatalogueOwner, connection: ConnectionRow, runId: string, itemId: number,
  request: Record<string, unknown>, allowProbe: boolean) {
  const key = `catalogue-review:${runId}:${itemId}`;
  const { rows } = await query<{ status: string; current: boolean; payload: { discovery?: unknown } }>(
    `SELECT status, sent_at > now() - interval '5 minutes' AS current, payload
     FROM integration_outbox_events WHERE business_id=$1 AND connection_id=$2
       AND entity_type='catalogue_product_review' AND remote_id=$3`, [owner.businessId, connection.id, key],
  );
  const last = rows[0];
  if (last?.status === "sent" && last.current) return cataloguePluginReviewSchema.parse(last.payload.discovery);
  if (allowProbe && (!last || ["sent", "dead", "needs_review", "skipped"].includes(last.status))) {
    await query(`INSERT INTO integration_outbox_events (business_id,connection_id,entity_type,remote_id,payload,operation_id)
      VALUES ($1,$2,'catalogue_product_review',$3,$4,$3) ON CONFLICT (connection_id,entity_type,remote_id) DO UPDATE
       SET payload=EXCLUDED.payload,status='pending',attempts=0,last_error=NULL,sent_at=NULL,next_attempt_at=now(),updated_at=now()
       WHERE integration_outbox_events.status IN ('sent','dead','needs_review','skipped')
         AND (integration_outbox_events.status <> 'sent' OR integration_outbox_events.sent_at <= now()-interval '5 minutes')`,
      [owner.businessId, connection.id, key, JSON.stringify(request)]);
  }
  throw new ReconciliationError("catalogue_woo_discovery_pending");
}

export async function previewCatalogueWoo(owner: CatalogueOwner, runId: string, itemId: number, connection: ConnectionRow, allowProbe = true) {
  const { run } = await catalogueSummary(owner, runId);
  await checkStore(owner, connection);
  const [item] = await listItems(owner.businessId, runId, { afterId: itemId - 1, limit: 1 });
  if (!item || item.id !== itemId || item.outcome === "invalid" || item.status === "skipped") {
    throw new ReconciliationError("item_not_found");
  }
  const record = item.snapshot as CatalogueRecord;
  if (!record.sku) throw new ReconciliationError("catalogue_missing_sku");
  const type = record.family ? "variable" : "simple";
  const localId = item.resolvedCanonicalId ?? item.canonicalId;
  const { rows: mappings } = await query<{
    remote_id: string; local_id: string; name: string; sku: string | null; kind: string;
    woo_type: string | null; parent: string | null; missing: boolean;
  }>(
    `SELECT m.remote_id, m.local_id, i.name, COALESCE(m.last_pushed_payload->>'remoteSku',i.sku) AS sku, i.kind,
       m.last_pushed_payload->>'wooType' AS woo_type, m.last_pushed_payload->>'remoteParentId' AS parent,
       COALESCE(m.last_pushed_payload->>'remoteMissing','false')='true' AS missing
     FROM integration_mappings m JOIN items i ON i.id=m.local_id
     WHERE m.business_id=$1 AND m.connection_id=$2 AND m.entity_type='product'`,
    [owner.businessId, connection.id],
  );
  const client = connection.link_mode === "rest_api" ? wooClientFor(connection) : null;
  const values = record.catalogue.values;
  const specs = record.family ? [] : Object.entries(specFields).flatMap(([key, slug]) => {
    const field = key as keyof typeof specFields;
    const value = field === "drive" ? record.catalogue.movement :
      field === "case_dimension" ? record.catalogue.dimensions?.join(" × ") : values[field];
    return value ? [{ field, slug, value }] : [];
  });
  const livePlugin = connection.link_mode === "plugin" && pluginSupportsJobType(connection.plugin_capabilities, "catalogue_product_review");
  const plugin = livePlugin ? await pluginDiscovery(owner, connection, runId, itemId, {
    sku: record.sku, category: values.collection, brand: values.brand, specs,
  }, allowProbe) : null;
  const byRemote = new Map(mappings.map(mapping => [mapping.remote_id, mapping.local_id]));
  const matches: Remote[] = client
    ? (await client.listProducts({ sku: record.sku, per_page: 100 })).map(remote => ({
        id: String(remote.id), sku: remote.sku, type: inferWooProductType(remote), name: remote.name,
        parent: remote.parent_id ? String(remote.parent_id) : null, categories: remote.categories, linkedTo: byRemote.get(String(remote.id)),
      }))
    : plugin
      ? plugin.matches.map(remote => ({ ...remote, id: String(remote.id), parent: remote.parent ? String(remote.parent) : null, linkedTo: byRemote.get(String(remote.id)) }))
      : mappings.filter(mapping => !mapping.missing).map(mapping => ({
          id: mapping.remote_id, sku: mapping.sku ?? "", name: mapping.name, parent: mapping.parent,
          type: mapping.woo_type ?? (mapping.kind === "variant_parent" ? "variable" : "simple"), linkedTo: mapping.local_id,
        }));
  const missingMapping = Boolean(localId && mappings.some(m => m.local_id === localId && !matches.some(remote => remote.id === m.remote_id)));
  let identity = missingMapping ? { action: "conflict" as const, remote: null } :
    resolveWooCatalogueAction(record.sku, type, localId, matches);
  const variations: { sku: string; id: string; remoteSku: string; options: { name: string; option: string }[] }[] = [];
  if (record.family && identity.remote && identity.action === "link") {
    const remoteParent = Number(identity.remote.id);
    const remoteVariations = client ? await client.listVariations(remoteParent, { per_page: 100, page: 1 }) : [];
    const hasMore = remoteVariations.length === 100 && client &&
      (await client.listVariations(remoteParent, { per_page: 100, page: 2 })).length > 0;
    const children = plugin?.variations ?? remoteVariations.map(variation => ({
      ...variation, parent: variation.parent_id, options: wooVariationAttributes(variation),
    }));
    if (!hasMore && children.length === record.family.children.length) {
      for (const row of record.family.children) {
        const candidates = children.filter(child => normalizeSkuKey(child.sku) === row.sku && child.parent === remoteParent);
        if (candidates.length !== 1) continue;
        const child = candidates[0];
        const options = child.options;
        if (options.length !== 1 || attributeComparisonKey(options[0].name) !== attributeComparisonKey(record.family.axis) ||
            attributeComparisonKey(options[0].option) !== attributeComparisonKey(row.values.option!)) continue;
        variations.push({ sku: row.sku!, id: String(child.id), remoteSku: child.sku, options });
      }
    }
    if (variations.length !== record.family.children.length) identity = { action: "conflict", remote: null };
  }
  const terms = await listTerms(owner.businessId, connection.id);
  const categories = client ? await client.listCategories() : plugin?.categories ??
    terms.filter(term => term.taxonomy === "product_cat").map(term => ({ id: Number(term.remoteId), name: term.name, slug: term.slug }));
  const categoryMatches = values.collection ? categories.filter(term => attributeComparisonKey(term.name) === attributeComparisonKey(values.collection!)) : [];
  const availableBrands = plugin?.brands ?? terms.filter(term => term.taxonomy === "product_brand")
    .map(term => ({ id: Number(term.remoteId), name: term.name, slug: term.slug }));
  const brands = values.brand ? availableBrands.filter(term => attributeComparisonKey(term.name) === attributeComparisonKey(values.brand!)) : [];
  const global = specs.length && client ? await client.listAttributes() : plugin?.attributes ?? [];
  const attributes = [];
  for (const spec of specs) {
    const matching = global.filter(attr => attr.slug.replace(/^pa_/, "") === spec.slug ||
      attributeComparisonKey(attr.name) === attributeComparisonKey(spec.field));
    const attribute = matching.length === 1 ? matching[0] : null;
    const available = attribute ? (client ? await client.listAttributeTerms(attribute.id) :
      plugin?.attributes.find(entry => entry.id === attribute.id)?.terms ?? []) : [];
    const candidates = available.filter(term => attributeComparisonKey(term.name) === attributeComparisonKey(spec.value));
    attributes.push({ ...spec, attributeId: attribute?.id ?? null, conflict: matching.length > 1 || candidates.length > 1,
      term: candidates.length === 1 ? { id: candidates[0].id, name: candidates[0].name, slug: candidates[0].slug } : null });
  }
  const matchesToReview = matches.filter(m => normalizeSkuKey(m.sku) === record.sku || (localId && m.linkedTo === localId));
  const preview = {
    ...identity,
    matches: matchesToReview.sort((a, b) => a.id.localeCompare(b.id)),
    discovery: client || plugin ? "live" as const : "mirror" as const,
    category: { value: values.collection ?? null, choices: categoryMatches },
    brand: { value: values.brand ?? null, choices: brands },
    attributes,
    variations,
  };
  const token = createHash("sha256").update(JSON.stringify({
    runId, itemId, fingerprint: run.sourceFingerprint, connectionId: connection.id, preview,
  })).digest("hex");
  return { ...preview, token };
}

export async function queueCatalogueWoo(owner: CatalogueOwner, runId: string, itemId: number, connection: ConnectionRow, input: {
  token: string; categoryId?: number; brandId?: number; createMissing: boolean; acceptMirror: boolean;
}) {
  const preview = await previewCatalogueWoo(owner, runId, itemId, connection, false);
  if (input.token !== preview.token) throw new ReconciliationError("catalogue_woo_preview_changed");
  if (preview.action === "conflict" || preview.action === "linked") throw new ReconciliationError("catalogue_woo_review_required");
  if (preview.discovery === "mirror" && !input.acceptMirror) throw new ReconciliationError("catalogue_woo_mirror_unverified");
  const category = preview.category.choices.find(term => term.id === input.categoryId);
  const brand = preview.brand.choices.find(term => term.id === input.brandId);
  if ((input.categoryId && !category) || (input.brandId && !brand)) throw new ReconciliationError("catalogue_woo_taxonomy_changed");

  return withTenantTransaction(owner.businessId, async () => {
    const { run } = await catalogueSummary(owner, runId);
    const [item] = await listItems(owner.businessId, runId, { afterId: itemId - 1, limit: 1 });
    const localId = item?.resolvedCanonicalId;
    if (!localId || item.id !== itemId || !canPublishOutbound({
      runStatus: run.status, itemStatus: item.status, mappingCommitted: true, ownershipConfirmed: true,
    })) throw new ReconciliationError("catalogue_local_apply_required");
    const record = item.snapshot as CatalogueRecord;
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`woo-publication:${connection.id}:${localId}`]);
    const { rows: mapped } = await query(
      `SELECT 1 FROM integration_mappings WHERE business_id=$1 AND connection_id=$2 AND entity_type='product'
        AND (local_id=$3 OR remote_id=$4)`,
      [owner.businessId, connection.id, localId, preview.remote?.id ?? ""],
    );
    if (mapped.length) throw new ReconciliationError("catalogue_woo_review_required");
    const { rows: existing } = await query<{ remote_id: string; payload: Record<string, unknown> }>(
      `SELECT remote_id,payload FROM integration_outbox_events WHERE business_id=$1 AND connection_id=$2
        AND local_id=$3 AND entity_type='product_publish' AND status NOT IN ('sent','skipped') LIMIT 1`,
      [owner.businessId, connection.id, localId],
    );
    if (existing[0]) {
      if (existing[0].payload.__catalogueRun === runId && existing[0].payload.__catalogueToken === input.token) return existing[0].remote_id;
      throw new ReconciliationError("catalogue_woo_already_queued");
    }
    const payload: Record<string, unknown> = {
      __catalogueRun: runId, __catalogueItem: itemId, __catalogueToken: input.token,
      __catalogueMetadataOnly: true, __localId: localId,
      __wooType: record.family ? "variable" : "simple",
      sku: preview.remote?.sku ?? record.sku,
    };
    if (preview.remote) {
      // Link-only ACK preserves store-owned presentation and taxonomy.
      payload.__linkOnly = true;
      payload.__targetRemoteId = publicationRemoteId(preview.remote.id);
    } else {
      Object.assign(payload, { name: record.name, type: payload.__wooType, status: "draft" });
      if (preview.discovery === "mirror" && (category || brand || input.createMissing)) {
        throw new ReconciliationError("catalogue_woo_plugin_taxonomy_unavailable");
      }
      if (category) payload.__catalogueCategory = category;
      else if (input.createMissing && preview.category.value && preview.category.choices.length === 0) {
        payload.__catalogueCategory = { id: null, name: preview.category.value, slug: catalogueTermSlug(preview.category.value) };
      }
      if (brand) payload.__catalogueBrand = brand;
      payload.__catalogueAllowCreate = input.createMissing;
      if (!record.family && preview.discovery === "live") {
        payload.__catalogueAttributes = preview.attributes.filter(a => !a.conflict && ((a.attributeId && a.term) || input.createMissing))
          .map(a => ({ ...a, termSlug: catalogueTermSlug(a.value) }));
        payload.__catalogueAllowCreate = input.createMissing;
      }
    }
    if (record.family) {
      const { rows: children } = await query<{ id: string; sku: string }>(
        "SELECT id,sku FROM items WHERE parent_item_id=$1 AND location_id=$2 AND is_active ORDER BY id", [localId, owner.locationId],
      );
      if (children.length !== record.family.children.length) throw new ReconciliationError("catalogue_variant_identity_changed");
      if (!preview.remote) payload.attributes = await buildMappedWooAttributes(owner.businessId, connection, localId);
      const remoteChildIds = preview.variations.map(variation => variation.id);
      const { rows: mappedChildren } = await query(
        `SELECT 1 FROM integration_mappings WHERE business_id=$1 AND connection_id=$2 AND entity_type='product'
         AND (local_id=ANY($3::uuid[]) OR remote_id=ANY($4::text[]))`,
        [owner.businessId, connection.id, children.map(child => child.id), remoteChildIds],
      );
      if (mappedChildren.length) throw new ReconciliationError("catalogue_woo_review_required");
      payload.__children = await Promise.all(children.map(async child => {
        const sku = normalizeSkuKey(child.sku);
        if (!record.family!.children.some(row => row.sku === sku)) throw new ReconciliationError("catalogue_variant_identity_changed");
        const target = preview.variations.find(variation => variation.sku === sku);
        const base = { __catalogueRun: runId, __catalogueItem: itemId, __catalogueMetadataOnly: true,
          __localId: child.id, __wooType: "variation", sku: target?.remoteSku ?? child.sku };
        if (preview.remote) {
          if (!target) throw new ReconciliationError("catalogue_woo_existing_family_review");
          return { ...base, __targetRemoteId: publicationRemoteId(target.id), __linkOnly: true, __catalogueVariationOptions: target.options };
        }
        return { ...base, status: "draft", attributes: await buildMappedWooAttributes(owner.businessId, connection, child.id) };
      }));
    }
    const reviewToken = createHash("sha256").update(JSON.stringify({ token: input.token, categoryId: input.categoryId, brandId: input.brandId, createMissing: input.createMissing })).digest("hex");
    const publication: PublicationPreview = { connectionId: connection.id, storeName: connection.name, localId,
      name: record.name ?? record.sku ?? "", action: preview.action, reviewToken, payload };
    await queueProductPublication(owner.businessId, publication);
    return `publication:${connection.id}:${localId}:${reviewToken}`;
  });
}

export async function catalogueWooStatus(owner: CatalogueOwner, runId: string, connectionId: string) {
  await catalogueSummary(owner, runId);
  const { rows } = await query<{
    item: string; operation: string; status: string; remote: string | null; error: string | null;
    expected_children: number; attributes: unknown;
  }>(
    `SELECT payload->>'__catalogueItem' AS item, remote_id AS operation, status,
      CASE WHEN status='sent' THEN payload->>'__ackRemoteId' END AS remote, last_error AS error,
      jsonb_array_length(COALESCE(payload->'__children','[]'::jsonb)) AS expected_children,
      CASE WHEN status='sent' THEN payload->'__catalogueTaxonomyAck' END AS attributes
     FROM integration_outbox_events WHERE business_id=$1 AND connection_id=$2 AND entity_type='product_publish'
       AND payload->>'__catalogueRun'=$3 ORDER BY id`, [owner.businessId, connectionId, runId],
  );
  return rows;
}
