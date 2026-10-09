import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";

/**
 * The register's server-backed filter vocabulary (issue #833): the categories
 * actually in use. Branches come from `/api/locations/active` — the same
 * member-scoped list the branch switcher shows — so this stays the one
 * endpoint that is purely the register's own.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { rows } = await query<{ category: string }>(
    `SELECT DISTINCT category FROM fixed_assets
      WHERE business_id = $1 AND category IS NOT NULL AND archived_at IS NULL
      ORDER BY category`,
    [session.businessId],
  );
  return NextResponse.json({ categories: rows.map((r) => r.category) });
});
