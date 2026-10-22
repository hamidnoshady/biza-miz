import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { drainOutbox, refreshOutboxForConnection } from "@/lib/integrations/outbox-service";

/**
 * "Push stock and prices now".
 *
 * Refreshing the outbox — diffing local stock/price against what was last
 * pushed — is identical in both link modes, because it only reads local data.
 * Draining is not: in plugin mode the WordPress plugin pulls these rows and
 * applies them, so this route stops at "queued" rather than trying to call a
 * store it has no credentials for.
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await refreshOutboxForConnection(connection);
    if (connection.link_mode === "plugin") {
      return NextResponse.json({ ok: true, queued: true });
    }
    await drainOutbox(connection);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
