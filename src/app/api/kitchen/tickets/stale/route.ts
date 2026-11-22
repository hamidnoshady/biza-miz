import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { query, withTenantTransaction } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

const activeLines = `
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id AND o.location_id = oi.location_id
 WHERE oi.location_id = $1
   AND o.status IN ('open', 'held', 'completed')
   AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
   AND oi.status IN ('sent', 'preparing', 'ready')
   AND oi.kitchen_archived_at IS NULL
   AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())`;

const staleOrder = `
  GROUP BY o.id, o.order_number, o.status
 HAVING COUNT(oi.sent_to_kitchen_at) = COUNT(*)
    AND MAX(oi.sent_to_kitchen_at) <= now() - interval '60 days'`;

const permissions = [PERMISSIONS.kitchenView, PERMISSIONS.settingsManage] as const;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermissions(...permissions);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ tickets: [] });
  const history = new URL(request.url).searchParams.get("view") === "history";

  const { rows: tickets } = await query(
    history
      ? `SELECT o.id AS order_id, o.order_number, o.status AS order_status,
                COUNT(*)::int AS item_count, entry.archived_at,
                oi.kitchen_archived_by AS archived_by, entry.reason
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id AND o.location_id = oi.location_id
           CROSS JOIN LATERAL (
             SELECT COALESCE(oi.kitchen_archived_at, oi.kitchen_clear_at) AS archived_at,
                    COALESCE(oi.kitchen_archive_reason, 'timer') AS reason
           ) entry
          WHERE oi.location_id = $1 AND entry.archived_at <= now()
          GROUP BY o.id, o.order_number, o.status, entry.archived_at,
                   oi.kitchen_archived_by, entry.reason
          ORDER BY entry.archived_at DESC, o.id
          LIMIT 100`
      : `SELECT o.id AS order_id, o.order_number, o.status AS order_status,
                COUNT(*)::int AS item_count
           ${activeLines}
           ${staleOrder}
          ORDER BY MAX(oi.sent_to_kitchen_at), o.id
          LIMIT 100`,
    [location.id],
  );

  return NextResponse.json({ tickets }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermissions(...permissions);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body: { orderIds?: unknown } | null = await request.json().catch(() => null);
  const orderIds = body?.orderIds;
  if (
    !Array.isArray(orderIds) ||
    orderIds.length === 0 ||
    orderIds.length > 100 ||
    !orderIds.every((id) => typeof id === "string" && uuid.test(id))
  ) {
    return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  }

  const archivedCount = await withTenantTransaction(
    session.businessId,
    async () => {
      // Match the parent lock taken by order mutations and kitchen transitions.
      await query(
        `SELECT id FROM orders
          WHERE location_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id FOR UPDATE`,
        [location.id, orderIds],
      );

      const { rows } = await query<{ count: number }>(
        `WITH eligible AS (
           SELECT o.id
           ${activeLines}
             AND o.id = ANY($2::uuid[])
           ${staleOrder}
         ), archived AS (
           UPDATE order_items oi
              SET kitchen_archived_at = now(), kitchen_archived_by = $3,
                  kitchen_archive_reason = 'stale_manual'
             FROM eligible
            WHERE oi.order_id = eligible.id AND oi.location_id = $1
              AND oi.kitchen_archived_at IS NULL
              AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())
              AND oi.status IN ('sent', 'preparing', 'ready')
            RETURNING oi.order_id
         )
         SELECT COUNT(DISTINCT order_id)::int AS count FROM archived`,
        [location.id, orderIds, session.sub],
      );
      return rows[0]?.count ?? 0;
    },
    { locationId: location.id, userId: session.sub },
  );

  return NextResponse.json({ archivedCount });
});
