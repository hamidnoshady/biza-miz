import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listWeightItems } from "@/lib/items-service";
import { createJewelryPiece } from "@/lib/specialist-product-creation";
import { validateWeightAttributes } from "@/lib/gold";
import { recordItemEvent } from "@/lib/item-audit-service";

  // Cashier included on the read side only: selling from the invoice screen
  // means listing what is in stock, exactly as /api/menu's GET is readable by
  // every floor role. The write handlers below stay owner/manager.
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  const items = await listWeightItems(location.id);
  return NextResponse.json({ items });
});

/** Creates a `tracking: 'weight'` jewelry piece and its weight/purity attributes together. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  let body: {
    name?: string;
    sku?: string | null;
    purity?: string;
    grossWeight?: string;
    netWeight?: string;
    unitCostPerGram?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (name.length > 200) return NextResponse.json({ error: "item_name_too_long" }, { status: 400 });

  const weightInput = {
    purity: body.purity ?? "",
    grossWeight: body.grossWeight ?? "",
    netWeight: body.netWeight ?? "",
    unitCostPerGram: body.unitCostPerGram ?? null,
  };
  // Keep the existing validation response; the native creation service also
  // wraps the item and required weight facts in a single transaction.
  const weightErrors = validateWeightAttributes(weightInput);
  if (weightErrors.length > 0) {
    return NextResponse.json({ error: "invalid_weight_attributes", message: weightErrors.join("؛ ") }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const item = await createJewelryPiece({
    businessId: session.businessId,
    locationId: location.id,
    userId: session.sub,
    name,
    sku: body.sku ?? null,
    weight: weightInput,
  });
  await recordItemEvent({
    businessId: session.businessId,
    locationId: location.id,
    itemId: item.id,
    eventType: "item.created",
    payload: { name, ...weightInput },
    createdBy: session.sub,
  });
  return NextResponse.json({ ok: true, id: item.id });
});
