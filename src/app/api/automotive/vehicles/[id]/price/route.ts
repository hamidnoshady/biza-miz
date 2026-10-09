import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { listVehiclePriceHistory, updateVehiclePrice } from "@/lib/automotive-service";
import { handleAutomotiveError, holdsPermission, readBody } from "../../../guard";

/**
 * §6 — changing what the dealership asks. The minimum price is the owner's
 * floor, so writing it is not part of ordinary price editing: it needs
 * `vehicles.override_min_price`, the same key a sale below the floor needs.
 * Asking/wholesale/promotional are `vehicles.price_edit`.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesPriceEdit);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readBody(request);

  const numberOrNull = (key: string): number | null | undefined => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
    const value = body[key];
    if (value === "" || value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const wantsFloorChange = Object.prototype.hasOwnProperty.call(body, "minimumPriceRial");
  if (wantsFloorChange) {
    const allowed = await holdsPermission(session, PERMISSIONS.vehiclesOverrideMinPrice);
    if (!allowed) {
      return NextResponse.json(
        { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesOverrideMinPrice },
        { status: 403 },
      );
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await updateVehiclePrice(client, {
      businessId: session.businessId,
      serialId: id,
      askingPriceRial: numberOrNull("askingPriceRial") ?? undefined,
      minimumPriceRial: wantsFloorChange ? (numberOrNull("minimumPriceRial") ?? null) : undefined,
      wholesalePriceRial: numberOrNull("wholesalePriceRial"),
      promotionalPriceRial: numberOrNull("promotionalPriceRial"),
      reason: typeof body.reason === "string" ? body.reason : null,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    const priceHistory = await listVehiclePriceHistory(session.businessId, id);
    return NextResponse.json({ ok: true, ...result, priceHistory });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
