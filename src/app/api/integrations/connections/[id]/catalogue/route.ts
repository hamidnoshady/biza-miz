import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cataloguePageFor } from "@/lib/integrations/sync-service";
import { productQueueStates } from "@/lib/integrations/woo-ops-service";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";

/**
 * The synced catalogue, as the dashboard shows it: every mapped product with
 * its WooCommerce type, its retail item kind (or nothing, for an F&B menu
 * item), its categories, its variation attributes, its local stock and
 * price — and, since issue #943, the store's own last-seen presentation
 * (publish status, manage_stock, regular/sale price, primary image) plus the
 * product's live outbox state, so «queued / failed / last sent» is a fact on
 * the row rather than something the UI has to guess.
 *
 * One shape for both industries on purpose. F&B writes `menu_items` and
 * retail writes `items` + `item_stock`, and a screen that had to know which
 * would be two screens.
 *
 * Since issue #943 (item 1) the paging itself lives in the database:
 * `cataloguePageFor` scopes every read to this tenant + this connection and
 * computes search, the type facet, the facets, the summary counts and the
 * page slice in SQL over one CTE, with a stable name → remote-id ordering.
 * This route no longer materialises the whole catalogue per request, and no
 * number on the screen can disagree with the rows under it.
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

  const connection = await getAccessibleConnection(session, id);
  // A wrong-provider id (Holoo shares this table since migration 0103) is a
  // 404, not a 400: this route speaks WooCommerce, and the caller does not
  // get to probe which other integrations the tenant holds.
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  // Raw pass-through: `cataloguePageFor` owns the clamping and normalising
  // (page ≥ 1, 10 ≤ pageSize ≤ 100, trimmed lower-cased 200-char search) so
  // the service and every other caller share one rule, and echoes the
  // clamped values back for the response.
  const catalogue = await cataloguePageFor(session.businessId, id, {
    page: Number.parseInt(url.searchParams.get("page") ?? "1", 10),
    pageSize: Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10),
    search: url.searchParams.get("search"),
    type: url.searchParams.get("type"),
    taxonomy: url.searchParams.get("taxonomy"),
    term: url.searchParams.get("term"),
    status: url.searchParams.get("status"),
    stock: url.searchParams.get("stock"),
  });
  const moneyUnit = await resolveBusinessMoneyUnit(session.businessId);

  const queue = await productQueueStates(
    session.businessId,
    id,
    catalogue.rows.map((row) => row.remoteId),
  );

  return NextResponse.json({
    industry: catalogue.industry,
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
    summary: catalogue.summary,
    types: catalogue.types,
    facets: catalogue.facets,
    total: catalogue.total,
    mappedTotal: catalogue.mappedTotal,
    totalPages: catalogue.totalPages,
    page: catalogue.page,
    pageSize: catalogue.pageSize,
    products: catalogue.rows.map((row) => ({
      ...row,
      priceRial: row.priceRial === null ? null : row.priceRial.toString(),
      queue: queue[row.remoteId] ?? null,
    })),
  });
});
