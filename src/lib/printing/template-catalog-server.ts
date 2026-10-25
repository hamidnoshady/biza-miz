/** Database-backed, request-scoped template access context. Never import from a client component. */
import { isFeatureEnabled } from "../features";
import { isIndustry } from "../industries";
import { hasModule } from "../industry-profile";
import { query } from "../db";
import type { TemplateAccessContext } from "./template-catalog";

/**
 * Resolve the active branch's business type and WooCommerce capability on each
 * request. Nothing is cached: an industry/module grant or integration status
 * change must take effect before the next gallery read, rule write or print.
 * The location/business join is constrained by the caller's RLS scope.
 */
export async function loadTemplateAccessContext(
  locationId: string,
  connectionId?: string | null,
): Promise<TemplateAccessContext | null> {
  const { rows } = await query<{ business_id: string; industry: string }>(
    `SELECT l.business_id, b.industry
       FROM locations l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.id = $1
      LIMIT 1`,
    [locationId],
  );
  const business = rows[0];
  if (!business || !isIndustry(business.industry)) return null;

  let wooEnabled = false;
  if (
    hasModule(business.industry, "integrations") &&
    await isFeatureEnabled(business.business_id, "integrations")
  ) {
    const params: unknown[] = [business.business_id, locationId];
    let connectionClause = "";
    if (connectionId) {
      params.push(connectionId);
      connectionClause = " AND id = $3::uuid";
    }
    const stores = await query<{ id: string }>(
      `SELECT id
         FROM integration_connections
        WHERE business_id = $1 AND location_id = $2
          AND provider = 'woocommerce' AND status = 'active'${connectionClause}
        LIMIT 1`,
      params,
    );
    wooEnabled = stores.rows.length > 0;
  }

  return { industry: business.industry, wooEnabled };
}
