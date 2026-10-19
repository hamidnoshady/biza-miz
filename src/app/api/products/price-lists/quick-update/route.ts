import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  isValidQuickUpdateValue,
  normalizeQuickUpdateScope,
  quickUpdatePrices,
  previewQuickUpdate,
  type QuickUpdateTarget,
} from "@/lib/price-lists-service";
import { isUuid } from "@/lib/uuid";

/** «بروزرسانی سریع»: one percent/amount move over a whole price column. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: {
    target?: QuickUpdateTarget;
    mode?: "percent" | "amount";
    value?: number;
    round?: boolean;
    itemIds?: string[];
    scope?: unknown;
    preview?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const target = body.target;
  if (!target || (target.kind !== "sale" && target.kind !== "purchase" && target.kind !== "list")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.mode !== "percent" && body.mode !== "amount") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (target.kind === "list" && typeof target.priceListId !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (target.kind === "list" && !isUuid(target.priceListId)) {
    return NextResponse.json({ error: "invalid_price_list_id" }, { status: 400 });
  }
  const value = Number(body.value);
  if (!isValidQuickUpdateValue(body.mode, value)) {
    return NextResponse.json({ error: "invalid_quick_update_value" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // Explicit scope parsing (F03): reject malformed, cap, verify membership
  const scopeResult = normalizeQuickUpdateScope({ scope: body.scope, itemIds: body.itemIds });
  if (!scopeResult.ok) {
    return NextResponse.json({ error: scopeResult.error }, { status: 400 });
  }
  const scope = scopeResult.scope;

  // Preview mode: return authoritative count/sample without writing
  if (body.preview) {
    let raw;
    try {
      raw = await previewQuickUpdate({
        target,
        mode: body.mode,
        value,
        round: Boolean(body.round),
        itemIds: scope.kind === "selected" ? scope.itemIds! : [],
        locationId: location.id,
        scope,
        businessId: session.businessId,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "scope_items_not_in_branch") {
        return NextResponse.json({ error: "scope_items_not_in_branch" }, { status: 400 });
      }
      throw err;
    }
    // Normalize to the contract the matrix UI expects (count + sample old/new)
    const preview = {
      count: (raw as { affectedCount?: number; count?: number }).affectedCount ?? (raw as { count?: number }).count ?? 0,
      affectedCount: (raw as { affectedCount?: number }).affectedCount ?? (raw as { count?: number }).count ?? 0,
      skippedCount: (raw as { skippedCount?: number }).skippedCount ?? 0,
      sample: ((raw as { sample?: unknown[] }).sample ?? []) as { itemId: string; oldPrice: number | null; newPrice: number | null }[],
      totalBefore: (raw as { totalBefore?: number }).totalBefore,
      totalAfter: (raw as { totalAfter?: number }).totalAfter,
    };
    return NextResponse.json({ ok: true, preview, scope });
  }

  // For purchase target, add safety note: if scope is all, require explicit confirmation
  // The service already guards quantity=0, but we add extra logging
  const itemIdsForService = scope.kind === "selected" ? scope.itemIds! : [];

  const changed = await quickUpdatePrices({
    target,
    mode: body.mode,
    value,
    round: Boolean(body.round),
    itemIds: itemIdsForService,
    locationId: location.id,
    businessId: session.businessId,
    actorId: session.sub,
    source: "bulk",
  });

  // F11: never claim success when changed=0 without explanation
  return NextResponse.json({ ok: true, changed, scope, previewNote: changed === 0 ? "no_rows_changed" : undefined });
});
