import { query, withoutTenantScope } from "../db";

/**
 * Background-only retention, same narrow shape as pruneExpiredExports:
 * one cross-tenant UPDATE drops expired encrypted data, returning a count,
 * never recipient rows. No request body, ids or tenant data enter this bypass.
 * Metadata (staff/store/order/template/printer/status) remains auditable.
 */
export async function pruneExpiredWooSnapshots(): Promise<number> {
  const { rowCount } = await withoutTenantScope("platform", () => query(
    `UPDATE print_jobs SET render_snapshot = NULL
      WHERE document_type IN ('shipping_label', 'woo_invoice') AND render_snapshot IS NOT NULL
        AND created_at < now() - interval '30 days'`,
  ));
  return rowCount ?? 0;
}
