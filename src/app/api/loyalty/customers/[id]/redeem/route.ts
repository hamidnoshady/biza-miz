import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { getCustomer } from "@/lib/parties-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { redeemPoints } from "@/lib/loyalty-service";

/** Redeems points into store credit, in one transaction. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyRedeem);
  if (error) return error;
  const { id } = await context.params;

  const customer = await getCustomer(session.businessId, id);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { points?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessDay = await getBusinessDayStatus(location.id);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await redeemPoints(client, {
      businessId: session.businessId,
      locationId: location.id,
      customerId: id,
      points: body.points as number,
      businessDate: businessDay?.businessDate,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "redeem_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
