/**
 * Database-backed pagination for the platform AI gateway console.
 *
 * This is intentionally kept separate from the route handler so the exact SQL
 * can be exercised against PostgreSQL. In particular, PostgreSQL does not
 * allow a query-level column such as `p.page` directly in an OFFSET expression;
 * the page value must be read through a scalar subquery.
 */
import { query, withoutTenantScope } from "./db";

export type FleetStatus =
  | "ready"
  | "missing_key"
  | "key_sync_error"
  | "entitlement_disabled"
  | "gateway_unavailable";

export type FleetQueryRow = {
  total: number | string;
  total_pages: number | string;
  page: number | string;
  business_id: string | null;
  business_name: string | null;
  ai_entitled: boolean | null;
  business_has_key: boolean | null;
  has_branch_override: boolean | null;
  has_sync_error: boolean | null;
  has_branch_sync_error: boolean | null;
  fleet_status: FleetStatus | null;
  is_focused: boolean | null;
};

export type LocationQueryRow = {
  total: number | string;
  total_pages: number | string;
  page: number | string;
  id: string | null;
  business_id: string | null;
  name: string | null;
};

export interface FleetPaginationInput {
  gatewayVirtualKeysEnabled: boolean;
  gatewayUnavailable: boolean;
  masterKeyConfigured: boolean;
  searchPattern: string;
  statusFilter: string;
  focusBusinessId: string;
  pageSize: number;
  requestedPage: number;
}

export interface LocationPaginationInput {
  businessId: string;
  searchPattern: string;
  focusLocationId: string;
  pageSize: number;
  requestedPage: number;
}

/**
 * Fetch one fleet page plus an optional focused business.
 *
 * All values remain parameters. The only interpolated SQL is static, and the
 * platform scope is deliberate: the caller has already passed `ai.read`.
 */
export function listAiGatewayFleetPage(input: FleetPaginationInput) {
  return withoutTenantScope("platform", () =>
    query<FleetQueryRow>(
      `WITH gateway_state AS (
         SELECT business_id,
                bool_or(location_id IS NULL AND NULLIF(btrim(virtual_key_ciphertext), '') IS NOT NULL) AS business_has_key,
                bool_or(location_id IS NOT NULL) AS has_branch_override,
                bool_or(NULLIF(btrim(sync_error), '') IS NOT NULL) AS has_sync_error,
                bool_or(location_id IS NOT NULL AND NULLIF(btrim(sync_error), '') IS NOT NULL) AS has_branch_sync_error
           FROM ai_business_gateway
          GROUP BY business_id
       ), fleet AS (
         SELECT b.id::text AS business_id,
                b.name AS business_name,
                COALESCE(bf.enabled, ff.default_enabled, false) AS ai_entitled,
                COALESCE(gs.business_has_key, false) AS business_has_key,
                COALESCE(gs.has_branch_override, false) AS has_branch_override,
                COALESCE(gs.has_sync_error, false) AS has_sync_error,
                COALESCE(gs.has_branch_sync_error, false) AS has_branch_sync_error,
                CASE
                  WHEN NOT COALESCE(bf.enabled, ff.default_enabled, false) THEN 'entitlement_disabled'
                  WHEN COALESCE(gs.has_sync_error, false) THEN 'key_sync_error'
                  WHEN $1::boolean AND NOT COALESCE(gs.business_has_key, false) THEN 'missing_key'
                  WHEN $2::boolean OR (NOT $1::boolean AND NOT $3::boolean) THEN 'gateway_unavailable'
                  ELSE 'ready'
                END AS fleet_status
           FROM businesses b
           LEFT JOIN feature_flags ff ON ff.key = 'ai_assistant'
           LEFT JOIN business_features bf ON bf.business_id = b.id AND bf.flag_key = ff.key
           LEFT JOIN gateway_state gs ON gs.business_id = b.id
          WHERE b.status <> 'archived'
       ), filtered AS (
         SELECT * FROM fleet f
          WHERE ($4::text = '' OR f.business_name ILIKE $4::text ESCAPE '!')
            AND (
              $5::text = 'all'
              OR ($5::text = 'branch_override' AND f.has_branch_override)
              OR ($5::text <> 'branch_override' AND f.fleet_status = $5::text)
            )
       ), totals AS (
         SELECT count(*)::int AS total FROM filtered
       ), page_info AS (
         SELECT total,
                GREATEST(1, CEIL(total::numeric / $7::numeric)::int) AS total_pages,
                LEAST($8::int, GREATEST(1, CEIL(total::numeric / $7::numeric)::int)) AS page
           FROM totals
       ), page_rows AS (
         SELECT f.* FROM filtered f CROSS JOIN page_info p
          ORDER BY f.business_name, f.business_id
          LIMIT $7::int
          OFFSET (
            SELECT (page - 1)::bigint * $7::bigint
            FROM page_info
          )
       ), visible AS (
         SELECT p.*, false AS is_focused FROM page_rows p
         UNION ALL
         SELECT f.*, true AS is_focused FROM fleet f
          WHERE f.business_id = $6::text
            AND $6::text <> ''
            AND NOT EXISTS (SELECT 1 FROM page_rows p WHERE p.business_id = f.business_id)
       )
       SELECT p.total, p.total_pages, p.page,
              v.business_id, v.business_name, v.ai_entitled,
              v.business_has_key, v.has_branch_override, v.has_sync_error,
              v.has_branch_sync_error, v.fleet_status, v.is_focused
         FROM page_info p
         LEFT JOIN visible v ON true
        ORDER BY v.business_name NULLS LAST, v.business_id`,
      [
        input.gatewayVirtualKeysEnabled,
        input.gatewayUnavailable,
        input.masterKeyConfigured,
        input.searchPattern,
        input.statusFilter,
        input.focusBusinessId,
        input.pageSize,
        input.requestedPage,
      ],
    ),
  );
}

/** Fetch one business's location page plus an optional focused location. */
export function listAiGatewayLocationPage(input: LocationPaginationInput) {
  return withoutTenantScope("platform", () =>
    query<LocationQueryRow>(
      `WITH target_business AS (
         SELECT id FROM businesses WHERE id::text = $1::text AND status <> 'archived'
       ), all_locations AS (
         SELECT l.id::text AS id, l.business_id::text AS business_id, l.name
           FROM locations l JOIN target_business b ON b.id = l.business_id
       ), filtered_locations AS (
         SELECT * FROM all_locations
          WHERE ($2::text = '' OR name ILIKE $2::text ESCAPE '!')
       ), totals AS (
         SELECT count(*)::int AS total FROM filtered_locations
       ), page_info AS (
         SELECT total,
                GREATEST(1, CEIL(total::numeric / $4::numeric)::int) AS total_pages,
                LEAST($5::int, GREATEST(1, CEIL(total::numeric / $4::numeric)::int)) AS page
           FROM totals
       ), page_rows AS (
         SELECT f.* FROM filtered_locations f CROSS JOIN page_info p
          ORDER BY f.name, f.id
          LIMIT $4::int
          OFFSET (
            SELECT (page - 1)::bigint * $4::bigint
            FROM page_info
          )
       ), visible AS (
         SELECT * FROM page_rows
         UNION ALL
         SELECT l.* FROM all_locations l
          WHERE l.id = $3::text AND $3::text <> ''
            AND NOT EXISTS (SELECT 1 FROM page_rows p WHERE p.id = l.id)
       )
       SELECT p.total, p.total_pages, p.page,
              v.id, v.business_id, v.name
         FROM page_info p
         LEFT JOIN visible v ON true
        ORDER BY v.name NULLS LAST, v.id`,
      [
        input.businessId,
        input.searchPattern,
        input.focusLocationId,
        input.pageSize,
        input.requestedPage,
      ],
    ),
  );
}
