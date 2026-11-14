/**
 * Domain-aware server apply runner for the #1118 reconciliation engine.
 * Kept separate from `service.ts` so `service.ts` stays decoupled from
 * domain writers like `createParty` and product creation services.
 */

import Decimal from "decimal.js";
import { withTenantTransaction } from "../db";
import { getBusinessIndustry } from "../industry-guard";
import { isRetailCatalogueIndustry } from "../industries";
import { createItem } from "../items-service";
import { createParty } from "../parties-service";
import { getSetting, SETTING_KEYS } from "../settings";
import { HOLOO_IMPORT_SOURCE_TYPE, postReconciledHolooVoucherOnClient } from "../integrations/holoo/journal-import-service";
import type { HolooVoucherLine } from "../integrations/holoo/journal-plan";
import { finalizeReconciledImportJob } from "../data-transfer/import-service";
import {
  applyRun,
  createFinancialDocumentApplyHandler,
  createInventoryApplyHandler,
  createPartyApplyHandler,
  createProductApplyHandler,
  crossCheckRun,
  financialDocumentCanonicalToken,
  getRunSummary,
  inventoryCanonicalToken,
  partyCanonicalToken,
  productCanonicalToken,
  type ApplyHandler,
  type ReconciliationRun,
} from "./service";

async function currentTokenForRun(run: ReconciliationRun): Promise<string> {
  return withTenantTransaction(run.businessId, async (client) => {
    switch (run.domain) {
      case "product":
        return productCanonicalToken(client, run);
      case "party":
        return partyCanonicalToken(client, run);
      case "financial_document":
        return financialDocumentCanonicalToken(client, run);
      case "inventory":
        return inventoryCanonicalToken(client, run);
    }
  });
}

function parseOptionalBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

export async function applyReconciliationRunWithDomainHandlers(input: {
  businessId: string;
  runId: string;
  locationId: string | null;
  actor: { userId: string | null; name: string };
}) {
  const { run } = await getRunSummary(input.businessId, input.runId);
  const industry = await getBusinessIndustry(input.businessId);
  const locationId = run.locationId ?? input.locationId;

  let handler: ApplyHandler;
  if (run.domain === "product") {
    const isRetail = isRetailCatalogueIndustry(industry);
    const isInventoryItemsScope =
      run.scope?.canonicalTable === "inventory_items" ||
      (industry === "food_service" && run.scope?.entityKey === "inventory.items");
    handler = createProductApplyHandler({
      async create(ctx) {
        const snap = ctx.item.snapshot as {
          name?: string;
          sku?: string | null;
          priceRial?: string;
          unit?: string;
          stockQuantity?: string;
          fields?: {
            unit?: string | null;
            reorderLevel?: number | string | null;
            purchaseUnit?: string | null;
            purchaseUnitFactor?: number | string | null;
            isActive?: boolean | null;
          };
        };
        if (!locationId) throw new Error("location_required");
        const name = (snap.name ?? "").trim() || `کالا ${ctx.item.externalKey}`;
        if (isInventoryItemsScope) {
          const unit = (snap.unit ?? snap.fields?.unit ?? "").trim() || "unit";
          const reorderRaw = snap.fields?.reorderLevel;
          const reorder =
            reorderRaw != null && reorderRaw !== "" && Number.isFinite(Number(reorderRaw))
              ? Number(reorderRaw)
              : null;
          const factorRaw = snap.fields?.purchaseUnitFactor;
          const factor =
            factorRaw != null && factorRaw !== "" && Number.isFinite(Number(factorRaw))
              ? Number(factorRaw)
              : 1;
          const purchaseUnit =
            typeof snap.fields?.purchaseUnit === "string" && snap.fields.purchaseUnit.trim()
              ? snap.fields.purchaseUnit.trim()
              : null;
          const isActive = typeof snap.fields?.isActive === "boolean" ? snap.fields.isActive : true;
          const { rows } = await ctx.client.query<{ id: string }>(
            `INSERT INTO inventory_items
               (location_id, name, sku, unit, reorder_level, purchase_unit, purchase_unit_factor, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id::text AS id`,
            [locationId, name, snap.sku ?? null, unit, reorder, purchaseUnit, factor, isActive],
          );
          return { canonicalId: rows[0].id };
        }
        if (isRetail) {
          const item = await createItem(
            {
              locationId,
              name,
              sku: snap.sku ?? null,
              kind: "simple",
              tracking: "none",
            },
            ctx.client,
          );
          const price = snap.priceRial && /^\d+$/.test(snap.priceRial) && BigInt(snap.priceRial) > 0n ? snap.priceRial : null;
          const qty = snap.stockQuantity && /^\d+(?:\.\d+)?$/.test(snap.stockQuantity) ? snap.stockQuantity : "0";
          await ctx.client.query(
            `INSERT INTO item_stock (item_id, quantity, unit_price)
             VALUES ($1, $2, $3)
             ON CONFLICT (item_id) DO NOTHING`,
            [item.id, qty, price],
          );
          return { canonicalId: item.id };
        }
        // Food-service fallback: insert into menu_items
        const { rows } = await ctx.client.query<{ id: string }>(
          `INSERT INTO menu_items (location_id, name, sku, price)
           VALUES ($1, $2, $3, $4)
           RETURNING id::text AS id`,
          [
            locationId,
            name,
            snap.sku ?? null,
            snap.priceRial && /^\d+$/.test(snap.priceRial) ? snap.priceRial : "0",
          ],
        );
        return { canonicalId: rows[0].id };
      },
    });
  } else if (run.domain === "party") {
    handler = createPartyApplyHandler({
      async create(ctx) {
        const snap = ctx.item.snapshot as {
          name?: string;
          phone?: string | null;
          email?: string | null;
          role?: string;
        };
        const displayName = (snap.name ?? "").trim() || `شخص ${ctx.item.externalKey}`;
        const role = snap.role === "supplier" ? "Supplier" : "Customer";
        const party = await createParty(
          input.businessId,
          {
            displayName,
            role,
            roles: [role],
            phone: snap.phone ?? null,
            email: snap.email ?? null,
          },
          { locationId: locationId ?? undefined, actorId: input.actor.userId ?? null },
        );
        return { canonicalId: party.id };
      },
    });
  } else if (run.domain === "financial_document") {
    handler = createFinancialDocumentApplyHandler({
      canonicalType: "journal_entries",
      mappingEntityType: run.provider === "holoo" ? "holoo_journal" : undefined,
      async create(ctx) {
        const snap = ctx.item.snapshot as {
          kind?: string;
          date?: string | null;
          fields?: {
            memo?: string | null;
            lines?: Array<{
              accountCode?: string;
              debitRial?: unknown;
              creditRial?: unknown;
              costCenterCode?: string | null;
              profitCenterCode?: string | null;
              departmentCode?: string | null;
              detailCode?: string | null;
            }>;
          };
        };
        if (snap.kind !== "journal" || !Array.isArray(snap.fields?.lines) || snap.fields.lines.length === 0) {
          throw new Error("create_not_supported");
        }
        let resolvedLocationId = locationId;
        if (!resolvedLocationId) {
          const { rows: locRows } = await ctx.client.query<{ id: string }>(
            `SELECT id::text AS id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
            [ctx.run.businessId],
          );
          resolvedLocationId = locRows[0]?.id ?? null;
        }
        const lines: HolooVoucherLine[] = snap.fields.lines.map((line) => ({
          accountCode: String(line.accountCode ?? "").trim(),
          debitRial: parseOptionalBigInt(line.debitRial),
          creditRial: parseOptionalBigInt(line.creditRial),
          costCenterCode: line.costCenterCode ?? null,
          profitCenterCode: line.profitCenterCode ?? null,
          departmentCode: line.departmentCode ?? null,
          detailCode: line.detailCode ?? null,
        }));
        const { entryId } = await postReconciledHolooVoucherOnClient(ctx.client, {
          businessId: ctx.run.businessId,
          connectionId: ctx.run.connectionId,
          locationId: resolvedLocationId,
          voucher: {
            remoteId: ctx.item.externalKey,
            entryDate: (snap.date ?? "").trim() || new Date().toISOString().slice(0, 10),
            memo: snap.fields?.memo ?? null,
            lines,
          },
          createdBy: ctx.actor.userId ?? null,
          sourceType: ctx.run.provider === "holoo" ? HOLOO_IMPORT_SOURCE_TYPE : "reconciliation_import",
        });
        return { canonicalId: entryId };
      },
    });
  } else {
    const isRetail = isRetailCatalogueIndustry(industry);
    const costing = await getSetting<{
      method?: "fifo" | "lifo" | "weighted_average";
      system?: "perpetual" | "periodic";
    }>(input.businessId, SETTING_KEYS.costing);
    handler = createInventoryApplyHandler({
      canonicalType: isRetail ? "items" : "inventory_items",
      async create(ctx) {
        const snap = ctx.item.snapshot as {
          kind?: "snapshot" | "movement";
          cause?: string;
          productExternalId?: string | null;
          quantity?: string | null;
          fields?: {
            name?: string | null;
            unit?: string | null;
            unitCostRial?: string | null;
          };
        };
        if (!locationId) throw new Error("location_required");
        const qtyStr = typeof snap.quantity === "string" ? snap.quantity.trim() : "";
        const qty = new Decimal(qtyStr || "NaN");
        if (!qty.isFinite()) throw new Error("invalid_quantity");
        const unitCostRaw = snap.fields?.unitCostRial;
        const unitCostStr =
          typeof unitCostRaw === "string" && /^\d+$/.test(unitCostRaw.trim()) ? unitCostRaw.trim() : "0";
        const unitCostBig = BigInt(unitCostStr);

        if (isRetail) {
          let targetItemId = ctx.canonicalId;
          if (targetItemId) {
            const { rows } = await ctx.client.query<{ id: string }>(
              `SELECT id::text AS id FROM items WHERE id::text = $1 AND location_id = $2 LIMIT 1`,
              [targetItemId, locationId],
            );
            if (!rows[0]) targetItemId = null;
          }
          if (!targetItemId && snap.productExternalId) {
            const relatedKeys = ctx.run.connectionId
              ? [ctx.run.sourceKey, `holoo:${ctx.run.connectionId}:goods`, ctx.run.connectionId]
              : [ctx.run.sourceKey];
            const { rows: idRows } = await ctx.client.query<{ canonical_id: string }>(
              `SELECT canonical_id FROM source_identities
                WHERE business_id = $1 AND source_key = ANY($2::text[]) AND domain = 'product'
                  AND retired_at IS NULL AND verified AND external_id = $3
                LIMIT 1`,
              [ctx.run.businessId, relatedKeys, snap.productExternalId],
            );
            targetItemId = idRows[0]?.canonical_id ?? null;
          }
          if (!targetItemId && snap.productExternalId && ctx.run.connectionId) {
            const { rows: mapRows } = await ctx.client.query<{ local_id: string }>(
              `SELECT local_id::text AS local_id FROM integration_mappings
                WHERE business_id = $1 AND connection_id = $2
                  AND entity_type IN ('product', 'holoo_goods') AND remote_id = $3
                LIMIT 1`,
              [ctx.run.businessId, ctx.run.connectionId, snap.productExternalId],
            );
            targetItemId = mapRows[0]?.local_id ?? null;
          }
          if (!targetItemId) {
            const itemName = (snap.fields?.name ?? "").trim() || `کالا ${ctx.item.externalKey}`;
            const created = await createItem(
              { locationId, name: itemName, sku: null, kind: "simple", tracking: "none" },
              ctx.client,
            );
            targetItemId = created.id;
          }

          if (snap.kind === "movement") {
            await ctx.client.query(
              `INSERT INTO item_stock (item_id, quantity, unit_cost)
               VALUES ($1::uuid, $2, $3)
               ON CONFLICT (item_id) DO UPDATE
                 SET quantity = item_stock.quantity + EXCLUDED.quantity`,
              [targetItemId, qty.toString(), unitCostBig > 0n ? unitCostStr : null],
            );
          } else {
            await ctx.client.query(
              `INSERT INTO item_stock (item_id, quantity, unit_cost)
               VALUES ($1::uuid, $2, $3)
               ON CONFLICT (item_id) DO UPDATE
                 SET quantity = EXCLUDED.quantity,
                     unit_cost = COALESCE(item_stock.unit_cost, EXCLUDED.unit_cost)`,
              [targetItemId, qty.toString(), unitCostBig > 0n ? unitCostStr : null],
            );
          }
          return { canonicalId: targetItemId };
        }

        if (costing?.system === "periodic") throw new Error("periodic_system_unsupported");
        const method = costing?.method ?? "fifo";
        let inventoryItemId = ctx.canonicalId;
        if (inventoryItemId) {
          const { rows } = await ctx.client.query<{ id: string }>(
            `SELECT id::text AS id FROM inventory_items WHERE id::text = $1 AND location_id = $2 LIMIT 1`,
            [inventoryItemId, locationId],
          );
          if (!rows[0]) inventoryItemId = null;
        }
        const itemName = (snap.fields?.name ?? "").trim() || `کالای انبار ${ctx.item.externalKey}`;
        if (!inventoryItemId) {
          const { rows: existing } = await ctx.client.query<{ id: string }>(
            `SELECT id::text AS id FROM inventory_items
              WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2))
              ORDER BY created_at LIMIT 1 FOR UPDATE`,
            [locationId, itemName],
          );
          inventoryItemId = existing[0]?.id ?? null;
        }
        if (!inventoryItemId) {
          const unit = (snap.fields?.unit ?? "").trim() || "unit";
          const { rows: inserted } = await ctx.client.query<{ id: string }>(
            `INSERT INTO inventory_items (location_id, name, sku, unit, avg_cost)
             VALUES ($1, $2, NULL, $3, $4)
             RETURNING id::text AS id`,
            [locationId, itemName, unit, unitCostStr],
          );
          inventoryItemId = inserted[0].id;
        }

        const { rows: existingEvent } = await ctx.client.query<{ id: string }>(
          `SELECT id::text AS id FROM inventory_events
            WHERE business_id = $1 AND source_type = 'reconciliation_import' AND source_id = $2::uuid
            LIMIT 1`,
          [ctx.run.businessId, ctx.run.id],
        );
        let eventId = existingEvent[0]?.id;
        if (!eventId) {
          const { rows: openingRows } = await ctx.client.query<{ id: string }>(
            `SELECT id::text AS id FROM inventory_events
              WHERE business_id = $1 AND event_type = 'opening'
              LIMIT 1`,
            [ctx.run.businessId],
          );
          const eventType =
            snap.cause === "opening" && openingRows.length === 0 ? "opening" : "stock_count_adjustment";
          const { rows: insertedEvent } = await ctx.client.query<{ id: string }>(
            `INSERT INTO inventory_events
               (business_id, location_id, event_type, source_type, source_id, created_by, posting_status, metadata)
             VALUES ($1, $2, $3, 'reconciliation_import', $4::uuid, $5, 'posted', $6::jsonb)
             RETURNING id::text AS id`,
            [
              ctx.run.businessId,
              locationId,
              eventType,
              ctx.run.id,
              ctx.actor.userId ?? null,
              JSON.stringify({ runId: ctx.run.id }),
            ],
          );
          eventId = insertedEvent[0].id;
        }

        let delta = qty;
        if (snap.kind !== "movement") {
          const { rows: stockRows } = await ctx.client.query<{ current_qty: string }>(
            `SELECT COALESCE(SUM(quantity), 0)::text AS current_qty
               FROM stock_movements
              WHERE location_id = $1 AND inventory_item_id = $2::uuid`,
            [locationId, inventoryItemId],
          );
          delta = qty.minus(new Decimal(stockRows[0]?.current_qty ?? "0"));
        }

        if (!delta.isZero()) {
          const costValue = Decimal.abs(delta).times(unitCostStr).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
          await ctx.client.query(
            `INSERT INTO stock_movements
               (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial,
                source_type, source_id, note, created_by, inventory_event_id)
             VALUES ($1, $2::uuid, 'adjustment', $3, $4, $5, 'reconciliation_import', $6::uuid,
                     'ثبت از تطبیق پیش از ورود', $7, $6::uuid)`,
            [locationId, inventoryItemId, delta.toString(), unitCostStr, costValue, eventId, ctx.actor.userId ?? null],
          );
          if (delta.gt(0) && method !== "weighted_average") {
            await ctx.client.query(
              `INSERT INTO inventory_lots
                 (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id,
                  inventory_event_id, original_quantity, original_value_rial, remaining_value_rial)
               VALUES ($1, $2::uuid, $3, $4, 'reconciliation_import', $5::uuid, $5::uuid, $3, $6, $6)`,
              [locationId, inventoryItemId, delta.toString(), unitCostStr, eventId, costValue],
            );
          }
        }
        return { canonicalId: inventoryItemId };
      },
    });
  }

  const canonicalToken = await currentTokenForRun(run);
  const summary = await applyRun({
    businessId: input.businessId,
    runId: run.id,
    handler,
    current: {
      sourceFingerprint: run.sourceFingerprint,
      policyVersion: run.policyVersion,
      canonicalToken,
    },
    actor: input.actor,
  });
  const crossCheck = await crossCheckRun(input.businessId, run.id);
  if (summary.run.status === "applied" && run.sourceKind === "file" && run.sourceKey.startsWith("job:")) {
    await finalizeReconciledImportJob(input.businessId, run.id, {
      locationId: locationId ?? null,
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
    });
  }
  return { summary, crossCheck };
}
