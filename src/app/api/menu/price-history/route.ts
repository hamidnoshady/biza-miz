import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  isPriceChangeSource,
  latestPriceChangesByItem,
  listPriceHistory,
  type PriceChangeSource,
} from "@/lib/menu-price-service";

/**
 * The price-history screen's read — issue #844.
 *
 * `?latest=1` answers the items tab's «آخرین تغییر قیمت» column with one
 * newest-change row per item of the branch. Otherwise: the history list with
 * the screen's filters (item search, category, source, user, date range),
 * newest first. Read-only, `menu.view` — the same gate as the menu itself;
 * the *write* paths are the privileged ones.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const params = request.nextUrl.searchParams;

  if (params.get("latest") === "1") {
    return NextResponse.json({ latest: await latestPriceChangesByItem(location.id) });
  }

  const rawSources = params.getAll("source");
  const sources: PriceChangeSource[] = [];
  for (const source of rawSources) {
    for (const part of source.split(",")) {
      if (isPriceChangeSource(part)) sources.push(part);
    }
  }

  const rows = await listPriceHistory(location.id, {
    menuItemId: params.get("itemId"),
    categoryId: params.get("categoryId"),
    search: params.get("search"),
    changedBy: params.get("changedBy"),
    dateFrom: params.get("from"),
    dateTo: params.get("to"),
    sources: sources.length > 0 ? sources : null,
    limit: Number(params.get("limit") ?? "") || undefined,
  });

  return NextResponse.json({ rows });
});
