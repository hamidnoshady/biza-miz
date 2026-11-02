import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, updateItemMeta, type ItemMetaPatch } from "@/lib/items-service";
import {
  isProductPublishStatus,
  normalizeProductDescription,
  PRODUCT_LONG_DESCRIPTION_MAX,
  PRODUCT_SHORT_DESCRIPTION_MAX,
} from "@/lib/product-content";

/**
 * The add/edit product form's write path for the Phase 42 product columns —
 * name, barcode, units, ordering hints, tax percents, sellability. Stock and
 * pricing stay with each trade's own `/api/<trade>/items/[id]/stock`, the one
 * writer the receipt and sale paths already trust.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
    if (error) return error;
    const industryError = await requireProductWorkspaceForApi(session);
    if (industryError) return industryError;

    const { id } = await context.params;
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const item = await getItem(id);
    if (!item || item.locationId !== location.id) {
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }

    let body: ItemMetaPatch;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    if (body.publishStatus !== undefined && !isProductPublishStatus(body.publishStatus)) {
      return NextResponse.json({ error: "invalid_publish_status" }, { status: 400 });
    }
    for (const [key, max] of [
      ["shortDescription", PRODUCT_SHORT_DESCRIPTION_MAX],
      ["longDescription", PRODUCT_LONG_DESCRIPTION_MAX],
    ] as const) {
      if (body[key] === undefined) continue;
      const normalized = normalizeProductDescription(body[key], max);
      if (!normalized.ok) return NextResponse.json({ error: normalized.reason, field: key }, { status: 400 });
      body[key] = normalized.value;
    }

    const numeric = (value: unknown) =>
      value === null || value === undefined || value === "" ? null : Number(value);
    for (const key of [
      "conversionFactor",
      "minOrderQty",
      "reorderReminderQty",
      "leadTimeDays",
      "taxSalePercent",
      "taxPurchasePercent",
    ] as const) {
      const converted = numeric(body[key]);
      if (converted !== null && !Number.isFinite(converted)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      (body as Record<string, unknown>)[key] = converted;
    }

    const updated = await updateItemMeta(id, body);
    if (!updated) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, item: updated });
  },
);
