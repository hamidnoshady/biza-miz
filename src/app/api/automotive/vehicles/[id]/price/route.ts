import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { listVehiclePriceHistory, updateVehiclePrice } from "@/lib/automotive-service";
import { redactVehicleCostSensitive } from "@/lib/automotive";
import { handleAutomotiveError, holdsPermission, readBody, vehicleBranchContext } from "../../../guard";

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
  const { access, response: branchError } = await vehicleBranchContext(session, id, { mutation: true });
  if (branchError) return branchError;
  const locationId = access.activeLocationId!;
  const body = await readBody(request);

  const parsePrice = (key: string, nullable: boolean): { valid: boolean; value: number | null | undefined } => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return { valid: true, value: undefined };
    const raw = body[key];
    if (nullable && (raw === "" || raw == null)) return { valid: true, value: null };
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0
      ? { valid: true, value: parsed }
      : { valid: false, value: undefined };
  };
  const asking = parsePrice("askingPriceRial", false);
  const minimum = parsePrice("minimumPriceRial", true);
  const wholesale = parsePrice("wholesalePriceRial", true);
  const promotional = parsePrice("promotionalPriceRial", true);
  for (const [field, parsed] of [
    ["askingPriceRial", asking], ["minimumPriceRial", minimum],
    ["wholesalePriceRial", wholesale], ["promotionalPriceRial", promotional],
  ] as const) {
    if (!parsed.valid) return NextResponse.json({ error: "invalid_price", field }, { status: 400 });
  }

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
  const wantsCostSensitivePriceChange = ["wholesalePriceRial", "promotionalPriceRial"].some((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (wantsCostSensitivePriceChange) {
    const allowed = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    if (!allowed) {
      return NextResponse.json(
        { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesCostView },
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
      locationId,
      askingPriceRial: asking.value ?? undefined,
      minimumPriceRial: minimum.value,
      wholesalePriceRial: wholesale.value,
      promotionalPriceRial: promotional.value,
      reason: typeof body.reason === "string" ? body.reason : null,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    const priceHistory = await listVehiclePriceHistory(session.businessId, id, undefined, { locationId });
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      ...result,
      priceHistory: canSeeCost ? priceHistory : priceHistory.map((entry) => redactVehicleCostSensitive(entry)),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
