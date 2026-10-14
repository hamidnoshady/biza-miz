import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveSectionId } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";
import { canTransitionTable, type TableStatus } from "@/lib/table-sessions";
import { broadcast } from "@/lib/realtime";

/**
 * Edit a table. Managers can change its name/section/capacity/geometry (floor
 * editor). A `status` change is a table-state-machine transition (e.g. mark a
 * table clean: cleaning → free) and is validated against the allowed moves;
 * cashiers/waiters may drive those without full edit rights.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;

  let body: {
    name?: string;
    zone?: string | null;
    sectionId?: string | null;
    capacity?: number;
    isActive?: boolean;
    posX?: number;
    posY?: number;
    width?: number;
    height?: number;
    shape?: string;
    status?: TableStatus;
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
    body.posX !== undefined ||
    body.posY !== undefined ||
    body.width !== undefined ||
    body.height !== undefined ||
    body.shape !== undefined;
  const isOperationalStatusChange = body.status !== undefined;
  if (!isStructuralEdit && !isOperationalStatusChange) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Structure and operations are separate capabilities. A request that mixes
  // both kinds of mutation must hold both permissions; status-only changes
  // remain available to cashiers and waiters with `tables.manage`.
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
    const { rows: dup } = await query(
      "SELECT id FROM dining_tables WHERE location_id = $1 AND name = $2 AND id <> $3",
      [location.id, name, id],
    );
    if (dup.length > 0) return NextResponse.json({ error: "table_exists" }, { status: 409 });
    set("name", name);
  }
  if (body.zone !== undefined) set("zone", body.zone?.trim() || null);
  if (body.sectionId !== undefined) {
    const sectionId = await resolveSectionId(location.id, body.sectionId);
    if (sectionId === false) return NextResponse.json({ error: "section_not_found" }, { status: 400 });
    set("section_id", sectionId);
  }
  if (body.capacity !== undefined) {
    const capacity = Number(body.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    set("capacity", capacity);
  }
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (body.posX !== undefined && Number.isFinite(body.posX)) set("pos_x", Math.max(0, Math.round(Number(body.posX))));
  if (body.posY !== undefined && Number.isFinite(body.posY)) set("pos_y", Math.max(0, Math.round(Number(body.posY))));
  if (body.width !== undefined && Number.isFinite(body.width)) {
    set("width", Math.min(400, Math.max(30, Math.round(Number(body.width)))));
  }
  if (body.height !== undefined && Number.isFinite(body.height)) {
    set("height", Math.min(400, Math.max(30, Math.round(Number(body.height)))));
  }
  if (body.shape !== undefined) set("shape", body.shape === "circle" ? "circle" : "rect");

  if (body.status !== undefined) {
    const to = body.status;
    // 'bill_requested' is intentionally absent: asking for the bill is no
    // longer a table state anyone can set, because the bill is not the
    // table's. Existing rows still render it; nothing creates a new one.
    const validTargets: TableStatus[] = ["free", "seated", "cleaning", "out_of_service"];
    if (!validTargets.includes(to)) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    if (existing[0].status !== to && !canTransitionTable(existing[0].status, to)) {
      return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
    }
    // Direct status changes here are for tables without an active session
    // (e.g. marking a dirty table clean, or out-of-service). Occupied tables
    // are driven through the session lifecycle instead.
    if (to === "seated") {
      return NextResponse.json({ error: "seat_via_session" }, { status: 409 });
    }
    set("status", to);
  }

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await query(`UPDATE dining_tables SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  if (body.status !== undefined) {
    broadcast(location.id, { type: "table.status", tableId: id, status: body.status });
  }
  return NextResponse.json({ ok: true });
});

/** Delete (deactivate) a table. Blocked while it holds an active session. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.tablesEdit);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const { rows: existing } = await query("SELECT id FROM dining_tables WHERE id = $1 AND location_id = $2", [
    id,
    location.id,
  ]);
  if (existing.length === 0) return NextResponse.json({ error: "table_not_found" }, { status: 404 });

  const { rows: active } = await query(
    "SELECT 1 FROM table_session_tables WHERE table_id = $1 AND released_at IS NULL",
    [id],
  );
  if (active.length > 0) return NextResponse.json({ error: "table_in_use" }, { status: 409 });

  await query("UPDATE dining_tables SET is_active = false, section_id = NULL, status = 'free' WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
});
