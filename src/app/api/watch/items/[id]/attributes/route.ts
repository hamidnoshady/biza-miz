import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import {
  getWatchAttributes,
  upsertWatchAttributes,
  type WatchItemAttributesInput,
} from "@/lib/watch-attributes-service";

/**
 * Issue #795 Phase 6 — a model's structured attributes (reference,
 * movement, case, water resistance, …). PUT replaces the whole set;
 * an all-empty body clears it.
 */
async function ownedItem(locationId: string | null, id: string) {
  if (!locationId) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== locationId || item.tracking !== "serial") return null;
  return item;
}

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    const item = await ownedItem(location?.id ?? null, id);
    if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

    return NextResponse.json({ attributes: await getWatchAttributes(id) });
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    const item = await ownedItem(location?.id ?? null, id);
    if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

    let body: WatchItemAttributesInput;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    try {
      const attributes = await upsertWatchAttributes(id, body);
      return NextResponse.json({ ok: true, attributes });
    } catch (err) {
      return NextResponse.json(
        { error: "validation_failed", message: (err as Error).message },
        { status: 400 },
      );
    }
  },
);
