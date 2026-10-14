import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getPool, query } from "@/lib/db";
import { transferSerialUnit, SerialTransferError } from "@/lib/watch-transfer-service";

/**
 * Issue #795 — moving one serialized unit to another branch: the canonical
 * transfer operation (accounting-neutral — the business-scoped inventory
 * account holds the cost basis on both sides; the domain event is the
 * audit trail).
 */

/** The destination choices: this business's OTHER active branches. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ destinations: [] });

  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations
      WHERE business_id = $1 AND is_active AND id <> $2
      ORDER BY name`,
    [session.businessId, location.id],
  );
  return NextResponse.json({ destinations: rows });
});

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: { toLocationId?: string; note?: string | null };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.toLocationId) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await transferSerialUnit(client, {
        businessId: session.businessId,
        fromLocationId: location.id,
        toLocationId: body.toLocationId,
        serialId: id,
        note: body.note ?? null,
        createdBy: session.sub,
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, toItemId: result.toItemId });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof SerialTransferError) {
        return NextResponse.json(
          { error: "transfer_failed", message: err.message },
          { status: err.status },
        );
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
