import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getConnection } from "@/lib/integrations/connections-service";
import { catalogueFor } from "@/lib/integrations/sync-service";
import { productQueueStates } from "@/lib/integrations/woo-ops-service";
import {
  catalogueSummary,
  catalogueTypeFacets,
  filterCatalogueRows,
  paginateCatalogueRows,
  sortCatalogueRows,
} from "@/lib/integrations/woo-catalogue";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";

/**
 * The synced catalogue, as the dashboard shows it: every mapped product with
 * its WooCommerce type, its retail item kind (or nothing, for an F&B menu
 * item), its categories, its variation attributes, its local stock and
 * price — and, since issue #943, the store's own last-seen presentation
 * (publish status, manage_stock, regular/sale price) plus the product's live
 * outbox state, so «queued / failed / last sent» is a fact on the row rather
 * than something the UI has to guess.
 *
 * One shape for both industries on purpose. F&B writes `menu_items` and
 * retail writes `items` + `item_stock`, and a screen that had to know which
 * would be two screens.
 *
 * Authorization is `woocommerce.view`, not `integrations.view`: this is the
 * WP Manager's product surface, and gating it on the technical-connection
 * privilege both locked out members granted only the WooCommerce
 * capabilities and leaned on a permission that is about configuring
 * connections, not reading a shopfront catalogue. Configuring the connection
 * itself still requires `integrations.*`.
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  // A wrong-provider id (Holoo shares this table since migration 0103) is a
  // 404, not a 400: this route speaks WooCommerce, and the caller does not
  // get to probe which other integrations the tenant holds.
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const parsedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  const page = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);
  const pageSize = Math.min(100, Math.max(10, Number.isFinite(parsedPageSize) ? parsedPageSize : 25));
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase().slice(0, 200);
  const type = (url.searchParams.get("type") ?? "").trim();

  const { industry, rows } = await catalogueFor(session.businessId, id);
  const moneyUnit = await resolveBusinessMoneyUnit(session.businessId);

  // One ordered list feeds every number on the screen: the summary and the
  // type facets see the WHOLE catalogue (so a type that exists only on
  // another page is still selectable), and the filter and the page slice use
  // the same predicate and the same deterministic order (name → remote id),
  // so paging cannot repeat or skip a row and the UI never re-filters with a
  // second, disagreeing rule.
  const ordered = sortCatalogueRows(rows);
  const summary = catalogueSummary(ordered);
  const types = catalogueTypeFacets(ordered);
  const filtered = filterCatalogueRows(ordered, { search, type });
  const pageSlice = paginateCatalogueRows(filtered, page, pageSize);

  const queue = await productQueueStates(
    session.businessId,
    id,
    pageSlice.rows.map((row) => row.remoteId),
  );

  return NextResponse.json({
    industry,
    moneyUnit,
    connection: {
      currencyUnit: connection.currency_unit,
      linkMode: connection.link_mode,
      status: connection.status,
      pushStock: connection.push_stock,
      pushPrices: connection.push_prices,
      syncProducts: connection.sync_products,
      lastCatalogueSyncAt: connection.last_catalogue_sync_at,
      lastError: connection.last_error,
    },
    summary,
    types,
    total: pageSlice.total,
    totalPages: pageSlice.totalPages,
    page: pageSlice.page,
    pageSize: pageSlice.pageSize,
    products: pageSlice.rows.map((row) => ({
      ...row,
      priceRial: row.priceRial === null ? null : row.priceRial.toString(),
      queue: queue[row.remoteId] ?? null,
    })),
  });
});
