import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { WP_ABILITY_PERMISSIONS } from "@/lib/wp-access";
import { wooClientFor } from "@/lib/integrations/connections-service";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
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
 * Authorization is the WP sync ability (issues #943 + #944): primarily
 * `woocommerce.sync` — the shopfront-operations capability the queue's
 * retry already gates on — with `integrations.manage` keeping the access
 * it always had, so nobody loses the button in the rename.
 *
 * The REST outcome is passed through whole — including `failed`,
 * `failureIds`, `variationFetchFailures`, `taxonomyError` and the `partial`
 * flag — because a sync that imported 90 of 100 products must not announce
 * itself as a success. The caller words the result from those numbers.
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  // Issue #944 / OVR-01 + #943: the WP manager's `woocommerce.sync` key
  // names this action (the queue's own capability); `integrations.manage`
  // keeps the access it always had. Any-of, via the one ability table.
  const { session, error } = await requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!connection.sync_products) {
    return NextResponse.json({ ok: false, error: "sync_products_disabled" }, { status: 409 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ ok: false, error: "connection_paused" }, { status: 409 });
  }

  if (connection.link_mode === "plugin") {
    // A job the plugin never advertised would sit `pending` forever — the
    // lease query filters by supported type — so refuse it here (#944 /
    // OVR-08) rather than queue a request nothing will pick up.
    if (!pluginSupportsJobType(connection.plugin_capabilities, "catalogue_export")) {
      return NextResponse.json({ ok: false, error: "plugin_job_unsupported" }, { status: 409 });
    }
    const catalogue = await enqueuePluginExport(session.businessId, id, "catalogue_export");
    // The content mirror rides the products toggle — the WP Manager reads
    // posts/pages/media from the same pull loop, so keep both fresh together
    // when the plugin can answer for content; an older plugin is told so.
    const contentSupported = pluginSupportsJobType(connection.plugin_capabilities, "content_export");
    const content = connection.sync_products && contentSupported ? await enqueueContentExport(session.businessId, id) : null;
    const jobIds = [catalogue.jobId, content?.jobId ?? null].filter((jobId): jobId is string => Boolean(jobId));
    const contentSkipped = connection.sync_products && !contentSupported;
    return NextResponse.json({
      ok: true,
      queued: true,
      result: "queued",
      jobIds,
      ...(contentSkipped
        ? {
            skippedSteps: [{ step: "content", reason: "plugin_job_unsupported" }],
            contentWarning: "plugin_content_export_unsupported",
            contentUpgradeRequired: true,
          }
        : {}),
    });
  }

  try {
    const outcome = await syncProducts(session.businessId, id);
    if (connection.sync_products) {
      // REST mode: pull wp/v2 content with the same credentials. A failure
      // here must not fail the catalogue the button is named for — but it
      // must not be reported as a clean success either (#944 / OVR-04):
      // `result: "partial"` names the failed substep so the overview can
      // say so and offer the content sync on its own.
      try {
        await syncWpContentRest(connection, wooClientFor(connection));
      } catch (err) {
        // Both audits' shapes, with #943's cap on leaked detail: the
        // structured partial (#944) and the bounded contentError (#943).
        const contentError = (err as Error).message.slice(0, 200);
        return NextResponse.json({
          ok: true,
          ...outcome,
          result: "partial",
          contentError,
          failedSteps: [{ step: "content", error: contentError }],
        });
      }
    }
    return NextResponse.json({ ok: true, ...outcome, result: "completed" });
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
