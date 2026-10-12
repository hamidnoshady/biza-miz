import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { parsePrinterInput } from "@/lib/printing/printer-input";
import { PRINTER_COLUMNS } from "@/lib/printing/printer-columns";
import { connectionJsonOf } from "@/lib/printing/types";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * All hardware for the active branch, including inactive printers.
 *
 * The row is the single source of truth for behaviour: purpose, paper,
 * drawer, cut, defaultness and activity are relational columns, and the
 * `connection` jsonb holds the hardware target and nothing else.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  try {
    const { rows: printers } = await query(
      `SELECT ${PRINTER_COLUMNS}
         FROM printers
        WHERE location_id = $1
        ORDER BY kind, is_default DESC, name`,
      [location.id],
    );
    return NextResponse.json({ printers });
  } catch (err) {
    console.error("listing printers failed", err);
    return NextResponse.json({ error: "printer_list_failed", printers: [] }, { status: 500 });
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = parsePrinterInput(body);
  if (!input) return NextResponse.json({ error: "invalid_printer" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) {
      await client.query(
        `UPDATE printers SET is_default = false WHERE location_id = $1 AND kind = $2`,
        [location.id, input.kind],
      );
    }
    const { rows } = await client.query(
      `INSERT INTO printers
         (location_id, name, kind, connection, is_active, printer_class, supports_drawer, supports_cut, is_default, paper, paper_width_mm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${PRINTER_COLUMNS}`,
      [
        location.id,
        input.name,
        input.kind,
        JSON.stringify(connectionJsonOf(input.connection)),
        input.isActive,
        input.printerClass,
        input.openDrawer,
        input.supportsCut,
        input.isDefault,
        input.paper,
        input.paperWidthMm,
      ],
    );
    await client.query("COMMIT");
    return NextResponse.json({ printer: rows[0] }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Keep database details out of the response but leave an actionable code
    // in the UI and the real failure in server logs.
    console.error("saving printer failed", err);
    return NextResponse.json({ error: "printer_save_failed" }, { status: 500 });
  } finally {
    client.release();
  }
});
