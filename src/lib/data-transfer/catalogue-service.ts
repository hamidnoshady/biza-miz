import { createHash } from "node:crypto";
import { query, withTenantTransaction, type PoolClient } from "../db";
import { createItem, updateItemMeta } from "../items-service";
import { assignBarcode } from "../item-barcodes-service";
import { createBrand, listBrands, updateItemProfile } from "../item-brands-service";
import { createProductRecord } from "../product-creation-service";
import { parseProductCreateInput } from "../product-input";
import { upsertWatchAttributes } from "../watch-attributes-service";
import { attributeComparisonKey } from "../product-attributes";
import { DEFAULT_FIELD_AUTHORITY_POLICY } from "../import-reconciliation/field-authority";
import { normalizeSkuKey } from "../import-reconciliation/normalize";
import { planProducts } from "../import-reconciliation/plan";
import {
  applyRun, approveSafeBatch, completeDiscovery, createProductApplyHandler, crossCheckRun,
  decideItem, getRunSummary, linkSourceIdentity, listItems, loadProductContext, openRun,
  productCanonicalToken, ReconciliationError, revalidateRun, stagePlannedItems,
  type Actor, type ApplyContext, type ReconciliationRun, type StagedItem,
} from "../import-reconciliation/service";
import { catalogueRecords, type CatalogueRecord } from "./catalogue-plan";
import { parseCatalogueRows, type CatalogueMapping, type CatalogueRow, type CatalogueSheet, type CatalogueTarget } from "./catalogue-profile";

import { CATALOGUE_PROFILE, lockCatalogueBranch } from "./catalogue-gate";
const VERSION = 1;

export interface CatalogueOwner {
  businessId: string;
  locationId: string;
  target: CatalogueTarget;
  actor: Actor;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function catalogueToken(client: PoolClient, run: ReconciliationRun) {
  const { rows } = await client.query(
    "SELECT id, version, is_active FROM item_attribute_definitions WHERE location_id=$1 ORDER BY id",
    [run.locationId],
  );
  return digest([await productCanonicalToken(client, run), rows]);
}

export async function catalogueRuns(owner: CatalogueOwner) {
  const { rows } = await query<{
    id: string; status: string; evidence: { fileName: string; mapping: CatalogueMapping; columns: string[]; sourceName: string };
  }>(`SELECT id, status, evidence FROM import_reconciliation_runs WHERE business_id=$1 AND location_id=$2
      AND profile_key=$3 AND scope->>'target'=$4 ORDER BY created_at DESC LIMIT 30`,
    [owner.businessId, owner.locationId, CATALOGUE_PROFILE, owner.target]);
  return rows;
}

export async function catalogueSummary(owner: CatalogueOwner, runId: string) {
  const summary = await getRunSummary(owner.businessId, runId);
  if (summary.run.locationId !== owner.locationId || summary.run.profileKey !== CATALOGUE_PROFILE ||
      summary.run.scope.target !== owner.target) throw new ReconciliationError("run_not_found");
  return summary;
}

export async function catalogueItems(owner: CatalogueOwner, runId: string) {
  await catalogueSummary(owner, runId);
  const items: StagedItem[] = [];
  for (;;) {
    const batch = await listItems(owner.businessId, runId, { afterId: items.at(-1)?.id, limit: 500 });
    items.push(...batch);
    if (batch.length < 500) return items;
  }
}

function childRecords(record: CatalogueRecord): CatalogueRecord[] {
  return (record.family?.children ?? []).map(row => ({
    domain: "product", externalId: `sku:${row.sku}`, sku: row.sku,
    name: row.title, kind: "variant_child", tracking: "none",
    barcodes: row.values.barcode ? [row.values.barcode] : [],
    parentExternalId: record.externalId, variantOptions: { [record.family!.axis]: row.values.option! },
    catalogue: row,
  }));
}

async function familyLinks(client: PoolClient, run: ReconciliationRun, parent: CatalogueRecord, canonicalId: string) {
  const children = childRecords(parent);
  const { ctx } = await loadProductContext(client, run, children);
  const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE parent_item_id=$1 AND location_id=$2 AND is_active ORDER BY id", [canonicalId, run.locationId]);
  if (rows.length !== children.length) return null;
  const links = children.map(child => {
    const candidates = ctx.candidatesBySku.get(child.sku!) ?? [];
    if (candidates.length !== 1) return null;
    const target = candidates[0];
    const mapped = ctx.mappings.get(child.externalId!);
    const variants = Object.entries(target.variantOptions ?? {});
    const [name, option] = variants[0] ?? [];
    if ((mapped && mapped !== target.id) || !rows.some(row => row.id === target.id) ||
        target.kind !== "variant_child" || target.tracking !== "none" || !target.isActive ||
        variants.length !== 1 || attributeComparisonKey(name ?? "") !== attributeComparisonKey(parent.family!.axis) ||
        attributeComparisonKey(option ?? "") !== attributeComparisonKey(child.catalogue.values.option!) ||
        (child.barcodes?.length && !child.barcodes.every(code => target.barcodes.includes(code)))) return null;
    return { child, id: target.id };
  });
  return links.every(link => link !== null) ? links : null;
}

export async function stageCatalogue(owner: CatalogueOwner, input: {
  sheet: CatalogueSheet; mapping: CatalogueMapping; fileName: string; sourceName: string; fingerprint: string;
  omax: boolean; duplicateRows: number[]; axis: string;
}) {
  const { rows, totals } = parseCatalogueRows(input.sheet, input.mapping, input.omax);
  const planned = catalogueRecords(rows, owner.target, new Set(input.duplicateRows), input.axis);
  return withTenantTransaction(owner.businessId, async client => {
    await lockCatalogueBranch(client, owner.locationId);
    const run = await openRun({
      ...owner, domain: "product", sourceKind: "file", provider: "xlsx",
      sourceKey: `xlsx:catalogue:${owner.locationId}:${attributeComparisonKey(input.sourceName)}`,
      importMode: "one_time", sourceFingerprint: input.fingerprint,
      profileKey: CATALOGUE_PROFILE, profileVersion: VERSION, scope: { target: owner.target },
      evidence: { fileName: input.fileName, sheet: input.sheet.name, columns: input.sheet.columns, mapping: input.mapping,
        sourceName: input.sourceName, omax: input.omax, axis: input.axis, totals },
    });
    const records = planned.map(entry => entry.record);
    const { ctx } = await loadProductContext(client, run, [...records, ...records.flatMap(childRecords)]);
    const canonicalToken = await catalogueToken(client, run);
    const items = planProducts(records, ctx, { policy: DEFAULT_FIELD_AUTHORITY_POLICY });
    for (const [i, item] of items.entries()) {
      const { record, invalid, skipped } = planned[i];
      const current = item.resolution;
      const mapped = ctx.mappings.get(record.externalId ?? "");
      const candidates = [];
      for (const candidate of current.candidates) {
        const target = ctx.canonicalById.get(candidate.id);
        if (!target?.isActive || target.kind !== record.kind || target.tracking !== record.tracking ||
            (mapped && mapped !== target.id) || normalizeSkuKey(target.sku) !== record.sku ||
            (record.family && !await familyLinks(client, run, record, target.id))) continue;
        candidates.push(candidate);
      }
      const children = childRecords(record);
      const childCollision = children.some(child => ctx.mappings.has(child.externalId!) ||
        ctx.candidatesBySku.has(child.sku!) ||
        child.barcodes?.some(code => ctx.candidatesByBarcode.has(code)));
      item.resolution = {
        ...current, candidates, canonicalId: candidates.some(c => c.id === current.canonicalId) ? current.canonicalId : null,
        outcome: skipped ? "skipped" : invalid || (current.candidates.length > 0 && candidates.length === 0)
          ? "invalid" : current.outcome === "create_new" && childCollision ? "invalid" : current.outcome,
      };
    }
    for (let i = 0; i < items.length; i += 100) await stagePlannedItems(owner.businessId, run.id, items.slice(i, i + 100));
    // Catalogue review always requires a separate confirmation, even in an empty branch.
    await completeDiscovery({ businessId: owner.businessId, runId: run.id, actor: owner.actor, canonicalCount: 1, canonicalToken });
    return run.id;
  });
}

async function applyProfile(ctx: ApplyContext, id: string, row: CatalogueRow) {
  const location = ctx.run.locationId!;
  let brandId: string | null = null;
  const brand = row.values.brand;
  if (brand) {
    const existing = (await listBrands(location)).find(entry => attributeComparisonKey(entry.name) === attributeComparisonKey(brand));
    brandId = (existing ?? await createBrand(location, { name: brand })).id;
  }
  if (brandId || row.values.collection) {
    await updateItemProfile(id, { brandId, collection: row.values.collection }, ctx.client);
  }
}

async function requireCreateIdentity(ctx: ApplyContext, record: CatalogueRecord) {
  const records = [record, ...childRecords(record)];
  const { ctx: matches } = await loadProductContext(ctx.client, ctx.run, records);
  if (records.some(row => matches.mappings.has(row.externalId!) || matches.candidatesBySku.has(row.sku!) ||
      row.barcodes?.some(code => matches.candidatesByBarcode.has(code)))) {
    throw new ReconciliationError("catalogue_identity_changed");
  }
}

async function createCatalogueItem(ctx: ApplyContext) {
  const record = ctx.item.snapshot as CatalogueRecord;
  const row = record.catalogue;
  const locationId = ctx.run.locationId!;
  await requireCreateIdentity(ctx, record);
  if (record.tracking === "serial") {
    const item = await createItem({ locationId, name: row.title, sku: record.sku, tracking: "serial" }, ctx.client);
    if (row.values.barcode) await assignBarcode(item.id, { code: row.values.barcode }, ctx.client);
    await updateItemMeta(item.id, { publishStatus: "draft" }, ctx.client);
    await upsertWatchAttributes(item.id, {
      referenceNo: row.sku, movement: row.movement, caseMaterial: row.values.case_material,
      caseDiameterMm: row.dimensions?.length === 1 ? row.dimensions[0] : null,
      caseDimensionsMm: row.dimensions, dialColor: row.values.face, braceletMaterial: row.values.band_material,
      braceletColor: row.values.band_color, claspType: row.values.lock_type, caseColor: row.values.case_color, caseShape: row.values.case_form,
    });
    await applyProfile(ctx, item.id, row);
    return { canonicalId: item.id };
  }
  const children = childRecords(record);
  const input = parseProductCreateInput({
    name: record.name, sku: record.sku, ...(record.family ? {} : { barcode: row.values.barcode }),
    publishStatus: "draft", variants: children.map(child => ({
      name: child.name, sku: child.sku, barcode: child.catalogue.values.barcode,
      attributes: [{ name: record.family!.axis, value: child.catalogue.values.option }],
    })),
  });
  if (!input.ok) throw new ReconciliationError("catalogue_product_invalid");
  const created = await createProductRecord(locationId, input.data, undefined, ctx.client);
  await applyProfile(ctx, created.item.id, row);
  for (const [index, child] of children.entries()) {
    const id = created.variants[index].id;
    await applyProfile(ctx, id, child.catalogue);
    await rememberChild(ctx, child, id);
  }
  return { canonicalId: created.item.id };
}

async function rememberChild(ctx: ApplyContext, child: CatalogueRecord, id: string) {
  await linkSourceIdentity(ctx.client, {
    businessId: ctx.run.businessId, domain: "product", sourceKey: ctx.run.sourceKey,
    provider: ctx.run.provider, externalType: "product", externalId: child.externalId!,
    canonicalType: "items", canonicalId: id, runId: ctx.run.id, linkedBy: ctx.actor.userId,
  });
}

export async function reviewCatalogueItem(owner: CatalogueOwner, runId: string, itemId: number,
  decision: "link" | "create_separate" | "skip" | "keep_for_review", canonicalId?: string) {
  await catalogueSummary(owner, runId);
  const [item] = await listItems(owner.businessId, runId, { afterId: itemId - 1, limit: 1 });
  if (item?.id !== itemId) throw new ReconciliationError("item_not_found");
  if (decision === "create_separate" && item.outcome !== "create_new") throw new ReconciliationError("catalogue_identity_conflict");
  return decideItem({ businessId: owner.businessId, runId, itemId, decision, canonicalId, actor: owner.actor });
}

export async function applyCatalogue(owner: CatalogueOwner, runId: string, approveSafe: boolean) {
  const result = await withTenantTransaction(owner.businessId, async client => {
    await lockCatalogueBranch(client, owner.locationId);
    const { run } = await catalogueSummary(owner, runId);
    if (run.status === "applied") return run.status;
    const current = {
      canonicalToken: await catalogueToken(client, run),
      sourceFingerprint: run.sourceFingerprint, policyVersion: DEFAULT_FIELD_AUTHORITY_POLICY.version,
    };
    const maxPreviewAgeMs = run.status === "applying" ? Number.POSITIVE_INFINITY : undefined;
    const validation = await revalidateRun(owner.businessId, runId, current, { maxAgeMs: maxPreviewAgeMs });
    if (validation.stale || validation.unverified) {
      if (run.status === "applying") {
        await client.query("UPDATE import_reconciliation_runs SET status='partially_applied', updated_at=now() WHERE id=$1 AND business_id=$2",
          [runId, owner.businessId]);
        await revalidateRun(owner.businessId, runId, current, { maxAgeMs: maxPreviewAgeMs });
      }
      return "stale";
    }
    if (approveSafe && run.status !== "applying") await approveSafeBatch(owner.businessId, runId, owner.actor);
    const base = createProductApplyHandler({ create: createCatalogueItem });
    const applied = await applyRun({
      businessId: owner.businessId, runId, actor: owner.actor, current, maxBatches: 1, maxPreviewAgeMs,
      handler: {
        ...base,
        async link(ctx) {
          const record = ctx.item.snapshot as CatalogueRecord;
          const { ctx: matches } = await loadProductContext(ctx.client, ctx.run, [record]);
          const target = matches.canonicalById.get(ctx.canonicalId!);
          if (!target?.isActive || target.kind !== record.kind || target.tracking !== record.tracking ||
              normalizeSkuKey(target.sku) !== record.sku) throw new ReconciliationError("catalogue_identity_changed");
          if (record.family) {
            const links = await familyLinks(ctx.client, ctx.run, record, target.id);
            if (!links) throw new ReconciliationError("catalogue_variant_identity_changed");
            for (const link of links) await rememberChild(ctx, link.child, link.id);
          }
          return base.link(ctx);
        },
      },
    });
    // Only this import's own committed writes should advance its comparison point.
    await client.query("UPDATE import_reconciliation_runs SET canonical_token=$3 WHERE id=$1 AND business_id=$2",
      [runId, owner.businessId, await catalogueToken(client, run)]);
    if (applied.run.status === "applied") await crossCheckRun(owner.businessId, runId);
    return applied.run.status;
  });
  if (result === "stale") throw new ReconciliationError("preview_stale");
  return catalogueSummary(owner, runId);
}
