/**
 * Domain-aware server apply runner for the #1118 reconciliation engine.
 * Kept separate from `service.ts` so `service.ts` stays decoupled from
 * domain writers like `createParty` and product creation services.
 */

import { withTenantTransaction } from "../db";
import { getBusinessIndustry } from "../industry-guard";
import { isRetailCatalogueIndustry } from "../industries";
import { createItem } from "../items-service";
import { createParty } from "../parties-service";
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
  type RunRecord,
} from "./service";

async function currentTokenForRun(run: RunRecord): Promise<string> {
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
    handler = createProductApplyHandler({
      async create(ctx) {
        const snap = ctx.item.snapshot as {
          name?: string;
          sku?: string | null;
          priceRial?: string;
          unit?: string;
          stockQuantity?: string;
        };
        if (!locationId) throw new Error("location_required");
        const name = (snap.name ?? "").trim() || `کالا ${ctx.item.externalKey}`;
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
        // Food-service fallback: insert into menu_items under active default category
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
    handler = createFinancialDocumentApplyHandler();
  } else {
    handler = createInventoryApplyHandler();
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
  return { summary, crossCheck };
}
