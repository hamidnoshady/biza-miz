import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { WP_ABILITY_PERMISSIONS } from "@/lib/wp-access";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { isPluginJobUnsupportedError, PLUGIN_JOB_UNSUPPORTED } from "@/lib/integrations/plugin-job-guard";
import { enqueuePluginExport } from "@/lib/integrations/plugin-service";
import { syncCustomers } from "@/lib/integrations/sync-service";

/** The customer twin of the products route — see it for why plugin mode queues rather than pulls. */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  // Issue #944 / OVR-01: the WP manager's own `woocommerce.sync` key names
  // this action; `integrations.manage` keeps the access it always had.
  const { session, error } = await requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  // Same provider guard as the read route: without it, POSTing a Holoo
  // connection id would enqueue a WooCommerce `customer_export` job (or, in
  // REST mode, hand Holoo credentials to the Woo client).
  if (!connection || connection.provider !== "woocommerce")
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!connection.sync_customers) {
    return NextResponse.json({ ok: false, error: "sync_customers_disabled" }, { status: 409 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ ok: false, error: "connection_paused" }, { status: 409 });
  }

  if (connection.link_mode === "plugin") {
    // A job the plugin never advertised would sit `pending` forever (#944 / OVR-08).
    if (!pluginSupportsJobType(connection.plugin_capabilities, "customer_export")) {
      return NextResponse.json({ ok: false, error: PLUGIN_JOB_UNSUPPORTED }, { status: 409 });
    }
    try {
      const { jobId } = await enqueuePluginExport(session.businessId, id, "customer_export");
      return NextResponse.json({ ok: true, queued: true, result: "queued", jobIds: jobId ? [jobId] : [] });
    } catch (err) {
      if (isPluginJobUnsupportedError(err)) return NextResponse.json({ ok: false, error: PLUGIN_JOB_UNSUPPORTED }, { status: 409 });
      throw err;
    }
  }

  try {
    // Retain the requesting member on the durable sync run for audit provenance.
    const outcome = await syncCustomers(session.businessId, id, { requestedBy: session.sub });
    return NextResponse.json({ ok: true, ...outcome, result: "completed" });
  } catch (err) {
    if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
