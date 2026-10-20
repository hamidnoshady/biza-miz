import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createPriceList,
  listPriceLists,
  listPriceMatrix,
  normalizePriceMatrixQuery,
} from "@/lib/price-lists-service";

/**
 * One bounded page of the matrix: the list definitions plus the item window and
 * only that window's filled cells (issue #924 F12, code-review item 1).
 *
 * `q`, `limit` and `offset` are clamped server-side (`limit` defaults to 50 and
 * never exceeds 200), so no caller — a stale client, a hand-edited URL, the
 * quick-update screen — can ask this endpoint for a whole large catalogue.
 * `total`/`hasMore` let the client page without guessing.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  const url = new URL(request.url);
  const page = normalizePriceMatrixQuery({
    q: url.searchParams.get("q"),
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  if (!location) {
    return NextResponse.json({
      lists: [],
      items: [],
      entries: [],
      total: 0,
      limit: page.limit,
      offset: page.offset,
      hasMore: false,
    });
  }

  const [lists, matrix] = await Promise.all([
    listPriceLists(location.id),
    listPriceMatrix(location.id, page),
  ]);
  return NextResponse.json({
    lists,
    items: matrix.items,
    entries: matrix.entries,
    total: matrix.total,
    limit: matrix.limit,
    offset: matrix.offset,
    hasMore: matrix.hasMore,
  });
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
