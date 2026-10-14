import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getPool } from "@/lib/db";
import {
  listSerialReturns,
  requestSerialReturn,
  SerialReturnError,
} from "@/lib/watch-return-service";

/**
 * Issue #795 Phase 3 — the serialized customer-return workflow
 * (requested → received_for_inspection → dispositioned).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ returns: [] });

  const returns = await listSerialReturns(session.businessId, location.id);
  return NextResponse.json({ returns });
});

/** Opens a return claim for the exact serial of an exact completed invoice. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { orderId?: string | null; serialId?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.serialId || !body.reason?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await requestSerialReturn(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: body.orderId ?? null,
      serialId: body.serialId,
      reason: body.reason,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: result.id, orderId: result.orderId });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof SerialReturnError) {
      return NextResponse.json({ error: "return_failed", message: err.message }, { status: err.status });
    }
    throw err;
  } finally {
    client.release();
  }
});
