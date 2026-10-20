import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { WP_ABILITY_PERMISSIONS } from "@/lib/wp-access";
import { getConnection, wooClientFor } from "@/lib/integrations/connections-service";
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
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  // Issue #944 / OVR-01: the WP manager's own `woocommerce.sync` key names
  // this action; `integrations.manage` keeps the access it always had.
  const { session, error } = await requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync);
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
    // A job the plugin never advertised would sit `pending` forever — the
    // lease query filters by supported type — so refuse it here (#944 /
    // OVR-08) rather than queue a request nothing will pick up.
    if (!pluginSupportsJobType(connection.plugin_capabilities, "catalogue_export")) {
      return NextResponse.json({ ok: false, error: "plugin_job_unsupported" }, { status: 409 });
    }
    await enqueuePluginExport(session.businessId, id, "catalogue_export");
    // The content mirror rides the products toggle — the WP Manager reads
    // posts/pages/media from the same pull loop, so keep both fresh together
    // when the plugin can answer for content; an older plugin is told so.
    const contentSupported = pluginSupportsJobType(connection.plugin_capabilities, "content_export");
    if (connection.sync_products && contentSupported) await enqueueContentExport(session.businessId, id);
    return NextResponse.json({
      ok: true,
      queued: true,
      result: "queued",
      ...(contentSupported ? {} : { skippedSteps: [{ step: "content", reason: "plugin_job_unsupported" }] }),
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
        return NextResponse.json({
          ok: true,
          ...outcome,
          result: "partial",
          contentError: (err as Error).message,
          failedSteps: [{ step: "content", error: (err as Error).message }],
        });
      }
    }
    return NextResponse.json({ ok: true, ...outcome, result: "completed" });
  } catch (err) {
    if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
