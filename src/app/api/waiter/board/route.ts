import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveFloorSectionAccessScope } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";

export interface WaiterTableOrder {
  id: string;
  order_number: number;
  status: string;
  total: string;
  opened_at: string;
  customer_id: string | null;
  customer_name: string | null;
  item_status_counts: Record<string, number>;
}

/**
 * Cashier/waiter table list.
 *
 * Issue #916 (Findings 5, 11, 20):
 *   - Uses `requireAnyPermission([PERMISSIONS.tablesManage, PERMISSIONS.ordersCreate, PERMISSIONS.tablesView])`
 *     so custom roles and permission overrides work alongside built-in roles.
 *   - Returns all active (`open` and `held`) orders per table (`orders: WaiterTableOrder[]`),
 *     plus `active_order_count` and summed `item_status_counts` across all active orders on
 *     that table so a ready item on an earlier order is never hidden by a newer order.
 *   - Keeps top-level `order_id` and `order_number` pointing to the latest active order
 *     for backward compatibility.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireAnyPermission(
    PERMISSIONS.tablesManage,
    PERMISSIONS.ordersCreate,
    PERMISSIONS.ordersView,
  );
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ sections: [], tables: [] });
  const loc = location.id;

  const url = new URL(request.url);
  const scopeAll = url.searchParams.get("scope") === "all";
  const scope = await resolveFloorSectionAccessScope(session, loc);

  // If the caller is assigned to one or more sections at this branch (and did not
  // request `?scope=all`), scope to their assigned sections; if they are a floating
  // staff member or manager with no pinned section, show all sections at the branch.
  const restrictToAssigned =
    !scopeAll && scope.assignedSectionIds.length > 0;

  const { rows: sections } = await query(
    `SELECT fs.id, fs.name, fs.color, fs.assigned_waiter_id, u.full_name AS waiter_name
       FROM floor_sections fs
       LEFT JOIN users u ON u.id = fs.assigned_waiter_id
      WHERE fs.location_id = $1
        AND ($2::boolean = false OR fs.assigned_waiter_id = $3)
      ORDER BY fs.sort_order, fs.name`,
    [loc, restrictToAssigned, session.sub],
  );
  const sectionIds = sections.map((section) => section.id as string);

  if (restrictToAssigned && sectionIds.length === 0) {
    return NextResponse.json({ sections: [], tables: [] });
  }

  const { rows: tables } = await query<{
    id: string;
    name: string;
    section_id: string | null;
    capacity: number;
    status: string;
    session_id: string | null;
    party_size: number | null;
    guest_name: string | null;
    session_opened_at: string | null;
  }>(
    `SELECT dt.id, dt.name, dt.section_id, dt.capacity, dt.status,
            ts.id AS session_id, ts.party_size, ts.guest_name, ts.opened_at AS session_opened_at
       FROM dining_tables dt
       LEFT JOIN table_session_tables tst ON tst.table_id = dt.id AND tst.released_at IS NULL
       LEFT JOIN table_sessions ts ON ts.id = tst.session_id AND ts.status = 'open'
      WHERE dt.location_id = $1 AND dt.is_active
        AND ($2::boolean = false OR dt.section_id = ANY($3::uuid[]) OR dt.section_id IS NULL)
      ORDER BY dt.sort_order, dt.name`,
    [loc, restrictToAssigned, sectionIds],
  );

  const { rows: activeOrdersRows } = await query<{
    id: string;
    table_id: string | null;
    table_session_id: string | null;
    order_number: number;
    status: string;
    total: string;
    opened_at: Date;
    customer_id: string | null;
    customer_name: string | null;
  }>(
    `SELECT o.id, o.table_id, o.table_session_id, o.order_number,
            o.status::text AS status, o.total::text AS total, o.opened_at,
            o.customer_id, p.name AS customer_name
       FROM orders o
       LEFT JOIN parties p ON p.id = o.customer_id
      WHERE o.location_id = $1
        AND o.status IN ('open', 'held')
        AND (o.table_id IS NOT NULL OR o.table_session_id IS NOT NULL)
      ORDER BY o.opened_at DESC, o.id DESC`,
    [loc],
  );

  const orderIds = activeOrdersRows.map((o) => o.id);
  const countsByOrder = new Map<string, Record<string, number>>();
  if (orderIds.length > 0) {
    const { rows: itemCounts } = await query<{
      order_id: string;
      status: string;
      n: string;
    }>(
      `SELECT order_id, status::text AS status, COUNT(*)::text AS n
         FROM order_items
        WHERE order_id = ANY($1::uuid[]) AND status != 'voided'
        GROUP BY order_id, status`,
      [orderIds],
    );
    for (const row of itemCounts) {
      if (!countsByOrder.has(row.order_id)) countsByOrder.set(row.order_id, {});
      countsByOrder.get(row.order_id)![row.status] = Number(row.n);
    }
  }

  const ordersByTableId = new Map<string, WaiterTableOrder[]>();
  const ordersBySessionId = new Map<string, WaiterTableOrder[]>();

  for (const row of activeOrdersRows) {
    const entry: WaiterTableOrder = {
      id: row.id,
      order_number: Number(row.order_number),
      status: row.status,
      total: String(row.total ?? "0"),
      opened_at: row.opened_at instanceof Date ? row.opened_at.toISOString() : String(row.opened_at),
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      item_status_counts: countsByOrder.get(row.id) ?? {},
    };
    if (row.table_id) {
      const list = ordersByTableId.get(row.table_id) ?? [];
      list.push(entry);
      ordersByTableId.set(row.table_id, list);
    } else if (row.table_session_id) {
      const list = ordersBySessionId.get(row.table_session_id) ?? [];
      list.push(entry);
      ordersBySessionId.set(row.table_session_id, list);
    }
  }

  const tablesOut = tables.map((table) => {
    const seen = new Set<string>();
    const tableOrders: WaiterTableOrder[] = [];
    for (const o of ordersByTableId.get(table.id) ?? []) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        tableOrders.push(o);
      }
    }
    if (table.session_id) {
      for (const o of ordersBySessionId.get(table.session_id) ?? []) {
        if (!seen.has(o.id)) {
          seen.add(o.id);
          tableOrders.push(o);
        }
      }
    }

    const summedCounts: Record<string, number> = {};
    for (const o of tableOrders) {
      for (const [status, count] of Object.entries(o.item_status_counts)) {
        summedCounts[status] = (summedCounts[status] ?? 0) + count;
      }
    }

    const latestOrder = tableOrders[0] ?? null;

    return {
      ...table,
      orders: tableOrders,
      active_order_count: tableOrders.length,
      order_id: latestOrder?.id ?? null,
      order_number: latestOrder?.order_number ?? null,
      item_status_counts: summedCounts,
    };
  });

  return NextResponse.json({ sections, tables: tablesOut });
});
