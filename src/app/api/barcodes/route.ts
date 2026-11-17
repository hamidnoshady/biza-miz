import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { withTenantTransaction } from "@/lib/db";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { assignBarcode, listBarcodes } from "@/lib/item-barcodes-service";

/**
 * Barcode assignment for every retail trade that has the `barcode` capability.
 *
 * Gated on the capability rather than a named industry (or the sales model):
 * it lives inside each trade's own module, so `requireIndustryForApi`'s
 * exact-match check cannot name it, and `capabilities` is the one place the
 * four trades switch it on.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "barcode");
  if (capabilityError) return capabilityError;

  let body: { itemId?: string; expectedLocationId?: string; code?: string | null; symbology?: string | null; note?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!itemId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (body.expectedLocationId !== undefined && body.expectedLocationId !== location.id) {
    return NextResponse.json({ error: "location_changed" }, { status: 409 });
  }

  try {
    const barcode = await withTenantTransaction(session.businessId, async (client) => {
      // Hold the item row until the code is assigned, so a branch transfer
      // cannot race the check and insert the code in a different branch.
      const { rows } = await client.query("SELECT id FROM items WHERE id = $1 AND location_id = $2 FOR UPDATE", [itemId, location.id]);
      if (!rows.length) return null;
      return assignBarcode(itemId, {
        code: typeof body.code === "string" ? body.code : null,
        symbology: typeof body.symbology === "string" ? (body.symbology as "EAN13" | "UPC" | "internal") : null,
        note: typeof body.note === "string" ? body.note : null,
      }, client);
    }, { locationId: location.id, userId: session.sub });
    if (!barcode) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, barcode });
  } catch (err) {
    return NextResponse.json({ error: "barcode_failed", message: (err as Error).message }, { status: 400 });
  }
});

/** Every code stuck to one item, for the label/management screen. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "barcode");
  if (capabilityError) return capabilityError;

  const itemId = request.nextUrl.searchParams.get("itemId") ?? "";
  if (!itemId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const item = await getItem(itemId);
  if (!item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  return NextResponse.json({ barcodes: (await listBarcodes(itemId)).filter((barcode) => barcode.locationId === location.id) });
});
