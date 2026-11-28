import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { WELL_KNOWN_CODES } from "@/lib/coa-template";
import {
  applyMarkdown,
  listMarkdownCandidates,
  withMerchandisingTransaction,
} from "@/lib/merchandising-service";

const INVENTORY_ACCOUNT_CODE: Record<string, string> = {
  accessories: WELL_KNOWN_CODES.accessoryInventory,
  cosmetics: WELL_KNOWN_CODES.cosmeticInventory,
  wholesale: WELL_KNOWN_CODES.wholesaleInventory,
  tools_fittings: WELL_KNOWN_CODES.toolsInventory,
  haberdashery: WELL_KNOWN_CODES.haberdasheryInventory,
  // Issue #1567 — markdowns relieve the trade's own merchandise inventory.
  fashion_apparel: WELL_KNOWN_CODES.fashionInventory,
};

function inventoryCodeFor(industry: string | null): string | null {
  return industry ? (INVENTORY_ACCOUNT_CODE[industry] ?? null) : null;
}

/** The markdown planner: slow/dead stock, with near-expiry cosmetics first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
  if (!industry || !inventoryCodeFor(industry)) {
    return NextResponse.json({ error: "industry_unavailable" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ candidates: [] });

  const todayIso = new Date().toISOString().slice(0, 10);
  const candidates = await listMarkdownCandidates(session.businessId, location.id, todayIso);
  return NextResponse.json({ candidates });
});

/**
 * Applies an accepted markdown: a new price on the sell screen, nothing else
 * (GH #1567 F3). The result flags `belowCost` when the price signals NRV below
 * cost; the write-down itself is `/api/inventory/item-write-downs` (reviewed).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
  const inventoryAccountCode = inventoryCodeFor(industry);
  if (!industry || !inventoryAccountCode) {
    return NextResponse.json({ error: "industry_unavailable" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { itemId?: string; newPrice?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.itemId || typeof body.newPrice !== "number") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await withMerchandisingTransaction((client) =>
      applyMarkdown(client, {
        businessId: session.businessId,
        locationId: location.id,
        itemId: body.itemId!,
        newPrice: body.newPrice!,
        inventoryAccountCode,
        createdBy: session.sub,
      }),
    );
    return NextResponse.json({ ok: true, markdown: result });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
