import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItem, listItems } from "@/lib/items-service";
import {
  listWatchAttributes,
  upsertWatchAttributes,
  type WatchItemAttributesInput,
} from "@/lib/watch-attributes-service";

/** The watch catalogue: one `tracking: 'serial'` item per model; its physical units live under /api/watch/units. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  // Phase 6 (issue #795): the models list carries the structured
  // attributes, one extra query for the whole catalogue.
  const [items, attributes] = await Promise.all([
    listItems(location.id),
    listWatchAttributes(location.id),
  ]);
  return NextResponse.json({
    items: items
      .filter((i) => i.tracking === "serial")
      .map((i) => ({ ...i, attributes: attributes.get(i.id) ?? null })),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  let body: {
    name?: string;
    sku?: string | null;
    serviceIntervalMonths?: number | null;
    attributes?: WatchItemAttributesInput | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const item = await createItem({
      locationId: location.id,
      name,
      sku: body.sku?.trim() || null,
      tracking: "serial",
      serviceIntervalMonths:
        body.serviceIntervalMonths == null ? null : Number(body.serviceIntervalMonths),
    });
    // Phase 6 (issue #795): the structured attributes ride the same create.
    const attributes = body.attributes ? await upsertWatchAttributes(item.id, body.attributes) : null;
    return NextResponse.json({ ok: true, item: { ...item, attributes } });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
