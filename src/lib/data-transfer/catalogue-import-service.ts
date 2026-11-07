import { query, withTenantTransaction, type PoolClient } from "../db";
import { createBrand, listBrands, updateItemProfile } from "../item-brands-service";
import { createItem, createVariantChild, listVariantAttributes, updateItemMeta } from "../items-service";
import { listAttributeDefinitions } from "../product-attributes-service";
import { upsertWatchAttributes, type WatchItemAttributesInput } from "../watch-attributes-service";
import { DEFAULT_FIELD_AUTHORITY_POLICY } from "../import-reconciliation/field-authority";
import { normalizeNameKey, normalizeSkuKey } from "../import-reconciliation/normalize";
import { planProducts, recordFingerprint } from "../import-reconciliation/plan";
import {
  applyRun, completeDiscovery, createProductApplyHandler, crossCheckRun, getRunSummary,
  listItems, loadProductContext, openRun, productCanonicalToken, ReconciliationError, stagePlannedItems,
  type Actor, type ApplyContext,
} from "../import-reconciliation/service";
import type { IncomingProduct } from "../import-reconciliation/types";
import { catalogueRecords, type CatalogueMapping, type CatalogueTarget, type readCatalogueWorkbook } from "./catalogue-workbook";

export const CATALOGUE_PROFILE = "accounting.catalogue.xlsx";

export type CatalogueScope = {
  businessId: string;
  locationId: string;
  target: CatalogueTarget;
  actor: Actor;
};

export async function stageCatalogue(
  scope: CatalogueScope,
  sheet: Awaited<ReturnType<typeof readCatalogueWorkbook>>,
  mapping: CatalogueMapping,
  fileName: string,
  source: string,
  fixedBrand?: string,
) {
  const { businessId, locationId, actor, target } = scope;
  const { records, counts, duplicateRows } = catalogueRecords(sheet, mapping, target, fixedBrand);
  const sourceName = normalizeNameKey(source);
  if (!sourceName || sourceName.length > 120) throw new ReconciliationError("catalogue_invalid_source");
  const sourceKey = `catalogue-xlsx:${locationId}:${sourceName}`;

  return withTenantTransaction(businessId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`catalogue-import:${locationId}`]);
    const run = await openRun({
      businessId, locationId, actor, sourceKey, sourceKind: "file", provider: "xlsx",
      domain: "product", importMode: "one_time", sourceFingerprint: sheet.fingerprint,
      profileKey: CATALOGUE_PROFILE, profileVersion: 1,
      scope: { target },
      evidence: { fileName: fileName.slice(0, 300), worksheet: sheet.name, columns: sheet.columns, mapping, sourceName, fixedBrand, counts, duplicateRows },
    });
    const canonicalToken = await productCanonicalToken(client, run);
    const { ctx } = await loadProductContext(client, run, records);
    const duplicateSkus = new Set(duplicateRows.map(([sku]) => sku));
    const options = { policy: DEFAULT_FIELD_AUTHORITY_POLICY, readCanonical: (id: string) => ctx.canonicalById.get(id)?.fields ?? null };
    const planned = planProducts(records, ctx, options);

    for (const [index, plan] of planned.entries()) {
      const record = records[index];
      const errors = record.fields?.errors as string[];
      const duplicate = record.sku && duplicateSkus.has(record.sku);
      if (duplicate || !record.sku) {
        plan.externalKey = `row:${record.rowNumber}`;
        plan.fingerprint = recordFingerprint(record);
      }
      const candidates = record.sku ? ctx.candidatesBySku.get(record.sku) ?? [] : [];
      const eligible = [];
      for (const candidate of candidates) {
        if (await compatibleProduct(client, locationId, record, candidate.id)) eligible.push(candidate);
      }
      const linked = plan.resolution.canonicalId;
      const verified = plan.resolution.outcome === "already_linked";
      if (errors.length || (verified && (!linked || !await compatibleProduct(client, locationId, record, linked)))) {
        plan.resolution = { ...plan.resolution, outcome: "invalid", reasons: [errors.length ? "missing_identity" : "identifier_conflict"], candidates: [], canonicalId: null };
      } else if (duplicate || candidates.length || plan.resolution.outcome === "ambiguous") {
        const offered = verified && linked ? eligible.filter((candidate) => candidate.id === linked) : eligible;
        if (!duplicate && verified) continue;
        plan.resolution = {
          ...plan.resolution,
          outcome: duplicate || candidates.length !== 1 || offered.length !== 1 ? "ambiguous" : "safe_match",
          reasons: duplicate ? ["duplicate_in_source"] : plan.resolution.reasons,
          canonicalId: offered.length === 1 ? offered[0].id : null,
          candidates: offered.map((candidate) => ({ id: candidate.id, label: candidate.name })),
        };
      }
    }
    for (let offset = 0; offset < planned.length; offset += 100) {
      await stagePlannedItems(businessId, run.id, planned.slice(offset, offset + 100));
    }
    return completeDiscovery({ businessId, runId: run.id, actor, canonicalCount: 1, canonicalToken });
  }, { locationId });
}

async function compatibleProduct(client: PoolClient, locationId: string, record: IncomingProduct, id: string) {
  const { rows } = await client.query<{
    kind: string; tracking: string; sku: string | null; unit: string | null; parent_sku: string | null;
  }>(`SELECT i.kind, i.tracking, i.sku, i.unit, p.sku AS parent_sku FROM items i
        LEFT JOIN items p ON p.id=i.parent_item_id AND p.location_id=i.location_id AND p.is_active
       WHERE i.id=$1 AND i.location_id=$2 AND i.is_active`, [id, locationId]);
  const item = rows[0];
  if (!item || item.kind !== record.kind || item.tracking !== record.tracking ||
      normalizeSkuKey(item.sku) !== record.sku || (record.unit && normalizeNameKey(item.unit) !== normalizeNameKey(record.unit))) return false;
  if (record.kind !== "variant_child") return true;
  if (normalizeSkuKey(item.parent_sku) !== record.parentExternalId) return false;
  const options = await listVariantAttributes(id);
  const expected = Object.entries(record.variantOptions ?? {});
  return options.length === expected.length && expected.every(([name, value]) =>
    options.some((option) => normalizeNameKey(option.name) === name && normalizeNameKey(option.value) === value));
}

export async function getCatalogueRun(scope: CatalogueScope, runId: string) {
  const summary = await getRunSummary(scope.businessId, runId);
  if (summary.run.locationId !== scope.locationId || summary.run.profileKey !== CATALOGUE_PROFILE ||
      summary.run.scope.target !== scope.target) throw new ReconciliationError("catalogue_run_not_found");
  return summary;
}

export async function listCatalogueRuns(scope: CatalogueScope) {
  const { rows } = await query<{ id: string; file_name: string; status: string }>(
    `SELECT id, evidence->>'fileName' AS file_name, status FROM import_reconciliation_runs
      WHERE business_id=$1 AND location_id=$2 AND profile_key=$3 AND scope->>'target'=$4
      ORDER BY created_at DESC LIMIT 30`, [scope.businessId, scope.locationId, CATALOGUE_PROFILE, scope.target]);
  return rows;
}

export async function catalogueReport(scope: CatalogueScope, runId: string) {
  const { run } = await getCatalogueRun(scope, runId);
  const { rows } = await query<{
    row_number: number; sku: string; status: string; outcome: string; reasons: string[];
    warnings: string[]; error: string | null;
  }>(`SELECT row_number, snapshot->>'sku' AS sku, status, outcome, reasons,
           snapshot->'fields'->'warnings' AS warnings, error
      FROM import_reconciliation_items WHERE business_id=$1 AND run_id=$2 ORDER BY row_number`, [scope.businessId, run.id]);
  return rows;
}

async function createCatalogueProduct(ctx: ApplyContext) {
  const record = ctx.item.snapshot as IncomingProduct;
  const { locationId } = ctx.run;
  if (!locationId || !record.name || !record.sku) throw new ReconciliationError("catalogue_invalid_identity");
  const { ctx: current } = await loadProductContext(ctx.client, ctx.run, [record]);
  if ((current.candidatesBySku.get(record.sku)?.length ?? 0) > 0 || current.mappings.has(record.sku)) {
    throw new ReconciliationError("catalogue_sku_collision");
  }
  const item = record.kind === "variant_child"
    ? await createCatalogueVariant(ctx, record, locationId)
    : await createItem({ locationId, name: record.name, sku: record.sku, tracking: record.tracking === "serial" ? "serial" : "none" }, ctx.client);

  const brandName = String(record.fields?.brand ?? "");
  const collection = String(record.fields?.collection ?? "");
  const brands = brandName ? (await listBrands(locationId)).filter((brand) =>
    normalizeNameKey(brand.name) === normalizeNameKey(brandName)) : [];
  if (brands.length > 1) throw new ReconciliationError("catalogue_brand_conflict");
  const brand = brands[0] ?? (brandName ? await createBrand(locationId, { name: brandName }) : null);
  await updateItemProfile(item.id, { brandId: brand?.id, collection }, ctx.client);
  await updateItemMeta(item.id, { publishStatus: "draft" }, ctx.client);
  if (record.tracking === "serial") {
    await upsertWatchAttributes(item.id, record.fields?.watch as WatchItemAttributesInput);
  }
  return { canonicalId: item.id };
}

async function createCatalogueVariant(ctx: ApplyContext, record: IncomingProduct, locationId: string) {
  const parentSku = record.parentExternalId!;
  const [[optionName, optionValue]] = Object.entries(record.variantOptions ?? {});
  const definitions = (await listAttributeDefinitions(locationId)).filter((definition) =>
    definition.isActive && normalizeNameKey(definition.name) === optionName);
  const definition = definitions[0];
  const value = definition?.options.find((option) => normalizeNameKey(option) === optionValue);
  if (definitions.length !== 1 || !value) throw new ReconciliationError("catalogue_variant_definition_required");

  const { ctx: parents } = await loadProductContext(ctx.client, ctx.run, [{ domain: "product", externalId: null, name: null, sku: parentSku }]);
  const hits = parents.candidatesBySku.get(parentSku) ?? [];
  if (hits.length > 1 || hits.some((parent) => !parent.isActive || parent.kind !== "variant_parent" || parent.tracking !== "none")) {
    throw new ReconciliationError("catalogue_variant_parent_conflict");
  }
  let parentId = hits[0]?.id;
  if (!parentId) {
    const parentName = String(record.fields?.parentTitle ?? "");
    if (!parentName) throw new ReconciliationError("catalogue_variant_parent_title_required");
    const parent = await createItem({ locationId, sku: parentSku, name: parentName, kind: "variant_parent" }, ctx.client);
    parentId = parent.id;
    await updateItemMeta(parent.id, { isSellable: false, publishStatus: "draft" }, ctx.client);
  }
  const { rows } = await query<{ name: string; value: string; definition_id: string | null }>(
    `SELECT a.name, a.value, a.attribute_definition_id AS definition_id FROM item_variant_attributes a
      JOIN items i ON i.id=a.item_id WHERE i.parent_item_id=$1 AND i.location_id=$2`, [parentId, locationId]);
  if (rows.some((row) => row.definition_id !== definition.id || normalizeNameKey(row.value) === optionValue)) {
    throw new ReconciliationError("catalogue_variant_combination_conflict");
  }
  return createVariantChild(parentId, locationId, record.name!, record.sku!,
    [{ name: definition.name, value, definitionId: definition.id }], ctx.client);
}

export async function applyCatalogue(scope: CatalogueScope, runId: string) {
  const { businessId, locationId, actor } = scope;
  const result = await withTenantTransaction(businessId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`catalogue-import:${locationId}`]);
    const { run } = await getCatalogueRun(scope, runId);
    if (run.status === "applied") return getRunSummary(businessId, runId);
    const { rows: collisions } = await client.query(`SELECT 1 FROM import_reconciliation_items
      WHERE run_id=$1 AND status IN ('approved','applied') AND snapshot->>'sku' IS NOT NULL
      GROUP BY snapshot->>'sku' HAVING count(*)>1 LIMIT 1`, [run.id]);
    if (collisions.length) throw new ReconciliationError("catalogue_choose_one_duplicate");
    const handler = createProductApplyHandler({ create: createCatalogueProduct });
    const reviewed = async (ctx: ApplyContext, effect: "link" | "create") => {
      const record = ctx.item.snapshot as IncomingProduct;
      if (!record.sku) throw new ReconciliationError("catalogue_invalid_identity");
      if (effect === "link" && (!ctx.canonicalId || !await compatibleProduct(ctx.client, locationId, record, ctx.canonicalId))) {
        throw new ReconciliationError("catalogue_mapping_conflict");
      }
      const operation = effect === "link" ? handler.link : handler.create!;
      return operation({ ...ctx, item: { ...ctx.item, externalKey: record.sku } });
    };
    const applied = await applyRun({
      businessId, runId, actor,
      current: { sourceFingerprint: run.sourceFingerprint, policyVersion: DEFAULT_FIELD_AUTHORITY_POLICY.version, canonicalToken: await productCanonicalToken(client, run) },
      handler: { domain: "product", link: (ctx) => reviewed(ctx, "link"), create: (ctx) => reviewed(ctx, "create") },
    }).catch((error: unknown) => {
      // Preserve the shared engine's stale transition when it declines apply.
      if (error instanceof ReconciliationError && error.code === "preview_stale") return error;
      throw error;
    });
    if (applied instanceof ReconciliationError) return applied;
    if (applied.run.status === "applied") await crossCheckRun(businessId, runId);
    if (applied.run.status === "partially_applied") await client.query(
      "UPDATE import_reconciliation_runs SET canonical_token=$2 WHERE id=$1 AND business_id=$3",
      [runId, await productCanonicalToken(client, run), businessId]);
    return getRunSummary(businessId, runId);
  }, { locationId });
  if (result instanceof ReconciliationError) throw result;
  return result;
}

export async function cataloguePage(scope: CatalogueScope, runId: string, search?: string, afterId?: number) {
  const summary = await getCatalogueRun(scope, runId);
  return { ...summary, items: await listItems(scope.businessId, runId, { limit: 25, search, afterId }) };
}
