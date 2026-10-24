import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { retryWpQueueRow } from "@/lib/integrations/wp-manager-service";

/**
 * Put one retryable WP queue row (outbox `failed`/`dead`, inbox
 * `failed`/`deferred`) back in the queue, due now.
 *
 * Every guard lives in `retryWpQueueRow` — tenant scope, paused connection
 * (issue #942, F06: this endpoint used to skip the paused check its sibling
 * route enforced), and eligible-state fencing (F05) — so both retry APIs
 * enforce identical rules. A refusal is a 409 with the row's real status.
 */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;

  const { id } = await context.params;
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (connection.status === "paused") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }

  // queueActionConnection inside retryWpQueueRow refuses paused connections
  // too (and, via getConnection, soft-deleted ones): the check above keeps
  // this endpoint's exact contract, the service gate keeps every other
  // retry caller's.
  const result = await retryWpQueueRow(session.businessId, connectionId, id, undefined, session.sub);
  if (!result.ok) {
    const httpStatus =
      result.error === "not_found"
        ? 404
        : result.error === "not_retryable" || result.error === "connection_paused"
          ? 409
          : 400;
    return NextResponse.json({ ok: false, error: result.error ?? "retry_failed", status: result.status }, { status: httpStatus });
  }
  return NextResponse.json({ ok: true, status: result.status });
});
