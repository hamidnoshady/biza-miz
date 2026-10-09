import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { listVehicleCosts, recordVehicleCost } from "@/lib/automotive-service";
import type { VehicleExpenseCategory, VehicleExpensePosting } from "@/lib/automotive";
import { handleAutomotiveError, readBody } from "../../../guard";

const SETTLEMENTS = new Set(["cash", "bank", "payable", "clearing"]);

/** §5 — every cost on one car, active and voided, so the history is the whole truth. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesCostView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;

  try {
    return NextResponse.json({ costs: await listVehicleCosts(session.businessId, id) });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/**
 * Records money spent on one car, with the explicit capitalize-vs-period choice
 * §5 demands. Gated on `vehicles.expense_record` — the act of spending against a
 * vehicle is its own permission, separate from editing its details.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesExpenseRecord);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const settlement = String(body.settlement ?? "payable");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await recordVehicleCost(client, {
      businessId: session.businessId,
      serialId: id,
      cost: {
        category: String(body.category ?? "other") as VehicleExpenseCategory,
        posting: (body.posting === "period_expense" ? "period_expense" : "capitalized") as VehicleExpensePosting,
        amountRial: Number(body.amountRial ?? 0),
        incurredOn: String(body.incurredOn ?? ""),
        vendorPartyId: typeof body.vendorPartyId === "string" ? body.vendorPartyId : null,
        documentRef: typeof body.documentRef === "string" ? body.documentRef : null,
        notes: typeof body.notes === "string" ? body.notes : null,
        settlement: (SETTLEMENTS.has(settlement) ? settlement : "payable") as never,
      },
      createdBy: session.sub,
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
