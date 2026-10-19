import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import * as floor from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";
import { openSession, setSessionGuests } from "@/lib/table-session-service";
import { broadcast } from "@/lib/realtime";

/** Open table sessions (with their tables), for a management/list view. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ sessions: [] });

  const { rows: sessions } = await query(
    `SELECT ts.id, ts.primary_table_id, ts.party_size, ts.guest_name, ts.guest_phone,
            ts.opened_at, ts.bill_requested_at, ts.note,
            COALESCE(json_agg(json_build_object('id', dt.id, 'name', dt.name)
                     ORDER BY dt.name) FILTER (WHERE dt.id IS NOT NULL), '[]') AS tables,
            (SELECT COALESCE(SUM(o.total), 0) FROM orders o
               WHERE o.table_session_id = ts.id AND o.status != 'voided') AS total
       FROM table_sessions ts
       LEFT JOIN table_session_tables tst ON tst.session_id = ts.id AND tst.released_at IS NULL
       LEFT JOIN dining_tables dt ON dt.id = tst.table_id
      WHERE ts.location_id = $1 AND ts.status = 'open'
      GROUP BY ts.id
      ORDER BY ts.opened_at`,
    [location.id],
  );
  return NextResponse.json({ sessions });
});

/** Seat a walk-in: open a session on one or more free tables. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
  if (error) return error;

  let body: {
    tableIds?: unknown;
    tableId?: string;
    partySize?: number;
    guestName?: string;
    guestPhone?: string;
    note?: string;
    customerIds?: (string | null | undefined)[];
    ignoreUpcomingReservation?: boolean;
    turnaroundMinutes?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.tableIds !== undefined && !Array.isArray(body.tableIds)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawIds = Array.isArray(body.tableIds)
    ? body.tableIds
    : body.tableId
      ? [body.tableId]
      : [];
  const tableIds = rawIds
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean);
  if (tableIds.length === 0) {
    return NextResponse.json({ error: "table_required" }, { status: 400 });
  }
  if (new Set(tableIds).size !== tableIds.length) {
    return NextResponse.json({ error: "duplicate_table_ids" }, { status: 400 });
  }

  if (body.partySize !== undefined && body.partySize !== null) {
    const ps = Number(body.partySize);
    if (!Number.isInteger(ps) || ps <= 0 || ps > 500) {
      return NextResponse.json({ error: "invalid_party_size" }, { status: 400 });
    }
  }
  const partySize =
    Number.isFinite(body.partySize) && Number(body.partySize) > 0
      ? Math.round(Number(body.partySize))
      : null;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (typeof floor.checkTableSectionAuthorization === "function") {
    const sectionAuth = await floor.checkTableSectionAuthorization(session, location.id, tableIds);
    if (sectionAuth && !sectionAuth.allowed) {
      return NextResponse.json({ error: "section_not_assigned" }, { status: 403 });
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { id } = await openSession(client, {
      locationId: location.id,
      tableIds,
      partySize,
      guestName: body.guestName?.trim() || null,
      guestPhone: body.guestPhone?.trim() || null,
      note: body.note?.trim() || null,
      openedBy: session.sub,
      checkUpcomingReservations: body.ignoreUpcomingReservation === false,
      turnaroundMinutes: body.turnaroundMinutes,
    });
    if (Array.isArray(body.customerIds)) {
      await setSessionGuests(client, {
        businessId: session.businessId,
        locationId: location.id,
        sessionId: id,
        customerIds: body.customerIds,
        partySize,
      });
    }
    await client.query("COMMIT");
    for (const tid of tableIds) {
      broadcast(location.id, { type: "table.status", tableId: tid, status: "seated" });
    }
    broadcast(location.id, { type: "table_session.updated", sessionId: id });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    await client.query("ROLLBACK");
    const code = (err as { code?: string }).code;
    const status = (err as { status?: number }).status;
    const details = (err as { details?: unknown }).details;
    if (code && status) {
      const firstConflict = Array.isArray(details) ? details[0] : details;
      return NextResponse.json(
        details !== undefined
          ? {
              error: code,
              conflicts: details,
              details,
              reservation: firstConflict,
            }
          : { error: code },
        { status },
      );
    }
    throw err;
  } finally {
    client.release();
  }
});
