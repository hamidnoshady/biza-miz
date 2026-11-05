import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { wooProductContentFor } from "@/lib/integrations/woo-product-content";

/**
 * What the store says about one product's presentation (issue #1215, P1-2).
 *
 * The sheet this feeds is the storefront half of a product: the descriptions
 * and imagery **as WordPress holds them**, plus the sync/queue facts. It is a
 * read — editing goes through the existing `POST /store/products` outbox
 * path, so there is exactly one way a store change leaves this app.
 *
 * Numbers matter here: an unmapped id is 404 (never an empty editor for
 * another store's product), a paused connection is readable but closed for
 * writes (`canWrite: false`), and `woocommerce.view` is enough to look.
 */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string; remoteId: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;
  const { id, remoteId } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // A WooCommerce product id is numeric; anything else was never mapped under
  // a key this table holds, so ask before touching the database with it.
  if (!/^\d{1,20}$/.test(remoteId)) {
    return NextResponse.json({ error: "invalid_remote_id" }, { status: 400 });
  }

  try {
    const content = await wooProductContentFor(session.businessId, id, remoteId);
    if (!content) return NextResponse.json({ error: "product_not_mapped" }, { status: 404 });
    return NextResponse.json({
      product: content,
      // The write gate is the connection's, not the screen's: a paused
      // connection (or one deleted under us) is readable history.
      canWrite: connection.status !== "paused",
    });
  } catch (err) {
    console.error("woo_product_content_failed", { connectionId: id, remoteId, error: (err as Error).message });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
});
