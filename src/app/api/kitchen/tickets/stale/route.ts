import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

interface StaleTicket {
  order_id: string;
  order_number: number;
  order_status: "open" | "held" | "completed";
  item_count: number;
}

export const GET = withTenantScope(async () => {
  const { error: kitchenError } = await requirePermission(PERMISSIONS.kitchenView);
  if (kitchenError) return kitchenError;

  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ tickets: [] });

  // Only review tickets currently eligible for the live board. A newly sent
  // item keeps the whole ticket out of the stale preview.
  const { rows: tickets } = await query<StaleTicket>(
    `SELECT o.id AS order_id, o.order_number, o.status AS order_status,
            COUNT(*)::int AS item_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id AND o.location_id = oi.location_id
      WHERE oi.location_id = $1
        AND o.status IN ('open', 'held', 'completed')
        AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
        AND oi.status IN ('sent', 'preparing', 'ready')
      GROUP BY o.id, o.order_number, o.status
     HAVING COUNT(oi.sent_to_kitchen_at) = COUNT(*)
        AND MAX(oi.sent_to_kitchen_at) <= now() - interval '60 days'
      ORDER BY MAX(oi.sent_to_kitchen_at), o.id`,
    [location.id],
  );

  return NextResponse.json({ tickets }, { headers: { "Cache-Control": "no-store" } });
});
