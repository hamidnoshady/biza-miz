import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { WP_ABILITY_PERMISSIONS } from "@/lib/wp-access";
import { getConnection } from "@/lib/integrations/connections-service";
import { enqueuePluginExport } from "@/lib/integrations/plugin-service";
import { syncCustomers } from "@/lib/integrations/sync-service";

/** The customer twin of the products route — see it for why plugin mode queues rather than pulls. */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  // Issue #944 / OVR-01: the WP manager's own `woocommerce.sync` key names
  // this action; `integrations.manage` keeps the access it always had.
  const { session, error } = await requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
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
    const { jobId } = await enqueuePluginExport(session.businessId, id, "customer_export");
    return NextResponse.json({ ok: true, queued: true, result: "queued", jobIds: jobId ? [jobId] : [] });
  }

  try {
    const outcome = await syncCustomers(session.businessId, id);
    return NextResponse.json({ ok: true, ...outcome, result: "completed" });
  } catch (err) {
    if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
