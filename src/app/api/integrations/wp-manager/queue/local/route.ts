import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import {
  LOCAL_QUEUE_PAGE_MAX,
  normaliseLocalQueuePageRequest,
  parseLocalQueuePageAnswer,
  parseLocalQueuePageRequest,
} from "@/lib/integrations/local-queue-page";

/**
 * Issue #1076 — the plugin-local queue, one page at a time.
 *
 * The queue screen already shows the PLUGIN's aggregate (pending/deferred/
 * failed plus the ten newest problem rows) beside the platform's own outbound
 * and inbound layers. That strip cannot answer «which of the two hundred stuck
 * events is the one that matters». This route is the mailbox for the paged
 * protocol: a POST records one request, the next plugin handshake receives it,
 * and the answer lands on the following handshake. Nothing here dials the
 * store — that is the whole point of plugin mode.
 *
 * Both verbs are sync-tier, the same permission the per-row queue diagnostics
 * use; they expose metadata only (topic, remote id, status, attempts, last
 * error, created at) and never a payload or a credential.
 */
function gate(connection: { link_mode: string; plugin_capabilities: Record<string, unknown> | null }) {
  if (connection.link_mode !== "plugin") return { supported: false, reason: "rest_mode" as const };
  // Advertising `localQueuePaging` is how a newer build says it knows the
  // protocol. An older plugin keeps today's aggregate strip, never a silent
  // empty page.
  const capabilities = connection.plugin_capabilities ?? {};
  if (capabilities.localQueuePaging !== true) return { supported: false, reason: "plugin_too_old" as const };
  return { supported: true as const };
}

export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const support = gate(connection);
  if (!support.supported) return NextResponse.json({ supported: false, reason: support.reason });

  const { rows } = await query<{ request: unknown; answer: unknown }>(
    `SELECT plugin_local_queue_request AS request, plugin_local_queue_answer AS answer
       FROM integration_connections WHERE id = $1 AND business_id = $2`,
    [connectionId, session.businessId],
  );

  return NextResponse.json({
    supported: true,
    request: parseLocalQueuePageRequest(rows[0]?.request),
    answer: parseLocalQueuePageAnswer(rows[0]?.answer),
    maxPageSize: LOCAL_QUEUE_PAGE_MAX,
  });
});

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;

  const body = (await request.json().catch(() => null)) as { connectionId?: unknown; after?: unknown; limit?: unknown } | null;
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : null;
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const support = gate(connection);
  if (!support.supported) return NextResponse.json({ supported: false, reason: support.reason });

  const pageRequest = normaliseLocalQueuePageRequest(body?.after, body?.limit);
  if (!pageRequest) return NextResponse.json({ error: "invalid_page_request" }, { status: 400 });
  if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });

  await query(
    `UPDATE integration_connections SET plugin_local_queue_request = $3::jsonb, updated_at = now()
      WHERE id = $1 AND business_id = $2`,
    [connectionId, session.businessId, JSON.stringify(pageRequest)],
  );
  await writeIntegrationAudit({
    businessId: session.businessId,
    connectionId,
    action: "plugin.local_queue_page_requested",
    payload: { after: pageRequest.after, limit: pageRequest.limit },
  });

  // Honest about the latency: the plugin answers on a later handshake, so a
  // request is «ثبت شد», never «در حال دریافت» with a spinner that implies now.
  return NextResponse.json({ ok: true, supported: true, request: pageRequest });
});
