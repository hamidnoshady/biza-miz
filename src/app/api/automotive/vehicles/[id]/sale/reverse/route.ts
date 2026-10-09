import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { reverseVehicleSale } from "@/lib/automotive-sales-service";
import { handleAutomotiveError, readBody } from "../../../../guard";

/**
 * §8 — unwinding a car sale.
 *
 * This is the deliberate, manager-approved path, and it does the whole job in
 * one transaction: it mirrors the exact ledger entries the vehicle line posted
 * (revenue, VAT and the tender the money came in through, plus COGS against
 * vehicle inventory), and it puts the car in `returned` — never silently back
 * in `in_stock`, so a car that sold and came back says so. Selling it again is a
 * separate, deliberate act after the car is brought back to the shelf.
 *
 * It needs `vehicles.sell` (the same key that let the car leave) on top of the
 * trade check, and it demands a reason: «چرا این فروش برگشت» is the question the
 * owner reads in the audit trail afterwards.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesSell);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "reason_required", message: "دلیل برگشت فروش الزامی است." }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseVehicleSale(client, {
      businessId: session.businessId,
      serialId: id,
      reason,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
