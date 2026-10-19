import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { query } from "@/lib/db";

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
  const rawLimit = Number(params.get("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;

  try {
    const where = ["location_id = $1"];
    const values: unknown[] = [location.id];
    if (itemId) {
      values.push(itemId);
      where.push(`item_id = $${values.length}::uuid`);
    }
    values.push(limit);
    const { rows } = await query<{
      id: string;
      item_id: string;
      price_kind: string;
      price_list_id: string | null;
      old_price: string | null;
      new_price: string | null;
      source: string;
      actor_id: string | null;
      created_at: Date;
      reason: string | null;
    }>(
      `SELECT id, item_id, price_kind, price_list_id, old_price::text, new_price::text, source, actor_id, created_at, reason
         FROM product_price_history
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return NextResponse.json({
      rows: rows.map((r) => ({
        id: r.id,
        itemId: r.item_id,
        priceKind: r.price_kind,
        priceListId: r.price_list_id,
        oldPrice: r.old_price == null ? null : Number(r.old_price),
        newPrice: r.new_price == null ? null : Number(r.new_price),
        source: r.source,
        actorId: r.actor_id,
        createdAt: r.created_at,
        reason: r.reason,
      })),
    });
  } catch {
    // Table may not exist yet — return empty
    return NextResponse.json({ rows: [] });
  }
});
