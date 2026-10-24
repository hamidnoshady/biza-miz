import { NextRequest, NextResponse } from "next/server";
import { getPool, query } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { resolveAutomotiveOfflineCapability } from "@/lib/automotive-offline";
import {
  isTradeInDifferenceSettlement,
  redactVehicleCostSensitive,
  type VehicleBodyType,
  type VehicleCondition,
  type VehicleDrivetrain,
  type VehicleFuelType,
  type VehicleTransmission,
  type VehicleYearCalendar,
} from "@/lib/automotive";
import { ledgerSettlementFor, type PaymentSettlement } from "@/lib/payment-methods";
import {
  executeTradeIn,
  listTradeInsForVehicle,
  type TradeInVehicleInput,
} from "@/lib/automotive-trade-in-service";
import { handleAutomotiveError, holdsPermission, readBody, vehicleBranchContext } from "../guard";

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTradeInVehicle(raw: Record<string, unknown>): TradeInVehicleInput {
  return {
    make: text(raw, "make") ?? "",
    model: text(raw, "model") ?? "",
    trim: text(raw, "trim"),
    vehicleYearCalendar: (raw.vehicleYearCalendar === "gregorian" ? "gregorian" : "jalali") as VehicleYearCalendar,
    modelYear: optionalNumber(raw, "modelYear"),
    productionYear: optionalNumber(raw, "productionYear"),
    vin: text(raw, "vin"),
    chassisNumber: text(raw, "chassisNumber"),
    engineNumber: text(raw, "engineNumber"),
    plateNumber: text(raw, "plateNumber"),
    stockNumber: text(raw, "stockNumber"),
    bodyType: text(raw, "bodyType") as VehicleBodyType | null,
    transmission: text(raw, "transmission") as VehicleTransmission | null,
    fuelType: text(raw, "fuelType") as VehicleFuelType | null,
    engineSpec: text(raw, "engineSpec"),
    drivetrain: text(raw, "drivetrain") as VehicleDrivetrain | null,
    exteriorColor: text(raw, "exteriorColor"),
    interiorColor: text(raw, "interiorColor"),
    condition: (raw.condition === "new" ? "new" : raw.condition === "used" ? "used" : undefined) as
      | VehicleCondition
      | undefined,
    mileageKm: optionalNumber(raw, "mileageKm"),
    priorOwners: optionalNumber(raw, "priorOwners"),
    registrationDate: text(raw, "registrationDate"),
    inspectionNotes: text(raw, "inspectionNotes"),
    bodyConditionNotes: text(raw, "bodyConditionNotes"),
    mechanicalNotes: text(raw, "mechanicalNotes"),
    serviceHistory: text(raw, "serviceHistory"),
    provenanceNote: text(raw, "provenanceNote"),
  };
}

/**
 * Issue #963 (#839 §9) — record one two-sided trade-in: sell vehicle A,
 * acquire vehicle B against it, settle the difference, in one transaction.
 *
 * The gates, in order: the dedicated `vehicles.trade_in` key; the layered
 * acts it composes (`vehicles.sell`, `vehicles.create`,
 * `vehicles.cost_edit` — the same layering §4's acquire route uses); the
 * industry; and cloud authority — on a paired site (`read_only_mirror`)
 * the answer is a legible cloud-only refusal, never a queued request,
 * because the deal is decided by A's sold-once lock and B's identity
 * uniqueness on the cloud.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesTradeIn);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  for (const permission of [PERMISSIONS.vehiclesSell, PERMISSIONS.vehiclesCreate, PERMISSIONS.vehiclesCostEdit]) {
    if (!(await holdsPermission(session, permission))) {
      return NextResponse.json({ error: "MISSING_PERMISSION", permission }, { status: 403 });
    }
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const profile = await readDeploymentProfile(session.businessId);
  const capability = resolveAutomotiveOfflineCapability({
    profile: profile.profile,
    runtimeRole: deploymentRole(),
  });
  if (capability.mode === "read_only_mirror") {
    return NextResponse.json(
      {
        error: "trade_in_cloud_only",
        message: "معاوضه فقط روی سرور مرکزی ثبت می‌شود و در صف درخواست آفلاین قرار نمی‌گیرد.",
      },
      { status: 409 },
    );
  }

  const body = await readBody(request);

  // One car handed in per deal — refused loudly, never "first one wins".
  if (Array.isArray(body.tradeInVehicles) && body.tradeInVehicles.length > 1) {
    return NextResponse.json(
      {
        error: "multi_trade_in_not_supported",
        message: "در هر معامله فقط یک خودرو می‌تواند معاوضه شود؛ برای چند خودرو، معامله‌های جدا ثبت کنید.",
      },
      { status: 400 },
    );
  }
  const tradeInRaw =
    (body.tradeIn as Record<string, unknown> | undefined) ??
    (Array.isArray(body.tradeInVehicles) ? (body.tradeInVehicles[0] as Record<string, unknown> | undefined) : undefined);
  if (!tradeInRaw || typeof tradeInRaw !== "object") {
    return NextResponse.json(
      { error: "invalid_trade_in", message: "مشخصات خودروی معاوضه ارسال نشده است." },
      { status: 400 },
    );
  }

  const soldSerialId = text(body, "soldSerialId");
  const customerId = text(body, "customerId");
  if (!soldSerialId || !customerId) {
    return NextResponse.json(
      { error: "invalid_trade_in", message: "خودروی فروخته‌شده و مشتری الزامی هستند." },
      { status: 400 },
    );
  }
  const differenceSettlement = String(body.differenceSettlement ?? "");
  if (!isTradeInDifferenceSettlement(differenceSettlement)) {
    return NextResponse.json(
      { error: "invalid_trade_in", message: "روش تسویهٔ مابه‌التفاوت معتبر نیست." },
      { status: 400 },
    );
  }

  // A, like every vehicle mutation, must be in the branch this session is
  // acting in — re-read from the session, never from the body.
  const { response: branchError } = await vehicleBranchContext(session, soldSerialId, { mutation: true });
  if (branchError) return branchError;

  const mayOverride = await holdsPermission(session, PERMISSIONS.vehiclesOverrideMinPrice);
  if (body.overrideMinPrice === true && !mayOverride) {
    return NextResponse.json(
      { error: "MISSING_PERMISSION", permission: PERMISSIONS.vehiclesOverrideMinPrice },
      { status: 403 },
    );
  }

  // The named payment way for the difference gets the sales-invoice route's
  // own agreement check: tenant-owned, active, and settling the way the
  // ledger method claims.
  const differencePaymentMethodId = text(body, "differencePaymentMethodId");
  const differenceReference = text(body, "differenceReference");
  if (differencePaymentMethodId) {
    const { rows: ways } = await query<{ settlement: string; requires_reference: boolean; is_active: boolean }>(
      `SELECT settlement::text, requires_reference, is_active FROM payment_methods
        WHERE id = $1 AND business_id = $2`,
      [differencePaymentMethodId, session.businessId],
    );
    const way = ways[0];
    if (!way || !way.is_active || ledgerSettlementFor(way.settlement as PaymentSettlement) !== differenceSettlement) {
      return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
    }
    if (way.requires_reference && !differenceReference) {
      return NextResponse.json({ error: "payment_reference_required" }, { status: 400 });
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await executeTradeIn(client, {
      businessId: session.businessId,
      locationId: location.id,
      soldSerialId,
      customerId,
      salePriceRial: Number(body.salePriceRial ?? Number.NaN),
      discountRial: optionalNumber(body, "discountRial") ?? 0,
      overrideMinPrice: body.overrideMinPrice === true && mayOverride,
      differenceSettlement,
      differencePaymentMethodId,
      differenceReference,
      tradeIn: parseTradeInVehicle(tradeInRaw),
      allowanceRial: Number(body.allowanceRial ?? Number.NaN),
      expectedRetailRial: optionalNumber(body, "expectedRetailRial") ?? 0,
      acquisitionDate: text(body, "acquisitionDate") ?? undefined,
      note: text(body, "note"),
      clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : null,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      canSeeCost,
      tradeIn: canSeeCost ? result.tradeIn : redactVehicleCostSensitive(result.tradeIn),
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      saleId: result.saleId,
      acquiredSerialId: result.acquiredSerialId,
      acquiredStockNumber: result.acquiredStockNumber,
      replayed: result.replayed,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});

/**
 * The deals one vehicle took part in, from either side. The allowance is
 * the acquired car's cost, so it follows `vehicles.cost_view` exactly like
 * every other cost field the API redacts.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const serialId = new URL(request.url).searchParams.get("serialId")?.trim();
  if (!serialId) return NextResponse.json({ error: "serial_id_required" }, { status: 400 });
  const { response: branchError } = await vehicleBranchContext(session, serialId);
  if (branchError) return branchError;

  try {
    const tradeIns = await listTradeInsForVehicle(session.businessId, serialId);
    const canSeeCost = await holdsPermission(session, PERMISSIONS.vehiclesCostView);
    return NextResponse.json({
      ok: true,
      canSeeCost,
      tradeIns: tradeIns.map((deal) => (canSeeCost ? deal : redactVehicleCostSensitive(deal))),
    });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});
