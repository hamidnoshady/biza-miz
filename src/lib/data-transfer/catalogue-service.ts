import { createHash } from "node:crypto";
import { query, withTenantTransaction, type PoolClient } from "../db";
import { createItem, updateItemMeta } from "../items-service";
import { assignBarcode } from "../item-barcodes-service";
import { ensureBranchBrand, updateItemProfile } from "../item-brands-service";
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
import { catalogueChildOptions, catalogueRecords, sameVariantOptions, type CatalogueRecord } from "./catalogue-plan";
import { normalizeBrandFallback, parseCatalogueRows, type CatalogueMapping, type CatalogueRow, type CatalogueSheet, type CatalogueTarget } from "./catalogue-profile";
import {
  planCatalogueValues,
  type CatalogueCurrency,
  type CatalogueStockState,
  type CatalogueValueMode,
  type CatalogueValuePlan,
} from "./catalogue-values";
import { saveStockPrices } from "../price-lists-service";
import { createItemStockCount } from "../item-stock-count-service";

import { CATALOGUE_PROFILE, lockCatalogueBranch } from "./catalogue-gate";
const VERSION = 2;

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
  // A price or stock edit is a catalogue change too: without this, a preview of
  // current→proposed values could be applied to a shelf that moved underneath it.
  const { rows: stock } = await client.query<{ token: string }>(
    `SELECT count(*)::text || ':' || COALESCE(max(s.updated_at)::text, '') || ':' || COALESCE(sum(s.quantity)::text, '0') AS token
       FROM item_stock s JOIN items i ON i.id = s.item_id WHERE i.location_id = $1`,
    [run.locationId],
  );
  return digest([await productCanonicalToken(client, run), rows, stock[0]?.token ?? ""]);
}

type StockStateRow = {
  id: string;
  kind: string;
  tracking: string;
  has_stock_row: boolean;
  quantity: string | null;
  unit_price: string | null;
  unit_cost: string | null;
};

async function loadStockStates(client: PoolClient, locationId: string, itemIds: string[]): Promise<Map<string, CatalogueStockState>> {
  const out = new Map<string, CatalogueStockState>();
  if (itemIds.length === 0) return out;
  const { rows } = await client.query<StockStateRow>(
    `SELECT i.id::text AS id, i.kind, i.tracking, (s.item_id IS NOT NULL) AS has_stock_row,
            s.quantity::text AS quantity, s.unit_price::text AS unit_price, s.unit_cost::text AS unit_cost
       FROM items i LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND i.id::text = ANY($2::text[])`,
    [locationId, itemIds],
  );
  for (const row of rows) {
    out.set(row.id, {
      kind: row.kind,
      tracking: row.tracking,
      hasStockRow: row.has_stock_row,
      quantity: row.quantity == null ? "0" : row.quantity,
      unitPriceRial: row.unit_price == null ? null : Number(row.unit_price),
      unitCostRial: row.unit_cost == null ? null : Number(row.unit_cost),
    });
  }
  return out;
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
    parentExternalId: record.externalId,
    variantOptions: Object.fromEntries(catalogueChildOptions(record.family!, row).map(pair => [pair.name, pair.value])),
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
    const variants = Object.entries(target.variantOptions ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    if ((mapped && mapped !== target.id) || !rows.some(row => row.id === target.id) ||
        target.kind !== "variant_child" || target.tracking !== "none" || !target.isActive ||
        !sameVariantOptions(catalogueChildOptions(parent.family!, child.catalogue), variants) ||
        (child.barcodes?.length && !child.barcodes.every(code => target.barcodes.includes(code)))) return null;
    return { child, id: target.id };
  });
  return links.every(link => link !== null) ? links : null;
}

export async function stageCatalogue(owner: CatalogueOwner, input: {
  sheet: CatalogueSheet; mapping: CatalogueMapping; fileName: string; sourceName: string; fingerprint: string;
  fallbackBrand?: string | null; duplicateRows: number[]; axis: string;
  /** GH #1567 F6: every variant axis in order; wins over `axis` when given. */
  axes?: string[];
  valueMode?: CatalogueValueMode; currency?: CatalogueCurrency;
}) {
  const fallbackBrand = normalizeBrandFallback(input.fallbackBrand);
  const valueMode: CatalogueValueMode = input.valueMode ?? "catalogue_only";
  const currency: CatalogueCurrency = input.currency === "toman" ? "toman" : "rial";
  const { rows, totals, valueTotals } = parseCatalogueRows(input.sheet, input.mapping, { fallbackBrand, currency });
  const axes = input.axes?.length ? input.axes : [input.axis];
  const planned = catalogueRecords(rows, owner.target, new Set(input.duplicateRows), axes);
  return withTenantTransaction(owner.businessId, async client => {
    await lockCatalogueBranch(client, owner.locationId);
    const run = await openRun({
      ...owner, domain: "product", sourceKind: "file", provider: "xlsx",
      sourceKey: `xlsx:catalogue:${owner.locationId}:${attributeComparisonKey(input.sourceName)}`,
      importMode: "one_time", sourceFingerprint: input.fingerprint,
      profileKey: CATALOGUE_PROFILE, profileVersion: VERSION,
      scope: { target: owner.target, valueMode, currency },
      evidence: { fileName: input.fileName, sheet: input.sheet.name, columns: input.sheet.columns, mapping: input.mapping,
        sourceName: input.sourceName, fallbackBrand, axis: axes[0] ?? "", axes, totals, valueTotals, valueMode, currency },
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
    // Update-only mode may not add a catalog: an unknown SKU stays in review
    // instead of quietly becoming a second product.
    for (const item of items) {
      if (valueMode !== "update_existing") continue;
      if (item.resolution.outcome !== "create_new") continue;
      item.resolution = {
        ...item.resolution,
        outcome: "invalid",
        reasons: [...item.resolution.reasons, "update_requires_existing"],
        candidates: [],
        canonicalId: null,
      };
    }

    // Current → proposed for the products this file touches. Stored on the
    // staged row so the review shows it and the apply writes exactly it.
    const resolved = items.filter(item => item.resolution.canonicalId != null &&
      ["already_linked", "safe_match", "field_conflict"].includes(item.resolution.outcome));
    if (valueMode !== "catalogue_only" && resolved.length > 0) {
      const stockStates = await loadStockStates(client, owner.locationId,
        [...new Set(resolved.map(item => item.resolution.canonicalId as string))]);
      for (const item of resolved) {
        const record = item.record as CatalogueRecord;
        const state = stockStates.get(item.resolution.canonicalId as string);
        if (!state) continue;
        const plan: CatalogueValuePlan = planCatalogueValues(record.values, state, valueMode);
        if (Object.keys(plan).length > 0) record.valuePlan = plan;
      }
    }

    for (let i = 0; i < items.length; i += 100) await stagePlannedItems(owner.businessId, run.id, items.slice(i, i + 100));
    // Catalogue review always requires a separate confirmation, even in an empty branch.
    await completeDiscovery({ businessId: owner.businessId, runId: run.id, actor: owner.actor, canonicalCount: 1, canonicalToken });
    return run.id;
  });
}

async function applyProfile(ctx: ApplyContext, id: string, row: CatalogueRow) {
  const location = ctx.run.locationId!;
  const brand = row.values.brand;
  const brandId = brand ? (await ensureBranchBrand(location, brand, ctx.client)).id : null;
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
      attributes: catalogueChildOptions(record.family!, child.catalogue),
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

export interface CatalogueApplyConfirmations {
  /** Explicit approval to write sale/purchase prices and price history. */
  prices?: boolean;
  /** Explicit approval to move stock to the file's target quantities. */
  stock?: boolean;
}

/** What this run would still write, so the screen can require both confirmations. */
export async function pendingCatalogueValues(owner: CatalogueOwner, runId: string): Promise<{ prices: boolean; stock: boolean }> {
  await catalogueSummary(owner, runId);
  return withTenantTransaction(owner.businessId, async client => {
    const { rows } = await client.query<{ prices: number; stock: number }>(
      `SELECT count(*) FILTER (WHERE snapshot->'valuePlan'->'price'->>'action' = 'set'
                                 OR snapshot->'valuePlan'->'cost'->>'action' = 'set')::int AS prices,
              count(*) FILTER (WHERE snapshot->'valuePlan'->'quantity'->>'action' = 'set')::int AS stock
         FROM import_reconciliation_items
        WHERE business_id = $1 AND run_id = $2 AND status NOT IN ('skipped', 'failed')`,
      [owner.businessId, runId],
    );
    return { prices: (rows[0]?.prices ?? 0) > 0, stock: (rows[0]?.stock ?? 0) > 0 };
  });
}

/**
 * Write the reviewed values for one item through the owning services. Price and
 * cost go through `saveStockPrices` (integer Rial, immutable history, cost guard);
 * an absolute quantity goes through `createItemStockCount` (reviewed delta, the
 * existing serial/batch refusals, one journal effect, idempotent per run+row).
 */
async function applyValuePlan(
  client: PoolClient,
  run: ReconciliationRun,
  actor: Actor,
  itemId: string,
  externalKey: string,
  plan: CatalogueValuePlan,
): Promise<void> {
  const locationId = run.locationId;
  if (!locationId) throw new ReconciliationError("location_required");
  const updates: Array<{ itemId: string; kind: "sale" | "purchase"; price: number }> = [];
  if (plan.price?.action === "set") updates.push({ itemId, kind: "sale", price: plan.price.proposed as number });
  if (plan.cost?.action === "set") updates.push({ itemId, kind: "purchase", price: plan.cost.proposed as number });
  if (updates.length > 0) {
    const result = await saveStockPrices(updates, { locationId, businessId: run.businessId, userId: actor.userId });
    if (result.skipped.length > 0 || result.conflicts.length > 0) {
      throw new ReconciliationError("catalogue_value_conflict", {
        skipped: result.skipped, conflicts: result.conflicts, externalKey,
      });
    }
  }
  const quantity = plan.quantity;
  if (quantity?.action === "set" && quantity.delta !== 0) {
    await createItemStockCount(client, {
      businessId: run.businessId,
      locationId,
      note: "ثبت موجودی و قیمت از ورود کاتالوگ",
      lines: [{ itemId, countedQty: quantity.proposed }],
      createdBy: actor.userId,
      idempotencyKey: `catalogue:${run.id}:${externalKey}`.slice(0, 200),
      // The balance the reviewer approved, not the balance the count happens to
      // find: if stock moved since the preview, the count refuses with
      // `snapshot_conflict` instead of posting a variance nobody reviewed.
      baselineSnapshot: { [itemId]: String(quantity.current) },
    });
  }
}

/**
 * Apply every stored value plan. Each item gets its own savepoint: one rejected
 * row must not undo the others, and the run is reported `partially_applied` so
 * the failure is visible rather than claimed as reconciled.
 */
async function applyStoredValuePlans(client: PoolClient, run: ReconciliationRun, actor: Actor): Promise<number> {
  const { rows } = await client.query<{
    id: number; external_key: string; snapshot: CatalogueRecord; resolved_canonical_id: string | null;
  }>(
    `SELECT id, external_key, snapshot, resolved_canonical_id
       FROM import_reconciliation_items
      WHERE business_id = $1 AND run_id = $2 AND status = 'applied'
        AND resolved_canonical_id IS NOT NULL AND snapshot ? 'valuePlan'
      ORDER BY id`,
    [run.businessId, run.id],
  );
  let failures = 0;
  for (const row of rows) {
    const plan = row.snapshot?.valuePlan;
    if (!plan || row.resolved_canonical_id == null) continue;
    await client.query("SAVEPOINT catalogue_value");
    try {
      await applyValuePlan(client, run, actor, row.resolved_canonical_id, row.external_key, plan);
      await client.query("RELEASE SAVEPOINT catalogue_value");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT catalogue_value");
      failures += 1;
      const message = error instanceof ReconciliationError ? error.code
        : error instanceof Error ? error.message : "catalogue_value_failed";
      await client.query(
        `UPDATE import_reconciliation_items SET error = $3, status = 'failed', updated_at = now()
          WHERE id = $1 AND business_id = $2 AND run_id = $4`,
        [row.id, run.businessId, message.slice(0, 500), run.id],
      );
    }
  }
  return failures;
}

export async function applyCatalogue(
  owner: CatalogueOwner,
  runId: string,
  approveSafe: boolean,
  confirmations: CatalogueApplyConfirmations = {},
) {
  const result = await withTenantTransaction(owner.businessId, async client => {
    await lockCatalogueBranch(client, owner.locationId);
    const { run } = await catalogueSummary(owner, runId);
    if (run.status === "applied") return run.status;
    const valueMode = (run.scope.valueMode as CatalogueValueMode | undefined) ?? "catalogue_only";
    if (valueMode !== "catalogue_only") {
      // Financial and stock writes are confirmed separately from metadata.
      const pending = await pendingCatalogueValues(owner, runId);
      if (pending.prices && !confirmations.prices) throw new ReconciliationError("catalogue_price_confirmation_required");
      if (pending.stock && !confirmations.stock) throw new ReconciliationError("catalogue_stock_confirmation_required");
    }
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
    const valueFailures = valueMode === "catalogue_only" ? 0 : await applyStoredValuePlans(client, run, owner.actor);
    // Only this import's own committed writes should advance its comparison point.
    await client.query("UPDATE import_reconciliation_runs SET canonical_token=$3 WHERE id=$1 AND business_id=$2",
      [runId, owner.businessId, await catalogueToken(client, run)]);
    if (applied.run.status === "applied" && valueFailures === 0) await crossCheckRun(owner.businessId, runId);
    if (applied.run.status === "applied" && valueFailures > 0) {
      // A held value write means the run is not reconciled; say so.
      await client.query(
        `UPDATE import_reconciliation_runs SET status = 'partially_applied', updated_at = now()
          WHERE id = $1 AND business_id = $2 AND status = 'applied'`,
        [runId, owner.businessId],
      );
      return "partially_applied";
    }
    return applied.run.status;
  });
  if (result === "stale") throw new ReconciliationError("preview_stale");
  return catalogueSummary(owner, runId);
}
