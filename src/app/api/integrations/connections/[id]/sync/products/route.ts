import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getConnection, wooClientFor } from "@/lib/integrations/connections-service";
import { enqueuePluginExport } from "@/lib/integrations/plugin-service";
import { syncProducts } from "@/lib/integrations/sync-service";
import { enqueueContentExport, syncWpContentRest } from "@/lib/integrations/wp-content-service";

/**
 * "Sync products now", in whichever direction this connection runs.
 *
 * In `rest_api` mode the app pulls the catalogue itself. In `plugin` mode it
 * cannot — it holds no credentials for the store — so the button enqueues a
 * job and the catalogue arrives as ordinary product events the next time the
 * plugin runs. Same button, same outcome, different mechanics; the response
 * says which happened so the panel can word it honestly.
 *
 * Authorization is `woocommerce.sync` (issue #943): running a sync is the
 * shopfront-operations capability the queue's retry already gates on, not
 * `integrations.manage`, which configures the connection itself.
 *
 * The REST outcome is passed through whole — including `failed`,
 * `failureIds`, `variationFetchFailures`, `taxonomyError` and the `partial`
 * flag — because a sync that imported 90 of 100 products must not announce
 * itself as a success. The caller words the result from those numbers.
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!connection.sync_products) {
    return NextResponse.json({ ok: false, error: "sync_products_disabled" }, { status: 409 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ ok: false, error: "connection_paused" }, { status: 409 });
  }

  if (connection.link_mode === "plugin") {
    await enqueuePluginExport(session.businessId, id, "catalogue_export");
    // The content mirror rides the products toggle — the WP Manager reads
    // posts/pages/media from the same pull loop, so keep both fresh together.
    if (connection.sync_products) await enqueueContentExport(session.businessId, id);
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const outcome = await syncProducts(session.businessId, id);
    if (connection.sync_products) {
      // REST mode: pull wp/v2 content with the same credentials. A failure
      // here must not fail the catalogue the button is named for.
      try {
        await syncWpContentRest(connection, wooClientFor(connection));
      } catch (err) {
        return NextResponse.json({ ok: true, ...outcome, contentError: (err as Error).message.slice(0, 200) });
      }
    }
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    const message = (err as Error).message;
    if (message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (message === "no_location") return NextResponse.json({ ok: false, error: "no_location" }, { status: 409 });
    // A stable code out, the raw detail in the server log: the store's own
    // error text can carry credentials-adjacent URLs or stack fragments.
    console.error("woo_product_sync_failed", { connectionId: id, error: message });
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 502 });
  }
});
