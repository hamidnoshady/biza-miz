import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import * as floor from "@/lib/floor";
import { recordReservationStateStandalone, recordTableSessionStateStandalone } from "@/lib/table-session-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { canTransitionTable, isValidTableStatus, type TableStatus } from "@/lib/table-sessions";
import { broadcast } from "@/lib/realtime";

type Params = { params: Promise<{ id: string }> };

async function archiveOrDeactivateTable(params: {
  businessId: string;
  locationId: string;
  userId: string;
  userRole: string;
  tableId: string;
  reassignToTableId?: string | null;
  unassignFutureReservations?: boolean;
}): Promise<NextResponse> {
  const { businessId, locationId, userId, tableId, reassignToTableId, unassignFutureReservations } = params;

  const { rows: existing } = await query<{ id: string; status?: string }>(
    "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2",
    [tableId, locationId],
  );
  if (existing.length === 0) {
    return NextResponse.json({ error: "table_not_found" }, { status: 404 });
  }

  if (reassignToTableId) {
    const targetId = String(reassignToTableId).trim();
    if (!floor.isUuid(targetId) || targetId === tableId) {
      return NextResponse.json({ error: "invalid_target_table" }, { status: 400 });
    }
    const { rows: targetRows } = await query<{ id: string; status: TableStatus }>(
      "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active",
      [targetId, locationId],
    );
    if (!targetRows[0]) {
      return NextResponse.json({ error: "table_not_found" }, { status: 404 });
    }
    if (targetRows[0].status === "cleaning" || targetRows[0].status === "out_of_service") {
      return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
    }

    await query(
      `UPDATE orders SET table_id = $1 WHERE table_id = $2 AND location_id = $3 AND status IN ('open', 'held')`,
      [targetId, tableId, locationId],
    );
    await query(
      `UPDATE table_sessions SET primary_table_id = $1 WHERE primary_table_id = $2 AND location_id = $3 AND status = 'open'`,
      [targetId, tableId, locationId],
    );
    await query(
      `UPDATE table_session_tables tst
          SET table_id = $1
         FROM table_sessions ts
        WHERE tst.session_id = ts.id
          AND ts.location_id = $3
          AND tst.table_id = $2
          AND tst.released_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM table_session_tables existing_tst
             WHERE existing_tst.table_id = $1 AND existing_tst.released_at IS NULL
          )`,
      [targetId, tableId, locationId],
    );
    await query(
      `UPDATE reservations
          SET table_id = $1, updated_at = now()
        WHERE table_id = $2
          AND location_id = $3
          AND status IN ('booked', 'seated')
          AND reserved_at + (duration_minutes || ' minutes')::interval > now()`,
      [targetId, tableId, locationId],
    );
  }

  const { rows: active } = await query<{
    active_sessions?: number;
    active_orders?: number;
    future_reservations?: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int
          FROM table_session_tables tst
          JOIN table_sessions ts ON ts.id = tst.session_id
         WHERE tst.table_id = $1
           AND ts.location_id = $2
           AND tst.released_at IS NULL
           AND ts.status = 'open') AS active_sessions,
       (SELECT COUNT(*)::int
          FROM orders o
         WHERE o.table_id = $1
           AND o.location_id = $2
           AND o.status IN ('open', 'held')) AS active_orders,
       (SELECT COUNT(*)::int
          FROM reservations r
         WHERE r.table_id = $1
           AND r.location_id = $2
           AND r.status IN ('booked', 'seated')
           AND r.reserved_at + (r.duration_minutes || ' minutes')::interval > now()) AS future_reservations`,
    [tableId, locationId],
  );
  const usage = active[0] ?? {};
  const activeSessions = Number(usage.active_sessions ?? 0);
  const activeOrders = Number(usage.active_orders ?? 0);
  const futureReservations = Number(usage.future_reservations ?? 0);

  if (activeSessions > 0 || activeOrders > 0) {
    return NextResponse.json(
      {
        error: "table_in_use",
        details: {
          activeSessionCount: activeSessions,
          activeOrderCount: activeOrders,
          futureReservationCount: futureReservations,
        },
      },
      { status: 409 },
    );
  }

  if (futureReservations > 0) {
    if (unassignFutureReservations) {
      const { rows: unassignedRes } = await query<{ id: string }>(
        `UPDATE reservations
            SET table_id = NULL, updated_at = now()
          WHERE table_id = $1
            AND location_id = $2
            AND status = 'booked'
            AND reserved_at + (duration_minutes || ' minutes')::interval > now()
          RETURNING id`,
        [tableId, locationId],
      );
      for (const r of unassignedRes ?? []) {
        await recordReservationStateStandalone({
          businessId,
          locationId,
          reservationId: r.id,
          actor: { userId },
        });
      }
    } else {
      return NextResponse.json(
        {
          error: "table_has_future_reservations",
          details: { futureReservationCount: futureReservations },
        },
        { status: 409 },
      );
    }
  }

  // Keep historical `orders.table_id` and past `reservations.table_id` intact by
  // soft-deactivating `is_active = false` without deleting the table row.
  await query(
    "UPDATE dining_tables SET is_active = false, status = 'free' WHERE id = $1 AND location_id = $2",
    [tableId, locationId],
  );

  await floor.recordFloorAudit?.({
    businessId,
    locationId,
    userId,
    action: "table.archived",
    entity: "dining_table",
    entityId: tableId,
    payload: {
      before: existing[0],
      reassignedToTableId: reassignToTableId ?? null,
      unassignFutureReservations: Boolean(unassignFutureReservations),
    },
  }).catch(() => {});

  broadcast(locationId, {
    type: "floor.updated",
    entity: "dining_table",
    entityId: tableId,
  });

  return NextResponse.json({ ok: true });
}

/**
 * Edit a table. Managers can change its name/section/capacity/geometry/note
 * (floor editor). A `status` change is a manual physical table transition
 * (`free`, `seated`, `cleaning`, `out_of_service`, `reserved`, `bill_requested`)
 * decoupled from order lifecycle: active orders never block manual status
 * changes or structural edits.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: Params) => {
  const { id } = await context.params;

  let body: {
    name?: string;
    zone?: string | null;
    sectionId?: string | null;
    capacity?: number;
    isActive?: boolean;
    sortOrder?: number;
    posX?: number;
    posY?: number;
    width?: number;
    height?: number;
    shape?: string;
    note?: string | null;
    status?: TableStatus;
    reassignToTableId?: string | null;
    unassignFutureReservations?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const isStructuralEdit =
    body.name !== undefined ||
    body.zone !== undefined ||
    body.sectionId !== undefined ||
    body.capacity !== undefined ||
    body.isActive !== undefined ||
    body.sortOrder !== undefined ||
    body.posX !== undefined ||
    body.posY !== undefined ||
    body.width !== undefined ||
    body.height !== undefined ||
    body.shape !== undefined ||
    body.note !== undefined;
  const isOperationalStatusChange = body.status !== undefined;
  if (!isStructuralEdit && !isOperationalStatusChange) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const firstGuard = await requirePermission(
    isStructuralEdit ? PERMISSIONS.tablesEdit : PERMISSIONS.tablesManage,
  );
  if (firstGuard.error) return firstGuard.error;
  if (isStructuralEdit && isOperationalStatusChange) {
    const operationalGuard = await requirePermission(PERMISSIONS.tablesManage);
    if (operationalGuard.error) return operationalGuard.error;
  }
  const session = firstGuard.session;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (isOperationalStatusChange && !isStructuralEdit && typeof floor.checkTableSectionAuthorization === "function") {
    const sectionAuth = await floor.checkTableSectionAuthorization(session, location.id, [id]);
    if (sectionAuth && !sectionAuth.allowed) {
      return NextResponse.json({ error: "section_not_assigned" }, { status: 403 });
    }
  }

  if (body.isActive === false) {
    return archiveOrDeactivateTable({
      businessId: session.businessId,
      locationId: location.id,
      userId: session.sub,
      userRole: session.role,
      tableId: id,
      reassignToTableId: body.reassignToTableId,
      unassignFutureReservations: body.unassignFutureReservations === true,
    });
  }

  const { rows: existing } = await query<{ id: string; status: TableStatus }>(
    "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2",
    [id, location.id],
  );
  if (existing.length === 0) return NextResponse.json({ error: "table_not_found" }, { status: 404 });

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const { rows: dup } = await query<{ id: string; is_active?: boolean }>(
      "SELECT id, is_active FROM dining_tables WHERE location_id = $1 AND name = $2 AND id <> $3",
      [location.id, name, id],
    );
    if (dup.length > 0) {
      return NextResponse.json(
        {
          error: dup[0].is_active === false ? "table_exists_archived" : "table_exists",
          archivedTableId: dup[0].id,
        },
        { status: 409 },
      );
    }
    set("name", name);
  }
  if (body.zone !== undefined) set("zone", body.zone?.trim() || null);
  if (body.sectionId !== undefined) {
    const sectionId = await floor.resolveSectionId(location.id, body.sectionId);
    if (sectionId === false) return NextResponse.json({ error: "section_not_found" }, { status: 400 });
    set("section_id", sectionId);
  }
  if (body.capacity !== undefined) {
    const capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 200) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    set("capacity", capacity);
  }
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (body.sortOrder !== undefined) {
    const so = Number(body.sortOrder);
    if (!Number.isFinite(so) || so < -10000 || so > 100000) {
      return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
    }
    set("sort_order", Math.round(so));
  }
  if (body.posX !== undefined) {
    const px = Number(body.posX);
    if (!Number.isFinite(px) || px < 0 || px > 5000) {
      return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
    }
    set("pos_x", Math.round(px));
  }
  if (body.posY !== undefined) {
    const py = Number(body.posY);
    if (!Number.isFinite(py) || py < 0 || py > 5000) {
      return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
    }
    set("pos_y", Math.round(py));
  }
  if (body.width !== undefined) {
    const w = Number(body.width);
    if (!Number.isFinite(w) || w < 30 || w > 400) {
      return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
    }
    set("width", Math.round(w));
  }
  if (body.height !== undefined) {
    const h = Number(body.height);
    if (!Number.isFinite(h) || h < 30 || h > 400) {
      return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
    }
    set("height", Math.round(h));
  }
  if (body.shape !== undefined) {
    if (body.shape !== "rect" && body.shape !== "circle") {
      return NextResponse.json({ error: "invalid_geometry" }, { status: 400 });
    }
    set("shape", body.shape);
  }
  if (body.note !== undefined) {
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    set("note", note);
  }

  if (body.status !== undefined) {
    if (!isValidTableStatus(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    const to = body.status;
    if (existing[0].status !== to && !canTransitionTable(existing[0].status, to)) {
      return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
    }
    set("status", to);
  }

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await query(`UPDATE dining_tables SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);

  // When a table is manually transitioned to free, cleaning, or out_of_service,
  // reconcile any active `table_session_tables` link on this table (and complete
  // any linked seated reservation if all tables in that session are now released),
  // without touching or blocking any active open/held orders on the table.
  if (
    body.status === "free" ||
    body.status === "cleaning" ||
    body.status === "out_of_service"
  ) {
    const reconciledRes = await query<{
      session_id?: string;
      closed_session_id?: string | null;
      completed_reservation_id?: string | null;
    }>(
      `WITH released_links AS (
         UPDATE table_session_tables tst
            SET released_at = now()
           FROM table_sessions ts
          WHERE tst.session_id = ts.id
            AND ts.location_id = $2
            AND tst.table_id = $1
            AND tst.released_at IS NULL
         RETURNING tst.session_id
       ),
       empty_sessions AS (
         SELECT rl.session_id
           FROM released_links rl
          WHERE NOT EXISTS (
            SELECT 1 FROM table_session_tables rem
             WHERE rem.session_id = rl.session_id
               AND rem.released_at IS NULL
               AND rem.table_id <> $1
          )
       ),
       closed_sessions AS (
         UPDATE table_sessions ts
            SET status = 'closed',
                closed_at = COALESCE(closed_at, now()),
                closed_by = COALESCE(closed_by, $3)
           FROM empty_sessions es
          WHERE ts.id = es.session_id
            AND ts.location_id = $2
            AND ts.status = 'open'
         RETURNING ts.id, ts.reservation_id
       ),
       completed_reservations AS (
         UPDATE reservations r
            SET status = 'completed',
                updated_at = now()
           FROM closed_sessions cs
          WHERE r.location_id = $2
            AND r.status = 'seated'
            AND (r.seated_session_id = cs.id OR (cs.reservation_id IS NOT NULL AND r.id = cs.reservation_id))
         RETURNING r.id, cs.id AS session_id
       )
       SELECT rl.session_id,
              cs.id AS closed_session_id,
              cr.id AS completed_reservation_id
         FROM released_links rl
         LEFT JOIN closed_sessions cs ON cs.id = rl.session_id
         LEFT JOIN completed_reservations cr ON cr.session_id = rl.session_id`,
      [id, location.id, session.sub],
    );
    for (const r of reconciledRes?.rows ?? []) {
      if (r.session_id) {
        broadcast(location.id, { type: "table_session.updated", sessionId: r.session_id });
        await recordTableSessionStateStandalone({
          locationId: location.id,
          sessionId: r.session_id,
          actor: { userId: session.sub, role: session.role },
        });
      }
      if (r.completed_reservation_id) {
        await recordReservationStateStandalone({
          businessId: session.businessId,
          locationId: location.id,
          reservationId: r.completed_reservation_id,
          actor: { userId: session.sub, role: session.role },
        });
      }
    }
  }

  await floor.recordFloorAudit?.({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    action:
      body.isActive === true
        ? "table.restored"
        : isOperationalStatusChange && !isStructuralEdit
          ? "table.status_changed"
          : "table.updated",
    entity: "dining_table",
    entityId: id,
    payload: { before: existing[0], changes: body },
  }).catch(() => {});

  if (body.status !== undefined) {
    broadcast(location.id, { type: "table.status", tableId: id, status: body.status });
  }
  if (isStructuralEdit) {
    broadcast(location.id, { type: "floor.updated", entity: "dining_table", entityId: id });
  }
  return NextResponse.json({ ok: true });
});

/** Delete (archive/deactivate) a table safely. */
export const DELETE = withTenantScope(async (request: NextRequest, context: Params) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const reassignToTableId =
    body.reassignToTableId ?? url.searchParams.get("reassignToTableId") ?? undefined;
  const unassignFutureReservations =
    body.unassignFutureReservations === true ||
    url.searchParams.get("unassignFutureReservations") === "true";

  return archiveOrDeactivateTable({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    userRole: session.role,
    tableId: id,
    reassignToTableId,
    unassignFutureReservations,
  });
});
