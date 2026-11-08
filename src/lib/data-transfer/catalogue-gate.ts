import type { PoolClient } from "../db";
import { normalizeSkuKey } from "../import-reconciliation/normalize";

export const CATALOGUE_PROFILE = "xlsx_catalogue";

export async function lockCatalogueBranch(client: PoolClient, locationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`catalogue-import:${locationId}`]);
}

/** A pull/webhook may retry, but may not create a twin while the XLSX identity is under review or linked. */
export async function gateWooCatalogueCreate(client: PoolClient, businessId: string, locationId: string, incomingSku?: string | null) {
  const sku = normalizeSkuKey(incomingSku);
  if (!sku) return;
  await lockCatalogueBranch(client, locationId);
  const { rows } = await client.query(
    `SELECT 1 FROM source_identities WHERE business_id=$1 AND source_key LIKE $2
       AND domain='product' AND external_type='product' AND external_id=$3 AND verified AND retired_at IS NULL
     UNION ALL
     SELECT 1 FROM import_reconciliation_items i JOIN import_reconciliation_runs r ON r.id=i.run_id
      WHERE i.business_id=$1 AND r.business_id=$1 AND r.location_id=$4 AND r.profile_key=$5
        AND r.status IN ('staged','in_review','applying','partially_applied') AND i.status NOT IN ('skipped','applied')
        AND (i.snapshot->>'sku'=$6 OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(i.snapshot->'family'->'children','[]'::jsonb)) child
           WHERE child->>'sku'=$6
        ))
     LIMIT 1`, [businessId, `xlsx:catalogue:${locationId}:%`, `sku:${sku}`, locationId, CATALOGUE_PROFILE, sku],
  );
  if (rows.length) throw new Error("catalogue_reconciliation_required");
}
