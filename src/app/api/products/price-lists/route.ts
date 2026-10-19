import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createPriceList, listPriceEntries, listPriceLists } from "@/lib/price-lists-service";

/** The list definitions plus every filled cell, so the matrix renders in one read. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ lists: [], entries: [] });

  const [lists, entries] = await Promise.all([
    listPriceLists(location.id),
    listPriceEntries(location.id),
  ]);
  return NextResponse.json({ lists, entries });
});

/** Adds one named price list (عمده، همکار، …). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: { name?: string; currency?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { list, error: createError } = await createPriceList({
    locationId: location.id,
    name: body.name ?? "",
    currency: body.currency,
  });
  if (createError) {
    const status = createError === "duplicate_name" ? 409 : 400;
    return NextResponse.json({ error: createError }, { status });
  }
  return NextResponse.json({ ok: true, list });
});
