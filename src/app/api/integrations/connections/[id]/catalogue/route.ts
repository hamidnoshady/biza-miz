import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { catalogueFor } from "@/lib/integrations/sync-service";
import { classifyWooProductType } from "@/lib/integrations/woo-catalogue";

/**
 * The synced catalogue, as the dashboard shows it: every mapped product with
 * its WooCommerce type, its retail item kind (or nothing, for an F&B menu
 * item), its categories, its variation attributes, and its local stock and
 * price.
 *
 * One shape for both industries on purpose. F&B writes `menu_items` and
 * retail writes `items` + `item_stock`, and a screen that had to know which
 * would be two screens.
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const url = new URL(request.url);
  const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const parsedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  const page = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);
  const pageSize = Math.min(100, Math.max(10, Number.isFinite(parsedPageSize) ? parsedPageSize : 25));
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase().slice(0, 200);
  const type = (url.searchParams.get("type") ?? "").trim();

  const { industry, rows } = await catalogueFor(session.businessId, id);

  const summary = {
    total: rows.length,
    sellable: rows.filter((r) => r.sellable).length,
    containers: rows.filter((r) => !r.sellable).length,
    variations: rows.filter((r) => classifyWooProductType(r.wooType) === "variation").length,
    outOfStock: rows.filter((r) => r.quantity === 0).length,
    uncategorised: rows.filter((r) => r.categories.length === 0).length,
  };

  const filtered = rows.filter((row) => {
    if (type && row.wooType !== type) return false;
    if (!search) return true;
    const haystack = [row.name, row.sku ?? "", row.wooType, ...row.categories, ...row.attributes]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });
  const offset = (page - 1) * pageSize;

  return NextResponse.json({
    industry,
    summary,
    total: filtered.length,
    page,
    pageSize,
    products: filtered.slice(offset, offset + pageSize).map((row) => ({
      ...row,
      priceRial: row.priceRial === null ? null : row.priceRial.toString(),
    })),
  });
});
