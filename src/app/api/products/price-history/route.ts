import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { isProductPriceKind, isProductPriceSource } from "@/lib/price-history-labels";
import { listPriceHistory } from "@/lib/price-history";
import type { ProductPriceKind, ProductPriceSource } from "@/lib/price-history-labels";

/**
 * The retail price-history read — issue #924 F07.
 *
 * The write side appends a row for every manual, bulk, import, AI, sync,
 * system and recommendation change; this is how a shopkeeper (or an auditor)
 * sees them. It answers the matrix's per-item history dialog and any report
 * built on the same shape.
 *
 * Filters: `itemId` (a single product), `kind` (`sale` | `purchase` | `list`),
 * `source` (repeatable or comma-separated, validated against the vocabulary)
 * and `limit` (default 100, hard maximum 500). Branch-scoped by
 * `location_id`; `inventory.view` is enough to read, which matches the screen.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [] });

  const params = request.nextUrl.searchParams;
  const itemId = params.get("itemId");
  if (itemId && !isUuid(itemId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = params.get("kind");
  if (kind && !isProductPriceKind(kind)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // An unknown source is a client bug, not an empty report: say so instead of
  // silently answering "no changes", which would read as "nothing happened".
  const sources: ProductPriceSource[] = [];
  for (const raw of params.getAll("source")) {
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (!isProductPriceSource(trimmed)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      sources.push(trimmed);
    }
  }

  const rows = await listPriceHistory(location.id, {
    itemId,
    priceKind: (kind as ProductPriceKind | null) ?? null,
    sources: sources.length > 0 ? sources : null,
    limit: Number(params.get("limit") ?? "") || undefined,
  });

  return NextResponse.json({ rows });
});
