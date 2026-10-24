import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { resolveFloorSnapshotCapabilities } from "@/lib/floor";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { normalizeTimeZone } from "@/lib/reservations";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Full floor-plan snapshot for `/accounting/floor`:
 *   - `timezone`: active branch IANA timezone
 *   - `sections`: floor sections with their assigned staff member
 *   - `tables`: active dining tables with geometry, manual physical status,
 *     active visit session summary (`session_id`, `party_size`, `guest_name`,
 *     `session_note`), derived active order count (`active_order_count`,
 *     `order_count`, `session_total`), authorized read-only `open_orders`, and
 *     next `upcoming_reservation`
 *   - `archivedTables`: inactive tables (only for `tables.edit` holders)
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      timezone: "Asia/Tehran",
      sections: [],
      tables: [],
      archivedTables: [],
    });
  }
  const loc = location.id;

  const { canSeeOrders, canEditTables } = await resolveFloorSnapshotCapabilities(session);

  const [sectionsRes, tablesRes, archivedRes, reservationsRes] = await Promise.all([
    query(
      `SELECT fs.id, fs.name, fs.color, fs.assigned_waiter_id, u.full_name AS waiter_name, fs.sort_order
         FROM floor_sections fs
         LEFT JOIN users u ON u.id = fs.assigned_waiter_id
        WHERE fs.location_id = $1
        ORDER BY fs.sort_order, fs.name`,
      [loc],
    ),
    query(
      `SELECT dt.id, dt.name, dt.zone, dt.section_id, dt.capacity, dt.status,
              dt.pos_x, dt.pos_y, dt.width, dt.height, dt.shape, dt.sort_order, dt.note,
              ts.id AS session_id, ts.party_size, ts.guest_name,
              ts.opened_at AS session_opened_at, ts.bill_requested_at, ts.note AS session_note,
              (SELECT COUNT(*)::int FROM orders o
                 WHERE o.location_id = dt.location_id
                   AND o.status IN ('open', 'held')
                   AND (o.table_id = dt.id OR (ts.id IS NOT NULL AND o.table_session_id = ts.id AND o.table_id IS NULL))
              ) AS active_order_count,
              (SELECT COUNT(*)::int FROM orders o
                 WHERE o.location_id = dt.location_id
                   AND o.status != 'voided'
                   AND ((ts.id IS NOT NULL AND o.table_session_id = ts.id) OR (o.table_id = dt.id AND o.status IN ('open', 'held')))
              ) AS order_count,
              (SELECT COALESCE(SUM(o.total), 0) FROM orders o
                 WHERE o.location_id = dt.location_id
                   AND o.status != 'voided'
                   AND ((ts.id IS NOT NULL AND o.table_session_id = ts.id) OR (o.table_id = dt.id AND o.status IN ('open', 'held')))
              ) AS session_total,
              COALESCE((
                SELECT json_agg(
                         json_build_object(
                           'id', o.id,
                           'order_number', o.order_number,
                           'status', o.status::text,
                           'total', o.total,
                           'opened_at', o.opened_at
                         )
                         ORDER BY o.opened_at ASC, o.id ASC
                       )
                  FROM orders o
                 WHERE $2::boolean
                   AND o.location_id = dt.location_id
                   AND o.status IN ('open', 'held')
                   AND (o.table_id = dt.id OR (ts.id IS NOT NULL AND o.table_session_id = ts.id AND o.table_id IS NULL))
              ), '[]'::json) AS open_orders
         FROM dining_tables dt
         LEFT JOIN table_session_tables tst
                ON tst.table_id = dt.id AND tst.released_at IS NULL
         LEFT JOIN table_sessions ts
                ON ts.id = tst.session_id AND ts.status = 'open'
        WHERE dt.location_id = $1 AND dt.is_active
        ORDER BY dt.sort_order, dt.name`,
      [loc, canSeeOrders],
    ),
    canEditTables
      ? query(
          `SELECT dt.id, dt.name, dt.zone, dt.section_id, dt.capacity, dt.status,
                  dt.pos_x, dt.pos_y, dt.width, dt.height, dt.shape, dt.sort_order, dt.note
             FROM dining_tables dt
            WHERE dt.location_id = $1 AND NOT dt.is_active
            ORDER BY dt.sort_order, dt.name`,
          [loc],
        )
      : Promise.resolve({ rows: [] }),
    query(
      `SELECT DISTINCT ON (table_id)
              id, table_id, customer_name, party_size, reserved_at, duration_minutes
         FROM reservations
        WHERE location_id = $1 AND table_id IS NOT NULL AND status = 'booked'
          AND reserved_at >= now() - interval '30 minutes'
          AND reserved_at <= now() + interval '12 hours'
        ORDER BY table_id, reserved_at`,
      [loc],
    ),
  ]);

  const nextResByTable = new Map(reservationsRes.rows.map((r) => [r.table_id, r]));

  const tablesOut = tablesRes.rows.map((t) => ({
    ...t,
    upcoming_reservation: nextResByTable.get(t.id) ?? null,
  }));

  return NextResponse.json({
    timezone: normalizeTimeZone(location.timezone),
    sections: sectionsRes.rows,
    tables: tablesOut,
    archivedTables: archivedRes.rows,
  });
});
