import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { WP_ABILITY_PERMISSIONS } from "@/lib/wp-access";
import { getConnection } from "@/lib/integrations/connections-service";
import { enqueueExport } from "@/lib/integrations/woo-ops-service";
import { syncOrders } from "@/lib/integrations/sync-service";

/**
 * «همگام‌سازی سفارش‌ها» — pull the store's recent orders, in whichever
 * direction this connection runs.
 *
 * REST mode reads them itself. Plugin mode cannot, so — exactly like the
 * products button — it enqueues a job and the plugin answers by pushing the
 * orders it finds. Same button, same outcome, different mechanics; the
 * response says which happened so the panel can word it honestly.
 *
 * Why the button exists at all: webhooks are the fast path and they are also
 * a thing an owner has to configure by hand in a second system. A store whose
 * webhook was never set up was silently missing sales with nothing anywhere to
 * say so. A pull makes a missing webhook a late order instead of a lost one.
 */
export const POST = withTenantScope(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    // Issue #944 / OVR-01: the WP manager's own `woocommerce.sync` key names
    // this action; `integrations.manage` keeps the access it always had.
    const { session, error } = await requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync);
    if (error) return error;
    const { id } = await context.params;

    const connection = await getConnection(session.businessId, id);
    if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!connection.sync_orders) {
      return NextResponse.json({ ok: false, error: "sync_orders_disabled" }, { status: 409 });
    }
    if (connection.status === "paused") {
      return NextResponse.json({ ok: false, error: "connection_paused" }, { status: 409 });
    }

    let sinceDays: number | undefined;
    try {
      const body = (await request.json()) as { sinceDays?: number };
      if (typeof body?.sinceDays === "number" && Number.isFinite(body.sinceDays)) {
        sinceDays = Math.min(365, Math.max(1, Math.round(body.sinceDays)));
      }
    } catch {
      // An empty body is the normal case — the connection's own lookback wins.
    }

    if (connection.link_mode === "plugin") {
      const { jobId } = await enqueueExport(session.businessId, id, "orders_export", { sinceDays });
      return NextResponse.json({ ok: true, queued: true, result: "queued", jobIds: jobId ? [jobId] : [] });
    }

    try {
      const outcome = await syncOrders(session.businessId, id, { sinceDays });
      return NextResponse.json({ ok: true, ...outcome, result: "completed" });
    } catch (err) {
      if ((err as Error).message === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
    }
  },
);
