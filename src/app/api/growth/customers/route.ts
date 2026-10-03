import { NextRequest, NextResponse } from "next/server";
import { LIFECYCLE_STAGES } from "@/lib/crm-scoring";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getBusinessDek } from "@/lib/business-keys";
import { decryptOptional } from "@/lib/field-crypto";
import { partySearchClause } from "@/lib/parties-service";
import { isUuid } from "@/lib/uuid";

/**
 * Growth & Marketing's customer projection.
 *
 * The customer *row* is the shared `parties` record — Growth keeps no second
 * customer table. What makes this screen Growth's is the columns it answers
 * against: lifecycle/RFM stage, loyalty points, purchase history. Adding and
 * editing happen here too, through the same party form and the same endpoint
 * every other app writes with; only the 360° file (notes, tags, timeline)
 * stays behind the CRM's own gates.
 */

/** The projection's page size — the screen asks for a page, never the table. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface GrowthCustomerRow extends Record<string, unknown> {
  customer_id: string;
  name: string;
  phone: string | null;
  phone_enc: unknown;
  is_active: boolean;
  lifecycle_stage: string | null;
  points: number;
  order_count: number;
  total_spent: string | null;
  last_purchase_date: string | null;
  total_count: string | number;
}

export interface GrowthCustomer {
  id: string;
  displayName: string;
  phone: string | null;
  isActive: boolean;
  lifecycleStage: string | null;
  points: number;
  orderCount: number;
  totalSpentRial: number;
  lastPurchaseDate: string | null;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.growthView);
  if (error) return error;

  const searchParams = request.nextUrl.searchParams;
  const q = searchParams.get("q")?.trim() ?? "";
  const id = searchParams.get("id")?.trim() ?? "";
  // Archived customers are part of the marketing file — a suppression list is
  // exactly the audience a campaign must be able to see — but the default view
  // is the live base, matching every other party screen.
  const includeInactive =
    searchParams.get("includeInactive") === "1" || searchParams.get("includeInactive") === "true";

  const pageSize = clampInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const page = clampInt(searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);

  // `WHERE c.id = $n` against a `uuid` column does not answer "no such row" for
  // a non-uuid — it raises a syntax error, which surfaces as a 500. A deep link
  // carrying junk is an empty result, not a crash.
  if (id && !isUuid(id)) {
    return NextResponse.json({ customers: [], total: 0, page: 1, pageSize, businessId: session.businessId });
  }

  const conditions = [
    "c.business_id = $1",
    // Overlap, not equality: since migration 0148 one person can hold several
    // roles, and a supplier who also buys coffee belongs in the marketing base.
    "c.roles && ARRAY['customer']::text[]",
    "c.merged_into_id IS NULL",
  ];
  const params: unknown[] = [session.businessId];

  if (id) {
    params.push(id);
    // Deep-link support: a customer outside the first projection page can still
    // be opened by its shared record id — and an archived one must resolve too,
    // or the hand-off from A/R lands on an empty screen.
    conditions.push(`c.id = $${params.length}`);
  } else {
    if (!includeInactive) conditions.push("c.is_active");
    // Audience filter (issue #764): one lifecycle stage, validated against the
    // CRM's own vocabulary so an unknown value is ignored, never interpolated.
    const stage = searchParams.get("stage")?.trim() ?? "";
    if (stage && stage in LIFECYCLE_STAGES) {
      params.push(stage);
      conditions.push(`c.lifecycle_stage = $${params.length}`);
    }
    if (q) {
      // The directory's own matcher, not a second definition of it: blind index,
      // last four, Persian digits and escaped wildcards. Hand-rolling
      // `LOWER(name) LIKE …` here meant a typed phone found nobody once the
      // plaintext column was encrypted, and a typed «%» listed the whole base.
      const clause = await partySearchClause(session.businessId, q, params.length + 1, "c.");
      conditions.push(clause.sql);
      params.push(...clause.params);
    }
  }

  const where = conditions.join(" AND ");
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const { rows } = await query<GrowthCustomerRow>(
    `SELECT c.id AS customer_id, c.name, c.phone, c.phone_enc,
            c.is_active AS is_active,
            c.lifecycle_stage AS lifecycle_stage,
            COALESCE(ps.points, 0)::int AS points,
            COALESCE(os.order_count, 0)::int AS order_count,
            COALESCE(os.total_spent, 0)::bigint AS total_spent,
            os.last_purchase_date::text AS last_purchase_date,
            COUNT(*) OVER ()::bigint AS total_count
       FROM parties c
       LEFT JOIN LATERAL (
         SELECT GREATEST(COALESCE(SUM(points), 0), 0)::int AS points
           FROM customer_points
          WHERE customer_id = c.id AND business_id = $1
            AND (expires_at IS NULL OR expires_at >= current_date)
       ) ps ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS order_count,
                COALESCE(SUM(o.total), 0)::bigint AS total_spent,
                MAX(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS last_purchase_date
           FROM orders o
           JOIN locations l ON l.id = o.location_id
          WHERE o.customer_id = c.id AND l.business_id = $1
            AND o.status = 'completed' AND o.closed_at IS NOT NULL
       ) os ON true
      WHERE ${where}
      ORDER BY c.name, c.id
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  // The plaintext `phone` column is being encrypted away (Phase 24 Wave 3): a
  // projection that reads it directly shows «—» for every customer of a
  // business that has finished the backfill. Read the envelope, same as the
  // party directory does.
  const dek = await getBusinessDek(session.businessId);

  const customers: GrowthCustomer[] = rows.map((row) => ({
    id: row.customer_id,
    displayName: row.name,
    phone: decryptOptional(row.phone_enc, dek, row.phone ?? null),
    isActive: row.is_active,
    lifecycleStage: row.lifecycle_stage,
    points: Number(row.points ?? 0),
    orderCount: Number(row.order_count ?? 0),
    totalSpentRial: Number(row.total_spent ?? 0),
    lastPurchaseDate: row.last_purchase_date,
  }));

  // `businessId` namespaces the form's local drafts — already in the session this
  // route read, same as the parties listing.
  return NextResponse.json({
    customers,
    total: Number(rows[0]?.total_count ?? 0),
    page,
    pageSize,
    businessId: session.businessId,
  });
});

/** A query-string integer, or the default when it is absent or nonsense. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
