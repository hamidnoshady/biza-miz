import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import * as floor from "@/lib/floor";
import { recordTableSessionStateStandalone } from "@/lib/floor-sync";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isValidTableStatus, type TableStatus } from "@/lib/table-sessions";
import {
  computeSessionBill,
  releaseSessionWithoutOrders,
  mergeTableIntoSession,
  setSessionGuests,
} from "@/lib/table-session-service";
import { broadcast } from "@/lib/realtime";

/** Session detail: header, its tables, its guests, its orders, and the combined bill. */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
    if (error) return error;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const { rows: sessions } = await query(
      `SELECT ts.id, ts.status, ts.primary_table_id, ts.party_size, ts.guest_name, ts.guest_phone,
              ts.reservation_id, ts.note, ts.opened_at, ts.bill_requested_at, ts.closed_at
         FROM table_sessions ts
        WHERE ts.id = $1 AND ts.location_id = $2`,
      [id, location.id],
    );
    if (sessions.length === 0) {
      return NextResponse.json({ error: "session_not_found" }, { status: 404 });
    }

    const access = await memberAccessFor(session).catch(() => null);
    const perms = access?.permissions ?? new Set<string>();
    const canSeeCustomerPhone =
      session.role === "owner" ||
      session.role === "manager" ||
      perms.has(PERMISSIONS.partiesView) ||
      perms.has(PERMISSIONS.partiesManage) ||
      perms.has(PERMISSIONS.reservationsManage);

    const { rows: tables } = await query(
      `SELECT dt.id, dt.name, dt.capacity, dt.status
         FROM table_session_tables tst JOIN dining_tables dt ON dt.id = tst.table_id
        WHERE tst.session_id = $1 AND tst.released_at IS NULL
        ORDER BY dt.name`,
      [id],
    );

    const { rows: rawGuests } = await query<{
      guestNumber: number;
      customerId: string;
      customerName: string;
      customerPhone: string | null;
    }>(
      `SELECT tsc.guest_number AS "guestNumber", tsc.customer_id AS "customerId",
              c.name AS "customerName", c.phone AS "customerPhone"
         FROM table_session_customers tsc
         JOIN parties c ON c.id = tsc.customer_id
        WHERE tsc.session_id = $1
        ORDER BY tsc.guest_number`,
      [id],
    );

    const guests = rawGuests.map((g) => ({
      ...g,
      customerPhone: canSeeCustomerPhone ? g.customerPhone : null,
    }));

    const { rows: orders } = await query(
      `SELECT o.id, o.order_number, o.status, o.subtotal, o.discount, o.service_charge,
              o.tax, o.total, o.opened_at, o.customer_id, p.name AS customer_name
         FROM orders o
         LEFT JOIN parties p ON p.id = o.customer_id
        WHERE o.table_session_id = $1 AND o.location_id = $2
        ORDER BY o.opened_at`,
      [id, location.id],
    );

    const bill = await computeSessionBill(location.id, id);

    const sessionOut = {
      ...sessions[0],
      guest_phone: canSeeCustomerPhone ? sessions[0].guest_phone : null,
    };

    return NextResponse.json({ session: sessionOut, tables, guests, orders, bill });
  },
);

interface PatchBody {
  action?: "release" | "merge" | "set_note" | "set_guests" | "update";
  tableId?: string;
  note?: string;
  partySize?: number | null;
  guestName?: string | null;
  guestPhone?: string | null;
  customerIds?: (string | null)[];
  nextTableStatus?: TableStatus | null;
}

/** Session lifecycle actions. */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.tablesManage);
    if (error) return error;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: PatchBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (typeof floor.checkTableSectionAuthorization === "function") {
      const { rows: sessionTables } = await query<{ table_id: string }>(
        `SELECT table_id FROM table_session_tables WHERE session_id = $1 AND released_at IS NULL`,
        [id],
      );
      const currentTableIds = (sessionTables ?? []).map((r) => r.table_id);
      if (currentTableIds.length > 0) {
        const auth = await floor.checkTableSectionAuthorization(
          session,
          location.id,
          currentTableIds,
        );
        if (auth && !auth.allowed) {
          return NextResponse.json({ error: "section_not_assigned" }, { status: 403 });
        }
      }
    }

    if (body.action === "set_note") {
      const { rows } = await query(
        "UPDATE table_sessions SET note = $3 WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING id",
        [id, location.id, body.note?.trim() || null],
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: "session_not_found" }, { status: 404 });
      }
      await recordTableSessionStateStandalone({
        locationId: location.id,
        sessionId: id,
        actor: { userId: session.sub, role: session.role },
      });
      broadcast(location.id, { type: "table_session.updated", sessionId: id });
      return NextResponse.json({ ok: true });
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      if (body.action === "set_guests") {
        await setSessionGuests(client, {
          businessId: session.businessId,
          locationId: location.id,
          sessionId: id,
          customerIds: body.customerIds ?? [],
          partySize: body.partySize,
        });
      } else if (body.action === "release") {
        if (
          body.nextTableStatus !== undefined &&
          body.nextTableStatus !== null &&
          !isValidTableStatus(body.nextTableStatus)
        ) {
          throw Object.assign(new Error("invalid_status"), {
            code: "invalid_status",
            status: 400,
          });
        }
        const nextStatus = body.nextTableStatus !== undefined ? body.nextTableStatus : "free";
        const releasedTableIds = await releaseSessionWithoutOrders(
          client,
          location.id,
          id,
          session.sub,
          { nextTableStatus: nextStatus },
        );
        await client.query("COMMIT");
        if (nextStatus) {
          for (const tid of releasedTableIds) {
            broadcast(location.id, { type: "table.status", tableId: tid, status: nextStatus });
          }
        }
        broadcast(location.id, { type: "table_session.updated", sessionId: id });
        return NextResponse.json({ ok: true });
      } else if (body.action === "merge") {
        if (!body.tableId) {
          throw Object.assign(new Error("table_required"), {
            code: "table_required",
            status: 400,
          });
        }
        await mergeTableIntoSession(client, location.id, id, body.tableId);
      } else {
        throw Object.assign(new Error("bad_request"), { code: "bad_request", status: 400 });
      }
      await client.query("COMMIT");
      broadcast(location.id, { type: "table_session.updated", sessionId: id });
      return NextResponse.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      const code = (err as { code?: string }).code;
      const status = (err as { status?: number }).status;
      if (code) return NextResponse.json({ error: code }, { status: status ?? 409 });
      throw err;
    } finally {
      client.release();
    }
  },
);
